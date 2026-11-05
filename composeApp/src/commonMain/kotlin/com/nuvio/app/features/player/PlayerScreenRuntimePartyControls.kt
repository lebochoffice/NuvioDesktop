package com.nuvio.app.features.player

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nuvio.app.core.network.ServerConfigurationRepository
import com.nuvio.app.core.format.formatLocalTime
import com.nuvio.app.features.party.PartyChat
import com.nuvio.app.features.party.PartyChatStatus
import com.nuvio.app.features.party.PartyMember
import com.nuvio.app.features.party.PartyMemberStatus
import com.nuvio.app.features.party.PartyPresence
import com.nuvio.app.features.party.PartySync
import com.nuvio.app.features.party.PartyRepository
import com.nuvio.app.features.party.partyChatRows
import com.nuvio.app.features.party.behindMs
import com.nuvio.app.features.party.displayTitle
import com.nuvio.app.features.party.formatPartyCode
import com.nuvio.app.features.party.partyInviteLink
import com.nuvio.app.features.party.presenceState
import com.nuvio.app.features.party.rememberProfileAvatar
import com.nuvio.app.features.party.statusRes
import nuvio.composeapp.generated.resources.Res
import nuvio.composeapp.generated.resources.action_cancel
import nuvio.composeapp.generated.resources.action_close
import nuvio.composeapp.generated.resources.action_remove
import nuvio.composeapp.generated.resources.party_behind
import nuvio.composeapp.generated.resources.party_behind_title
import nuvio.composeapp.generated.resources.party_chat_empty_message
import nuvio.composeapp.generated.resources.party_chat_empty_title
import nuvio.composeapp.generated.resources.party_chat_new_messages
import nuvio.composeapp.generated.resources.party_chat_not_sent
import nuvio.composeapp.generated.resources.party_chat_placeholder
import nuvio.composeapp.generated.resources.party_chat_send
import nuvio.composeapp.generated.resources.party_catch_up
import nuvio.composeapp.generated.resources.party_code_label
import nuvio.composeapp.generated.resources.party_copy_invite
import nuvio.composeapp.generated.resources.party_end
import nuvio.composeapp.generated.resources.party_end_message
import nuvio.composeapp.generated.resources.party_end_title
import nuvio.composeapp.generated.resources.party_experimental
import nuvio.composeapp.generated.resources.party_host
import nuvio.composeapp.generated.resources.party_host_only_description
import nuvio.composeapp.generated.resources.party_host_only_note
import nuvio.composeapp.generated.resources.party_host_only_title
import nuvio.composeapp.generated.resources.party_invite_copied
import nuvio.composeapp.generated.resources.party_invite_message
import nuvio.composeapp.generated.resources.party_leave
import nuvio.composeapp.generated.resources.party_now_watching
import nuvio.composeapp.generated.resources.party_open_seat
import nuvio.composeapp.generated.resources.party_reconnecting
import nuvio.composeapp.generated.resources.party_remove_message
import nuvio.composeapp.generated.resources.party_remove_title
import nuvio.composeapp.generated.resources.party_seats
import nuvio.composeapp.generated.resources.party_share_description
import nuvio.composeapp.generated.resources.party_share_title
import nuvio.composeapp.generated.resources.party_share_unavailable
import nuvio.composeapp.generated.resources.party_sign_in_required
import nuvio.composeapp.generated.resources.party_start_action
import nuvio.composeapp.generated.resources.party_start_description
import nuvio.composeapp.generated.resources.party_start_title
import nuvio.composeapp.generated.resources.party_switch
import nuvio.composeapp.generated.resources.party_switch_confirm
import nuvio.composeapp.generated.resources.party_switch_message
import nuvio.composeapp.generated.resources.party_switch_title
import nuvio.composeapp.generated.resources.party_tab_chat
import nuvio.composeapp.generated.resources.party_tab_party
import nuvio.composeapp.generated.resources.party_title
import nuvio.composeapp.generated.resources.party_unavailable
import nuvio.composeapp.generated.resources.party_watch_with_party
import nuvio.composeapp.generated.resources.party_you
import org.jetbrains.compose.resources.stringResource
import kotlinx.coroutines.launch
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi

@Composable
internal fun PlayerScreenRuntime.rememberPartyControlsState(): PlayerControlPartyState {
    val partyState by PartyRepository.state.collectAsStateWithLifecycle()
    val playback by PartyRepository.playback.collectAsStateWithLifecycle()
    val available by PartyRepository.available.collectAsStateWithLifecycle()
    val hlsSuggestion by PartyRepository.hlsSuggestion.collectAsStateWithLifecycle()
    val countdown by PartyRepository.countdown.collectAsStateWithLifecycle()
    val notice = rememberPartyNotice()
    val avatar = rememberProfileAvatar()
    val clipboard = LocalClipboardManager.current
    val party = partyState.party
    val invite = party?.let {
        stringResource(Res.string.party_invite_message, formatPartyCode(it.code), partyInviteLink(it.code))
    }
    val copiedLabel = stringResource(Res.string.party_invite_copied)
    SideEffect {
        copyBrowserInvite = { url ->
            clipboard.setText(AnnotatedString(url))
            showPartyMessage("Browser link copied")
        }
        copyNuvioInvite = {
            party?.let {
                clipboard.setText(AnnotatedString(partyInviteLink(it.code)))
                showPartyMessage("Nuvio link copied")
            }
        }
        copyPartyInvite = {
            if (invite != null) {
                clipboard.setText(AnnotatedString(invite))
                showPartyMessage(copiedLabel)
            }
        }
    }
    val chatMessages by PartyChat.messages.collectAsStateWithLifecycle()
    val unread by PartyChat.unread.collectAsStateWithLifecycle()
    val chatVisible = partyChatVisible && party != null
    DisposableEffect(chatVisible) {
        PartyChat.setOpen(chatVisible)
        onDispose { PartyChat.setOpen(false) }
    }
    val canStart = PartyRepository.canUse
    val base = PlayerControlPartyState(
        available = available,
        panelToken = partyPanelToken,
        busy = partyState.busy,
        canStart = canStart,
        startNote = when {
            !available -> stringResource(Res.string.party_unavailable)
            !canStart -> stringResource(Res.string.party_sign_in_required)
            else -> ""
        },
        profile = PlayerControlPartyMember(
            name = avatar.name,
            initial = avatar.name.initial(),
            imageUrl = avatar.imageUrl.orEmpty(),
            color = avatar.color.orEmpty(),
        ),
        message = partyMessage,
        messageToken = partyMessageToken,
        labels = partyControlLabels(),
        chat = PlayerControlChatState(unread = unread),
    )
    if (party == null) return base

    val playerMedia = currentPartyMedia()
    val elsewhere = playerMedia.key != party.media.key
    val selfBehindMs = if (partyBehind) partyBehindMs ?: 0L else null
    val storage = "${ServerConfigurationRepository.active.value.backendUrl}/storage/v1/object/"
    val you = stringResource(Res.string.party_you)
    val nowMs = PartyRepository.nowMs()
    val members = party.members.mapIndexed { index, member ->
        val isSelf = member.id == party.memberId
        val label = com.nuvio.app.features.party.partyMemberLabel(member.displayName, index)
        val behindMs = if (isSelf) selfBehindMs else party.behindMs(member)
        // Estimated distance to the party time (display only). Own row uses
        // the live player position instead of the last report.
        val reported = if (isSelf) {
            PartyPresence(memberId = member.id, status = party.presence[member.id]?.status ?: PartyMemberStatus.Ready,
                mediaKey = partyKey, positionMs = currentPlaybackPositionMs(), positionAt = nowMs, playing = playbackSnapshot.isPlaying)
                .takeIf { !elsewhere }
        } else party.presence[member.id]
        val syncInfo = PartySync.memberSync(reported, playback, party.media.key, nowMs)
        val syncLabel = PartySync.memberSyncLabel(syncInfo).replace(" (", " · ").removeSuffix(")")
        val offline = party.presenceState(member) == com.nuvio.app.features.party.PartyPresenceState.Offline
        PlayerControlPartyMember(
            id = member.id,
            name = if (isSelf) "$label ($you)" else label,
            initial = label.initial(),
            imageUrl = member.avatarUrl?.takeIf { it.startsWith(storage) }.orEmpty(),
            color = member.avatarColor.orEmpty(),
            isHost = member.id == party.hostMemberId,
            // One short line: "Synchron · +0,1 s", "Puffert", "Allein", "Offline"; else the plain status.
            status = when {
                offline && !isSelf -> "Offline"
                behindMs != null && syncInfo.state != com.nuvio.app.features.party.MemberSync.Solo ->
                    stringResource(Res.string.party_behind, formatPlaybackTime(behindMs))
                syncLabel.isNotEmpty() -> syncLabel
                else -> stringResource(party.statusRes(member))
            },
            syncState = when {
                offline && !isSelf -> "offline"
                else -> when (syncInfo.state) {
                    com.nuvio.app.features.party.MemberSync.Synced -> "synced"
                    com.nuvio.app.features.party.MemberSync.CatchingUp -> "catching_up"
                    com.nuvio.app.features.party.MemberSync.Buffering -> "buffering"
                    com.nuvio.app.features.party.MemberSync.Unsynced -> "unsynced"
                    com.nuvio.app.features.party.MemberSync.Solo -> "solo"
                    com.nuvio.app.features.party.MemberSync.Stale -> "stale"
                    com.nuvio.app.features.party.MemberSync.Unknown -> ""
                }
            },
            presence = party.presenceState(member).name.lowercase(),
            canRemove = party.isHost && !isSelf,
            removeTitle = stringResource(Res.string.party_remove_title, label),
        )
    }
    val chat = if (chatVisible) {
        PlayerControlChatState(
            unread = unread,
            ready = true,
            messages = partyChatRows(chatMessages).map { row ->
                val message = row.message
                val member = party.member(message.memberId)
                    ?: PartyMember(
                        id = message.memberId,
                        displayName = message.name,
                        avatarUrl = message.avatarUrl,
                        avatarColor = message.avatarColor,
                    )
                PlayerControlChatMessage(
                    key = message.key,
                    memberId = message.memberId,
                    name = member.displayName,
                    initial = member.displayName.initial(),
                    imageUrl = member.avatarUrl?.takeIf { it.startsWith(storage) }.orEmpty(),
                    color = member.avatarColor.orEmpty(),
                    body = message.body,
                    time = if (row.showTime) formatLocalTime(message.sentAt) else "",
                    mine = message.mine,
                    sent = message.status == PartyChatStatus.Sent,
                    failed = message.status == PartyChatStatus.Failed,
                    startsGroup = row.startsGroup,
                    endsGroup = row.endsGroup,
                    showTime = row.showTime,
                )
            },
        )
    } else {
        PlayerControlChatState(unread = unread)
    }
    val canSwitch = elsewhere && party.isHost
    val pendingSuggestion = hlsSuggestion?.takeIf { party.isHost && !elsewhere && it.mediaKey == party.media.key }
    return base.copy(
        active = true,
        synced = !elsewhere,
        solo = partySolo,
        code = party.code,
        connected = party.connected,
        isHost = party.isHost,
        hostOnly = party.hostOnly,
        sharing = party.sharing,
        browserSharing = party.browserSharing,
        shareNote = if (party.isHost && party.sharing && !elsewhere && currentPartyStream() == null) {
            stringResource(Res.string.party_share_unavailable)
        } else "",
        hlsAvailable = party.isHost && !elsewhere && effectiveTorboxFile != null && activeHostPartyHls == null,
        hlsBusy = torboxPartyPhase == com.nuvio.app.features.debrid.TorboxHlsPhase.Preparing,
        browserOrigin = com.nuvio.app.features.party.watchPartyBrowserOrigin,
        streamTitle = if (party.isHost && !elsewhere) party.media.displayTitle() else "",
        streamSource = when {
            !party.isHost || elsewhere -> ""
            activeHostPartyHls != null -> if (activeHostPartyHls?.familyOnly == true) "Eigener TorBox-Link" else "Eigener Link"
            activeStream?.torboxPartyFile != null -> "TorBox-Cloud"
            torboxManualFor == partyKey -> if (torboxLinkAuto) "TorBox automatisch verknüpft" else "TorBox verknüpft"
            activeStream != null -> "Keine Cloud-Datei verknüpft"
            else -> ""
        },
        countdownActive = countdown?.mediaKey == party.media.key,
        countdownAvailable = party.isHost && !elsewhere && party.members.size > 1 && countdown == null && playback?.paused != false,
        countdownSeconds = partyCountdownSeconds,
        countdownReadiness = if (party.isHost && !elsewhere) countdownReadiness(party, nowMs, playback) else "",
        smartStatus = members.firstOrNull { it.id == party.memberId }?.status.orEmpty(),
        smartNudgeActive = partyRateNudge != null,
        smartNudgeEnabled = partySmartNudge,
        smartSeeks = partyStatSeeks,
        smartNudges = partyStatNudges,
        smartBuffering = partyStatBuffering,
        smartSeekLeadMs = partyStatSeekLeadMs,
        smartLastCorrection = partyStatLastCorrectionAt?.let { at ->
            "$partyStatLastCorrection vor ${((nowMs - at).coerceAtLeast(0L) / 1000L)} s"
        }.orEmpty(),
        canSyncMe = !party.isHost && !elsewhere,
        canSyncAll = party.isHost && !elsewhere && party.members.size > 1,
        syncAllStatus = partySyncAllAt?.takeIf { party.isHost && nowMs - it < SYNC_ALL_STATUS_MS }
            ?.let { requestedAt -> syncAllSummary(party, playback, nowMs, nowMs - requestedAt) }.orEmpty(),
        hlsPhase = when {
            !party.isHost || elsewhere -> ""
            activeHostPartyHls != null -> if (activeHostPartyHls?.familyOnly == true) "family-link" else "link"
            effectiveTorboxFile != null -> when (torboxPartyPhase) {
                com.nuvio.app.features.debrid.TorboxHlsPhase.Ready -> if (party.browserSharing) "sent" else "ready"
                com.nuvio.app.features.debrid.TorboxHlsPhase.Preparing -> "preparing"
                com.nuvio.app.features.debrid.TorboxHlsPhase.Processing -> "processing"
                com.nuvio.app.features.debrid.TorboxHlsPhase.Expired -> "renewing"
                com.nuvio.app.features.debrid.TorboxHlsPhase.Unavailable -> "idle"
                else -> "error"
            }
            activeStream != null -> "unavailable"
            else -> ""
        },
        partyMediaTitle = if (elsewhere) party.media.displayTitle() else "",
        playerMediaTitle = if (elsewhere) playerMedia.displayTitle() else "",
        torboxLinkAuto = torboxManualFor == partyKey && torboxLinkAuto,
        torboxSuggestedFilter = if (party.isHost) playerMedia.title.take(60) else "",
        hlsStatus = when {
            !party.isHost || elsewhere -> ""
            activeHostPartyHls != null -> "Der geteilte Video-Link ersetzt TorBox-HLS, solange er aktiv ist."
            effectiveTorboxFile != null -> torboxPartyStatus.takeIf {
                it.isNotBlank() && (torboxFamilyOnly || torboxPartyPhase != com.nuvio.app.features.debrid.TorboxHlsPhase.Ready)
            } ?: com.nuvio.app.features.debrid.torboxHlsStatusLabel(torboxPartyPhase, party.browserSharing)
            // A provider name such as "[TB+] …" is no TorBox file identity.
            party.browserSharing && activeStream != null -> if (activeTorrentInfoHash.isNullOrBlank())
                "Nicht verfügbar: Addon-Stream ohne Infohash und ohne TorBox-Dateikennung. „Mit TorBox-Datei verknüpfen“ wählen oder einen Video-Link für Browser teilen."
            else
                "Nicht verfügbar: Kein eindeutiger passender Eintrag in deiner TorBox-Cloud (Infohash und Dateiname). „Mit TorBox-Datei verknüpfen“ wählen oder die Quelle über die TorBox-Cloud starten."
            else -> ""
        },
        hostHlsAllowed = party.isHost && !elsewhere && activeStream != null,
        hostHlsActive = party.isHost && activeHostPartyHls != null,
        hostHlsLabel = activeHostPartyHls?.label.orEmpty(),
        hostHlsBusy = hostPartyHlsBusy,
        hostHlsStatus = if (party.isHost) hostPartyHlsStatus else "",
        hlsSuggestionFrom = pendingSuggestion?.let { it.name.trim().takeIf { name -> name.isNotEmpty() && "://" !in name }?.take(40) ?: "Gast" }.orEmpty(),
        hlsSuggestionHost = pendingSuggestion?.let { com.nuvio.app.features.party.partyHlsDisplayHost(it.url) }.orEmpty(),
        hlsSuggestionId = pendingSuggestion?.id,
        // Manual linking only when no unique cloud file was found automatically
        // (or to change an existing manual link).
        torboxLinkAvailable = party.isHost && !elsewhere && activeStream != null && activeStream?.torboxPartyFile == null &&
            com.nuvio.app.features.debrid.DebridSettingsRepository.snapshot().apiKeyFor(com.nuvio.app.features.debrid.DebridProviders.TORBOX_ID).isNotBlank(),
        familyAvailable = party.isHost && !elsewhere && com.nuvio.app.features.party.PartyFamilyShare.configured,
        familyStatus = if (party.isHost) familyShareStatus else "",
        torboxLinkedName = if (torboxManualFor == partyKey) torboxManualName else "",
        torboxChoicesOpen = party.isHost && torboxChoicesFor == partyKey && (torboxChoices != null || torboxChoicesBusy),
        torboxChoicesBusy = torboxChoicesBusy,
        torboxChoicesStatus = if (party.isHost) torboxChoicesStatus else "",
        torboxChoices = if (party.isHost && torboxChoicesFor == partyKey) torboxChoices.orEmpty().map {
            PlayerControlTorboxChoice(id = "${it.torrentId}:${it.fileId}", name = it.name, size = it.size?.let(::formatTorboxSize).orEmpty())
        } else emptyList(),
        canEnd = party.isHost && party.members.size > 1,
        seatsLabel = stringResource(Res.string.party_seats, party.members.size, party.maxMembers),
        maxMembers = party.maxMembers,
        members = members,
        behindTitle = selfBehindMs?.let { stringResource(Res.string.party_behind_title, formatPlaybackTime(it)) }.orEmpty(),
        nowWatching = if (elsewhere) stringResource(Res.string.party_now_watching, party.media.displayTitle()) else "",
        switchLabel = if (canSwitch) stringResource(Res.string.party_switch, playerMedia.displayTitle()) else "",
        switchMessage = if (canSwitch) stringResource(Res.string.party_switch_message, playerMedia.displayTitle()) else "",
        pillMessage = if (pendingSuggestion != null) "Neuer Video-Vorschlag" else partyPillMessage(party, playback, notice).orEmpty(),
        pillPinned = pendingSuggestion != null || partyPillPinned(party, playback, notice),
        chat = chat,
    )
}

@OptIn(ExperimentalEncodingApi::class)
internal fun PlayerScreenRuntime.handlePartyControlsEvent(type: String, value: Double): Boolean {
    // NUVIO_BROWSER_PARTY_BRIDGE_V1: accept only this party's HTTPS browser invite.
    if (type.startsWith(BROWSER_INVITE_EVENT)) {
        val party = PartyRepository.state.value.party
        val url = runCatching {
            Base64.UrlSafe.withPadding(Base64.PaddingOption.ABSENT_OPTIONAL)
                .decode(type.removePrefix(BROWSER_INVITE_EVENT))
                .decodeToString()
        }.getOrNull()
        if (party?.isHost == true && url != null &&
            url.length <= 2048 &&
            Regex("^https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?/party/${Regex.escape(party.code)}$").matches(url)) {
            // Invite events are copy-only, including events from older overlays.
            // Copying an invite does not change either sharing choice.
            copyBrowserInvite(url)
        } else {
            showPartyMessage("Invalid browser invite")
        }
        return true
    }
    if (type.startsWith(SUGGEST_LINK_EVENT)) {
        // Member proposal of a direct HLS/MP4/WebM link; only the host decides.
        val url = runCatching {
            Base64.UrlSafe.withPadding(Base64.PaddingOption.ABSENT_OPTIONAL)
                .decode(type.removePrefix(SUGGEST_LINK_EVENT))
                .decodeToString()
                .trim()
        }.getOrNull()
        val party = PartyRepository.state.value.party
        if (url != null && party != null && !party.isHost) {
            val keys = com.nuvio.app.features.debrid.DebridSettingsRepository.snapshot().providerApiKeys.values.filter { it.isNotBlank() }
            val path = runCatching { io.ktor.http.Url(url).encodedPath.lowercase() }.getOrDefault("")
            val problem = com.nuvio.app.features.party.partyHostHlsProblem(url, keys)
                ?: if (listOf(".m3u8", ".mp4", ".webm").none { path.endsWith(it) }) "Nur direkte HLS-, MP4- oder WebM-Links." else null
            if (problem != null) showPartyMessage(problem)
            else { PartyRepository.suggestLink(url); showPartyMessage("Vorschlag gesendet. Der Host entscheidet.") }
        }
        return true
    }
    if (type.startsWith(HOST_HLS_EVENT)) {
        val url = runCatching {
            Base64.UrlSafe.withPadding(Base64.PaddingOption.ABSENT_OPTIONAL)
                .decode(type.removePrefix(HOST_HLS_EVENT))
                .decodeToString()
        }.getOrNull()
        // The overlay sends this only after the explicit consent checkbox.
        if (url != null) shareHostPartyHls(url, "Video-Link des Hosts")
        return true
    }
    if (type.startsWith(TORBOX_PICK_EVENT)) {
        val ids = type.removePrefix(TORBOX_PICK_EVENT).split(':').mapNotNull { it.toIntOrNull() }
        if (ids.size == 2) linkTorboxCloudFile(ids[0], ids[1])
        return true
    }
    if (type.startsWith(CHAT_SEND_EVENT)) {
        val text = runCatching {
            Base64.UrlSafe.withPadding(Base64.PaddingOption.ABSENT_OPTIONAL)
                .decode(type.removePrefix(CHAT_SEND_EVENT))
                .decodeToString()
        }.getOrNull()
        if (text != null) PartyChat.send(text)
        return true
    }
    if (type.startsWith(CHAT_RETRY_EVENT)) {
        PartyChat.retry(type.removePrefix(CHAT_RETRY_EVENT))
        return true
    }
    if (type.startsWith(REMOVE_MEMBER_EVENT)) {
        val memberId = type.removePrefix(REMOVE_MEMBER_EVENT)
        val party = PartyRepository.state.value.party
        if (party != null && party.isHost && memberId != party.memberId && party.members.any { it.id == memberId }) {
            PartyRepository.removeMember(memberId)
        }
        return true
    }
    when (type) {
        "partyStart" -> startParty()
        "partyCopyInvite" -> copyPartyInvite()
        "partyCopyNuvioLink" -> copyNuvioInvite()
        "partyHostOnly" -> PartyRepository.setHostOnly(value >= 0.5)
        "partySharing" -> PartyRepository.setSharing(value >= 0.5)
        "partyBrowserSharing" -> {
            val enabled = value >= 0.5
            if (!enabled && hostPartyHlsBusy) {
                hostPartyHlsJob?.cancel()
                hostPartyHlsJob = null
                hostPartyHlsBusy = false
                hostPartyHlsStatus = "Linkprüfung abgebrochen. Browser-HLS-Freigabe ist aus."
            }
            PartyRepository.setBrowserSharing(enabled)
        }
        // Restarts the single HLS producer; ignored while one is preparing.
        // Never changes the sharing consent.
        "partyHlsRefresh" -> {
            val party = PartyRepository.state.value.party
            if (party?.isHost == true && effectiveTorboxFile != null &&
                torboxPartyPhase != com.nuvio.app.features.debrid.TorboxHlsPhase.Preparing) torboxPartyRefresh += 1
        }
        "partyHostHlsClear" -> {
            if (PartyRepository.state.value.party?.isHost == true && hostPartyHls != null) {
                hostPartyHls = null
                hostPartyHlsStatus = "Link-Freigabe beendet."
            }
        }
        "partyHlsSuggestionAccept" -> {
            val suggestion = PartyRepository.hlsSuggestion.value
            val party = PartyRepository.state.value.party
            if (party?.isHost == true && suggestion != null && value == suggestion.id.toDouble() &&
                suggestion.mediaKey == party.media.key && party.media.key == partyKey && !hostPartyHlsBusy &&
                PartyRepository.dismissHlsSuggestion(suggestion)) {
                shareHostPartyHls(suggestion.url, "Video-Link des Hosts")
            }
        }
        "partyHlsSuggestionReject" -> {
            val suggestion = PartyRepository.hlsSuggestion.value
            if (PartyRepository.state.value.party?.isHost == true &&
                suggestion != null && suggestion.id.toDouble() == value) PartyRepository.dismissHlsSuggestion(suggestion)
        }
        "partyTorboxList" -> loadTorboxCloudChoices()
        "partyTorboxClose" -> { torboxChoices = null; torboxChoicesFor = null; torboxChoicesStatus = "" }
        "partyTorboxUnlink" -> {
            torboxManualFile = null; torboxManualFor = null; torboxManualName = ""; torboxLinkAuto = false
            torboxChoicesStatus = ""
        }
        "partyWatch" -> watchWithParty()
        "partySwitch" -> switchPartyMedia()
        "partySolo" -> {
            if (PartyRepository.state.value.party?.isHost == false) {
                if (partySolo) syncMeWithParty() else {
                    partySolo = true
                    partyBehind = true
                }
            }
        }
        "partyCatchUp" -> catchUpWithParty()
        "partySyncMe" -> if (PartyRepository.state.value.party?.isHost == false) syncMeWithParty()
        "partySyncAll" -> syncEveryone()
        "partyCountdownSeconds" -> partyCountdownSeconds = value.toInt().coerceIn(
            com.nuvio.app.features.party.PARTY_COUNTDOWN_MIN_S, com.nuvio.app.features.party.PARTY_COUNTDOWN_MAX_S)
        "partyCountdownStart" -> {
            val party = PartyRepository.state.value.party
            if (party?.isHost == true && party.media.key == partyKey) PartyRepository.startCountdown(partyCountdownSeconds)
        }
        "partyCountdownCancel" -> if (PartyRepository.state.value.party?.isHost == true) PartyRepository.cancelCountdown()
        "partySmartNudge" -> partySmartNudge = value >= 0.5
        "partyLeave" -> leaveParty()
        "partyEnd" -> endParty()
        "partyChatVisible" -> partyChatVisible = value >= 0.5
        else -> return false
    }
    return true
}

@Composable
private fun partyControlLabels(): Map<String, String> = mapOf(
    "title" to stringResource(Res.string.party_title),
    "close" to stringResource(Res.string.action_close),
    "cancel" to stringResource(Res.string.action_cancel),
    "startTitle" to stringResource(Res.string.party_start_title),
    "startDescription" to stringResource(Res.string.party_start_description),
    "startAction" to stringResource(Res.string.party_start_action),
    "experimental" to stringResource(Res.string.party_experimental),
    "codeLabel" to stringResource(Res.string.party_code_label),
    "copyInvite" to stringResource(Res.string.party_copy_invite),
    "reconnecting" to stringResource(Res.string.party_reconnecting),
    "host" to stringResource(Res.string.party_host),
    "openSeat" to stringResource(Res.string.party_open_seat),
    "remove" to stringResource(Res.string.action_remove),
    "removeMessage" to stringResource(Res.string.party_remove_message),
    "hostOnlyTitle" to stringResource(Res.string.party_host_only_title),
    "hostOnlyDescription" to stringResource(Res.string.party_host_only_description),
    "hostOnlyNote" to stringResource(Res.string.party_host_only_note),
    "shareTitle" to stringResource(Res.string.party_share_title),
    "shareDescription" to stringResource(Res.string.party_share_description),
    "watchWithParty" to stringResource(Res.string.party_watch_with_party),
    "switchTitle" to stringResource(Res.string.party_switch_title),
    "switchConfirm" to stringResource(Res.string.party_switch_confirm),
    "catchUp" to stringResource(Res.string.party_catch_up),
    "leave" to stringResource(Res.string.party_leave),
    "end" to stringResource(Res.string.party_end),
    "endTitle" to stringResource(Res.string.party_end_title),
    "endMessage" to stringResource(Res.string.party_end_message),
    "tabParty" to stringResource(Res.string.party_tab_party),
    "tabChat" to stringResource(Res.string.party_tab_chat),
    "chatEmptyTitle" to stringResource(Res.string.party_chat_empty_title),
    "chatEmptyMessage" to stringResource(Res.string.party_chat_empty_message),
    "chatPlaceholder" to stringResource(Res.string.party_chat_placeholder),
    "chatSend" to stringResource(Res.string.party_chat_send),
    "chatNotSent" to stringResource(Res.string.party_chat_not_sent),
    "chatNewMessages" to stringResource(Res.string.party_chat_new_messages),
)

private fun String.initial(): String = trim().take(1).uppercase()

private const val BROWSER_INVITE_EVENT = "partyBrowserInvite:"
private const val REMOVE_MEMBER_EVENT = "partyRemoveMember:"
private const val CHAT_SEND_EVENT = "partyChatSend:"
private const val HOST_HLS_EVENT = "partyHostHls:"
private const val SUGGEST_LINK_EVENT = "partySuggestLink:"
private const val SYNC_ALL_STATUS_MS = 60_000L

/**
 * Readiness before a shared start, from the members' own reports: members on
 * this title that are not loading/buffering count as ready; offline members
 * and members watching alone do not block.
 */
private fun countdownReadiness(
    party: com.nuvio.app.features.party.ActiveParty,
    nowMs: Long,
    playback: com.nuvio.app.features.party.PartyPlayback?,
): String {
    val joined = party.members.filter { it.id != party.memberId }
        .filter { party.presenceState(it) != com.nuvio.app.features.party.PartyPresenceState.Offline }
        .filter { PartySync.memberSync(party.presence[it.id], playback, party.media.key, nowMs).state != com.nuvio.app.features.party.MemberSync.Solo }
    val waiting = joined.filter { member ->
        val presence = party.presence[member.id]
        presence == null || presence.mediaKey != party.media.key ||
            presence.status in setOf(PartyMemberStatus.Loading, PartyMemberStatus.Buffering, PartyMemberStatus.Browsing)
    }
    return when {
        joined.isEmpty() -> ""
        waiting.isEmpty() -> "Alle bereit"
        else -> "Wartet auf: ${waiting.joinToString { it.displayName.take(20) }}"
    }
}
private const val SYNC_ALL_SETTLE_MS = 2_500L

/**
 * Host feedback for "Alle synchronisieren", from the members' own reports
 * (never assumed): offline and "Allein" members are listed separately and do
 * not block; a member counts as synced only with a fresh in-sync report.
 */
private fun syncAllSummary(
    party: com.nuvio.app.features.party.ActiveParty,
    playback: com.nuvio.app.features.party.PartyPlayback?,
    nowMs: Long,
    elapsedMs: Long,
): String {
    val others = party.members.filter { it.id != party.memberId }
    val offline = others.filter { party.presenceState(it) == com.nuvio.app.features.party.PartyPresenceState.Offline }
    val online = others - offline.toSet()
    val states = online.associateWith { PartySync.memberSync(party.presence[it.id], playback, party.media.key, nowMs).state }
    val solo = online.filter { states[it] == com.nuvio.app.features.party.MemberSync.Solo }
    val joined = online - solo.toSet()
    val synced = joined.filter { states[it] == com.nuvio.app.features.party.MemberSync.Synced }
    val pending = joined - synced.toSet()
    val extras = listOfNotNull(
        solo.size.takeIf { it > 0 }?.let { "$it allein" },
        offline.size.takeIf { it > 0 }?.let { "$it offline" },
    ).joinToString(" · ").let { if (it.isEmpty()) "" else " · $it" }
    return when {
        joined.isEmpty() -> "Niemand schaut gerade gemeinsam$extras"
        pending.isEmpty() -> "Alle synchron (${synced.size})$extras"
        elapsedMs < SYNC_ALL_SETTLE_MS -> "Synchronisiere …"
        else -> "${synced.size}/${joined.size} synchron · ausstehend: ${pending.joinToString { it.displayName.take(20) }}$extras"
    }
}
private const val TORBOX_PICK_EVENT = "partyTorboxPick:"

private fun formatTorboxSize(bytes: Long): String = when {
    bytes >= 1L shl 30 -> "${(bytes * 10 / (1L shl 30)) / 10.0} GB"
    bytes >= 1L shl 20 -> "${bytes / (1L shl 20)} MB"
    else -> ""
}

/**
 * Checks the link on the desktop (public HTTPS, finished VOD playlist, no
 * debrid key, except for explicitly shared TorBox URLs) and only then turns on Browser-HLS because
 * the host has just consented to sharing this link. The URL is never logged.
 */
private fun PlayerScreenRuntime.shareHostPartyHls(url: String, label: String) {
    val party = PartyRepository.state.value.party ?: return
    if (!party.isHost || party.media.key != partyKey || hostPartyHlsBusy) return
    val mediaKey = partyKey
    hostPartyHlsBusy = true
    hostPartyHlsStatus = "Video-Link wird geprüft …"
    hostPartyHlsJob = scope.launch {
        val settings = com.nuvio.app.features.debrid.DebridSettingsRepository.snapshot()
        val keys = settings.providerApiKeys.values.filter { it.isNotBlank() }
        val torboxKey = settings.apiKeyFor(com.nuvio.app.features.debrid.DebridProviders.TORBOX_ID)
        // Existing TorBox compatibility: an explicitly consented URL may
        // carry the account key as its token. TorBox rejects it without it.
        val family = torboxKey.isNotBlank() && com.nuvio.app.features.debrid.torboxKeyFreeUrl(url.trim(), torboxKey) != null
        val result = try { com.nuvio.app.features.party.checkPartyHostHls(url, if (family) keys - torboxKey else keys) }
            catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
            catch (_: Exception) { com.nuvio.app.features.party.PartyHostHlsCheck.Problem("Unerwarteter Fehler bei der Prüfung. Link kontrollieren und erneut versuchen.") }
        hostPartyHlsBusy = false
        val current = PartyRepository.state.value.party
        if (current == null || !current.isHost || current.id != party.id || current.memberId != party.memberId ||
            partyKey != mediaKey || current.media.key != mediaKey) {
            hostPartyHlsStatus = "Party oder Titel gewechselt. Der Link wurde nicht geteilt."
            return@launch
        }
        when (result) {
            is com.nuvio.app.features.party.PartyHostHlsCheck.Problem -> hostPartyHlsStatus = "Nicht geteilt: ${result.message}"
            is com.nuvio.app.features.party.PartyHostHlsCheck.Ok -> {
                hostPartyHls = com.nuvio.app.features.party.PartyHostHls(result.url, mediaKey, label, party.id, party.memberId, familyOnly = family)
                PartyRepository.setBrowserSharing(true)
                hostPartyHlsStatus = if (family) "Mit allen Mitgliedern geteilt (TorBox-Link mit Account-Key)."
                    else "Geteilt mit allen Mitgliedern."
            }
        }
    }
}

private fun PlayerScreenRuntime.loadTorboxCloudChoices() {
    val party = PartyRepository.state.value.party ?: return
    if (!party.isHost || torboxChoicesBusy) return
    val key = com.nuvio.app.features.debrid.DebridSettingsRepository.snapshot().apiKeyFor(com.nuvio.app.features.debrid.DebridProviders.TORBOX_ID)
    if (key.isBlank()) { torboxChoicesStatus = "Kein TorBox-Account-Key gespeichert."; return }
    val mediaKey = partyKey
    torboxChoicesFor = mediaKey
    torboxChoicesBusy = true
    torboxChoicesStatus = "TorBox-Cloud wird geladen …"
    scope.launch {
        val choices = try { com.nuvio.app.features.debrid.listTorboxCloudChoices(key) }
            catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
            catch (_: Exception) { null }
        torboxChoicesBusy = false
        if (torboxChoicesFor != mediaKey) return@launch
        torboxChoices = choices
        torboxChoicesStatus = when {
            choices == null -> "TorBox-Cloud konnte nicht geladen werden. Netzwerk und Account prüfen."
            choices.isEmpty() -> "Keine Videodateien in deiner TorBox-Cloud gefunden."
            choices.size >= com.nuvio.app.features.debrid.TORBOX_CHOICES_LIMIT -> "Die ersten ${choices.size} Videodateien (alphabetisch). Exakte Datei für genau diesen Titel wählen."
            else -> "Exakte Datei für genau diesen Titel wählen."
        }
    }
}

/** Accepts only an ID pair from the list just loaded; nothing is guessed. */
private fun PlayerScreenRuntime.linkTorboxCloudFile(torrentId: Int, fileId: Int) {
    val party = PartyRepository.state.value.party ?: return
    if (!party.isHost || torboxChoicesFor != partyKey) return
    val choice = torboxChoices?.firstOrNull { it.torrentId == torrentId && it.fileId == fileId } ?: return
    val key = com.nuvio.app.features.debrid.DebridSettingsRepository.snapshot().apiKeyFor(com.nuvio.app.features.debrid.DebridProviders.TORBOX_ID)
    if (key.isBlank()) return
    torboxManualFile = com.nuvio.app.features.debrid.TorboxPartyFile(torrentId, fileId, com.nuvio.app.features.debrid.torboxAccountFingerprint(key))
    torboxManualFor = partyKey
    torboxManualName = choice.name
    torboxLinkAuto = false
    torboxChoices = null; torboxChoicesFor = null
    torboxChoicesStatus = "" // The linked name is shown once in its own row.
}
private const val CHAT_RETRY_EVENT = "partyChatRetry:"
