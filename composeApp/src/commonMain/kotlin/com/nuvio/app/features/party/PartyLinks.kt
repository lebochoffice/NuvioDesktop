package com.nuvio.app.features.party

import com.nuvio.app.features.addons.RawHttpResponse
import com.nuvio.app.features.addons.httpRequestRaw
import io.ktor.http.Url
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlin.random.Random

/**
 * A separate video (YouTube or a direct MP4/WebM file) that the host shares
 * with the browser members of the party (fork "links" protocol 1).
 *
 * It never changes the party's media_key or the movie's playback state. It has
 * its own identity: [key] = "link:<id>:<rev>", used as media_key of its own
 * `state` revisions, commands and status reports. Every replacement raises
 * [rev], so a late event of an earlier source can never steer the next one.
 * Existing clients ignore all of it (unknown event, foreign media_key).
 *
 * Link states are broadcast only and never persisted: the backend row keeps
 * the movie's playback. Late joiners get the source and its state from the
 * host's answer to state_request.
 */
@Serializable
data class PartySharedSource(
    val key: String,
    val id: String,
    val rev: Int,
    val kind: String,
    @SerialName("video_id") val videoId: String? = null,
    val url: String? = null,
    val label: String = "",
    @SerialName("party_key") val partyKey: String,
)

/** A checked guest proposal of a separate video, before the host decides. */
internal data class PartyLinkCandidate(val kind: String, val videoId: String?, val url: String)

internal object PartyLinks {
    const val PROTOCOL = 1
    const val YOUTUBE = "youtube"
    val KINDS = setOf(YOUTUBE, "mp4", "webm")
    private val YOUTUBE_ID = Regex("^[A-Za-z0-9_-]{11}$")
    private val SOURCE_ID = Regex("^[A-Za-z0-9]{8,32}$")
    private const val ID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"

    fun key(id: String, rev: Int): String = "link:$id:$rev"

    fun isLinkKey(key: String?): Boolean = key?.startsWith("link:") == true

    fun validYouTubeId(id: String?): Boolean = id != null && YOUTUBE_ID.matches(id)

    /** Canonical watch address without tracking or playlist parameters. */
    fun youTubeUrl(id: String): String = "https://www.youtube.com/watch?v=$id"

    /** "mp4"/"webm" from the path of a public HTTPS file address, else null. */
    fun fileKind(url: String): String? = runCatching {
        val path = Url(url).encodedPath.lowercase()
        when {
            path.endsWith(".mp4") -> "mp4"
            path.endsWith(".webm") -> "webm"
            else -> null
        }
    }.getOrNull()

    fun newId(random: Random = Random.Default): String =
        (1..16).map { ID_ALPHABET[random.nextInt(ID_ALPHABET.length)] }.joinToString("")

    /**
     * Guest proposal (`stream_suggest` with kind). YouTube: only the video ID
     * counts; the address is rebuilt canonically. Files: a public HTTPS
     * address whose path really ends in the proposed container.
     */
    fun candidate(kind: String?, url: String?, videoId: String?): PartyLinkCandidate? = when (kind) {
        YOUTUBE -> videoId?.takeIf(::validYouTubeId)?.let { PartyLinkCandidate(YOUTUBE, it, youTubeUrl(it)) }
        "mp4", "webm" -> url?.trim()
            ?.takeIf { it.length <= PARTY_HOST_HLS_MAX_LENGTH && isPublicHttpsUrl(it) && !it.contains('#') && fileKind(it) == kind }
            ?.let { PartyLinkCandidate(kind, null, it) }
        else -> null
    }

    /** The next shared source; always a new revision of a new identity. */
    fun source(candidate: PartyLinkCandidate, partyKey: String, previous: PartySharedSource?, label: String, id: String = newId()): PartySharedSource {
        val rev = (previous?.rev ?: 0) + 1
        return PartySharedSource(
            key = key(id, rev),
            id = id,
            rev = rev,
            kind = candidate.kind,
            videoId = candidate.videoId,
            url = candidate.url.takeIf { candidate.kind != YOUTUBE },
            label = label.filterNot { it.isISOControl() }.trim().take(80),
            partyKey = partyKey,
        )
    }

    /** Structural check of a source received from the host (desktop guests: display only). */
    fun valid(source: PartySharedSource, partyKey: String): Boolean =
        SOURCE_ID.matches(source.id) && source.rev >= 1 && source.key == key(source.id, source.rev) &&
            source.partyKey == partyKey && source.kind in KINDS &&
            (if (source.kind == YOUTUBE) validYouTubeId(source.videoId) && source.url == null
            else source.url != null && candidate(source.kind, source.url, null) != null)

    /**
     * Host-side check of a direct MP4/WebM file before it is shared: public
     * HTTPS (also after redirects), no account key, a matching video type and
     * byte-range support (HTTP 206), which seeking needs. Only two bytes are
     * requested. Codecs, duration and the guests' CORS are checked by each
     * browser when it loads the file; it reports a short error otherwise.
     */
    suspend fun checkFile(
        candidate: PartyLinkCandidate,
        accountKeys: Collection<String>,
        fetch: suspend (String) -> RawHttpResponse = { target ->
            httpRequestRaw(method = "GET", url = target, headers = mapOf("Range" to "bytes=0-1"), body = "", followRedirects = false, maxResponseBodyBytes = 1024)
        },
    ): String? {
        partyHostHlsProblem(candidate.url, accountKeys)?.let { return it }
        var target = candidate.url
        repeat(6) {
            val response = try { fetch(target) }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) { return "Video nicht erreichbar. Netzwerk und Gültigkeit des Links prüfen." }
            fun header(name: String) = response.headers.entries.firstOrNull { it.key.equals(name, ignoreCase = true) }?.value.orEmpty()
            val responseUrl = response.url.ifBlank { target }
            if (!isPublicHttpsUrl(responseUrl)) return "Das Video leitet auf eine nicht öffentliche Adresse weiter."
            if (response.status in listOf(301, 302, 303, 307, 308)) {
                val next = header("location").takeIf { it.isNotBlank() }?.let { resolveHlsUri(responseUrl, it) }
                    ?.takeIf { partyHostHlsProblem(it, accountKeys) == null } ?: return "Die Weiterleitung des Videos ist nicht erlaubt."
                target = next
                return@repeat
            }
            if (response.status in listOf(401, 403)) return "Zugriff verweigert (HTTP ${response.status}). Der Link ist abgelaufen oder nur für ein Gerät gültig."
            if (response.status in listOf(404, 410)) return "Video nicht gefunden (HTTP ${response.status}). Der Link ist abgelaufen oder falsch."
            if (response.status == 200) return "Der Server unterstützt keine Bereichsanfragen. Ohne sie kann niemand im Video springen."
            if (response.status != 206) return "Video nicht abrufbar (HTTP ${response.status})."
            val type = header("content-type").substringBefore(';').trim().lowercase()
            val expected = if (candidate.kind == "webm") "video/webm" else "video/mp4"
            if (type.isNotEmpty() && type != expected && type != "application/octet-stream") return "Die Adresse liefert kein ${candidate.kind.uppercase()}-Video (Typ $type)."
            return null
        }
        return "Zu viele Weiterleitungen."
    }

    /** Same rules as [PartyCommands.decide], for the shared link's own epoch. */
    fun decide(command: PartyCommand, party: ActiveParty, source: PartySharedSource?): PartyCommandDecision {
        fun reject(reason: String) = PartyCommandDecision.Reject(reason)
        if (!PartyCommands.validId(command.commandId) || command.positionMs < 0L) return reject("invalid")
        if (!party.isHost || command.hostMemberId != party.memberId || source == null ||
            command.mediaKey != source.key || source.partyKey != party.media.key) return reject("stale_epoch")
        if (command.memberId == party.memberId || party.members.none { it.id == command.memberId }) return reject("not_member")
        if (party.hostOnly) return reject("host_only")
        return PartyCommandDecision.Accept
    }
}
