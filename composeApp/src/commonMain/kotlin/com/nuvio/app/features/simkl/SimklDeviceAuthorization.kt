package com.nuvio.app.features.simkl

import com.nuvio.app.features.addons.RawHttpResponse
import com.nuvio.app.features.addons.httpRequestRaw
import io.ktor.http.URLProtocol
import io.ktor.http.Url
import io.ktor.http.encodeURLParameter
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json

internal const val SIMKL_DEVICE_SCOPE = "media:read media:write"

internal class SimklDeviceAuthorization(
    private val clientId: String,
    private val request: suspend (String, Map<String, String>, String) -> RawHttpResponse = ::sendSimklOAuthForm,
    private val now: () -> Long = SimklPlatformClock::nowEpochMs,
    private val wait: suspend (Long) -> Unit = { delay(it) },
) {
    suspend fun start(pkce: SimklPkceMaterial): SimklDeviceCode =
        post("/oauth2/device", mapOf(
            "scope" to SIMKL_DEVICE_SCOPE,
            "code_challenge" to pkce.challenge,
            "code_challenge_method" to "S256",
        )).decode<SimklDeviceCode>().also {
            if (it.deviceCode.isBlank() || it.userCode.isBlank() || it.expiresIn !in 1L..86_400L ||
                it.browserUrl() == null
            ) throw SimklOAuthFailure(SimklAuthError.INVALID_TOKEN_RESPONSE)
        }

    suspend fun poll(code: SimklDeviceCode, verifier: String, expiresAt: Long): SimklV2Session {
        var interval = code.interval?.coerceAtLeast(1) ?: 5L
        while (true) {
            val remaining = expiresAt - now()
            if (remaining <= 0) throw SimklOAuthFailure(SimklAuthError.AUTHORIZATION_EXPIRED)
            wait(minOf(interval, 86_400L).times(1_000).coerceAtMost(remaining))
            if (now() >= expiresAt) throw SimklOAuthFailure(SimklAuthError.AUTHORIZATION_EXPIRED)
            val result = post("/oauth2/token", mapOf(
                "grant_type" to "urn:ietf:params:oauth:grant-type:device_code",
                "device_code" to code.deviceCode,
                "code_verifier" to verifier,
            ))
            if (now() >= expiresAt) throw SimklOAuthFailure(SimklAuthError.AUTHORIZATION_EXPIRED)
            when (result.oauthError()) {
                "authorization_pending" -> continue
                "slow_down" -> interval = interval.coerceAtMost(86_400L) + 5
                else -> return result.session()
            }
        }
    }

    suspend fun refresh(session: SimklV2Session): SimklV2Session =
        post("/oauth2/token", mapOf(
            "grant_type" to "refresh_token",
            "refresh_token" to session.refreshToken,
        )).session(session)

    suspend fun revoke(session: SimklV2Session) {
        post("/oauth2/revoke", mapOf(
            "token" to session.refreshToken,
            "token_type_hint" to "refresh_token",
        )).requireSuccess()
    }

    private suspend fun post(path: String, fields: Map<String, String>): RawHttpResponse {
        val body = (fields + ("client_id" to clientId)).entries.joinToString("&") { (name, value) ->
            "${name.encodeURLParameter(spaceToPlus = true)}=${value.encodeURLParameter(spaceToPlus = true)}"
        }
        return try {
            request(buildSimklApiUrl(path), simklRequestHeaders() + mapOf(
                "Content-Type" to "application/x-www-form-urlencoded",
                "simkl-api-key" to clientId,
            ), body)
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            throw SimklOAuthFailure(SimklAuthError.TOKEN_EXCHANGE_FAILED)
        }
    }

    private fun RawHttpResponse.session(previous: SimklV2Session? = null): SimklV2Session {
        val token = decode<SimklV2Token>()
        val scope = token.scope ?: previous?.scope.orEmpty()
        val refresh = token.refreshToken ?: previous?.refreshToken.orEmpty()
        if (token.accessToken.isBlank() || refresh.isBlank() || token.expiresIn !in 1L..31_536_000L ||
            !token.tokenType.equals("bearer", ignoreCase = true) ||
            !scope.split(' ').containsAll(SIMKL_DEVICE_SCOPE.split(' '))
        ) throw SimklOAuthFailure(SimklAuthError.INVALID_TOKEN_RESPONSE)
        return SimklV2Session(clientId, token.accessToken, refresh, now() + token.expiresIn * 1_000L, scope)
    }

    private inline fun <reified T> RawHttpResponse.decode(): T {
        requireSuccess()
        return try {
            oauthJson.decodeFromString<T>(body)
        } catch (_: Exception) {
            throw SimklOAuthFailure(SimklAuthError.INVALID_TOKEN_RESPONSE)
        }
    }

    private fun RawHttpResponse.requireSuccess() {
        if (status in 200..299) return
        val error = when (oauthError()) {
            "invalid_client", "unauthorized_client" -> SimklAuthError.INVALID_CLIENT_ID
            "expired_token" -> SimklAuthError.AUTHORIZATION_EXPIRED
            "access_denied" -> SimklAuthError.AUTHORIZATION_DENIED
            "invalid_grant", "invalid_token" -> SimklAuthError.AUTHORIZATION_REVOKED
            else -> SimklAuthError.TOKEN_EXCHANGE_FAILED
        }
        throw SimklOAuthFailure(error)
    }

    private fun RawHttpResponse.oauthError(): String? =
        if (status in 400..499) runCatching { oauthJson.decodeFromString<SimklOAuthError>(body).error }
            .getOrNull() else null
}

private val oauthJson = Json { ignoreUnknownKeys = true }

private suspend fun sendSimklOAuthForm(url: String, headers: Map<String, String>, body: String) =
    httpRequestRaw(
        method = "POST", url = url, headers = headers, body = body,
        followRedirects = false, maxResponseBodyBytes = 64 * 1024,
    )

internal class SimklOAuthFailure(val reason: SimklAuthError) : Exception(reason.name)

@Serializable
private class SimklOAuthError(val error: String)

@Serializable
internal class SimklDeviceCode(
    @SerialName("device_code") val deviceCode: String,
    @SerialName("user_code") val userCode: String,
    @SerialName("verification_uri") val verificationUri: String,
    @SerialName("verification_uri_complete") val completeUri: String? = null,
    @SerialName("expires_in") val expiresIn: Long,
    val interval: Long? = null,
) {
    fun browserUrl(): String? = sequenceOf(completeUri, verificationUri).filterNotNull().firstOrNull { value ->
        val url = runCatching { Url(value) }.getOrNull() ?: return@firstOrNull false
        url.protocol == URLProtocol.HTTPS && url.port == 443 && url.user == null && url.password == null &&
            url.host.lowercase() in setOf("simkl.com", "www.simkl.com")
    }
}

@Serializable
private class SimklV2Token(
    @SerialName("access_token") val accessToken: String,
    @SerialName("refresh_token") val refreshToken: String? = null,
    @SerialName("expires_in") val expiresIn: Long,
    @SerialName("token_type") val tokenType: String,
    val scope: String? = null,
)

@Serializable
internal class SimklV2Session(
    val clientId: String,
    val accessToken: String,
    val refreshToken: String,
    val expiresAt: Long,
    val scope: String,
)
