package com.nuvio.app.features.party

import com.nuvio.app.features.streams.StreamBadge
import com.nuvio.app.features.streams.StreamBehaviorHints
import com.nuvio.app.features.streams.StreamItem
import com.nuvio.app.features.streams.StreamProxyHeaders
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import io.ktor.http.decodeURLPart
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonArray

@Serializable
data class PartySource(
    @SerialName("info_hash") val infoHash: String? = null,
    @SerialName("file_idx") val fileIdx: Int? = null,
    val filename: String? = null,
    @SerialName("video_size") val videoSize: Long? = null,
    @SerialName("binge_group") val bingeGroup: String? = null,
    @SerialName("addon_id") val addonId: String? = null,
    val name: String? = null,
)

@Serializable
data class PartyMedia(
    val type: String,
    @SerialName("meta_id") val metaId: String,
    @SerialName("meta_type") val metaType: String,
    @SerialName("video_id") val videoId: String? = null,
    val season: Int? = null,
    val episode: Int? = null,
    val title: String = "",
    @SerialName("episode_title") val episodeTitle: String? = null,
    val description: String? = null,
    val poster: String? = null,
    val background: String? = null,
    val logo: String? = null,
    val source: PartySource? = null,
) {
    val key: String
        get() = partyMediaKey(metaType, metaId, season, episode)
}

@Serializable
data class PartyBrowserHls(
    // Null means preparation unavailable/pending, never "use the Desktop URL".
    val url: String? = null,
    val headers: Map<String, String> = emptyMap(),
    // Optional, for browsers: "preparing", "denied" or "failed" while url is
    // null. Older browsers ignore it and keep showing "pending".
    val state: String? = null,
    // Optional display name ("TorBox HLS", "Video-Link des Hosts"); older browsers ignore it.
    val label: String? = null,
    // state "family": the address is only available from the family share
    // service for admitted guests; rev changes with every new share there.
    val rev: Int? = null,
    // The TorBox token must also go on variant/segment requests (relative URIs lose it).
    @SerialName("propagate_token") val propagateToken: Boolean? = null,
)

@Serializable
data class PartyStream(
    @SerialName("media_key") val mediaKey: String,
    val url: String,
    val headers: Map<String, String> = emptyMap(),
    @SerialName("response_headers") val responseHeaders: Map<String, String> = emptyMap(),
    val name: String? = null,
    val description: String? = null,
    @SerialName("addon_name") val addonName: String = "",
    @SerialName("addon_id") val addonId: String = "",
    @SerialName("addon_logo") val addonLogo: String? = null,
    val filename: String? = null,
    @SerialName("video_size") val videoSize: Long? = null,
    @SerialName("binge_group") val bingeGroup: String? = null,
    @SerialName("stream_type") val streamType: String? = null,
    val badges: List<StreamBadge> = emptyList(),
    @SerialName("browser_hls") val browserHls: PartyBrowserHls? = null,
) {
    fun forDesktop(): PartyStream? = when {
        !isShareableStreamUrl(url) -> null
        browserHls == null -> this
        else -> copy(browserHls = null)
    }

    fun toStreamItem(): StreamItem = StreamItem(
        name = name,
        description = description,
        url = url,
        addonName = addonName,
        addonId = addonId,
        addonLogo = addonLogo,
        streamType = streamType,
        behaviorHints = StreamBehaviorHints(
            bingeGroup = bingeGroup,
            videoSize = videoSize,
            filename = filename,
            proxyHeaders = StreamProxyHeaders(request = headers, response = responseHeaders),
        ),
        badges = badges,
    )
}

internal fun isShareableStreamUrl(url: String): Boolean = SHAREABLE_URL.containsMatchIn(url)

internal fun ActiveParty?.desktopStreamFor(mediaKey: String, offer: PartyStream?): PartyStream? {
    val party = this ?: return null
    val stream = offer ?: return null
    if (party.isHost || party.media.key != mediaKey || stream.mediaKey != mediaKey) return null
    return stream.forDesktop()
}

// A single offer (or revocation) keeps both routes on the existing stream event.
// Older Desktop clients ignore browser_hls; an empty top-level URL is not playable.
internal fun ActiveParty.streamOffer(desktop: PartyStream?, browser: PartyBrowserHls?): PartyStream? {
    if (!isHost) return null
    val original = desktop?.takeIf { sharing && it.mediaKey == media.key && isShareableStreamUrl(it.url) }
    val hls = browser?.takeIf { browserSharing && it.state != "disabled" }
    return when {
        original != null -> original.copy(browserHls = hls ?: PartyBrowserHls(state = "disabled"))
        hls != null -> PartyStream(mediaKey = media.key, url = "", browserHls = hls)
        else -> null
    }
}

// Detect a complete known account key when a sharing path requires that check.
internal fun PartyStream.containsAccountKey(key: String): Boolean {
    if (key.isBlank()) return false
    fun textContains(value: String): Boolean = value.contains(key) ||
        runCatching { value.decodeURLPart().contains(key) }.getOrDefault(false)
    fun contains(element: JsonElement): Boolean = when (element) {
        is JsonPrimitive -> element.isString && textContains(element.content)
        is JsonObject -> element.any { (name, value) -> textContains(name) || contains(value) }
        is JsonArray -> element.any { contains(it) }
    }
    return contains(PartyApi.json.encodeToJsonElement(PartyStream.serializer(), this))
}

private val SHAREABLE_URL = Regex("^https?://(?!localhost|127\\.|0\\.0\\.0\\.0|\\[::1])[^\\s/]+", RegexOption.IGNORE_CASE)

internal fun partyMediaKey(metaType: String, metaId: String, season: Int?, episode: Int?): String =
    listOf(metaType.lowercase(), metaId, season?.toString().orEmpty(), episode?.toString().orEmpty())
        .joinToString("|")

@Serializable
data class PartyPlayback(
    val seq: Long,
    @SerialName("member_id") val memberId: String? = null,
    val paused: Boolean,
    @SerialName("position_ms") val positionMs: Long,
    val rate: Float = 1f,
    val at: Long,
    @SerialName("media_key") val mediaKey: String? = null,
    val waiting: Boolean = false,
    // Fork command protocol (optional, ignored by older clients): the member
    // whose command the host sequenced into this revision, and its command ID.
    // memberId remains the publisher (the host). Never persisted.
    @SerialName("origin_member_id") val originMemberId: String? = null,
    @SerialName("command_id") val commandId: String? = null,
) {
    /** Member whose action produced this revision. */
    val actorId: String?
        get() = originMemberId ?: memberId
}

@Serializable
data class PartyMember(
    val id: String,
    @SerialName("display_name") val displayName: String,
    @SerialName("avatar_url") val avatarUrl: String? = null,
    @SerialName("avatar_color") val avatarColor: String? = null,
)

@Serializable
data class PartyPreview(
    val media: PartyMedia? = null,
    val host: PartyMember? = null,
    val members: Int = 0,
    @SerialName("max_members") val maxMembers: Int = 0,
    val error: String? = null,
) {
    val isFull: Boolean
        get() = maxMembers in 1..members
}

@Serializable
enum class PartyMemberStatus {
    @SerialName("browsing") Browsing,
    @SerialName("loading") Loading,
    @SerialName("buffering") Buffering,
    @SerialName("ready") Ready,
    @SerialName("behind") Behind,
}

@Serializable
data class PartyPresence(
    @SerialName("member_id") val memberId: String,
    val status: PartyMemberStatus = PartyMemberStatus.Browsing,
    @SerialName("media_key") val mediaKey: String? = null,
    @SerialName("behind_ms") val behindMs: Long? = null,
    // Set by a host that sequences guest commands (PartyCommands.PROTOCOL).
    val commands: Int? = null,
    // Optional position report (fork, informational only, never a command):
    // player position at server time positionAt and whether it was playing.
    @SerialName("position_ms") val positionMs: Long? = null,
    @SerialName("position_at") val positionAt: Long? = null,
    val playing: Boolean? = null,
    // Watching alone on purpose (local pause/seek, browser "Allein schauen"):
    // shown as "Allein", not as out of sync. Optional; older clients ignore it.
    val solo: Boolean? = null,
)

@Serializable
internal data class PartyInfo(
    val id: String,
    val code: String,
    @SerialName("host_member_id") val hostMemberId: String? = null,
    @SerialName("host_only") val hostOnly: Boolean = false,
    val media: PartyMedia,
    val playback: PartyPlayback? = null,
    @SerialName("max_members") val maxMembers: Int = 3,
)

@Serializable
internal data class PartySnapshot(
    val party: PartyInfo? = null,
    val members: List<PartyMember> = emptyList(),
    @SerialName("member_id") val memberId: String? = null,
    @SerialName("server_time_ms") val serverTimeMs: Long? = null,
    val error: String? = null,
    val ok: Boolean? = null,
)

@Serializable
internal data class PartyChatPayload(
    val id: Long,
    @SerialName("member_id") val memberId: String,
    val name: String = "",
    @SerialName("avatar_url") val avatarUrl: String? = null,
    @SerialName("avatar_color") val avatarColor: String? = null,
    val body: String,
    @SerialName("client_id") val clientId: String? = null,
    @SerialName("sent_at") val sentAt: Long = 0L,
    val mine: Boolean = false,
)

@Serializable
internal data class PartyChatSendResult(
    val message: PartyChatPayload? = null,
    val error: String? = null,
)

@Serializable
internal data class PartyChatHistory(
    val messages: List<PartyChatPayload> = emptyList(),
    val error: String? = null,
)

enum class PartyError {
    NotFound,
    Full,
    Removed,
    Ended,
    RateLimited,
    SignInRequired,
    Unavailable,
    Network,
}

internal fun partyErrorOf(code: String?): PartyError? = when (code) {
    null -> null
    "party_not_found" -> PartyError.NotFound
    "party_full" -> PartyError.Full
    "removed", "not_member" -> PartyError.Removed
    "party_ended" -> PartyError.Ended
    "rate_limited" -> PartyError.RateLimited
    "unavailable" -> PartyError.Unavailable
    else -> PartyError.Network
}

data class ActiveParty(
    val id: String,
    val code: String,
    val memberId: String,
    val hostMemberId: String?,
    val members: List<PartyMember>,
    val presence: Map<String, PartyPresence>,
    val media: PartyMedia,
    val maxMembers: Int,
    val connected: Boolean,
    val hostOnly: Boolean = false,
    val sharing: Boolean = false,
    val browserSharing: Boolean = false,
) {
    val isHost: Boolean
        get() = memberId == hostMemberId

    val canControl: Boolean
        get() = !hostOnly || isHost

    fun blocksManualPlayback(playerMediaKey: String, solo: Boolean): Boolean =
        !solo && !canControl && media.key == playerMediaKey

    fun member(id: String?): PartyMember? = members.firstOrNull { it.id == id }
}

data class PartyUiState(
    val party: ActiveParty? = null,
    val busy: Boolean = false,
)

sealed interface PartyEvent {
    data class MemberJoined(val name: String) : PartyEvent
    data class MemberLeft(val name: String) : PartyEvent
    data object Removed : PartyEvent
    data object Ended : PartyEvent
    data class MediaChanged(val media: PartyMedia) : PartyEvent
    data class ControlChanged(val hostOnly: Boolean) : PartyEvent
}

enum class PartyAction {
    Paused,
    Resumed,
    Seeked,
    Speed,
}

data class PartyNotice(
    val name: String,
    val action: PartyAction,
    val positionMs: Long,
    val rate: Float,
)
