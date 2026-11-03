package com.nuvio.app.features.party

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

// Browser seek → pause: mpv lands on a keyframe ("absolute+keyframes",
// hr-seek=no). The host confirms its real paused position once.
class PausedPositionTest {
    private val pausedAt300 = PartyPlayback(seq = 7, memberId = "host", paused = true, positionMs = 300_000, at = 1_000,
        originMemberId = "guest", commandId = "cmd-00000001")

    private fun confirm(
        isHost: Boolean = true,
        playback: PartyPlayback = pausedAt300,
        isPlaying: Boolean = false,
        settled: Boolean = true,
        stable: Boolean = true,
        actualMs: Long = 296_000,
        alreadyConfirmed: Boolean = false,
    ) = PartySync.shouldConfirmPausedPosition(isHost, playback, isPlaying, settled, stable, actualMs, alreadyConfirmed)

    @Test
    fun hostConfirmsAKeyframeLandingOnceWhenSettled() {
        assertTrue(confirm())
        assertFalse(confirm(alreadyConfirmed = true)) // At most once per revision: no publish loop.
    }

    @Test
    fun noConfirmationWhileSeekingBufferingPlayingOrWithinTolerance() {
        assertFalse(confirm(settled = false)) // A seek within SEEK_SETTLE (slow desktop buffering).
        assertFalse(confirm(stable = false)) // Position still moving.
        assertFalse(confirm(isPlaying = true))
        assertFalse(confirm(actualMs = 300_400)) // Within PAUSED_TOLERANCE_MS.
        assertFalse(confirm(playback = pausedAt300.copy(paused = false)))
        assertFalse(confirm(playback = pausedAt300.copy(waiting = true))) // Coordinator wait.
    }

    @Test
    fun onlyTheHostConfirms() {
        assertFalse(confirm(isHost = false))
    }

    @Test
    fun appliedForAPausedRevisionRequiresThePausedTolerance() {
        // Paused: 1.2 s away is still seeking (was "applied" with the 1.5 s seek threshold).
        assertEquals(PendingApply.Seeking, PartySync.pendingApply(pendingPaused = true, shouldPlay = false, isPlaying = false, driftMs = 1_200))
        assertEquals(PendingApply.Applied, PartySync.pendingApply(pendingPaused = true, shouldPlay = false, isPlaying = false, driftMs = -400))
        // Playing keeps the seek threshold.
        assertEquals(PendingApply.Applied, PartySync.pendingApply(pendingPaused = false, shouldPlay = true, isPlaying = true, driftMs = 1_200))
    }
}
