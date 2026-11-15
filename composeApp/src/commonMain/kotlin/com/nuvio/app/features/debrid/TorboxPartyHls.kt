package com.nuvio.app.features.debrid

import com.nuvio.app.features.addons.httpRequestRaw
import io.ktor.http.URLBuilder
import io.ktor.http.Url
import io.ktor.http.decodeURLPart
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.*

/** Non-secret identity retained from the exact file chosen by the resolver. */
enum class TorboxPartySource(val apiType: String, val label: String) {
    Torrent("torrent", "Torrent"), Usenet("usenet", "Usenet"),
}

data class TorboxPartyFile(
    val downloadId: Int,
    val fileId: Int,
    val accountFingerprint: String,
    val source: TorboxPartySource = TorboxPartySource.Torrent,
)

internal fun torboxAccountFingerprint(apiKey: String): String =
    com.nuvio.app.features.profiles.ProfilePinCrypto.sha256Hex(apiKey)

/** Why no browser HLS is available; each maps to its own panel state. */
internal enum class TorboxHlsFailure { RequestFailed, Denied, Unsupported, NotReady }

internal sealed interface TorboxPartyHlsResult {
    /**
     * familyOnly: the original TorBox address carrying the account token. It is
     * never broadcast; only the family share service may hand it to admitted
     * guests. propagateToken: variant playlists need the same `token`.
     */
    class Ready(val url: String, val familyOnly: Boolean = false, val propagateToken: Boolean = false, val audioStatus: String = "") : TorboxPartyHlsResult
    class Failed(val message: String, val reason: TorboxHlsFailure = TorboxHlsFailure.RequestFailed) : TorboxPartyHlsResult {
        // The account/plan refused access (not a transient failure).
        val denied: Boolean get() = reason == TorboxHlsFailure.Denied
    }
}

/** Result of reading createstream: only data.hls_url is used, nothing guessed. */
internal sealed interface TorboxHlsCandidate {
    data class Url(val url: String) : TorboxHlsCandidate
    /** success=true but no hls_url: only the field NAMES of data are kept (never values). */
    data class Missing(val fieldNames: List<String>) : TorboxHlsCandidate
    data class UnsafeHost(val host: String) : TorboxHlsCandidate
    data object ContainsAccountKey : TorboxHlsCandidate
    /**
     * The key appears only as the `token` query parameter. [keyFreeUrl] is the
     * same address without it; it is used only if TorBox serves the playlist
     * (and its first variant) without the key, which the probe verifies.
     */
    data class KeyOnlyInTokenParameter(val keyFreeUrl: String) : TorboxHlsCandidate
    data object Invalid : TorboxHlsCandidate
}

private val SAFE_FIELD_NAME = Regex("^[A-Za-z0-9_]{1,40}$")
private val SAFE_HOST = Regex("^[a-z0-9.-]{1,253}$")

/**
 * TorBox stream hosts: torbox.app and the CDN domains TorBox documents
 * (support.torbox.app, "Accessing TorBox with NextDNS"). Exact name or a real
 * subdomain only; no trailing dot, no lookalikes such as evil-tb-cdn.io or
 * tb-cdn.io.example.com. Names only, never IP addresses.
 */
internal val TORBOX_STREAM_DOMAINS = listOf(
    "torbox.app", "tb-cdn.cx", "tb-cdn.io", "tb-cdn.pw", "tb-cdn.sh", "tb-cdn.st", "tb-cdn.to", "tb-cdn.earth",
)
private val TORBOX_HOST_LABEL = Regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")

internal fun isTorboxStreamHost(host: String): Boolean {
    val name = host.lowercase()
    if (name.length > 253 || name.endsWith(".") || name.split('.').any { !TORBOX_HOST_LABEL.matches(it) }) return false
    return TORBOX_STREAM_DOMAINS.any { name == it || name.endsWith(".$it") }
}

/** HTTPS on a TorBox stream host, without credentials; for redirects and variant playlists. */
internal fun isTorboxStreamUrl(url: String): Boolean = try {
    val parsed = Url(url)
    url.startsWith("https://", ignoreCase = true) && parsed.protocol.name == "https" &&
        parsed.user.isNullOrEmpty() && parsed.password.isNullOrEmpty() && isTorboxStreamHost(parsed.host)
} catch (_: Exception) { false }

/**
 * Same address without the account key, if the key appears ONLY as the
 * `token` query parameter of a TorBox stream URL. Null otherwise. Whether
 * TorBox serves it without the key is decided by the playlist probe.
 */
internal fun torboxKeyFreeUrl(url: String, apiKey: String): String? {
    if (apiKey.isBlank() || !isTorboxStreamUrl(url)) return null
    return try {
        val parsed = Url(url)
        val path = parsed.encodedPath
        if (path.contains(apiKey) || path.decodeURLPart().contains(apiKey)) return null
        if (parsed.parameters.entries().any { (name, values) -> name != "token" && (name.contains(apiKey) || values.any { it.contains(apiKey) }) }) return null
        if (parsed.parameters.getAll("token")?.any { it.contains(apiKey) } != true) return null
        URLBuilder(parsed).apply { parameters.remove("token") }.buildString()
            .takeUnless { it.contains(apiKey) || it.decodeURLPart().contains(apiKey) }
    } catch (_: Exception) { null }
}

/** Probe result: a redirect or variant left the TorBox stream hosts. */
internal const val TORBOX_PROBE_UNSAFE_HOST = 497
/** Probe result: 2xx, but the body is no HLS playlist (our own check, not TorBox). */
internal const val TORBOX_PROBE_NOT_HLS = 415
/** Probe result: playable, but the variant playlist only works with the same `token`. */
internal const val TORBOX_PROBE_OK_NEEDS_TOKEN = 290

/**
 * Statuses that show TorBox is still producing the playlist. Everything else
 * (422 parameter error, 400, 405, not HLS, …) is permanent: fail at once
 * instead of polling for ten minutes.
 */
internal val TORBOX_PROCESSING_STATUSES = setOf(0, 202, 404, 408, 425, 429, 500, 502, 503, 504)

/** The address with `token` set to [token] (for variant requests that need it). */
internal fun withTorboxToken(url: String, token: String): String? = try {
    URLBuilder(Url(url)).apply { parameters.remove("token"); parameters.append("token", token) }.buildString()
} catch (_: Exception) { null }

internal fun torboxTokenOf(url: String): String? = try { Url(url).parameters["token"]?.takeIf { it.isNotBlank() } } catch (_: Exception) { null }

// Field names verified against TorBox's public Stream/streamFunctions modules.
// Never serialize an entire response: user_token may be the account API key.
internal fun torboxHlsCandidate(body: JsonElement?, apiKey: String): TorboxHlsCandidate {
    val root = body as? JsonObject ?: return TorboxHlsCandidate.Invalid
    if ((root["success"] as? JsonPrimitive)?.booleanOrNull != true) return TorboxHlsCandidate.Invalid
    val data = root["data"] as? JsonObject
        ?: return TorboxHlsCandidate.Missing(emptyList())
    val candidate = (data["hls_url"] as? JsonPrimitive)?.contentOrNull
        ?: return TorboxHlsCandidate.Missing(data.keys.filter { SAFE_FIELD_NAME.matches(it) }.sorted().take(20))
    if (apiKey.isBlank()) return TorboxHlsCandidate.Invalid
    return try {
        val parsed = Url(candidate)
        val host = parsed.host.lowercase()
        if (parsed.protocol.name != "https" || parsed.user != null || parsed.password != null || parsed.fragment.isNotEmpty()) return TorboxHlsCandidate.Invalid
        if (!isTorboxStreamHost(host)) {
            return TorboxHlsCandidate.UnsafeHost(host.takeIf { SAFE_HOST.matches(it) } ?: "unbekannt")
        }
        // Covers percent-encoded credentials in query/path, not merely raw text.
        if (candidate.contains(apiKey) || parsed.encodedPath.decodeURLPart().contains(apiKey) ||
            parsed.parameters.entries().any { (_, values) -> values.any { it.contains(apiKey) } }) {
            return torboxKeyFreeUrl(candidate, apiKey)?.let { TorboxHlsCandidate.KeyOnlyInTokenParameter(it) }
                ?: TorboxHlsCandidate.ContainsAccountKey
        }
        TorboxHlsCandidate.Url(candidate)
    } catch (_: Exception) { TorboxHlsCandidate.Invalid }
}

internal fun torboxShareableHls(body: JsonElement?, apiKey: String): String? =
    (torboxHlsCandidate(body, apiKey) as? TorboxHlsCandidate.Url)?.url

/**
 * TorBox may transcode for minutes before the first playlist exists. Poll the
 * SAME session with backoff, bounded to about 10 minutes; cancellation (media
 * change, refresh button, leaving the party) stops it at once.
 */
internal val TORBOX_PLAYLIST_POLL_DELAYS_MS: List<Long> =
    List(5) { 2_000L } + List(10) { 5_000L } + List(36) { 15_000L }

private val TORBOX_GERMAN_AUDIO = Regex("^(?:de|deu|ger)(?:[-_][a-z0-9]+)*$|^(?:german|deutsch)(?:$|[ .(].*)")

private suspend fun preferGermanTorboxAudio(
    response: DebridApiResponse<JsonElement>,
    apiKey: String,
    createForAudio: suspend (Int) -> DebridApiResponse<JsonElement>,
): Pair<DebridApiResponse<JsonElement>, String> {
    val unknown = response to "TorBox-Audio: Audio-Metadaten fehlen oder sind ungültig; Standardspur verwendet."
    val data = (response.body as? JsonObject)?.get("data") as? JsonObject ?: return unknown
    val metadata = data["metadata"] as? JsonObject ?: return unknown
    val tracks = metadata["audios"] as? JsonArray ?: return unknown
    if (tracks.isEmpty() || tracks.any { it !is JsonObject }) return unknown
    fun JsonObject.language(field: String) =
        (get(field) as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull?.trim()?.lowercase()
    // Use the array position, which is independent of the container stream index.
    val germanTracks = tracks.indices.filter { index ->
        val track = tracks[index] as JsonObject
        val languages = listOfNotNull(track.language("language"), track.language("language_full"))
            .filterNot { it in setOf("", "und", "unknown", "undefined") }
        if (languages.isEmpty()) {
            track.language("title")?.let(TORBOX_GERMAN_AUDIO::matches) == true
        } else {
            languages.all(TORBOX_GERMAN_AUDIO::matches)
        }
    }
    val count = tracks.size
    if (germanTracks.isEmpty()) return response to "TorBox-Audio: Keine eindeutig deutsche Spur in $count gemeldeten Spuren; Standardspur verwendet."
    val current = (data["audio_index"] as? JsonPrimitive)?.intOrNull
    if (current != null && current in germanTracks)
        return response to "TorBox-Audio: Deutsch vom Anbieter bestätigt (relativer Index $current, $count Spuren)."
    val german = germanTracks.singleOrNull()
        ?: return response to "TorBox-Audio: Mehrere deutsche Spuren; Standardspur verwendet."
    if (current == null && german == 0)
        return response to "TorBox-Audio: Deutsch steht an Index 0; TorBox bestätigt den gewählten Index nicht."
    val adjusted = try {
        createForAudio(german)
    } catch (cancelled: CancellationException) { throw cancelled }
    catch (_: Exception) {
        return response to "TorBox-Audio: Anfrage für Deutsch (Index $german) fehlgeschlagen; Standardspur verwendet."
    }
    val adjustedData = (adjusted.body as? JsonObject)?.get("data") as? JsonObject
    if (!adjusted.isSuccessful)
        return response to "TorBox-Audio: Auswahl Deutsch (Index $german) fehlgeschlagen (HTTP ${adjusted.status}); Standardspur verwendet."
    val actual = (adjustedData?.get("audio_index") as? JsonPrimitive)?.intOrNull
    if (actual != german)
        return response to "TorBox-Audio: Angeforderter Index $german nicht bestätigt (Antwort: ${actual ?: "kein Index"}); Standardspur verwendet."
    return when (torboxHlsCandidate(adjusted.body, apiKey)) {
        is TorboxHlsCandidate.Url, is TorboxHlsCandidate.KeyOnlyInTokenParameter ->
            adjusted to "TorBox-Audio: Deutsch vom Anbieter bestätigt (relativer Index $german, $count Spuren)."
        else -> response to "TorBox-Audio: Keine verwendbare HLS-Adresse für Deutsch (Index $german); Standardspur verwendet."
    }
}

internal suspend fun prepareTorboxPartyHls(
    file: TorboxPartyFile,
    apiKey: String,
    onProcessing: () -> Unit = {},
    // Injectable for tests; production uses the real API, probe and delay.
    createStream: suspend (String, TorboxPartyFile) -> DebridApiResponse<JsonElement> =
        { key, selected -> TorboxApiClient.createStream(key, selected.downloadId, selected.fileId, source = selected.source) },
    probe: suspend (url: String, apiKey: String) -> Int = { url, key -> probeTorboxPartyHls(url, key) },
    pause: suspend (Long) -> Unit = { kotlinx.coroutines.delay(it) },
    // True only when the protected family share service is configured: then
    // the original address with the account token is used (host side only).
    familyShare: Boolean = false,
    createStreamForAudio: suspend (String, TorboxPartyFile, Int) -> DebridApiResponse<JsonElement> =
        { key, selected, audioIndex -> TorboxApiClient.createStream(key, selected.downloadId, selected.fileId, audioIndex, source = selected.source) },
): TorboxPartyHlsResult {
    if (apiKey.isBlank()) return TorboxPartyHlsResult.Failed("TorBox: Kein gespeicherter Account-Key verfügbar.")
    if (file.accountFingerprint != torboxAccountFingerprint(apiKey)) return TorboxPartyHlsResult.Failed("TorBox: Account geändert. Quelle im neuen Account erneut auswählen.")
    var keyFree = false
    var familyOnly = false
    val audioStatus: String
    val url = try {
        val response = createStream(apiKey, file)
        val root = response.body as? JsonObject
        if (response.status == 401 || response.status == 403) {
            return TorboxPartyHlsResult.Failed("TorBox: Streamzugriff verweigert (HTTP ${response.status}). Tarif und Account-Berechtigung prüfen.", TorboxHlsFailure.Denied)
        }
        if (!response.isSuccessful || (root?.get("success") as? JsonPrimitive)?.booleanOrNull != true) {
            return TorboxPartyHlsResult.Failed("TorBox: API-Anfrage fehlgeschlagen (HTTP ${response.status}). Account, Tarif und Verfügbarkeit prüfen.")
        }
        // Same address TorBox returned (host already checked by the candidate).
        val (stream, selectionStatus) = preferGermanTorboxAudio(response, apiKey) { audioIndex ->
            createStreamForAudio(apiKey, file, audioIndex)
        }
        audioStatus = selectionStatus
        val original = (((stream.body as? JsonObject)?.get("data") as? JsonObject)?.get("hls_url") as? JsonPrimitive)?.contentOrNull
        val candidate = torboxHlsCandidate(stream.body, apiKey)
        val keyed = candidate is TorboxHlsCandidate.KeyOnlyInTokenParameter || candidate == TorboxHlsCandidate.ContainsAccountKey
        // Family share: keep the original address with its token unchanged.
        if (familyShare && keyed && original != null && isTorboxStreamUrl(original)) original.also { familyOnly = true }
        else when (candidate) {
            is TorboxHlsCandidate.Url -> candidate.url
            // Variant A: try the same stream without the account key. Never the keyed URL.
            is TorboxHlsCandidate.KeyOnlyInTokenParameter -> candidate.keyFreeUrl.also { keyFree = true }
            is TorboxHlsCandidate.Missing -> return TorboxPartyHlsResult.Failed(
                "TorBox: Antwort enthält keine HLS-Adresse (Felder: ${candidate.fieldNames.joinToString().ifEmpty { "keine" }}). Diese Quelle stellt TorBox so nicht als HLS bereit.",
                TorboxHlsFailure.Unsupported,
            )
            is TorboxHlsCandidate.UnsafeHost -> return TorboxPartyHlsResult.Failed(
                "TorBox: HLS-Adresse auf nicht freigegebenem Host (${candidate.host}). Aus Sicherheitsgründen nicht geteilt.",
                TorboxHlsFailure.Unsupported,
            )
            TorboxHlsCandidate.ContainsAccountKey -> return TorboxPartyHlsResult.Failed(
                "TorBox: Die HLS-Adresse enthält den Account-Key. Aus Sicherheitsgründen nicht geteilt.",
                TorboxHlsFailure.Unsupported,
            )
            TorboxHlsCandidate.Invalid -> return TorboxPartyHlsResult.Failed("TorBox: Ungültige Antwort der Stream-API.")
        }
    } catch (cancelled: CancellationException) { throw cancelled }
    catch (_: Exception) { return TorboxPartyHlsResult.Failed("TorBox: Stream-API nicht erreichbar. Netzwerk prüfen.") }
    // Poll the same newly created session; never create duplicates merely
    // because the transcoder has not produced its first manifest yet.
    for ((attempt, delayMs) in TORBOX_PLAYLIST_POLL_DELAYS_MS.withIndex()) {
        // The original family address legitimately carries the token: no key check on it.
        val manifest = try { probe(url, if (familyOnly) "" else apiKey) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { 0 }
        if (manifest == 200 || manifest == TORBOX_PROBE_OK_NEEDS_TOKEN) {
            return TorboxPartyHlsResult.Ready(url, familyOnly = familyOnly, propagateToken = manifest == TORBOX_PROBE_OK_NEEDS_TOKEN, audioStatus = audioStatus)
        }
        if (keyFree && manifest in listOf(401, 403, 422)) return TorboxPartyHlsResult.Failed(
            "TorBox: Ohne Account-Key liefert TorBox die Playlist nicht (HTTP $manifest). Für die Familienfreigabe muss der Freigabedienst eingerichtet sein.",
            TorboxHlsFailure.Unsupported,
        )
        if (manifest in listOf(401, 403, 410)) return TorboxPartyHlsResult.Failed("TorBox: Streamzugriff verweigert (HTTP $manifest). Account und Mehrgeräteberechtigung prüfen.", TorboxHlsFailure.Denied)
        if (manifest == 498) return TorboxPartyHlsResult.Failed("TorBox: Playlist enthält Account-Zugangsdaten. Aus Sicherheitsgründen nicht geteilt.", TorboxHlsFailure.Unsupported)
        if (manifest == TORBOX_PROBE_UNSAFE_HOST) return TorboxPartyHlsResult.Failed("TorBox: Weiterleitung oder Variante auf einem Host außerhalb der TorBox-CDNs. Aus Sicherheitsgründen nicht geteilt.", TorboxHlsFailure.Unsupported)
        if (manifest == TORBOX_PROBE_NOT_HLS) return TorboxPartyHlsResult.Failed("TorBox: Die Antwort ist keine HLS-Playlist (#EXTM3U fehlt).", TorboxHlsFailure.Unsupported)
        // Permanent errors end at once; only real processing states are polled again.
        if (manifest !in TORBOX_PROCESSING_STATUSES) return TorboxPartyHlsResult.Failed(
            "TorBox: Playlist-Anfrage abgelehnt (HTTP $manifest).", TorboxHlsFailure.Unsupported,
        )
        if (attempt == 0) onProcessing()
        pause(delayMs)
    }
    return TorboxPartyHlsResult.Failed("TorBox: Playlist nach etwa 10 Minuten noch nicht fertig. „HLS erstellen / aktualisieren“ versucht es erneut.", TorboxHlsFailure.NotReady)
}

/**
 * Addon streams (e.g. "[TB+] …") carry no TorBox file identity. If the addon
 * gave an info hash, look for exactly one torrent with that hash in the
 * user's own TorBox cloud (official mylist) and exactly one file that matches
 * the stream's filename (or the only video file). Nothing is guessed.
 */
internal fun matchTorboxCloudFile(items: List<TorboxCloudItemDto>, infoHash: String, filename: String?): Pair<Int, Int>? {
    val hash = infoHash.trim().lowercase().takeIf { it.isNotEmpty() } ?: return null
    val torrent = items.filter { it.hash?.trim()?.lowercase() == hash }.singleOrNull() ?: return null
    val torrentId = (torrent.id as? JsonPrimitive)?.contentOrNull?.toIntOrNull()?.takeIf { it >= 0 } ?: return null
    val files = torrent.files.orEmpty().mapNotNull { file ->
        (file.id as? JsonPrimitive)?.contentOrNull?.toIntOrNull()?.takeIf { it >= 0 }?.let { it to file }
    }
    fun names(file: TorboxCloudFileDto) = listOfNotNull(file.name, file.shortName, file.absolutePath?.substringAfterLast('/'))
        .map(::torboxBasename).filter { it.isNotEmpty() }
    val wanted = filename?.let(::torboxBasename)?.takeIf { it.isNotEmpty() }
    val match = if (wanted != null) {
        val exact = files.filter { (_, file) -> wanted in names(file) }
        if (exact.isNotEmpty()) exact.singleOrNull()
        else files.filter { (_, file) ->
            names(file).any { normalizedTorboxFilename(it) == normalizedTorboxFilename(wanted) }
        }.singleOrNull()
    } else {
        files.filter { (_, file) ->
            (file.mimeType ?: file.mimeTypeAlt)?.startsWith("video/") == true ||
                names(file).any { name -> VIDEO_EXTENSIONS.any { name.endsWith(it) } }
        }.singleOrNull()
    } ?: return null
    return torrentId to match.first
}

private val VIDEO_EXTENSIONS = listOf(".mkv", ".mp4", ".m4v", ".avi", ".mov", ".webm", ".ts", ".m2ts", ".wmv")

internal suspend fun findTorboxCloudFile(apiKey: String, infoHash: String, filename: String?): TorboxPartyFile? {
    if (apiKey.isBlank()) return null
    val response = TorboxApiClient.listCloudTorrents(apiKey)
    if (!response.isSuccessful) return null
    val items = response.body?.data ?: return null
    val (torrentId, fileId) = matchTorboxCloudFile(items, infoHash, filename) ?: return null
    return TorboxPartyFile(torrentId, fileId, torboxAccountFingerprint(apiKey))
}

/** One video file of the host's own TorBox cloud, offered for manual linking. */
data class TorboxCloudChoice(
    val downloadId: Int,
    val fileId: Int,
    val name: String,
    val size: Long?,
    val source: TorboxPartySource = TorboxPartySource.Torrent,
) {
    val selectionId: String get() = "${source.apiType}:$downloadId:$fileId"
    fun partyFile(accountFingerprint: String) = TorboxPartyFile(downloadId, fileId, accountFingerprint, source)
}

/** Real torrent/file IDs from mylist; video files only, nothing derived from names. */
internal fun torboxCloudVideoChoices(
    items: List<TorboxCloudItemDto>, source: TorboxPartySource = TorboxPartySource.Torrent,
): List<TorboxCloudChoice> =
    items.flatMap { download ->
        if (download.downloadPresent == false || download.downloadFinished == false) return@flatMap emptyList()
        val status = listOfNotNull(download.downloadState, download.status, download.state)
            .firstOrNull { it.isNotBlank() }?.trim()?.lowercase()
        if (source == TorboxPartySource.Usenet && download.downloadFinished != true &&
            status !in setOf("completed", "cached", "finished")
        ) return@flatMap emptyList()
        val downloadId = (download.id as? JsonPrimitive)?.contentOrNull?.toIntOrNull()?.takeIf { it >= 0 } ?: return@flatMap emptyList()
        download.files.orEmpty().mapNotNull { file ->
            val fileId = (file.id as? JsonPrimitive)?.contentOrNull?.toIntOrNull()?.takeIf { it >= 0 } ?: return@mapNotNull null
            val names = listOfNotNull(file.shortName, file.name, file.absolutePath)
                .map { it.substringAfterLast('/').substringAfterLast('\\').trim() }
                .filter { it.isNotEmpty() && !it.contains('?') && !it.contains('#') }
            val videoName = names.firstOrNull { name -> VIDEO_EXTENSIONS.any { name.lowercase().endsWith(it) } }
            val videoMime = listOfNotNull(file.mimeType, file.mimeTypeAlt).any { it.startsWith("video/", ignoreCase = true) }
            val name = videoName ?: names.firstOrNull()?.takeIf { videoMime } ?: return@mapNotNull null
            TorboxCloudChoice(downloadId, fileId, name, file.size, source)
        }
    }.sortedBy { it.name.lowercase() }

internal data class TorboxCloudChoices(val files: List<TorboxCloudChoice>, val missingCategory: String? = null)

internal suspend fun listTorboxCloudChoices(apiKey: String): TorboxCloudChoices? {
    if (apiKey.isBlank()) return null
    val torrents = readTorboxCloudItems { TorboxApiClient.listCloudTorrents(apiKey) }
    val usenet = readTorboxCloudItems { TorboxApiClient.listCloudUsenet(apiKey) }
    if (torrents == null && usenet == null) return null
    return TorboxCloudChoices(
        torboxCloudVideoChoices(torrents.orEmpty()) + torboxCloudVideoChoices(usenet.orEmpty(), TorboxPartySource.Usenet),
        missingCategory = if (torrents == null) "Torrent" else if (usenet == null) "Usenet" else null,
    )
}

private fun torboxBasename(name: String): String =
    name.substringAfterLast('/').substringAfterLast('\\').trim().lowercase()

private fun titleTokens(text: String): List<String> = text.lowercase()
    .replace("ä", "ae").replace("ö", "oe").replace("ü", "ue").replace("ß", "ss")
    .replace(Regex("['’]"), "")
    .split(Regex("[^\\p{L}\\p{N}]+")).filter { it.isNotEmpty() }

private fun normalizedTorboxFilename(name: String): List<String> = titleTokens(torboxBasename(name))

private val RELEASE_YEAR = Regex("^(19|20)\\d{2}$")
private val RELEASE_SUFFIX = Regex("^(\\d{3,4}p|4k|uhd|hdr10?|dv|web|webrip|webdl|bluray|bdrip|brrip|remux|x26[45]|h26[45]|hevc|proper|repack|multi|german|dl)$")
private val EPISODE_TAG = Regex("(?<![a-z0-9])(?:s(\\d{1,3})[ ._-]*e(\\d{1,3})|(\\d{1,3})[ ._-]*x[ ._-]*(\\d{1,3}))(?!\\d)")
private val EPISODE_SUFFIX = Regex("^(?:e\\d|[ ._]*-[ ._]*(?:s\\d|e?\\d{1,3}(?!\\d|p)))")

private fun torboxEpisodeMatches(stem: String, season: Int?, episode: Int?): Boolean {
    val tags = EPISODE_TAG.findAll(stem).toList()
    if (season == null && episode == null) return tags.isEmpty()
    if (season == null || episode == null) return false
    val tag = tags.singleOrNull() ?: return false
    if (EPISODE_SUFFIX.containsMatchIn(stem.substring(tag.range.last + 1))) return false
    val tagSeason = tag.groupValues[1].ifEmpty { tag.groupValues[3] }.toInt()
    val tagEpisode = tag.groupValues[2].ifEmpty { tag.groupValues[4] }.toInt()
    return tagSeason == season && tagEpisode == episode
}

/** Never use size or list order to choose between different plausible releases. */
private fun torboxTitleCandidates(
    choices: List<TorboxCloudChoice>, title: String, season: Int?, episode: Int?,
    releaseYear: String? = null, filename: String? = null,
): List<TorboxCloudChoice> {
    val wanted = titleTokens(title).takeIf { it.isNotEmpty() } ?: return emptyList()
    val year = releaseYear?.takeIf(RELEASE_YEAR::matches)
    val candidates = choices.mapNotNull { choice ->
        val stem = torboxBasename(choice.name).substringBeforeLast('.')
        if (!torboxEpisodeMatches(stem, season, episode)) return@mapNotNull null
        val titlePart = EPISODE_TAG.find(stem)?.let { stem.substring(0, it.range.first) } ?: stem
        val tokens = titleTokens(titlePart)
        if ("sample" in titleTokens(stem) || tokens.take(wanted.size) != wanted) return@mapNotNull null
        val suffix = tokens.drop(wanted.size)
        val fileYear = suffix.firstOrNull()?.takeIf(RELEASE_YEAR::matches)
        if (suffix.isNotEmpty() && fileYear == null && !RELEASE_SUFFIX.matches(suffix.first())) return@mapNotNull null
        if (year != null && fileYear != null && year != fileYear) return@mapNotNull null
        choice to fileYear
    }
    if (!filename.isNullOrBlank()) {
        val exact = candidates.filter { (choice, _) -> torboxBasename(choice.name) == torboxBasename(filename) }
        if (exact.isNotEmpty()) return exact.map { it.first }
        val normalized = candidates.filter { (choice, _) -> normalizedTorboxFilename(choice.name) == normalizedTorboxFilename(filename) }
        if (normalized.isNotEmpty()) return normalized.map { it.first }
    }
    if (year != null) {
        val dated = candidates.filter { it.second == year }
        if (dated.isNotEmpty()) return dated.map { it.first }
    }
    return candidates.map { it.first }
}

internal fun matchTorboxCloudByTitle(
    choices: List<TorboxCloudChoice>, title: String, season: Int?, episode: Int?,
    releaseYear: String? = null, filename: String? = null,
): TorboxCloudChoice? = torboxTitleCandidates(choices, title, season, episode, releaseYear, filename).singleOrNull()

internal enum class TorboxMatchKind(val message: String) {
    Exact(""), UniqueTitle(""),
    Ambiguous("Mehrere TorBox-Veröffentlichungen passen. Bitte Originaldatei manuell wählen."),
    UnclearFile("Torrent gefunden, Datei oder Folge nicht eindeutig. Bitte Originaldatei manuell wählen."),
    NotFound("Keine passende Datei im abgefragten Cloud-Inventar des eingestellten TorBox-Kontos."),
    Unavailable("TorBox-Cloud vorübergehend nicht abrufbar. Beim nächsten Quellenwechsel wird erneut gesucht."),
}

internal data class TorboxCloudMatch(val kind: TorboxMatchKind, val choice: TorboxCloudChoice? = null)

internal suspend fun autoLinkTorboxCloud(
    apiKey: String, infoHash: String?, filename: String?, title: String, season: Int?, episode: Int?,
    releaseYear: String? = null,
    load: suspend (String) -> DebridApiResponse<TorboxEnvelopeDto<List<TorboxCloudItemDto>>> = TorboxApiClient::listCloudTorrents,
    loadUsenet: suspend (String) -> DebridApiResponse<TorboxEnvelopeDto<List<TorboxCloudItemDto>>> = TorboxApiClient::listCloudUsenet,
): TorboxCloudMatch {
    val torrents = readTorboxCloudItems { load(apiKey) } ?: return TorboxCloudMatch(TorboxMatchKind.Unavailable)
    // A known torrent hash restricts matching to that torrent. For metadata
    // matching compare both inventories so a second release stays ambiguous.
    val usenet = if (infoHash.isNullOrBlank())
        readTorboxCloudItems { loadUsenet(apiKey) } ?: return TorboxCloudMatch(TorboxMatchKind.Unavailable)
    else emptyList()
    return resolveTorboxCloudMatch(torrents, infoHash, filename, title, season, episode, releaseYear, usenet)
}

private suspend fun readTorboxCloudItems(
    load: suspend () -> DebridApiResponse<TorboxEnvelopeDto<List<TorboxCloudItemDto>>>,
): List<TorboxCloudItemDto>? {
    suspend fun fetch() = try {
        load()
    } catch (cancelled: CancellationException) { throw cancelled }
    catch (_: Exception) { null }
    var response = fetch()
    if (response == null || response.status in setOf(0, 408, 500, 502, 503, 504)) {
        kotlinx.coroutines.delay(2_000)
        response = fetch()
    }
    return response?.takeIf { it.isSuccessful }?.body?.takeUnless { it.success == false }?.data
}

internal fun resolveTorboxCloudMatch(
    items: List<TorboxCloudItemDto>, infoHash: String?, filename: String?, title: String,
    season: Int?, episode: Int?, releaseYear: String? = null,
    usenet: List<TorboxCloudItemDto> = emptyList(),
): TorboxCloudMatch {
    val hash = infoHash?.trim()?.takeIf { it.isNotEmpty() }
    if (hash == null) {
        val choices = (torboxCloudVideoChoices(items) + torboxCloudVideoChoices(usenet, TorboxPartySource.Usenet)).let { videos ->
            if (filename.isNullOrBlank()) videos
            else videos.filter { normalizedTorboxFilename(it.name) == normalizedTorboxFilename(filename) }
        }
        val candidates = torboxTitleCandidates(choices, title, season, episode, releaseYear, filename)
        return when (candidates.size) {
            0 -> TorboxCloudMatch(TorboxMatchKind.NotFound)
            1 -> TorboxCloudMatch(TorboxMatchKind.UniqueTitle, candidates.single())
            else -> TorboxCloudMatch(TorboxMatchKind.Ambiguous)
        }
    }
    val torrents = items.filter { it.hash?.trim().equals(hash, ignoreCase = true) }
    if (torrents.isEmpty()) return TorboxCloudMatch(TorboxMatchKind.NotFound)
    val torrent = torrents.singleOrNull() ?: return TorboxCloudMatch(TorboxMatchKind.Ambiguous)
    val choices = torboxCloudVideoChoices(listOf(torrent))
    val byHash = matchTorboxCloudFile(listOf(torrent), hash, filename)
    // When a filename was supplied, absence or ambiguity is final.
    if (!filename.isNullOrBlank() && byHash == null) return TorboxCloudMatch(TorboxMatchKind.UnclearFile)
    val direct = byHash?.let { (torrentId, fileId) ->
        choices.firstOrNull { it.downloadId == torrentId && it.fileId == fileId }
    }?.takeIf { choice ->
        // An exact source filename and hash identify the selected episode even when its name is untagged.
        (season == null && episode == null) ||
            (!filename.isNullOrBlank() && torboxBasename(choice.name) == torboxBasename(filename) &&
                EPISODE_TAG.find(torboxBasename(choice.name)) == null) ||
            torboxEpisodeMatches(torboxBasename(choice.name), season, episode)
    }
    val choice = if (!filename.isNullOrBlank()) direct
        else direct ?: matchTorboxCloudByTitle(choices, title, season, episode, releaseYear)
    return if (choice == null) TorboxCloudMatch(TorboxMatchKind.UnclearFile) else TorboxCloudMatch(TorboxMatchKind.Exact, choice)
}

/** Host-side state of the browser HLS source; shown in the party panel. */
enum class TorboxHlsPhase { Unavailable, Preparing, Processing, NotReady, Ready, Denied, Unsupported, Expired, Failed }

/**
 * Panel label. "Sent" is not a phase of its own: a ready source counts as sent
 * only while the host has explicitly enabled Browser-HLS sharing.
 */
internal fun torboxHlsStatusLabel(phase: TorboxHlsPhase, sharing: Boolean): String = when (phase) {
    TorboxHlsPhase.Unavailable -> "Nicht verfügbar"
    TorboxHlsPhase.Preparing -> "HLS wird vorbereitet …"
    TorboxHlsPhase.Processing -> "TorBox verarbeitet den Stream, Playlist noch nicht fertig …"
    TorboxHlsPhase.NotReady -> "Playlist nicht rechtzeitig fertig"
    TorboxHlsPhase.Ready -> if (sharing) "An Teilnehmer gesendet" else "HLS bereit (Browser-HLS-Freigabe ist aus)"
    TorboxHlsPhase.Denied -> "Zugriff verweigert"
    TorboxHlsPhase.Unsupported -> "Quelle nicht unterstützt"
    TorboxHlsPhase.Expired -> "Link abgelaufen – wird erneuert …"
    TorboxHlsPhase.Failed -> "API-Anfrage fehlgeschlagen"
}

/** Optional browser_hls.state while no URL is ready (older browsers ignore it). */
internal fun torboxBrowserState(phase: TorboxHlsPhase): String = when (phase) {
    TorboxHlsPhase.Denied -> "denied"
    TorboxHlsPhase.Failed, TorboxHlsPhase.NotReady -> "failed"
    TorboxHlsPhase.Unsupported -> "unsupported"
    TorboxHlsPhase.Processing -> "processing"
    else -> "preparing"
}

// Playlist-only probe: no media forwarding, no account key or raw error logging.
internal suspend fun probeTorboxPartyHls(
    url: String,
    accountKey: String? = null,
    fetch: suspend (String) -> com.nuvio.app.features.addons.RawHttpResponse = { target ->
        httpRequestRaw(method = "GET", url = target, headers = emptyMap(), body = "", followRedirects = true, maxResponseBodyBytes = 512 * 1024)
    },
): Int {
    // Follows redirects (TorBox may redirect to its CDN); no headers or account
    // key are sent, and the final body is still checked for the key. The start,
    // every final address and the first variant must stay on TorBox stream hosts.
    if (!isTorboxStreamUrl(url)) return TORBOX_PROBE_UNSAFE_HOST
    val response = fetch(url)
    val finalUrl = response.url.ifBlank { url }
    if (!isTorboxStreamUrl(finalUrl)) return TORBOX_PROBE_UNSAFE_HOST
    val result = torboxPlaylistStatus(response.status, response.body, accountKey)
    if (result != 200 || !response.body.contains("#EXT-X-STREAM-INF")) return result
    // Master playlist: the first variant must work the same way (and be key free),
    // requested exactly as hls.js would resolve it.
    val variant = com.nuvio.app.features.party.firstHlsVariant(response.body, finalUrl) ?: return TORBOX_PROBE_NOT_HLS
    if (!isTorboxStreamUrl(variant)) return TORBOX_PROBE_UNSAFE_HOST
    val child = fetch(variant)
    if (!isTorboxStreamUrl(child.url.ifBlank { variant })) return TORBOX_PROBE_UNSAFE_HOST
    val childResult = torboxPlaylistStatus(child.status, child.body, accountKey)
    // A relative variant loses the query. If it only works with the same token,
    // report that, so admitted browsers add it to TorBox requests themselves.
    val token = torboxTokenOf(url) ?: torboxTokenOf(finalUrl)
    if (childResult in listOf(401, 403, 422) && token != null && torboxTokenOf(variant) == null) {
        val withToken = withTorboxToken(variant, token) ?: return childResult
        val retry = fetch(withToken)
        if (!isTorboxStreamUrl(retry.url.ifBlank { withToken })) return TORBOX_PROBE_UNSAFE_HOST
        return if (torboxPlaylistStatus(retry.status, retry.body, accountKey) == 200) TORBOX_PROBE_OK_NEEDS_TOKEN else childResult
    }
    return childResult
}

internal fun torboxPlaylistStatus(status: Int, body: String, accountKey: String?): Int {
    if (!accountKey.isNullOrBlank() && (body.contains(accountKey) || body.contains(encodePathSegment(accountKey)))) return 498
    return if (status in 200..299 && body.trimStart().startsWith("#EXTM3U")) 200 else status.takeUnless { it in 200..299 } ?: TORBOX_PROBE_NOT_HLS
}
