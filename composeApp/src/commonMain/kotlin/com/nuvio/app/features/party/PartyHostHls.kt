package com.nuvio.app.features.party

import com.nuvio.app.features.addons.RawHttpResponse
import com.nuvio.app.features.addons.httpRequestRaw
import io.ktor.http.Url
import io.ktor.http.decodeURLPart
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.Serializable

/**
 * A public HTTPS HLS VOD link the host explicitly shares as the party's
 * browser source (typed by the host, or a guest suggestion the host accepted).
 * Memory only: never persisted, logged or put into an invitation.
 */
data class PartyHostHls(
    val url: String,
    val mediaKey: String,
    val label: String,
    val partyId: String,
    val memberId: String,
    val familyOnly: Boolean = false,
)

private val GENERIC_MEMBER_NAMES = setOf("", "nuvio", "nuvio-mitglied", "nuvio mitglied", "nuvio member", "member", "mitglied", "gast", "guest")

/** Display name of a member; generic or empty names become "Mitglied N" (1-based). */
internal fun partyMemberLabel(displayName: String, index: Int): String =
    displayName.trim().takeUnless { it.lowercase() in GENERIC_MEMBER_NAMES } ?: "Mitglied ${index + 1}"

/** Part before "@" of an e-mail address, as a readable name; never the full address. */
internal fun partyEmailName(email: String?): String? =
    email?.substringBefore('@', missingDelimiterValue = "")?.trim()
        ?.filter { it.isLetterOrDigit() || it in "._- " }?.trim('.', '_', '-', ' ')?.take(36)
        ?.takeIf { it.length >= 2 }

/**
 * A guest's proposal; it never replaces the host source without the host's confirmation.
 * kind "hls": an alternative browser source of the same film. "youtube"/"mp4"/"webm":
 * a separate video shared as [PartySharedSource] (videoId only for YouTube).
 */
@Serializable
data class PartyHlsSuggestion(
    val id: Int,
    val memberId: String,
    val name: String,
    val url: String,
    val mediaKey: String,
    val kind: String = "hls",
    val videoId: String? = null,
)

internal sealed interface PartyHostHlsCheck {
    /** keyRemoved: the TorBox account key was stripped from the shared address. */
    data class Ok(val url: String, val keyRemoved: Boolean = false) : PartyHostHlsCheck
    data class Problem(val message: String) : PartyHostHlsCheck
}

internal const val PARTY_HOST_HLS_MAX_LENGTH = 4096

/** Same rules as the browser's safeStreamUrl: public HTTPS, no credentials, no local hosts. */
internal fun isPublicHttpsUrl(value: String): Boolean = try {
    val url = Url(value)
    val host = url.host.lowercase().removePrefix("[").removeSuffix("]").trimEnd('.')
    val ipv4 = Regex("^(\\d+)\\.(\\d+)\\.(\\d+)\\.(\\d+)$").find(host)?.groupValues?.drop(1)?.map { it.toInt() }
    url.protocol.name == "https" && value.startsWith("https://", ignoreCase = true) &&
        url.user.isNullOrEmpty() && url.password.isNullOrEmpty() && host.isNotEmpty() &&
        (host.contains('.') || host.contains(':')) && !host.endsWith(".localhost") &&
        !host.endsWith(".local") && !host.endsWith(".internal") && host != "home.arpa" && !host.endsWith(".home.arpa") &&
        (ipv4 != null || !Regex("^(?:0x[0-9a-f]+|\\d+)(?:\\.(?:0x[0-9a-f]+|\\d+))*$").matches(host)) &&
        (!host.contains(':') || Regex("^[23][0-9a-f]{0,3}:", RegexOption.IGNORE_CASE).containsMatchIn(host)) &&
        (ipv4 == null || (ipv4.joinToString(".") == host && ipv4.all { it in 0..255 } &&
            !(ipv4[0] == 0 || ipv4[0] == 10 || ipv4[0] == 127 || ipv4[0] >= 224 ||
            (ipv4[0] == 169 && ipv4[1] == 254) || (ipv4[0] == 192 && ipv4[1] == 168) ||
            (ipv4[0] == 172 && ipv4[1] in 16..31) || (ipv4[0] == 100 && ipv4[1] in 64..127))))
} catch (_: Exception) { false }

private fun containsAnyKey(text: String, keys: Collection<String>): Boolean {
    val decoded = runCatching { text.decodeURLPart() }.getOrDefault(text)
    return keys.any { it.isNotBlank() && (text.contains(it) || decoded.contains(it)) }
}

/** Syntax only; the text never contains the URL itself. */
internal fun partyHostHlsProblem(value: String, accountKeys: Collection<String>): String? {
    val url = value.trim()
    if (url.isEmpty() || url.length > PARTY_HOST_HLS_MAX_LENGTH || url.any { it.code <= 0x20 || it.code == 0x7f }) {
        return "Bitte eine gültige HTTPS-HLS-Adresse eintragen (ohne Leerzeichen, höchstens $PARTY_HOST_HLS_MAX_LENGTH Zeichen)."
    }
    if (!isPublicHttpsUrl(url)) return "Erlaubt ist nur eine öffentliche HTTPS-Adresse ohne Benutzername/Passwort. Keine lokalen oder HTTP-Adressen."
    if (url.contains('#')) return "Die Adresse darf keinen Fragmentteil (#…) enthalten."
    // Never share a configured debrid account key, not even with consent here.
    if (containsAnyKey(url, accountKeys)) return "Die Adresse enthält einen deiner Debrid-Account-Keys und wird nicht geteilt."
    return null
}

/** First variant URI of a master playlist, resolved against the playlist's final URL. */
internal fun firstHlsVariant(playlist: String, baseUrl: String): String? {
    val lines = playlist.lines().map { it.trim() }
    val index = lines.indexOfFirst { it.startsWith("#EXT-X-STREAM-INF") }.takeIf { it >= 0 } ?: return null
    val uri = lines.drop(index + 1).firstOrNull { it.isNotEmpty() && !it.startsWith("#") } ?: return null
    return resolveHlsUri(baseUrl, uri)
}

internal fun resolveHlsUri(baseUrl: String, uri: String): String? = when {
    uri.startsWith("https://", ignoreCase = true) -> uri
    uri.contains("://") -> null
    uri.startsWith("//") -> "https:$uri"
    uri.startsWith("?") -> baseUrl.substringBefore('#').substringBefore('?') + uri
    else -> runCatching {
        val base = Url(baseUrl)
        val origin = "https://${base.host}${if (base.specifiedPort > 0 && base.specifiedPort != 443) ":${base.specifiedPort}" else ""}"
        if (uri.startsWith("/")) origin + uri else origin + base.encodedPath.substringBeforeLast('/') + "/" + uri
    }.getOrNull()
}

/**
 * Loads only the playlist text (no segments, headers or cookies) and accepts a
 * finished VOD: a media playlist with #EXT-X-ENDLIST, or a master playlist whose
 * first variant is one. The desktop cannot check the browsers' CORS; hls.js
 * reports that per guest.
 */
internal suspend fun checkPartyHostHls(
    value: String,
    accountKeys: Collection<String>,
    fetch: suspend (String) -> RawHttpResponse = { url ->
        httpRequestRaw(method = "GET", url = url, headers = emptyMap(), body = "", followRedirects = false, maxResponseBodyBytes = 512 * 1024)
    },
): PartyHostHlsCheck {
    // A TorBox stream link whose key is only the `token` parameter: try it
    // without the key (never the keyed address); all other checks still apply.
    val keyFree = accountKeys.firstNotNullOfOrNull { com.nuvio.app.features.debrid.torboxKeyFreeUrl(value.trim(), it) }
    val url = keyFree ?: value.trim()
    partyHostHlsProblem(url, accountKeys)?.let { return PartyHostHlsCheck.Problem(it) }
    // TorBox addresses must stay on TorBox stream hosts, also after redirects.
    val torbox = com.nuvio.app.features.debrid.isTorboxStreamUrl(url)
    suspend fun fetchPlaylist(initial: String): Pair<RawHttpResponse?, String?> {
        var target = initial
        repeat(6) {
            val response = try { fetch(target) }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) { return null to "Playlist nicht erreichbar. Netzwerk und Gültigkeit des Links prüfen." }
            val responseUrl = response.url.ifBlank { target }
            if (!isPublicHttpsUrl(responseUrl)) return null to "Die Playlist leitet auf eine nicht öffentliche Adresse weiter."
            if (torbox && !com.nuvio.app.features.debrid.isTorboxStreamUrl(responseUrl)) return null to "Die TorBox-Playlist leitet auf einen Host außerhalb der TorBox-CDNs weiter."
            if (response.status !in listOf(301, 302, 303, 307, 308)) return response to null
            val location = response.headers.entries.firstOrNull { it.key.equals("location", ignoreCase = true) }?.value
            val next = location?.takeIf { it.isNotBlank() }?.let { resolveHlsUri(responseUrl, it) }
                ?.takeIf { partyHostHlsProblem(it, accountKeys) == null && (!torbox || com.nuvio.app.features.debrid.isTorboxStreamUrl(it)) }
                ?: return null to "Die Playlist-Weiterleitung ist nicht erlaubt."
            target = next
        }
        return null to "Zu viele Playlist-Weiterleitungen."
    }
    suspend fun load(target: String): Pair<RawHttpResponse?, String?> {
        val (response, problem) = fetchPlaylist(target)
        if (response == null) return null to problem
        if (response.status in listOf(401, 403)) return null to if (keyFree != null)
            "TorBox liefert die Playlist ohne Account-Key nicht (HTTP ${response.status}). Links mit Account-Key werden nicht geteilt."
            else "Zugriff verweigert (HTTP ${response.status}). Der Link ist abgelaufen oder nur für ein Gerät gültig."
        if (response.status in listOf(404, 410)) return null to "Playlist nicht gefunden (HTTP ${response.status}). Der Link ist abgelaufen oder falsch."
        if (response.status !in 200..299) return null to "Playlist nicht abrufbar (HTTP ${response.status})."
        if (!response.body.trimStart().startsWith("#EXTM3U")) return null to "Die Adresse liefert keine HLS-Playlist (#EXTM3U fehlt)."
        if (containsAnyKey(response.body, accountKeys)) return null to "Die Playlist enthält einen deiner Debrid-Account-Keys und wird nicht geteilt."
        return response to null
    }
    val (master, masterProblem) = load(url)
    if (master == null) return PartyHostHlsCheck.Problem(masterProblem.orEmpty())
    val media = if (master.body.contains("#EXT-X-STREAM-INF")) {
        val variant = firstHlsVariant(master.body, master.url.ifBlank { url })
            ?.takeIf { isPublicHttpsUrl(it) && partyHostHlsProblem(it, accountKeys) == null && (!torbox || com.nuvio.app.features.debrid.isTorboxStreamUrl(it)) }
            ?: return PartyHostHlsCheck.Problem("Die Master-Playlist nennt keine öffentliche HTTPS-Variante.")
        val (loaded, problem) = load(variant)
        loaded ?: return PartyHostHlsCheck.Problem("Variante: ${problem.orEmpty()}")
    } else master
    if (!media.body.contains("#EXT-X-ENDLIST")) {
        return PartyHostHlsCheck.Problem(if (torbox) "TorBox bereitet den Stream noch vor (Playlist noch nicht vollständig). In ein paar Minuten erneut versuchen."
            else "Live- oder unfertige Playlist (kein #EXT-X-ENDLIST). Für die Party sind nur abgeschlossene VOD-Playlists erlaubt.")
    }
    if (!media.body.contains("#EXTINF")) return PartyHostHlsCheck.Problem("Die Playlist enthält keine Segmente.")
    return PartyHostHlsCheck.Ok(url, keyRemoved = keyFree != null)
}

/** Only the host name is shown for a suggestion; the full link may carry tokens. */
internal fun partyHlsDisplayHost(url: String): String =
    runCatching { Url(url).host.lowercase() }.getOrNull()
        ?.takeIf { isPublicHttpsUrl(url) && Regex("^[a-z0-9.-]{1,253}$").matches(it) } ?: "unbekannter Host"
