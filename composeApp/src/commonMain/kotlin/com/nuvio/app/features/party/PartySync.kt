package com.nuvio.app.features.party

import kotlin.math.abs

internal sealed interface PartyCorrection {
    data object InSync : PartyCorrection
    data class Seek(val positionMs: Long) : PartyCorrection
    data class Nudge(val rate: Float) : PartyCorrection
}

internal sealed interface OwnSeek {
    data class Behind(val positionMs: Long) : OwnSeek
    data object CatchUp : OwnSeek
    data object Blocked : OwnSeek
}

/** Progress of applying a revision received from another member. */
internal enum class PendingApply {
    /** A real local action changed the intent since; nothing left to apply. */
    Superseded,
    /** The player has not reached the play state yet (seek/HLS/network). */
    Waiting,
    /** Play state reached, position still far away: regular correction seeks. */
    Seeking,
    /** Reached. */
    Applied,
}

/** Estimated state of a member relative to the party time (display only). */
internal enum class MemberSync { Synced, CatchingUp, Buffering, Unsynced, Stale, Unknown }

internal data class MemberSyncInfo(val state: MemberSync, val positionMs: Long? = null, val driftMs: Long? = null)

internal object PartySync {
    const val NUDGE_START_MS = 250L
    const val NUDGE_STOP_MS = 80L
    const val SEEK_THRESHOLD_MS = 1_500L
    const val PAUSED_TOLERANCE_MS = 500L
    const val NUDGE_FACTOR = 0.05f
    const val SEEK_NOTICE_MS = 2_000L
    const val REJOIN_GAP_MS = 2_000L
    const val BEHIND_STEP_MS = 5_000L

    fun expectedPositionMs(playback: PartyPlayback, nowMs: Long, durationMs: Long = 0L): Long {
        val position = if (playback.paused) {
            playback.positionMs
        } else {
            val elapsed = (nowMs - playback.at).coerceAtLeast(0L)
            playback.positionMs + (elapsed * playback.rate).toLong()
        }
        val clamped = position.coerceAtLeast(0L)
        return if (durationMs > 0L) clamped.coerceAtMost(durationMs) else clamped
    }

    fun isNewer(candidate: PartyPlayback, current: PartyPlayback?): Boolean {
        if (current == null) return true
        if (candidate.seq != current.seq) return candidate.seq > current.seq
        return candidate.memberId.orEmpty() > current.memberId.orEmpty()
    }

    fun correction(
        localPositionMs: Long,
        expectedPositionMs: Long,
        playback: PartyPlayback,
        nudging: Boolean,
    ): PartyCorrection {
        val drift = localPositionMs - expectedPositionMs
        val distance = abs(drift)
        if (playback.paused) {
            return if (distance > PAUSED_TOLERANCE_MS) PartyCorrection.Seek(expectedPositionMs) else PartyCorrection.InSync
        }
        val threshold = if (nudging) NUDGE_STOP_MS else NUDGE_START_MS
        return when {
            distance > SEEK_THRESHOLD_MS -> PartyCorrection.Seek(expectedPositionMs)
            distance > threshold -> {
                val factor = if (drift > 0L) 1f - NUDGE_FACTOR else 1f + NUDGE_FACTOR
                PartyCorrection.Nudge(playback.rate * factor)
            }
            else -> PartyCorrection.InSync
        }
    }

    fun coordinatorId(party: ActiveParty): String? {
        val online = party.presence.keys + party.memberId
        val host = party.hostMemberId
        if (host != null && host in online) return host
        if (party.hostOnly) return host
        return party.members.firstOrNull { it.id in online }?.id ?: party.memberId
    }

    fun actionOf(previous: PartyPlayback?, next: PartyPlayback): PartyAction? {
        if (previous == null || previous.waiting || next.waiting) return null
        if (previous.mediaKey != next.mediaKey) return null
        return when {
            previous.paused != next.paused -> if (next.paused) PartyAction.Paused else PartyAction.Resumed
            abs(previous.rate - next.rate) > 0.01f -> PartyAction.Speed
            abs(next.positionMs - expectedPositionMs(previous, next.at)) > SEEK_NOTICE_MS -> PartyAction.Seeked
            else -> null
        }
    }

    fun pendingApply(pendingPaused: Boolean, shouldPlay: Boolean, isPlaying: Boolean, driftMs: Long): PendingApply = when {
        shouldPlay == pendingPaused -> PendingApply.Superseded
        isPlaying == pendingPaused -> PendingApply.Waiting
        // Paused: "applied" means the paused frame is within the paused
        // tolerance, not merely the play state (playing keeps the seek threshold).
        abs(driftMs) > (if (pendingPaused) PAUSED_TOLERANCE_MS else SEEK_THRESHOLD_MS) -> PendingApply.Seeking
        else -> PendingApply.Applied
    }

    const val REPORT_STALE_MS = 30_000L
    const val MEMBER_SYNCED_MS = 1_000L
    const val MEMBER_CATCH_UP_MS = 15_000L

    /**
     * Same rule as browser-site memberSync(): a report older than 30 s is stale;
     * buffering/loading wins; "behind" (watching alone or catching up alone) is
     * unsynced; otherwise the extrapolated position decides.
     */
    fun memberSync(presence: PartyPresence?, playback: PartyPlayback?, mediaKey: String, nowMs: Long): MemberSyncInfo {
        if (presence == null || (presence.mediaKey != null && presence.mediaKey != mediaKey)) return MemberSyncInfo(MemberSync.Unknown)
        if (presence.status == PartyMemberStatus.Loading || presence.status == PartyMemberStatus.Buffering) return MemberSyncInfo(MemberSync.Buffering)
        val reported = presence.positionMs
        val at = presence.positionAt
        if (reported == null || at == null) {
            return MemberSyncInfo(if (presence.status == PartyMemberStatus.Behind) MemberSync.Unsynced else MemberSync.Unknown)
        }
        if (nowMs - at > REPORT_STALE_MS) return MemberSyncInfo(MemberSync.Stale)
        val position = reported + if (presence.playing == true) (nowMs - at).coerceAtLeast(0L) else 0L
        val drift = playback?.let { position - expectedPositionMs(it, nowMs) }
        val state = when {
            presence.status == PartyMemberStatus.Behind -> MemberSync.Unsynced
            drift == null -> MemberSync.Unknown
            abs(drift) <= MEMBER_SYNCED_MS -> MemberSync.Synced
            abs(drift) <= MEMBER_CATCH_UP_MS -> MemberSync.CatchingUp
            else -> MemberSync.Unsynced
        }
        return MemberSyncInfo(state, position, drift)
    }

    fun memberSyncLabel(info: MemberSyncInfo): String {
        val drift = info.driftMs?.let { " (${formatDrift(it)})" }.orEmpty()
        return when (info.state) {
            MemberSync.Synced -> "Synchron$drift"
            MemberSync.CatchingUp -> "Holt auf$drift"
            MemberSync.Buffering -> "Puffert"
            MemberSync.Unsynced -> "Unsynchron$drift"
            MemberSync.Stale -> "Status veraltet"
            MemberSync.Unknown -> ""
        }
    }

    fun formatDrift(driftMs: Long): String {
        val sign = if (driftMs < 0) "−" else "+"
        val ms = abs(driftMs)
        return if (ms < 60_000L) {
            val tenths = (ms + 50L) / 100L
            "$sign${tenths / 10},${tenths % 10} s"
        } else {
            val seconds = (ms + 500L) / 1_000L
            "$sign${seconds / 60}:${(seconds % 60).toString().padStart(2, '0')}"
        }
    }

    /**
     * The host confirms its real paused position once per revision when the
     * player settled (no seek within SEEK_SETTLE, position stable, not
     * buffering) but stands more than PAUSED_TOLERANCE_MS from the target,
     * typically a keyframe before it. Not for coordinator waits; bounded, so
     * no seek or publish loop.
     */
    fun shouldConfirmPausedPosition(
        isHost: Boolean,
        playback: PartyPlayback,
        isPlaying: Boolean,
        settled: Boolean,
        stable: Boolean,
        actualMs: Long,
        alreadyConfirmed: Boolean,
    ): Boolean = isHost && playback.paused && !playback.waiting && !isPlaying && settled && stable && !alreadyConfirmed &&
        abs(actualMs - playback.positionMs) > PAUSED_TOLERANCE_MS

    fun ownSeek(targetMs: Long, partyPositionMs: Long, behind: Boolean): OwnSeek = when {
        targetMs < partyPositionMs - REJOIN_GAP_MS -> OwnSeek.Behind(targetMs)
        behind -> OwnSeek.CatchUp
        else -> OwnSeek.Blocked
    }

    fun shouldRejoin(gapMs: Long, playing: Boolean): Boolean = playing && gapMs <= REJOIN_GAP_MS

    fun reportedGapMs(gapMs: Long): Long =
        ((gapMs.coerceAtLeast(0L) + BEHIND_STEP_MS / 2) / BEHIND_STEP_MS * BEHIND_STEP_MS).coerceAtLeast(BEHIND_STEP_MS)

    fun waitingMemberIds(party: ActiveParty, ignored: Set<String>): List<String> =
        party.presence.values
            .filter { it.mediaKey == party.media.key }
            .filter { it.status == PartyMemberStatus.Loading || it.status == PartyMemberStatus.Buffering }
            .map { it.memberId }
            .filterNot { it in ignored }
}
