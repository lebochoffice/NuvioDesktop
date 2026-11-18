package com.nuvio.app.features.party

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.math.abs

class PartyStabilityTest {
    private val media = PartyMedia(type = "movie", metaId = "test", metaType = "movie")
    private fun status(id: String, state: PartyMemberStatus = PartyMemberStatus.Buffering, at: Long? = null) =
        PartyPresence(id, state, media.key, positionAt = at)
    private fun room(vararg statuses: PartyPresence) = ActiveParty(
        id = "test", code = "ABC234", memberId = "host", hostMemberId = "host", media = media,
        members = listOf("host", "tv", "browser").map { PartyMember(it, it) },
        presence = statuses.associateBy { it.memberId }, maxMembers = 3, connected = true,
    )
    private val playing = PartyPlayback(1, "host", false, 10_000, at = 0, mediaKey = media.key)

    @Test fun legacyCoordinatorCanTurnOneBriefReportIntoTwoNativeSeeks() {
        // Exact old conditions: first coordinator tick pauses; Ready resumes next tick.
        val buffering = room(status("tv"))
        assertEquals(listOf("tv"), PartySync.waitingMemberIds(buffering, emptySet()))
        val paused = playing.copy(seq = 2, paused = true, waiting = true, positionMs = 30_000, at = 20_000)
        val resumed = paused.copy(seq = 3, paused = false, waiting = false, at = 21_000)
        val nativeAtPause = 29_200L
        val nativeAfterKeyframeSeek = 29_400L
        assertTrue(abs(nativeAtPause - PartySync.expectedPositionMs(paused, 20_000)) > PartySync.PAUSED_TOLERANCE_MS)
        assertTrue(abs(nativeAfterKeyframeSeek - PartySync.expectedPositionMs(resumed, 21_000)) > PartySync.PAUSED_TOLERANCE_MS)
        assertFalse(PartySync.needsImmediatePosition(playing, paused, false))
        assertFalse(PartySync.needsImmediatePosition(paused, resumed, false))
    }

    @Test fun threeMinuteMixedGuestReplayRejectsBriefPeriodicWaitsButPreservesLongOnes() {
        val gate = PartyWaitGate()
        var pauses = 0
        var resumes = 0
        var waiting = false
        for (now in 0L..180_000L step 250L) {
            // One guest has two brief stalls around each 20 s boundary;
            // another really starves once. This is a policy simulation, not a TV playback test.
            val phase = now % 20_000L
            val tvBad = phase in 0L..500L || phase in 1500L..2000L
            val browserBad = now in 90_000L..96_000L
            val tv = status("tv", if (tvBad) PartyMemberStatus.Buffering else PartyMemberStatus.Ready)
            val browser = status("browser", if (browserBad) PartyMemberStatus.Buffering else PartyMemberStatus.Ready)
            gate.observe(tv, now); gate.observe(browser, now)
            val blocked = gate.waiting(room(tv, browser), emptySet(), now).isNotEmpty()
            if (!waiting && blocked) pauses++
            if (waiting && !blocked) resumes++
            waiting = blocked
        }
        assertEquals(1, pauses)
        assertEquals(1, resumes)
    }

    @Test fun waitTimeoutStillIgnoresStuckMemberUntilRealRecovery() {
        val gate = PartyWaitGate()
        val ignored = mutableSetOf<String>()
        gate.observe(status("tv"), 0)
        val waiting = gate.waiting(room(status("tv")), ignored, 2000)
        assertEquals(listOf("tv"), waiting)
        // Existing repository WAIT_LIMIT behavior, deliberately unchanged.
        ignored += gate.waiting(room(status("tv")), ignored, 18_000)
        assertTrue(gate.waiting(room(status("tv")), ignored, 18_500).isEmpty())
        gate.observe(status("tv", PartyMemberStatus.Ready), 19_000)
        ignored.removeAll(gate.recovered(19_500))
        assertEquals(setOf("tv"), ignored)
        ignored.removeAll(gate.recovered(20_000))
        assertTrue(ignored.isEmpty())
    }

    @Test fun briefBufferingFromTvOrBrowserDoesNotPauseOthers() {
        for (guest in listOf("tv", "browser")) {
            val gate = PartyWaitGate()
            val bad = status(guest)
            gate.observe(bad, 20_000)
            assertTrue(gate.waiting(room(bad), emptySet(), 20_500).isEmpty())
            val ready = status(guest, PartyMemberStatus.Ready)
            gate.observe(ready, 20_750)
            assertTrue(gate.waiting(room(ready), emptySet(), 22_500).isEmpty())
        }
    }

    @Test fun twoShortStallsOneSecondApartDoNotAccumulate() {
        val gate = PartyWaitGate()
        for (start in listOf(20_000L, 21_750L)) {
            gate.observe(status("tv"), start)
            assertTrue(gate.waiting(room(status("tv")), emptySet(), start + 500).isEmpty())
            gate.observe(status("tv", PartyMemberStatus.Ready), start + 750)
        }
        assertTrue(gate.waiting(room(status("tv", PartyMemberStatus.Ready)), emptySet(), 25_000).isEmpty())
    }

    @Test fun sustainedBufferingStillPausesAndRequiresStableRecovery() {
        val gate = PartyWaitGate()
        gate.observe(status("tv"), 0)
        assertEquals(listOf("tv"), gate.waiting(room(status("tv")), emptySet(), 2000))
        val ready = status("tv", PartyMemberStatus.Ready)
        gate.observe(ready, 2500)
        assertEquals(listOf("tv"), gate.waiting(room(ready), emptySet(), 3000))
        assertTrue(gate.waiting(room(ready), emptySet(), 3500).isEmpty())
        assertEquals(setOf("tv"), gate.recovered(3500))
    }

    @Test fun readyBufferingFlappingDoesNotResumeAQualifiedWait() {
        val gate = PartyWaitGate()
        gate.observe(status("browser"), 0)
        gate.waiting(room(status("browser")), emptySet(), 2000)
        gate.observe(status("browser", PartyMemberStatus.Ready), 2500)
        gate.observe(status("browser"), 3000)
        assertEquals(listOf("browser"), gate.waiting(room(status("browser")), emptySet(), 3000))
    }

    @Test fun repeatedPresenceDoesNotResetSustainedWaitOrAgeItForever() {
        val gate = PartyWaitGate()
        for (time in listOf(0L, 500L, 1000L, 1500L)) gate.observe(status("tv"), time)
        assertEquals(listOf("tv"), gate.waiting(room(status("tv")), emptySet(), 2000))
        assertTrue(gate.waiting(room(status("tv")), emptySet(), 32_000).isEmpty())
    }

    @Test fun olderTimestampCannotReplaceReadyWithStaleBuffering() {
        val gate = PartyWaitGate()
        assertTrue(gate.observe(status("tv", PartyMemberStatus.Ready, 5000), 0))
        assertFalse(gate.observe(status("tv", at = 4000), 500))
        assertTrue(gate.waiting(room(status("tv", PartyMemberStatus.Ready, 5000)), emptySet(), 3000).isEmpty())
    }

    @Test fun expiredTimestampDoesNotPermanentlyRejectAReconnectedClock() {
        val gate = PartyWaitGate()
        gate.observe(status("tv", PartyMemberStatus.Ready, 5000), 0)
        assertTrue(gate.observe(status("tv", at = 4000), 31_000))
        assertEquals(listOf("tv"), gate.waiting(room(status("tv", at = 4000)), emptySet(), 33_000))
    }

    @Test fun legacyStatusWithoutPositionFieldsRemainsSupported() {
        val gate = PartyWaitGate()
        gate.observe(status("tv"), 0)
        assertEquals(listOf("tv"), gate.waiting(room(status("tv")), emptySet(), 2000))
    }

    @Test fun membershipMediaSoloAndIgnoredWaitsAreRespected() {
        val gate = PartyWaitGate()
        val states = arrayOf(status("tv"), status("browser").copy(solo = true), status("outsider"))
        states.forEach { gate.observe(it, 0) }
        assertEquals(listOf("tv"), gate.waiting(room(*states), emptySet(), 2500))
        assertTrue(gate.waiting(room(*states), setOf("tv"), 3000).isEmpty())
        assertTrue(gate.waiting(room(*states).copy(media = media.copy(metaId = "other")), emptySet(), 3000).isEmpty())
    }

    @Test fun twoGuestsRecoverIndependently() {
        val gate = PartyWaitGate()
        gate.observe(status("tv"), 0); gate.observe(status("browser"), 0)
        assertEquals(setOf("tv", "browser"), gate.waiting(room(status("tv"), status("browser")), emptySet(), 2500).toSet())
        gate.observe(status("tv", PartyMemberStatus.Ready), 3000)
        assertEquals(listOf("browser"), gate.waiting(room(status("tv", PartyMemberStatus.Ready), status("browser")), emptySet(), 4000))
    }

    @Test fun leaveAndReconnectDoNotReuseOldWaits() {
        val gate = PartyWaitGate()
        gate.observe(status("tv"), 0)
        gate.waiting(room(), emptySet(), 2000)
        assertTrue(gate.waiting(room(status("tv")), emptySet(), 3000).isEmpty())
        gate.observe(status("tv"), 3000)
        gate.clear()
        assertTrue(gate.waiting(room(status("tv")), emptySet(), 6000).isEmpty())
    }

    @Test fun ordinaryRevisionsDoNotDemandImmediateSeeks() {
        var previous = playing
        repeat(30) { i ->
            val next = playing.copy(seq = i + 2L, at = (i + 1) * 10_000L, positionMs = 10_000 + (i + 1) * 10_000L)
            assertFalse(PartySync.needsImmediatePosition(previous, next, false))
            previous = next
        }
    }

    @Test fun explicitHostSeekAndInitialAlignmentRemainImmediate() {
        assertTrue(PartySync.needsImmediatePosition(playing, playing.copy(seq = 2, positionMs = 40_000), false))
        assertTrue(PartySync.needsImmediatePosition(playing, playing.copy(seq = 2, commandId = "test"), false))
        assertTrue(PartySync.needsImmediatePosition(null, playing, true))
    }

    @Test fun hostPauseAndResumeAreNotPositionCommandsUnlessTimelineMoved() {
        val pause = playing.copy(seq = 2, at = 20_000, positionMs = 30_000, paused = true)
        val resume = pause.copy(seq = 3, at = 25_000, paused = false)
        assertFalse(PartySync.needsImmediatePosition(playing, pause, false))
        assertFalse(PartySync.needsImmediatePosition(pause, resume, false))
        assertTrue(PartySync.needsImmediatePosition(pause, resume.copy(positionMs = 50_000), false))
    }

    @Test fun stableSmallOffsetNudgesWithoutHardSeeks() {
        assertTrue(PartySync.correction(10_600, 10_000, playing, false) is PartyCorrection.Nudge)
        assertEquals(PartyCorrection.InSync, PartySync.correction(10_200, 10_000, playing, false))
    }

    @Test fun sustainedNativeDriftAndCooldown() {
        val gate = PartyDriftGate()
        assertFalse(gate.allowSeek(true, 0))
        assertFalse(gate.allowSeek(true, 1500))
        assertTrue(gate.allowSeek(true, 2000))
        gate.seeked(2000)
        assertFalse(gate.allowSeek(true, 2500))
        assertFalse(gate.allowSeek(true, 4500))
        assertTrue(gate.allowSeek(true, 6000))
    }

    @Test fun recoveredBufferingCannotTriggerImmediateSecondSeek() {
        val gate = PartyDriftGate()
        gate.seeked(20_000)
        gate.recovering(20_750)
        assertFalse(gate.allowSeek(true, 21_000))
        assertFalse(gate.allowSeek(true, 23_250))
        assertFalse(gate.allowSeek(true, 24_000))
        assertTrue(gate.allowSeek(true, 25_250))
    }

    @Test fun transientDriftCannotAccumulateAcrossRecoveryOrInSync() {
        val gate = PartyDriftGate()
        assertFalse(gate.allowSeek(true, 0))
        assertFalse(gate.allowSeek(false, 1000))
        assertFalse(gate.allowSeek(true, 2000))
        assertFalse(gate.allowSeek(true, 3500))
        gate.recovering(3600)
        assertFalse(gate.allowSeek(true, 6000))
    }
}
