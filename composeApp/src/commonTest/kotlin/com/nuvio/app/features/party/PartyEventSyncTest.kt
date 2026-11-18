package com.nuvio.app.features.party

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PartyEventSyncTest {
    private fun playback(
        seq: Long = 1,
        paused: Boolean = false,
        positionMs: Long = 10_000,
        rate: Float = 1f,
        at: Long = 1_000_000,
        waiting: Boolean = false,
        commandId: String? = null,
    ) = PartyPlayback(seq = seq, memberId = "host", paused = paused, positionMs = positionMs, rate = rate, at = at,
        waiting = waiting, commandId = commandId)

    @Test
    fun playAndPauseKeepTheOwnPosition() {
        val running = playback()
        assertFalse(PartySync.eventNeedsPosition(running, playback(seq = 2, paused = true, positionMs = 15_000, at = 1_005_000), align = false))
        assertFalse(PartySync.eventNeedsPosition(playback(paused = true), playback(seq = 2, positionMs = 40_000), align = false))
        // A guest's sequenced pause command at the guest's own position is still only a pause.
        assertFalse(PartySync.eventNeedsPosition(running, playback(seq = 2, paused = true, positionMs = 3_000, commandId = "c1"), align = false))
    }

    @Test
    fun deliberateJumpsSeekOnceButReAnchorsRateAndWaitsDoNot() {
        val running = playback()
        assertTrue(PartySync.eventNeedsPosition(running, playback(seq = 2, positionMs = 60_000, at = 1_005_000), align = false))
        assertTrue(PartySync.eventNeedsPosition(running, playback(seq = 2, positionMs = 2_000, at = 1_005_000), align = false))
        assertFalse(PartySync.eventNeedsPosition(running, playback(seq = 2, positionMs = 15_200, at = 1_005_000), align = false))
        assertFalse(PartySync.eventNeedsPosition(running, playback(seq = 2, rate = 1.5f, positionMs = 15_000, at = 1_005_000), align = false))
        assertFalse(PartySync.eventNeedsPosition(running, playback(seq = 2, paused = true, waiting = true, positionMs = 15_000, at = 1_005_000), align = false))
        assertFalse(PartySync.eventNeedsPosition(playback(paused = true, waiting = true), playback(seq = 2, positionMs = 10_000), align = false))
        assertFalse(PartySync.eventNeedsPosition(running, running, align = false))
    }

    @Test
    fun joinAndManualSyncAlignExactlyWhenRequested() {
        assertTrue(PartySync.eventNeedsPosition(null, playback(), align = true))
        assertTrue(PartySync.eventNeedsPosition(playback(), playback(seq = 2), align = true))
        // App resume / reconnect without an explicit request is not a join.
        assertFalse(PartySync.eventNeedsPosition(null, playback(), align = false))
        // Never align onto a coordinator wait.
        assertFalse(PartySync.eventNeedsPosition(null, playback(paused = true, waiting = true), align = true))
    }

    @Test
    fun liveSyncRulesAreUnchanged() {
        // Live sync still treats commands and jumps as immediate positions.
        assertTrue(PartySync.needsImmediatePosition(playback(), playback(seq = 2, paused = true, commandId = "c1"), forced = false))
        assertTrue(PartySync.needsImmediatePosition(null, playback(), forced = true))
        assertFalse(PartySync.needsImmediatePosition(playback(), playback(seq = 2, paused = true, waiting = true), forced = true))
    }

    @Test
    fun theModeIsOnlyTakenFromTheCurrentHostsPresence() {
        fun party(presence: Map<String, PartyPresence>, host: String = "host") = ActiveParty(
            id = "p", code = "C", memberId = "guest", hostMemberId = host, members = emptyList(), presence = presence,
            media = PartyMedia(type = "movie", metaId = "tt1", metaType = "movie"), maxMembers = 3, connected = true,
        )
        assertEquals(PartySyncMode.Live, party(emptyMap()).announcedSyncMode)
        assertEquals(PartySyncMode.Event, party(mapOf("host" to PartyPresence("host", sync = "event"))).announcedSyncMode)
        assertEquals(PartySyncMode.Live, party(mapOf("host" to PartyPresence("host", sync = "something-else"))).announcedSyncMode)
        // A guest cannot switch the party by announcing the field itself.
        assertEquals(PartySyncMode.Live, party(mapOf("other" to PartyPresence("other", sync = "event"))).announcedSyncMode)
        // After a host change the new host's (missing) announcement wins.
        assertEquals(PartySyncMode.Live, party(mapOf("host" to PartyPresence("host", sync = "event")), host = "other").announcedSyncMode)
    }

    @Test
    fun theWireFieldIsOptionalAndIgnoredWhenLive() {
        val live = PartyApi.json.encodeToJsonElement(PartyPresence.serializer(), PartyPresence("host", sync = PartySyncMode.Live.wire)).jsonObject
        assertFalse("sync" in live) // Live sends nothing new; older clients see the unchanged payload.
        val event = PartyApi.json.encodeToJsonElement(PartyPresence.serializer(), PartyPresence("host", sync = PartySyncMode.Event.wire)).jsonObject
        assertEquals("\"event\"", event["sync"].toString())
        // Older payloads without the field decode as before.
        val decoded = PartyApi.json.decodeFromJsonElement(PartyPresence.serializer(), JsonObject(live - "sync"))
        assertEquals(null, decoded.sync)
        // Playback revisions carry no mode at all.
        val revision = PartyApi.json.encodeToJsonElement(PartyPlayback.serializer(), playback()).jsonObject
        assertFalse("sync" in revision)
    }
}
