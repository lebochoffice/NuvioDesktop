package com.nuvio.app.features.debrid

import com.nuvio.app.features.addons.httpRequestRaw
import io.ktor.http.Url
import io.ktor.http.decodeURLPart
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.*

/** Non-secret identity retained from the exact file chosen by the resolver. */
data class TorboxPartyFile(val torrentId: Int, val fileId: Int, val accountFingerprint: String)

internal fun torboxAccountFingerprint(apiKey: String): String =
    com.nuvio.app.features.profiles.ProfilePinCrypto.sha256Hex(apiKey)

internal sealed interface TorboxPartyHlsResult {
    class Ready(val url: String) : TorboxPartyHlsResult
    class Failed(val message: String) : TorboxPartyHlsResult
}

// Field names verified against TorBox's public Stream/streamFunctions modules.
// Never serialize an entire response: user_token may be the account API key.
internal fun torboxShareableHls(body: JsonElement?, apiKey: String): String? {
    val root = body as? JsonObject ?: return null
    if ((root["success"] as? JsonPrimitive)?.booleanOrNull != true) return null
    val data = root["data"] as? JsonObject ?: return null
    val candidate = (data["hls_url"] as? JsonPrimitive)?.contentOrNull ?: return null
    if (apiKey.isBlank()) return null
    return try {
        val parsed = Url(candidate)
        val host = parsed.host.lowercase()
        if (parsed.protocol.name != "https" || parsed.user != null || parsed.password != null || parsed.fragment.isNotEmpty() ||
            !(host == "torbox.app" || host.endsWith(".torbox.app"))) return null
        // Covers percent-encoded credentials in query/path, not merely raw text.
        if (candidate.contains(apiKey) || parsed.encodedPath.decodeURLPart().contains(apiKey) ||
            parsed.parameters.entries().any { (_, values) -> values.any { it.contains(apiKey) } }) return null
        candidate
    } catch (_: Exception) { null }
}

internal suspend fun prepareTorboxPartyHls(file: TorboxPartyFile, apiKey: String): TorboxPartyHlsResult {
    if (apiKey.isBlank()) return TorboxPartyHlsResult.Failed("TorBox: Kein gespeicherter Account-Key verfügbar.")
    if (file.accountFingerprint != torboxAccountFingerprint(apiKey)) return TorboxPartyHlsResult.Failed("TorBox: Account geändert. Quelle im neuen Account erneut auswählen.")
    return try {
        val response = TorboxApiClient.createStream(apiKey, file.torrentId, file.fileId)
        val body = response.body
        val root = body as? JsonObject
        if (!response.isSuccessful || (root?.get("success") as? JsonPrimitive)?.booleanOrNull != true) {
            return TorboxPartyHlsResult.Failed(if (response.status == 403) "TorBox: Streamzugriff verweigert. Tarif und Account-Berechtigung prüfen."
                else "TorBox: HLS-Vorbereitung fehlgeschlagen. Account, Tarif und Verfügbarkeit prüfen.")
        }
        val url = torboxShareableHls(body, apiKey)
            ?: return TorboxPartyHlsResult.Failed("TorBox: Keine sichere HLS-Freigabe erhalten. Fehlender Link, unbekanntes CDN oder Account-Key in der URL. Persönliches HLS bleibt verfügbar.")
        // Poll the same newly created session; never create duplicates merely
        // because the transcoder has not produced its first manifest yet.
        repeat(15) {
            val manifest = probeTorboxPartyHls(url, apiKey)
            if (manifest == 200) return TorboxPartyHlsResult.Ready(url)
            if (manifest in listOf(401, 403, 410, 498)) return TorboxPartyHlsResult.Failed("TorBox: Streamzugriff nicht freigabefähig. Account und Berechtigungen prüfen.")
            kotlinx.coroutines.delay(2_000L)
        }
        TorboxPartyHlsResult.Failed("TorBox: HLS-Playlist nach Wartezeit noch nicht bereit. Party neu öffnen oder persönliche HLS-Quelle verwenden.")
    } catch (cancelled: CancellationException) { throw cancelled }
    catch (_: Exception) { TorboxPartyHlsResult.Failed("TorBox: HLS-Vorbereitung nicht erreichbar. Netzwerk und Account prüfen.") }
}

// Playlist-only probe: no media forwarding, no account key or raw error logging.
internal suspend fun probeTorboxPartyHls(url: String, accountKey: String? = null): Int {
    val response = httpRequestRaw(method = "GET", url = url, headers = emptyMap(), body = "", followRedirects = false, maxResponseBodyBytes = 512 * 1024)
    if (!accountKey.isNullOrBlank() && (response.body.contains(accountKey) || response.body.contains(encodePathSegment(accountKey)))) return 498
    return if (response.status in 200..299 && response.body.trimStart().startsWith("#EXTM3U")) 200 else response.status.takeUnless { it in 200..299 } ?: 422
}
