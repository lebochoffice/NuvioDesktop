package com.nuvio.app.features.party

import com.nuvio.app.core.network.SupabaseProvider
import com.nuvio.app.core.sync.SyncClientIdentity
import com.nuvio.app.features.addons.RawHttpResponse
import com.nuvio.app.features.addons.httpRequestRaw
import io.github.jan.supabase.auth.auth
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

/** Lifetime the host asks for, and how often it renews while sharing (Worker caps at 2 h). */
internal const val FAMILY_SHARE_TTL_S = 30 * 60
internal const val FAMILY_SHARE_RENEW_MS = 10 * 60 * 1000L

/**
 * Client of the family share Worker (party-share-worker/). The host hands it
 * the TorBox address with the account token over an authenticated request;
 * the Worker gives it only to members the host admitted. Never logged: no
 * URL, token or response body leaves this object.
 */
internal object PartyFamilyShare {
    // Build-time origin (-Pnuvio.party.shareWorker); empty disables the feature.
    internal var workerOrigin: String = PartyBrowserConfig.SHARE_WORKER
    val configured: Boolean get() = workerOrigin.isNotBlank()

    data class Result(val rev: Int?, val message: String)

    // Injectable for tests; production sends the host's own Nuvio session.
    internal var post: suspend (url: String, token: String, body: String) -> RawHttpResponse = { url, token, body ->
        httpRequestRaw(
            method = "POST",
            url = url,
            headers = mapOf("Authorization" to "Bearer $token", "Content-Type" to "application/json"),
            body = body,
            followRedirects = false,
            maxResponseBodyBytes = 16 * 1024,
        )
    }
    internal var accessToken: () -> String? = { SupabaseProvider.client.auth.currentAccessTokenOrNull() }
    internal var deviceId: () -> String = { SyncClientIdentity.currentClientId() }

    suspend fun publish(partyId: String, mediaKey: String, url: String, admitted: Collection<String>, propagateToken: Boolean): Result {
        if (!configured) return Result(null, "")
        if (admitted.isEmpty()) {
            revoke(partyId)
            return Result(null, "Familienfreigabe bereit. Noch kein Familienmitglied zugelassen.")
        }
        val body = buildJsonObject {
            put("party_id", partyId)
            put("device_id", deviceId())
            put("media_key", mediaKey)
            put("url", url)
            put("admitted", buildJsonArray { admitted.forEach { add(JsonPrimitive(it)) } })
            put("propagate_token", propagateToken)
            put("ttl_s", FAMILY_SHARE_TTL_S)
        }.toString()
        val response = send("share", body) ?: return Result(null, "Familienfreigabe nicht erreichbar. Netzwerk und Anmeldung prüfen.")
        return when (response.status) {
            200 -> Result(
                runCatching { kotlinx.serialization.json.Json.parseToJsonElement(response.body).jsonObject["rev"] as? JsonPrimitive }.getOrNull()?.intOrNull,
                "Familienfreigabe aktiv für ${admitted.size} ${if (admitted.size == 1) "Mitglied" else "Mitglieder"}.",
            )
            401, 403 -> Result(null, "Familienfreigabe abgelehnt: Anmeldung oder Host-Rolle nicht bestätigt.")
            409 -> Result(null, "Familienfreigabe abgelehnt: Titel hat gewechselt.")
            else -> Result(null, "Familienfreigabe fehlgeschlagen (HTTP ${response.status}).")
        }
    }

    suspend fun revoke(partyId: String): Boolean {
        if (!configured) return false
        val body = buildJsonObject { put("party_id", partyId); put("device_id", deviceId()) }.toString()
        return send("revoke", body)?.status == 200
    }

    private suspend fun send(action: String, body: String): RawHttpResponse? {
        val token = accessToken()?.takeIf { it.isNotBlank() } ?: return null
        return try { post("$workerOrigin/v1/$action", token, body) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { null }
    }
}
