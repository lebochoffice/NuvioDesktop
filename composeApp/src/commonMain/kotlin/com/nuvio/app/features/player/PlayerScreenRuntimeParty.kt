package com.nuvio.app.features.player

import androidx.compose.animation.AnimatedVisibility
import com.nuvio.app.features.party.OwnSeek
import com.nuvio.app.features.party.containsAccountKey
import com.nuvio.app.features.party.PartyMember
import com.nuvio.app.features.party.AvatarStack
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.animation.togetherWith
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.core.tween
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeContent
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.graphics.Shadow
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import co.touchlab.kermit.Logger
import com.nuvio.app.features.party.ActiveParty
import com.nuvio.app.features.party.PartyAction
import com.nuvio.app.core.sync.AppForegroundMonitor
import com.nuvio.app.core.sync.AppVisibility
import com.nuvio.app.core.ui.NuvioToastController
import com.nuvio.app.features.party.PartyChat
import com.nuvio.app.features.party.PartyCorrection
import com.nuvio.app.features.party.PartyEvent
import com.nuvio.app.features.party.PartyMedia
import com.nuvio.app.features.party.PartyMemberStatus
import com.nuvio.app.features.party.PartyNotice
import com.nuvio.app.features.party.PartyPanel
import com.nuvio.app.features.party.PartyPlayback
import com.nuvio.app.features.party.PartyRepository
import com.nuvio.app.features.party.PartySource
import com.nuvio.app.features.party.PartyBrowserHls
import com.nuvio.app.features.party.PartyStream
import com.nuvio.app.features.party.isShareableStreamUrl
import com.nuvio.app.features.party.PartySync
import com.nuvio.app.features.party.PendingApply
import com.nuvio.app.features.party.message
import com.nuvio.app.features.party.UnreadBadge
import com.nuvio.app.features.party.messageRes
import com.nuvio.app.features.party.partyMediaKey
import com.nuvio.app.isDesktop
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import nuvio.composeapp.generated.resources.Res
import nuvio.composeapp.generated.resources.party_action_paused
import nuvio.composeapp.generated.resources.party_action_resumed
import nuvio.composeapp.generated.resources.party_action_seeked
import nuvio.composeapp.generated.resources.party_action_speed
import nuvio.composeapp.generated.resources.party_behind
import nuvio.composeapp.generated.resources.party_caught_up
import nuvio.composeapp.generated.resources.party_host_only_note
import nuvio.composeapp.generated.resources.party_paused_for_you
import nuvio.composeapp.generated.resources.party_reconnecting
import nuvio.composeapp.generated.resources.party_waiting
import nuvio.composeapp.generated.resources.party_waiting_for
import org.jetbrains.compose.resources.getString
import org.jetbrains.compose.resources.stringResource
import kotlin.math.abs
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.TimeMark
import kotlin.time.TimeSource

internal val PlayerScreenRuntime.partyKey: String
    get() = partyMediaKey(parentMetaType, parentMetaId, activeSeasonNumber, activeEpisodeNumber)

internal val PlayerScreenRuntime.isPartySynced: Boolean
    get() = PartyRepository.state.value.party?.media?.key == partyKey

internal val PlayerScreenRuntime.isPartyControlLocked: Boolean
    get() = PartyRepository.state.value.party?.blocksManualPlayback(partyKey, partySolo) == true

internal fun PlayerScreenRuntime.partyBlocksControl(): Boolean {
    if (!isPartyControlLocked) return false
    if (partyLockedNoticeAt?.elapsedNow()?.inWholeMilliseconds?.let { it < 3000 } != true) {
        partyLockedNoticeAt = kotlin.time.TimeSource.Monotonic.markNow()
        showPartyMessage("Der Host steuert die Wiedergabe. Wenn du selbst pausieren oder spulen möchtest, öffne das Party-Menü und wähle „Allein schauen“.")
    }
    return true
}

internal fun PlayerScreenRuntime.showPartyMessage(message: String) {
    if (isDesktop) {
        partyMessage = message
        partyMessageToken += 1L
    } else {
        showGestureMessage(message)
    }
}

internal fun PlayerScreenRuntime.openPartyPanel() {
    if (PartyChat.unread.value > 0) showPartyChat = true
    showPartyPanel = true
    if (!isDesktop) controlsVisible = false
    partyPanelToken += 1L
}

internal fun PlayerScreenRuntime.switchPartyMedia() {
    PartyRepository.publishMedia(currentPartyMedia(), positionMs = playbackSnapshot.positionMs)
}

internal fun PlayerScreenRuntime.watchWithParty() {
    val media = PartyRepository.state.value.party?.media ?: return
    showPartyPanel = false
    flushWatchProgress()
    args.onOpenPartyMedia(media)
}

internal fun PlayerScreenRuntime.catchUpWithParty() {
    partySolo = false
    partyBehind = false
    showPartyPanel = false
}

/** "Mich synchronisieren": leave local mode and re-apply the current party state (own player only). */
internal fun PlayerScreenRuntime.syncMeWithParty() {
    partySolo = false
    partyBehind = false
    partyResyncRequest += 1
    showPartyPanel = false
}

/**
 * "Alle synchronisieren" (host): publish the host's current party time as a
 * new revision through the existing publish path, then ask for immediate
 * status reports. Members already in sync stay put (existing tolerances);
 * paused stays paused; members watching alone are not pulled back.
 */
internal fun PlayerScreenRuntime.syncEveryone() {
    val party = PartyRepository.state.value.party ?: return
    if (!party.isHost || party.media.key != partyKey || !isPartySynced) return
    publishPartyPlayback()
    PartyRepository.requestStatusReports()
    partySyncAllAt = PartyRepository.nowMs()
}

internal fun PlayerScreenRuntime.leaveParty() {
    showPartyPanel = false
    PartyRepository.leave()
}

internal fun PlayerScreenRuntime.endParty() {
    showPartyPanel = false
    PartyRepository.end()
}

internal fun PlayerScreenRuntime.toggleOwnPlayback(revealControls: Boolean = true) {
    if (partyBlocksControl()) return
    if (revealControls) controlsVisible = true
    when {
        shouldPlay -> {
            partyBehind = true
            shouldPlay = false
            playerController?.pause()
        }
        partyBehind -> {
            shouldPlay = true
            playerController?.play()
        }
        else -> partyBlocksControl()
    }
}

internal fun PlayerScreenRuntime.ownSeekTarget(targetMs: Long): Long? {
    if (partyBlocksControl()) return null
    val playback = PartyRepository.playback.value ?: return targetMs
    val partyPositionMs = PartySync.expectedPositionMs(playback, PartyRepository.nowMs(), playbackSnapshot.durationMs)
    return when (val seek = PartySync.ownSeek(targetMs, partyPositionMs, partyBehind)) {
        is OwnSeek.Behind -> {
            partyBehind = true
            seek.positionMs
        }
        OwnSeek.CatchUp -> {
            partyBehind = false
            null
        }
        OwnSeek.Blocked -> {
            partyBlocksControl()
            null
        }
    }
}

internal fun PlayerScreenRuntime.currentPartyMedia(): PartyMedia = PartyMedia(
    type = contentType ?: parentMetaType,
    metaId = parentMetaId,
    metaType = parentMetaType,
    videoId = activeVideoId,
    season = activeSeasonNumber,
    episode = activeEpisodeNumber,
    title = title,
    episodeTitle = activeEpisodeTitle,
    description = activePauseDescription?.take(DESCRIPTION_LIMIT),
    poster = poster,
    background = background,
    logo = logo,
    source = PartySource(
        infoHash = activeTorrentInfoHash,
        fileIdx = activeTorrentFileIdx,
        filename = activeSourceFilename ?: activeTorrentFilename,
        bingeGroup = currentStreamBingeGroup,
        addonId = activeProviderAddonId,
        name = activeStreamTitle,
    ),
)

/** TorBox file of the current source: its own identity, a unique cloud match, or the host's manual link. */
internal val PlayerScreenRuntime.effectiveTorboxFile: com.nuvio.app.features.debrid.TorboxPartyFile?
    get() = activeStream?.torboxPartyFile ?: torboxMappedFile?.takeIf { torboxMappedFor == torboxMappingKey() }
        ?: torboxManualFile?.takeIf { torboxManualFor == partyKey }

/** The host's shared video link, valid only for the title it was entered for. */
internal val PlayerScreenRuntime.activeHostPartyHls: com.nuvio.app.features.party.PartyHostHls?
    get() {
        val party = PartyRepository.state.value.party ?: return null
        return hostPartyHls?.takeIf {
            party.isHost && it.partyId == party.id && it.memberId == party.memberId &&
                it.mediaKey == partyKey && party.media.key == partyKey
        }
    }

private fun configuredDebridKeys(): List<String> =
    com.nuvio.app.features.debrid.DebridSettingsRepository.snapshot().providerApiKeys.values.filter { it.isNotBlank() }

/** Identity of the addon stream a cloud match was made for (hash + filename + media). */
internal fun PlayerScreenRuntime.torboxMappingKey(): String? =
    activeTorrentInfoHash?.takeIf { it.isNotBlank() }?.let { hash -> "$partyKey|${hash.lowercase()}|${activeSourceFilename ?: activeStream?.behaviorHints?.filename.orEmpty()}" }

internal fun PlayerScreenRuntime.currentPartyStream(): PartyStream? {
    val stream = activeStream ?: return null
    if (!isShareableStreamUrl(activeSourceUrl) || activeSourceAudioUrl != null) return null
    val offer = PartyStream(
        mediaKey = partyKey,
        url = activeSourceUrl,
        headers = activeSourceHeaders,
        responseHeaders = activeSourceResponseHeaders,
        name = stream.name,
        description = stream.description,
        addonName = stream.addonName,
        addonId = stream.addonId,
        addonLogo = stream.addonLogo,
        filename = activeSourceFilename ?: stream.behaviorHints.filename,
        videoSize = stream.behaviorHints.videoSize,
        bingeGroup = stream.behaviorHints.bingeGroup,
        streamType = activeStreamType,
        badges = stream.badges,
    )
    if (isDesktop) return offer
    val accountKey = com.nuvio.app.features.debrid.DebridSettingsRepository.snapshot()
        .apiKeyFor(com.nuvio.app.features.debrid.DebridProviders.TORBOX_ID)
    return offer.takeUnless { it.containsAccountKey(accountKey) }
}

private fun PlayerScreenRuntime.currentPartyBrowserHls(): PartyBrowserHls {
    // An explicitly shared host link replaces the TorBox HLS as browser source.
    val hostLink = activeHostPartyHls?.takeUnless { link -> link.familyOnly || configuredDebridKeys().any { link.url.contains(it) } }
    val familyHostLink = activeHostPartyHls?.takeIf { it.familyOnly }
    val torboxFile = effectiveTorboxFile.takeIf { hostLink == null && familyHostLink == null }
    val accountKey = com.nuvio.app.features.debrid.DebridSettingsRepository.snapshot()
        .apiKeyFor(com.nuvio.app.features.debrid.DebridProviders.TORBOX_ID)
    if (torboxFile != null && torboxFile.accountFingerprint != com.nuvio.app.features.debrid.torboxAccountFingerprint(accountKey)) {
        return PartyBrowserHls(state = "unsupported")
    }
    val ready = torboxPartyStream?.takeIf { torboxFile != null && it.mediaKey == partyKey && torboxPreparedFile == torboxFile }
    // TorBox link WITH the account token: the host shares it directly with
    // party members through the existing channel after Browser-HLS consent.
    val keyedUrl = familyHostLink?.url ?: ready?.url?.takeIf { hostLink == null && torboxFamilyOnly }
    val browserHls = if (hostLink != null) {
        PartyBrowserHls(url = hostLink.url, label = hostLink.label)
    } else if (keyedUrl != null) {
        PartyBrowserHls(url = keyedUrl, label = "TorBox HLS",
            propagateToken = (familyHostLink == null && torboxPropagateToken).takeIf { it })
    } else if (torboxFile != null) {
        PartyBrowserHls(
            url = ready?.url,
            headers = ready?.headers.orEmpty(),
            state = if (ready != null) null else com.nuvio.app.features.debrid.torboxBrowserState(torboxPartyPhase),
        )
    } else PartyBrowserHls(state = "unsupported")
    return if (keyedUrl == null && PartyStream(partyKey, "", browserHls = browserHls).containsAccountKey(accountKey)) {
        PartyBrowserHls(state = "unsupported")
    } else browserHls
}

internal fun PlayerScreenRuntime.partyBaseRate(): Float =
    PartyRepository.playback.value?.rate ?: playbackSnapshot.playbackSpeed

internal fun PlayerScreenRuntime.currentPlaybackPositionMs(): Long {
    val snapshot = playbackSnapshot
    if (!snapshot.isPlaying || snapshot.isLoading) return snapshot.positionMs
    val elapsedMs = playbackSnapshotMark?.elapsedNow()?.inWholeMilliseconds?.coerceIn(0L, 1_000L) ?: 0L
    return snapshot.positionMs + (elapsedMs * snapshot.playbackSpeed).toLong()
}

internal fun PlayerScreenRuntime.publishPartyPlayback(
    positionMs: Long = currentPlaybackPositionMs(),
    rate: Float = partyBaseRate(),
) {
    if (!isPartySynced || partySolo) return
    PartyRepository.publishPlayback(paused = !shouldPlay, positionMs = positionMs, rate = rate)
}

internal fun PlayerScreenRuntime.startParty() {
    scope.launch {
        val error = PartyRepository.create(currentPartyMedia()) ?: return@launch
        val message = getString(error.messageRes)
        if (isDesktop) showPartyMessage(message) else NuvioToastController.show(message)
    }
}

private fun PlayerScreenRuntime.applyPartyPaused(paused: Boolean, force: Boolean) {
    if (!force && shouldPlay == !paused) return
    shouldPlay = !paused
    if (paused) playerController?.pause() else playerController?.play()
}

private fun PlayerScreenRuntime.handlePartyMediaChange(media: PartyMedia) {
    if (media.key == partyKey) return
    val season = media.season
    val episode = media.episode
    if (media.metaId == parentMetaId && isSeries && season != null && episode != null) {
        val next = nextEpisodeInfo
        if (next != null && next.hasAired && next.season == season && next.episode == episode) {
            playNextEpisode()
            return
        }
        val video = playerMetaVideos.firstOrNull { it.season == season && it.episode == episode }
        if (video != null) {
            episodeStreamsPanelState = EpisodeStreamsPanelState(showStreams = true, selectedEpisode = video)
            showEpisodesPanel = true
            showPartyPanel = false
            return
        }
    }
    showPartyChat = false
    showPartyPanel = true
    partyPanelToken += 1L
}

@Composable
internal fun PlayerScreenRuntime.BindPartyEffects() {
    // This binding belongs to the player session, including background PiP.
    val partyState by PartyRepository.state.collectAsState()
    val party = partyState.party
    val partyId = party?.id
    val key = partyKey
    val sharingHost = party?.takeIf { it.isHost && it.media.key == key }
    val desktopOffer = if (sharingHost?.sharing == true) currentPartyStream() else null
    val browserOffer = if (sharingHost?.browserSharing == true) currentPartyBrowserHls() else null
    val browserSharing = sharingHost?.browserSharing == true
    val debridSettings by com.nuvio.app.features.debrid.DebridSettingsRepository.uiState.collectAsState()
    val torboxKey = debridSettings.apiKeyFor(com.nuvio.app.features.debrid.DebridProviders.Torbox.id)
    // Addon stream without TorBox identity: look for exactly one matching file
    // in the user's own TorBox cloud (by info hash), once per stream. Host only.
    // Addon stream without TorBox identity: link a cloud file automatically
    // (unique info hash, else exact title), once per stream; the host can
    // change or remove it. A manual link always wins.
    val autoKey = if (activeStream != null && activeStream?.torboxPartyFile == null && partyState.party?.isHost == true)
        "$key|${activeTorrentInfoHash.orEmpty()}|${activeSourceFilename ?: activeStream?.behaviorHints?.filename.orEmpty()}" else null
    LaunchedEffect(autoKey, torboxKey) {
        if (autoKey == null || torboxKey.isBlank() || torboxAutoTriedFor == autoKey || torboxManualFor == key) return@LaunchedEffect
        torboxAutoTriedFor = autoKey
        val media = currentPartyMedia()
        val found = try {
            com.nuvio.app.features.debrid.autoLinkTorboxCloud(torboxKey, activeTorrentInfoHash,
                activeSourceFilename ?: activeStream?.behaviorHints?.filename, media.title, media.season, media.episode)
        } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled } catch (_: Exception) { null }
        if (found != null && torboxManualFor != key) {
            torboxManualFile = found.first; torboxManualFor = key; torboxManualName = found.second; torboxLinkAuto = true
        }
    }
    val torboxFile = effectiveTorboxFile
    // torboxPartyRefresh restarts this single producer (button); the previous
    // run is cancelled first, so a click never runs two TorBox sessions at once.
    LaunchedEffect(partyId, key, torboxFile, torboxKey, partyState.party?.isHost, partyState.party?.media?.key, torboxPartyRefresh) {
        torboxPartyStream = null
        torboxPreparedFile = null
        torboxFamilyOnly = false
        torboxPropagateToken = false
        torboxPartyStatus = ""
        torboxPartyPhase = com.nuvio.app.features.debrid.TorboxHlsPhase.Unavailable
        if (torboxFile == null || partyId == null || partyState.party?.isHost != true || partyState.party?.media?.key != key) return@LaunchedEffect
        torboxPartyPhase = com.nuvio.app.features.debrid.TorboxHlsPhase.Preparing
        torboxPartyStatus = "TorBox: Stream wird vorbereitet …"
        var renewals = 0
        // One producer per player/file; cancellation on media, account or party change.
        while (isActive) {
            val result = com.nuvio.app.features.debrid.prepareTorboxPartyHls(
                torboxFile, torboxKey,
                onProcessing = {
                    torboxPartyPhase = com.nuvio.app.features.debrid.TorboxHlsPhase.Processing
                    torboxPartyStatus = "TorBox verarbeitet den Stream. Die Playlist ist noch nicht fertig; es wird bis zu etwa 10 Minuten geprüft."
                },
                familyShare = true,
            )
            when (result) {
                is com.nuvio.app.features.debrid.TorboxPartyHlsResult.Failed -> {
                    torboxPartyStream = null
                    torboxPartyStatus = result.message
                    torboxPartyPhase = when (result.reason) {
                        com.nuvio.app.features.debrid.TorboxHlsFailure.Denied -> com.nuvio.app.features.debrid.TorboxHlsPhase.Denied
                        com.nuvio.app.features.debrid.TorboxHlsFailure.Unsupported -> com.nuvio.app.features.debrid.TorboxHlsPhase.Unsupported
                        com.nuvio.app.features.debrid.TorboxHlsFailure.NotReady -> com.nuvio.app.features.debrid.TorboxHlsPhase.NotReady
                        com.nuvio.app.features.debrid.TorboxHlsFailure.RequestFailed -> com.nuvio.app.features.debrid.TorboxHlsPhase.Failed
                    }
                    return@LaunchedEffect
                }
                is com.nuvio.app.features.debrid.TorboxPartyHlsResult.Ready -> {
                    torboxPreparedFile = torboxFile
                    torboxFamilyOnly = result.familyOnly
                    torboxPropagateToken = result.propagateToken
                    torboxPartyStream = PartyStream(mediaKey = key, url = result.url, name = "TorBox HLS", streamType = "hls")
                    torboxPartyPhase = com.nuvio.app.features.debrid.TorboxHlsPhase.Ready
                    torboxPartyStatus = if (result.familyOnly)
                        "TorBox HLS mit Account-Key vorbereitet. Bei Browser-HLS-Freigabe erhalten ihn alle Party-Mitglieder."
                    else "TorBox HLS vorbereitet. Mehrgerätezugriff und Browserwiedergabe müssen geprüft werden."
                    // Renew only after an explicit expiry/access failure, never on
                    // every recomposition, toggle or transient network failure.
                    while (isActive) {
                        delay(60_000L)
                        // The family address carries the token by design: no key check on it.
                        val code = try { com.nuvio.app.features.debrid.probeTorboxPartyHls(result.url, if (result.familyOnly) "" else torboxKey) }
                            catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
                            catch (_: Exception) { 0 }
                        if (code == 498 || code == com.nuvio.app.features.debrid.TORBOX_PROBE_UNSAFE_HOST) {
                            torboxPartyStream = null
                            torboxPartyStatus = "TorBox: Manifest enthält Account-Zugangsdaten. Browserfreigabe gestoppt."
                            torboxPartyPhase = com.nuvio.app.features.debrid.TorboxHlsPhase.Unsupported
                            return@LaunchedEffect
                        }
                        if (code in listOf(401, 403, 404, 410)) break
                    }
                    torboxPartyStream = null
                    if (++renewals > 3) {
                        torboxPartyStatus = "TorBox: Wiederholte Zugriffsfehler. Browserfreigabe gestoppt; Account und Mehrgeräteberechtigung prüfen."
                        torboxPartyPhase = com.nuvio.app.features.debrid.TorboxHlsPhase.Failed
                        return@LaunchedEffect
                    }
                    torboxPartyPhase = com.nuvio.app.features.debrid.TorboxHlsPhase.Expired
                    torboxPartyStatus = "TorBox: Stream abgelaufen oder Zugriff entzogen. Neue HLS-Quelle wird vorbereitet …"
                }
            }
        }
    }

    DisposableEffect(playerController) {
        val source = playerController as? PlayerSystemControlSource
        // System controls follow the same party rules as the in-player controls.
        source?.setSystemControlHandler(object : PlayerSystemControlHandler {
            override fun handleSetPlaying(playing: Boolean): Boolean {
                if (!isPartySynced) return false
                setPlaybackPlaying(playing)
                return true
            }

            override fun handleSeekTo(positionMs: Long): Boolean {
                if (!isPartySynced) return false
                val targetMs = if (isPartyControlLocked) ownSeekTarget(positionMs) else positionMs
                if (targetMs != null) {
                    playerController?.seekTo(targetMs)
                    scheduleProgressSyncAfterSeek()
                    publishPartyPlayback(positionMs = targetMs)
                }
                return true
            }

            override fun handleSeekBy(offsetMs: Long): Boolean {
                if (!isPartySynced) return false
                this@BindPartyEffects.seekBy(offsetMs)
                return true
            }
        })
        onDispose { source?.setSystemControlHandler(null) }
    }

    LaunchedEffect(sharingHost?.id, sharingHost?.memberId, key, desktopOffer, browserOffer) {
        if (sharingHost != null) {
            PartyRepository.shareStream(sharingHost.id, sharingHost.memberId, key, desktopOffer, browserOffer)
        }
    }

    // Shared start: everyone shows the countdown to the server-time start; at
    // the start the host plays through the existing path (members follow the
    // authoritative state). A play/pause before the start cancels it.
    val countdown by PartyRepository.countdown.collectAsState()
    LaunchedEffect(countdown, key) {
        val running = countdown ?: return@LaunchedEffect
        if (running.mediaKey != key) return@LaunchedEffect
        var shown = -1
        while (isActive) {
            if (PartyRepository.countdown.value != running) return@LaunchedEffect
            if (PartyRepository.playback.value?.paused == false) { PartyRepository.clearCountdown(); return@LaunchedEffect }
            val left = running.startAt - PartyRepository.nowMs()
            if (left <= 0L) break
            val seconds = ((left + 999L) / 1000L).toInt()
            if (seconds != shown) { shown = seconds; showPartyMessage("Start in $seconds …") }
            delay(((left - 1L) % 1000L + 1L).coerceIn(20L, 1000L))
        }
        val party = PartyRepository.state.value.party
        if (party?.isHost == true && party.media.key == key && PartyRepository.countdown.value == running) setPlaybackPlaying(true)
        showPartyMessage("Los geht's!")
        PartyRepository.clearCountdown()
    }

    // Family share: publish the token address for the admitted members while
    // Browser-HLS sharing is on; revoke when it is off, the title changes or the
    // party ends. Guests that already loaded it keep playing.
    // TorBox links with the key now go directly through the party state, so
    // the family share service is not used (a leftover share is revoked).
    val familyUrl: String? = null
    val familyHost = partyState.party?.isHost == true && partyState.party?.media?.key == key
    // Republish when members change, so kicked or departed members lose their grants at once.
    val familyMembers = partyState.party?.members.orEmpty().map { it.id }.sorted()
    LaunchedEffect(partyId, key, browserSharing, familyUrl, familyHost, familyMembers) {
        val previous = familySharePartyId
        if (previous != null && previous != partyId) {
            // Host left: no new grants. Guests keep what they already loaded.
            com.nuvio.app.features.party.PartyFamilyShare.revoke(previous)
            familySharePartyId = null
        }
        if (partyId == null) { familyShareRev = null; familyShareStatus = ""; return@LaunchedEffect }
        if (!com.nuvio.app.features.party.PartyFamilyShare.configured || !familyHost) return@LaunchedEffect
        if (!browserSharing || familyUrl == null) {
            if (familySharePartyId != null) com.nuvio.app.features.party.PartyFamilyShare.revoke(partyId)
            familySharePartyId = null
            familyShareRev = null
            familyShareStatus = if (familyUrl != null) "Familienfreigabe beendet (Browser-HLS-Freigabe ist aus)." else ""
            return@LaunchedEffect
        }
        // Every current member except the host is admitted; joins, kicks and
        // leaves republish (removed members'
        // grants are deleted by the share service).
        val admitted = familyMembers.filter { it != partyState.party?.memberId }
        // Short-lived share, renewed while it is on: a crash or host change ends it by itself.
        while (isActive) {
            val propagate = activeHostPartyHls?.familyOnly != true && torboxPropagateToken
            val result = com.nuvio.app.features.party.PartyFamilyShare.publish(partyId, key, familyUrl, admitted, propagate)
            familySharePartyId = partyId
            // Throttled: keep the last rev (guests keep their state) and retry sooner.
            if (result.retryAfterMs == null) familyShareRev = result.rev
            familyShareStatus = result.message
            delay(result.retryAfterMs ?: com.nuvio.app.features.party.FAMILY_SHARE_RENEW_MS)
        }
    }

    DisposableEffect(key, partyId, party?.memberId, party?.isHost) {
        onDispose {
            hostPartyHlsJob?.cancel()
            hostPartyHlsJob = null
            hostPartyHlsBusy = false
        }
    }
    LaunchedEffect(key, partyId, party?.memberId, party?.hostMemberId) {
        // A shared video link and a manual TorBox link belong to one title of one party.
        if (hostPartyHls != null && activeHostPartyHls == null) {
            hostPartyHls = null
            hostPartyHlsStatus = if (partyId == null) "" else "Der geteilte Video-Link galt für den vorherigen Titel und wurde beendet."
        }
        if (torboxManualFor != null && (partyId == null || torboxManualFor != key)) {
            torboxManualFile = null; torboxManualFor = null; torboxManualName = ""; torboxLinkAuto = false
        }
        if (torboxChoicesFor != key) { torboxChoices = null; torboxChoicesFor = null; torboxChoicesStatus = "" }
    }

    LaunchedEffect(partyId, key) {
        partySolo = false
        partyBehind = false
        val previous = partyPreviousKey
        partyPreviousKey = key
        val party = PartyRepository.state.value.party ?: return@LaunchedEffect
        if (previous != null && previous != key && party.media.key == previous) {
            PartyRepository.publishMedia(currentPartyMedia(), positionMs = 0L)
        }
    }

    LaunchedEffect(Unit) {
        PartyRepository.events.collect { event ->
            if (isDesktop) showPartyMessage(event.message())
            if (event is PartyEvent.MediaChanged) handlePartyMediaChange(event.media)
        }
    }

    LaunchedEffect(Unit) {
        if (isDesktop) return@LaunchedEffect
        AppForegroundMonitor.events().collect { visibility ->
            partyAppInBackground = visibility == AppVisibility.Background
        }
    }

    LaunchedEffect(partyId) {
        if (partyId == null) {
            clearPartyNudge()
            return@LaunchedEffect
        }
        val clock = TimeSource.Monotonic
        var bufferingSince: TimeMark? = null
        var mismatchSince: TimeMark? = null
        var lastSeek: TimeMark? = null
        var lastCorrection: TimeMark? = null
        var lastSeq: Pair<Long, String?>? = null
        var lastPlayback: PartyPlayback? = null
        var revisionNeedsPosition = false
        // Revision from another member (e.g. a browser guest command the host
        // sequenced) that the local player has not reached yet (seek/HLS/
        // network). Until it is reached, superseded by a newer revision or by a
        // real local action, the player's old state is never published back as
        // a new command (playback ping-pong). Event-based, no fixed time window.
        var awaitingApply: PartyPlayback? = null
        var applyRetries = 0
        var lastStatus: Triple<PartyMemberStatus, String, Long?>? = null
        var lastPositionReport: TimeMark? = null
        var wasInBackground = false
        var handledResync = partyResyncRequest
        var publishedInitial = false
        var seekLeadMs = 0L
        var measureSeekLead = false
        // Final paused position (host only), now a safety net: paused party
        // seeks are frame-accurate (seekToExact). If the player still misses
        // the target (keyframe-only fallback, non-seekable stream), the host
        // confirms where it really stands, at most once per revision.
        var confirmedPausedSeq: Pair<Long, String?>? = null
        var exactSeekFor: Pair<Long, String?>? = null
        var lastPausedPosition: Long? = null
        var wasBehind = false
        while (isActive) {
            delay(PARTY_TICK)
            val party = PartyRepository.state.value.party ?: break
            val snapshot = playbackSnapshot
            val awayFromPlayback = partyAppInBackground &&
                (playerController as? PlayerSystemControlSource)?.keepsPlaybackInBackground != true
            val resumedFromBackground = wasInBackground && !partyAppInBackground
            wasInBackground = partyAppInBackground
            if (resumedFromBackground) lastSeq = null
            if (handledResync != partyResyncRequest) { handledResync = partyResyncRequest; lastSeq = null }
            val behindGap = PartyRepository.playback.value
                ?.takeIf { partyBehind && party.media.key == partyKey }
                ?.let { PartySync.expectedPositionMs(it, PartyRepository.nowMs(), snapshot.durationMs) - currentPlaybackPositionMs() }
            val status = when {
                errorMessage != null || awayFromPlayback -> PartyMemberStatus.Browsing
                behindGap != null -> PartyMemberStatus.Behind
                !initialLoadCompleted -> PartyMemberStatus.Loading
                snapshot.isLoading && !snapshot.isEnded -> {
                    val since = bufferingSince ?: clock.markNow().also { bufferingSince = it }
                    if (since.elapsedNow() > BUFFERING_REPORT_DELAY) PartyMemberStatus.Buffering else PartyMemberStatus.Ready
                }
                else -> {
                    bufferingSince = null
                    PartyMemberStatus.Ready
                }
            }
            val reportedStatus = Triple(
                status,
                partyKey,
                behindGap?.takeIf { status == PartyMemberStatus.Behind }?.let(PartySync::reportedGapMs),
            )
            if (reportedStatus != lastStatus) {
                lastStatus = reportedStatus
                // Behind is only reported in the deliberate local mode: "Allein".
                PartyRepository.setLocalStatus(status, partyKey, reportedStatus.third, solo = status == PartyMemberStatus.Behind)
                if (status == PartyMemberStatus.Buffering) partyStatBuffering += 1
            }

            val controller = playerController
            if (party.media.key != partyKey || controller == null || errorMessage != null || awayFromPlayback) {
                clearPartyNudge()
                continue
            }
            // Sparse, informational position report for the members' sync display.
            if (initialLoadCompleted && lastPositionReport?.let { it.elapsedNow() < POSITION_REPORT_INTERVAL } != true) {
                lastPositionReport = clock.markNow()
                PartyRepository.reportPosition(currentPlaybackPositionMs(), snapshot.isPlaying && !snapshot.isLoading)
            }
            val playback = PartyRepository.playback.value
            if (playback == null) {
                if (initialLoadCompleted && !publishedInitial && party.isHost) {
                    publishedInitial = true
                    PartyRepository.publishPlayback(
                        paused = !shouldPlay,
                        positionMs = snapshot.positionMs,
                        rate = snapshot.playbackSpeed,
                    )
                }
                continue
            }
            publishedInitial = true
            if (!initialLoadCompleted) continue
            if (partySolo) {
                clearPartyNudge(playback)
                continue
            }
            if (partyBehind && party.canControl) partyBehind = false
            if (partyBehind) {
                clearPartyNudge(playback)
                mismatchSince = null
                val gap = PartySync.expectedPositionMs(playback, PartyRepository.nowMs(), snapshot.durationMs) - currentPlaybackPositionMs()
                if (PartySync.shouldRejoin(gap, playing = shouldPlay && !snapshot.isLoading)) {
                    partyBehind = false
                } else {
                    val shown = partyBehindMs
                    if (shown == null || abs(gap - shown) >= BEHIND_DISPLAY_STEP_MS) partyBehindMs = gap.coerceAtLeast(0L)
                    wasBehind = true
                    continue
                }
            }
            if (wasBehind) {
                wasBehind = false
                lastSeq = null
                partyBehindMs = null
                if (!party.canControl) showPartyMessage(getString(Res.string.party_caught_up))
            }
            val expected = PartySync.expectedPositionMs(playback, PartyRepository.nowMs(), snapshot.durationMs)
            val identity = playback.seq to playback.memberId
            val allowDriftSeek = partyAutoSync && partyAutoSeek
            if (identity != lastSeq) {
                val forced = lastSeq == null
                // Legacy revisions have no action type. A change to the party timeline
                // is a remote jump; local distance from an unchanged timeline is drift.
                val timelineJump = lastPlayback?.let { previous ->
                    abs(playback.positionMs - PartySync.expectedPositionMs(previous, playback.at)) >
                        PartySync.PAUSED_TOLERANCE_MS
                } ?: false
                revisionNeedsPosition = forced || playback.commandId != null || timelineJump
                lastPlayback = playback
                lastSeq = identity
                applyPartyPaused(playback.paused, force = forced)
                // A revision the host sequenced from a guest command is published
                // by this device but caused by someone else: apply it like a remote one.
                val own = playback.actorId == party.memberId && !forced
                awaitingApply = if (own) null else playback
                applyRetries = 0
                if ((allowDriftSeek || revisionNeedsPosition) && (!own || playback.paused) &&
                    abs(snapshot.positionMs - expected) > PartySync.PAUSED_TOLERANCE_MS
                ) {
                    // Paused: frame-accurate, so everyone shows the chosen frame
                    // (keyframe seeks miss by up to a GOP); playing keeps the
                    // fast keyframe seek with the measured lead.
                    if (playback.paused) {
                        controller.seekToExact(expected)
                        exactSeekFor = identity
                    } else controller.seekTo(expected + seekLeadMs)
                    measureSeekLead = !playback.paused
                }
                lastSeek = clock.markNow()
                if (partyRateNudge == null && abs(snapshot.playbackSpeed - playback.rate) > 0.01f) {
                    controller.setPlaybackSpeed(playback.rate)
                }
                mismatchSince = null
                continue
            }

            if (snapshot.isLoading || isScrubbingTimeline || snapshot.isEnded) {
                mismatchSince = null
                continue
            }

            val pending = awaitingApply
            if (pending != null) {
                val pendingDrift = if (allowDriftSeek || revisionNeedsPosition) snapshot.positionMs - expected else 0L
                when (PartySync.pendingApply(pending.paused, shouldPlay, snapshot.isPlaying, pendingDrift)) {
                    // A real local action changed the intent; it was published on its own.
                    PendingApply.Superseded -> awaitingApply = null
                    PendingApply.Applied -> {
                        awaitingApply = null
                        mismatchSince = null
                        pending.commandId?.let { PartyRepository.reportApplied(it, pending.seq) }
                    }
                    // Play state reached; the regular correction below completes the seek.
                    PendingApply.Seeking -> Unit
                    PendingApply.Waiting -> {
                        // Re-issue the programmatic apply; this is recovery, not a
                        // lock: local controls publish directly at any time. Only a
                        // player that never reaches it (failed play) is handled like
                        // any other divergence afterwards.
                        val since = mismatchSince ?: clock.markNow().also { mismatchSince = it }
                        if (since.elapsedNow() > OUTSIDE_TOGGLE_DELAY) {
                            mismatchSince = null
                            if (applyRetries < MAX_APPLY_RETRIES) {
                                applyRetries++
                                applyPartyPaused(pending.paused, force = true)
                            } else {
                                awaitingApply = null
                            }
                        }
                        continue
                    }
                }
            }

            if (snapshot.isPlaying != shouldPlay) {
                val since = mismatchSince ?: clock.markNow().also { mismatchSince = it }
                if (since.elapsedNow() > OUTSIDE_TOGGLE_DELAY) {
                    mismatchSince = null
                    when {
                        party.canControl -> {
                            shouldPlay = snapshot.isPlaying
                            PartyRepository.publishPlayback(
                                paused = !snapshot.isPlaying,
                                positionMs = snapshot.positionMs,
                                rate = playback.rate,
                            )
                        }
                        snapshot.isPlaying -> applyPartyPaused(playback.paused, force = true)
                        else -> {
                            applyPartyPaused(playback.paused, force = true)
                        }
                    }
                }
                continue
            }
            mismatchSince = null

            val settled = lastSeek?.let { it.elapsedNow() > SEEK_SETTLE } ?: true
            val stablePosition = lastPausedPosition?.let { abs(it - snapshot.positionMs) <= POSITION_STABLE_MS } == true
            lastPausedPosition = snapshot.positionMs.takeIf { playback.paused && !snapshot.isPlaying }
            if ((allowDriftSeek || revisionNeedsPosition) && PartySync.shouldConfirmPausedPosition(
                    isHost = party.isHost,
                    playback = playback,
                    isPlaying = snapshot.isPlaying,
                    settled = settled,
                    stable = stablePosition,
                    actualMs = snapshot.positionMs,
                    alreadyConfirmed = confirmedPausedSeq == identity,
                    exactAttempted = exactSeekFor == identity,
                )) {
                confirmedPausedSeq = identity
                partyLog.i { "Confirming paused keyframe position ${snapshot.positionMs} for target ${playback.positionMs}" }
                PartyRepository.publishPlayback(paused = true, positionMs = snapshot.positionMs, rate = playback.rate)
                continue
            }
            if (!partyAutoSync) {
                measureSeekLead = false
                continue
            }
            val due = lastCorrection?.let { it.elapsedNow() >= CORRECTION_INTERVAL } ?: true
            if (!settled || !due) continue
            lastCorrection = clock.markNow()
            val drift = snapshot.positionMs - expected
            if (measureSeekLead && !playback.paused) {
                measureSeekLead = false
                if (abs(drift) < MAX_SEEK_LEAD_MS) seekLeadMs = (seekLeadMs - drift).coerceIn(0L, MAX_SEEK_LEAD_MS)
                partyStatSeekLeadMs = seekLeadMs
            }
            when (val correction = PartySync.correction(snapshot.positionMs, expected, playback, partyRateNudge != null, allowNudge = partySmartNudge)) {
                is PartyCorrection.Seek -> {
                    if (!allowDriftSeek) {
                        clearPartyNudge(playback)
                        continue
                    }
                    partyLog.i { "Seeking $drift ms back into sync with ${seekLeadMs} ms lead" }
                    partyStatSeeks += 1
                    partyStatLastCorrection = "Seek-Korrektur"
                    partyStatLastCorrectionAt = PartyRepository.nowMs()
                    clearPartyNudge(playback)
                    val target = if (playback.paused) correction.positionMs else correction.positionMs + seekLeadMs
                    val clamped = if (snapshot.durationMs > 0L) target.coerceAtMost(snapshot.durationMs) else target
                    if (playback.paused) {
                        controller.seekToExact(clamped)
                        exactSeekFor = playback.seq to playback.memberId
                    } else controller.seekTo(clamped)
                    lastSeek = clock.markNow()
                    measureSeekLead = !playback.paused
                }
                is PartyCorrection.Nudge -> {
                    if (partyRateNudge != correction.rate) {
                        partyLog.i { "Nudging speed to ${correction.rate} for ${snapshot.positionMs - expected} ms drift" }
                        partyRateNudge = correction.rate
                        controller.setPlaybackSpeed(correction.rate)
                        partyStatNudges += 1
                        partyStatLastCorrection = "Tempo-Korrektur"
                        partyStatLastCorrectionAt = PartyRepository.nowMs()
                    }
                }
                PartyCorrection.InSync -> clearPartyNudge(playback)
            }
        }
        clearPartyNudge()
    }

    DisposableEffect(Unit) {
        onDispose {
            val party = PartyRepository.state.value.party ?: return@onDispose
            val playback = PartyRepository.playback.value
            val othersWatching = party.presence.values.any {
                it.memberId != party.memberId && it.mediaKey == party.media.key && it.status != PartyMemberStatus.Browsing
            }
            if (!partyOpeningRequestedSource && party.media.key == partyKey && playback != null && !playback.paused && !othersWatching) {
                PartyRepository.publishPlayback(paused = true, positionMs = playbackSnapshot.positionMs, rate = playback.rate)
            }
            PartyRepository.setLocalStatus(PartyMemberStatus.Browsing, null)
        }
    }
}

internal fun PlayerScreenRuntime.clearPartyNudge(playback: PartyPlayback? = PartyRepository.playback.value) {
    if (partyRateNudge == null) return
    partyRateNudge = null
    playerController?.setPlaybackSpeed(playback?.rate ?: 1f)
}

@Composable
internal fun BoxScope.RenderParty(runtime: PlayerScreenRuntime) {
    val partyState by PartyRepository.state.collectAsStateWithLifecycle()
    val playback by PartyRepository.playback.collectAsStateWithLifecycle()
    val unread by PartyChat.unread.collectAsStateWithLifecycle()
    val notice = rememberPartyNotice()
    val party = partyState.party
    runtime.run {
        if (party != null) {
            PartyStatusPill(
                visible = (controlsVisible || partyPillPinned(party, playback, notice)) && !playerControlsLocked && !showPartyPanel,
                members = party.members,
                unread = unread,
                message = partyPillMessage(party, playback, notice),
                onClick = { openPartyPanel() },
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .windowInsetsPadding(WindowInsets.safeContent.only(WindowInsetsSides.Top))
                    .padding(top = metrics.verticalPadding / 4 + 8.dp),
            )
        }
        PartyPanel(
            visible = showPartyPanel,
            state = partyState,
            showChat = showPartyChat,
            onShowChatChange = { showPartyChat = it },
            playerMedia = currentPartyMedia(),
            isSupported = PartyRepository.available.collectAsStateWithLifecycle().value,
            canStart = PartyRepository.canUse,
            onStart = { startParty() },
            onSwitchParty = { switchPartyMedia() },
            onWatchWithParty = { watchWithParty() },
            onLeave = { leaveParty() },
            onEnd = { endParty() },
            onRemove = { member -> PartyRepository.removeMember(member.id) },
            onHostOnlyChange = { enabled -> PartyRepository.setHostOnly(enabled) },
            canShareStream = currentPartyStream() != null,
            onSharingChange = { enabled -> PartyRepository.setSharing(enabled) },
            behindMs = if (partyBehind) partyBehindMs ?: 0L else null,
            onCatchUp = { catchUpWithParty() },
            onDismiss = { showPartyPanel = false },
        )
    }
}

@Composable
internal fun rememberPartyNotice(): PartyNotice? {
    var notice by remember { mutableStateOf<PartyNotice?>(null) }
    LaunchedEffect(Unit) {
        PartyRepository.notices.collectLatest { next ->
            notice = next
            delay(NOTICE_DURATION)
            notice = null
        }
    }
    return notice
}

internal fun PlayerScreenRuntime.partyPillPinned(party: ActiveParty, playback: PartyPlayback?, notice: PartyNotice?): Boolean =
    party.waitingNames(playback).isNotEmpty() || !party.connected || notice != null || (partyBehind && !shouldPlay)

@Composable
internal fun PlayerScreenRuntime.partyPillMessage(party: ActiveParty, playback: PartyPlayback?, notice: PartyNotice?): String? {
    val waitingNames = party.waitingNames(playback)
    return when {
        !party.connected -> stringResource(Res.string.party_reconnecting)
        waitingNames.isNotEmpty() -> stringResource(Res.string.party_waiting_for, waitingNames.joinToString())
        playback?.waiting == true -> stringResource(Res.string.party_waiting)
        notice != null -> notice.text()
        partyBehind && !shouldPlay -> stringResource(Res.string.party_paused_for_you)
        partyBehind -> partyBehindMs?.let { stringResource(Res.string.party_behind, formatPlaybackTime(it)) }
        else -> null
    }
}

@Composable
private fun PartyNotice.text(): String = when (action) {
    PartyAction.Paused -> stringResource(Res.string.party_action_paused, name)
    PartyAction.Resumed -> stringResource(Res.string.party_action_resumed, name)
    PartyAction.Seeked -> stringResource(Res.string.party_action_seeked, name, formatPlaybackTime(positionMs))
    PartyAction.Speed -> stringResource(Res.string.party_action_speed, name, formatPlaybackSpeedLabel(rate))
}

private fun ActiveParty.waitingNames(playback: PartyPlayback?): List<String> {
    if (playback?.paused != true || !playback.waiting) return emptyList()
    return PartySync.waitingMemberIds(this, emptySet())
        .filter { it != memberId }
        .mapNotNull { id -> member(id)?.displayName }
}

@Composable
private fun PartyStatusPill(
    visible: Boolean,
    members: List<PartyMember>,
    unread: Int,
    message: String?,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    AnimatedVisibility(
        visible = visible,
        enter = fadeIn(),
        exit = fadeOut(),
        modifier = modifier,
    ) {
        Row(
            modifier = Modifier
                .clip(CircleShape)
                .clickable(onClick = onClick)
                .animateContentSize()
                .padding(6.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            AvatarStack(
                members = members,
                size = 28.dp,
                ringColor = Color.Black.copy(alpha = 0.5f),
            )
            UnreadBadge(count = unread, icon = true)
            AnimatedContent(
                targetState = message,
                transitionSpec = {
                    (fadeIn(tween(200)) + slideInVertically(tween(240)) { it / 2 }) togetherWith
                        (fadeOut(tween(120)) + slideOutVertically(tween(160)) { -it / 2 })
                },
            ) { text ->
                if (text != null) {
                    Text(
                        text = text,
                        style = MaterialTheme.typography.labelLarge.copy(
                            shadow = Shadow(color = Color.Black.copy(alpha = 0.8f), blurRadius = 12f),
                        ),
                        fontWeight = FontWeight.SemiBold,
                        color = Color.White,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

private val partyLog = Logger.withTag("Party")
private val PARTY_TICK = 250.milliseconds
private val NOTICE_DURATION = 3_000.milliseconds
private val BUFFERING_REPORT_DELAY = 1_000.milliseconds
private val OUTSIDE_TOGGLE_DELAY = 1_200.milliseconds
private const val MAX_APPLY_RETRIES = 3
private val POSITION_REPORT_INTERVAL = 10_000.milliseconds
private const val POSITION_STABLE_MS = 50L
private val SEEK_SETTLE = 2_500.milliseconds
private val CORRECTION_INTERVAL = 500.milliseconds
private const val MAX_SEEK_LEAD_MS = 3_000L
private const val BEHIND_DISPLAY_STEP_MS = 1_000L
private const val DESCRIPTION_LIMIT = 600
