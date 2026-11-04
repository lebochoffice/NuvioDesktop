package com.nuvio.app.features.player

import kotlinx.serialization.Serializable

@Serializable
data class PlayerControlPartyState(
    val available: Boolean = false,
    val active: Boolean = false,
    val synced: Boolean = false,
    val panelToken: Long = 0L,
    val busy: Boolean = false,
    val canStart: Boolean = false,
    val startNote: String = "",
    val profile: PlayerControlPartyMember = PlayerControlPartyMember(),
    val code: String = "",
    val connected: Boolean = false,
    val isHost: Boolean = false,
    val hostOnly: Boolean = false,
    val sharing: Boolean = false,
    val browserSharing: Boolean = false,
    val shareNote: String = "",
    // Browser HLS of the host's TorBox source ("HLS erstellen / aktualisieren").
    val hlsAvailable: Boolean = false,
    val hlsBusy: Boolean = false,
    val hlsStatus: String = "",
    // Stream card: current title and where its browser source comes from.
    val streamTitle: String = "",
    val streamSource: String = "",
    // "Mich synchronisieren" (guest on the party title) and "Alle synchronisieren" (host).
    val canSyncMe: Boolean = false,
    val canSyncAll: Boolean = false,
    // Shared start (host): offered while paused; running countdown; readiness.
    val countdownAvailable: Boolean = false,
    val countdownActive: Boolean = false,
    val countdownSeconds: Int = 3,
    val countdownReadiness: String = "",
    // "Intelligente Wiedergabe": live values of the own player and the expert option.
    val smartStatus: String = "",
    val smartNudgeActive: Boolean = false,
    val smartNudgeEnabled: Boolean = true,
    val smartSeeks: Int = 0,
    val smartNudges: Int = 0,
    val smartBuffering: Int = 0,
    val smartSeekLeadMs: Long = 0,
    val smartLastCorrection: String = "",
    // Result of the host's last "Alle synchronisieren" (live, for about a minute).
    val syncAllStatus: String = "",
    // Short browser HLS state for a status chip ("sent", "ready", "preparing", …).
    val hlsPhase: String = "",
    // Titles for the "different title" card (only while the player is elsewhere).
    val partyMediaTitle: String = "",
    val playerMediaTitle: String = "",
    // The cloud link was found automatically; filter text for the manual picker.
    val torboxLinkAuto: Boolean = false,
    val torboxSuggestedFilter: String = "",
    // Default origin of "Watch in Browser" (production, or the preview in a test build).
    val browserOrigin: String = "",
    // Host's own video link for all browser guests (never the URL itself here).
    val hostHlsAllowed: Boolean = false,
    val hostHlsActive: Boolean = false,
    val hostHlsLabel: String = "",
    val hostHlsBusy: Boolean = false,
    val hostHlsStatus: String = "",
    // Pending guest proposal: name and host name only.
    val hlsSuggestionFrom: String = "",
    val hlsSuggestionHost: String = "",
    val hlsSuggestionId: Int? = null,
    // "hls" (same film for browsers) or "youtube"/"mp4"/"webm" (separate video).
    val hlsSuggestionKind: String = "",
    // Shared separate video (links protocol 1): host controls, guests a notice.
    val linkActive: Boolean = false,
    val linkKind: String = "",
    val linkLabel: String = "",
    val linkPaused: Boolean = true,
    val linkPositionMs: Long = 0L,
    // "Mit TorBox-Datei verknüpfen" for addon streams without TorBox identity.
    val torboxLinkAvailable: Boolean = false,
    val torboxLinkedName: String = "",
    val torboxChoicesOpen: Boolean = false,
    val torboxChoicesBusy: Boolean = false,
    val torboxChoicesStatus: String = "",
    val torboxChoices: List<PlayerControlTorboxChoice> = emptyList(),
    // Family share of TorBox addresses with the account token.
    val familyAvailable: Boolean = false,
    val familyStatus: String = "",
    val canEnd: Boolean = false,
    val seatsLabel: String = "",
    val maxMembers: Int = 0,
    val members: List<PlayerControlPartyMember> = emptyList(),
    val behindTitle: String = "",
    val nowWatching: String = "",
    val switchLabel: String = "",
    val switchMessage: String = "",
    val pillMessage: String = "",
    val pillPinned: Boolean = false,
    val message: String = "",
    val messageToken: Long = 0L,
    val labels: Map<String, String> = emptyMap(),
    val chat: PlayerControlChatState = PlayerControlChatState(),
)

@Serializable
data class PlayerControlTorboxChoice(
    val id: String = "",
    val name: String = "",
    val size: String = "",
)

@Serializable
data class PlayerControlPartyMember(
    val id: String = "",
    val name: String = "",
    val initial: String = "",
    val imageUrl: String = "",
    val color: String = "",
    val isHost: Boolean = false,
    val status: String = "",
    val presence: String = "",
    val canRemove: Boolean = false,
    val removeTitle: String = "",
    // Compact sync state for colours: synced, catching_up, buffering,
    // unsynced, solo, stale, offline or "" (unknown; never assumed synced).
    val syncState: String = "",
)

@Serializable
data class PlayerControlChatState(
    val unread: Int = 0,
    val ready: Boolean = false,
    val messages: List<PlayerControlChatMessage> = emptyList(),
)

@Serializable
data class PlayerControlChatMessage(
    val key: String = "",
    val memberId: String = "",
    val name: String = "",
    val initial: String = "",
    val imageUrl: String = "",
    val color: String = "",
    val body: String = "",
    val time: String = "",
    val mine: Boolean = false,
    val sent: Boolean = true,
    val failed: Boolean = false,
    val startsGroup: Boolean = false,
    val endsGroup: Boolean = false,
    val showTime: Boolean = false,
)
