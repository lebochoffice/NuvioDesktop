package com.nuvio.app.features.player.skip

import com.nuvio.app.features.addons.httpGetText
import com.nuvio.app.features.addons.httpPostJsonWithHeaders
import kotlinx.serialization.json.Json
import kotlinx.coroutines.CancellationException

internal object SkipIntroApi {

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    private const val ANISKIP_BASE = "https://api.aniskip.com/v2/"
    private const val ANIMESKIP_BASE = "https://api.anime-skip.com/"

    // --- IntroDb ---

    suspend fun getIntroDbMovieSegments(imdbId: String): IntroDbSegmentsResponse? {
        val baseUrl = IntroDbConfig.URL.trimEnd('/')
        if (baseUrl.isBlank()) return null
        return try {
            val text = httpGetText(introDbMovieSegmentsUrl(baseUrl, imdbId))
            json.decodeFromString<IntroDbSegmentsResponse>(text)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            null
        }
    }

    suspend fun getIntroDbSegments(
        imdbId: String,
        season: Int,
        episode: Int,
    ): IntroDbSegmentsResponse? {
        val baseUrl = IntroDbConfig.URL.trimEnd('/')
        if (baseUrl.isBlank()) return null
        val url = "$baseUrl/segments?imdb_id=$imdbId&season=$season&episode=$episode"
        return try {
            val text = httpGetText(url)
            json.decodeFromString<IntroDbSegmentsResponse>(text)
        } catch (cancelled: CancellationException) {
            throw cancelled // An episode change or timeout must cancel, not count as "no data".
        } catch (_: Exception) {
            null
        }
    }

    suspend fun submitIntro(
        apiKey: String,
        request: SubmitIntroRequest,
    ): Boolean {
        val baseUrl = IntroDbConfig.URL.trimEnd('/')
        if (baseUrl.isBlank() || apiKey.isBlank()) return false
        val url = "$baseUrl/submit"
        val body = json.encodeToString(SubmitIntroRequest.serializer(), request)
        val headers = mapOf(
            "Authorization" to "Bearer $apiKey",
            "Content-Type" to "application/json"
        )
        return try {
            val response = com.nuvio.app.features.addons.httpRequestRaw(
                method = "POST",
                url = url,
                headers = headers,
                body = body
            )
            response.status == 200 || response.status == 201
        } catch (_: Exception) {
            false
        }
    }

    suspend fun verifyIntroDbApiKey(apiKey: String): Boolean {
        val baseUrl = IntroDbConfig.URL.trimEnd('/')
        if (baseUrl.isBlank() || apiKey.isBlank()) return false
        val url = "$baseUrl/submit"
        val headers = mapOf(
            "Authorization" to "Bearer $apiKey",
            "Content-Type" to "application/json"
        )
        return try {
            val response = com.nuvio.app.features.addons.httpRequestRaw(
                method = "POST",
                url = url,
                headers = headers,
                body = "{}"
            )
            
            // 400 means Auth passed but payload was empty/invalid -> Key is Valid
            if (response.status == 400) return true
            
            // 200/201 would also mean valid (though unexpected with empty body)
            if (response.status == 200 || response.status == 201) return true
            
            // Explicitly handle auth failures
            if (response.status == 401 || response.status == 403) return false
            
            false
        } catch (_: Exception) {
            false
        }
    }

    // --- AniSkip ---

    suspend fun getAniSkipTimes(
        malId: String,
        episode: Int,
    ): AniSkipResponse? {
        val types = "types=op&types=ed&types=recap&types=mixed-op&types=mixed-ed"
        val url = "${ANISKIP_BASE}skip-times/$malId/$episode?$types&episodeLength=0"
        return try {
            val response = com.nuvio.app.features.addons.httpRequestRaw(
                method = "GET",
                url = url,
                headers = mapOf("Accept" to "application/json"),
                body = "",
            )
            aniSkipResponseOf(response.status, response.body)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            null
        }
    }

    // --- Anime-Skip GraphQL ---

    suspend fun queryAnimeSkip(clientId: String, graphqlQuery: String): AnimeSkipGraphqlResponse? {
        val body = json.encodeToString(
            kotlinx.serialization.json.JsonObject.serializer(),
            kotlinx.serialization.json.buildJsonObject {
                put("query", kotlinx.serialization.json.JsonPrimitive(graphqlQuery))
            }
        )
        val headers = mapOf(
            "X-Client-ID" to clientId,
            "Content-Type" to "application/json",
        )
        return try {
            val text = httpPostJsonWithHeaders(ANIMESKIP_BASE + "graphql", body, headers)
            json.decodeFromString<AnimeSkipGraphqlResponse>(text)
        } catch (_: Exception) {
            null
        }
    }
}

private val aniSkipJson = Json { ignoreUnknownKeys = true; isLenient = true }

/**
 * AniSkip answers an episode without data with HTTP 404 {"found":false}. That is a
 * real empty answer (cacheable), unlike 5xx/429/network errors, which are transient (null).
 */
internal fun aniSkipResponseOf(status: Int, body: String): AniSkipResponse? = when {
    status == 404 -> AniSkipResponse(found = false)
    status !in 200..299 -> null
    else -> runCatching { aniSkipJson.decodeFromString<AniSkipResponse>(body) }.getOrNull()
}

internal fun introDbMovieSegmentsUrl(baseUrl: String, imdbId: String): String =
    "${baseUrl.trimEnd('/')}/segments?imdb_id=$imdbId&is_movie=true"
