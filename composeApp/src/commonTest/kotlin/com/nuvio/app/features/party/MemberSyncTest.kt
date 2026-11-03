package com.nuvio.app.features.party

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.jsonObject

// Same rule as browser-site memberSync() (tests/protocol.test.js).
class MemberSyncTest {
    private val key = "movie|tt1||"
    private val party = PartyPlayback(seq = 3, memberId = "host", paused = false, positionMs = 60_000, at = 10_000, mediaKey = key)

    private fun report(
        status: PartyMemberStatus = PartyMemberStatus.Ready,
        positionMs: Long? = 60_000,
        positionAt: Long? = 10_000,
        playing: Boolean? = true,
        mediaKey: String? = key,
    ) = PartyPresence(memberId = "guest", status = status, mediaKey = mediaKey, positionMs = positionMs, positionAt = positionAt, playing = playing)

    @Test
    fun syncedCatchingUpAndUnsyncedFollowTheExtrapolatedDrift() {
        assertEquals(MemberSyncInfo(MemberSync.Synced, 65_000, 0), PartySync.memberSync(report(), party, key, 15_000))
        val catchingUp = PartySync.memberSync(report(positionMs = 56_000), party, key, 15_000)
        assertEquals(MemberSync.CatchingUp, catchingUp.state)
        assertEquals(-4_000L, catchingUp.driftMs)
        assertEquals(MemberSync.Unsynced, PartySync.memberSync(report(positionMs = 20_000), party, key, 15_000).state)
        assertEquals(MemberSync.Synced, PartySync.memberSync(report(playing = false), party.copy(paused = true), key, 15_000).state)
    }

    @Test
    fun bufferingBehindStaleAndOtherMedia() {
        assertEquals(MemberSync.Buffering, PartySync.memberSync(report(status = PartyMemberStatus.Buffering), party, key, 15_000).state)
        assertEquals(MemberSync.Unsynced, PartySync.memberSync(report(status = PartyMemberStatus.Behind), party, key, 15_000).state)
        assertEquals(MemberSync.Stale, PartySync.memberSync(report(), party, key, 10_000 + 30_001).state)
        assertEquals(MemberSync.Unknown, PartySync.memberSync(report(mediaKey = "movie|tt9||"), party, key, 15_000).state)
        assertEquals(MemberSync.Unknown, PartySync.memberSync(null, party, key, 15_000).state)
        // Older clients send no position.
        assertEquals(MemberSync.Unknown, PartySync.memberSync(report(positionMs = null, positionAt = null), party, key, 15_000).state)
        assertEquals(MemberSync.Unsynced, PartySync.memberSync(report(status = PartyMemberStatus.Behind, positionMs = null, positionAt = null), party, key, 15_000).state)
    }

    @Test
    fun labelsAndDriftFormattingMatchTheBrowser() {
        assertEquals("+0,0 s", PartySync.formatDrift(0))
        assertEquals("−4,2 s", PartySync.formatDrift(-4_249))
        assertEquals("+1:05", PartySync.formatDrift(65_400))
        assertEquals("Synchron (+0,3 s)", PartySync.memberSyncLabel(MemberSyncInfo(MemberSync.Synced, driftMs = 300)))
        assertEquals("Holt auf (−4,0 s)", PartySync.memberSyncLabel(MemberSyncInfo(MemberSync.CatchingUp, driftMs = -4_000)))
        assertEquals("Puffert", PartySync.memberSyncLabel(MemberSyncInfo(MemberSync.Buffering)))
        assertEquals("Unsynchron (−1:30)", PartySync.memberSyncLabel(MemberSyncInfo(MemberSync.Unsynced, driftMs = -90_000)))
        assertEquals("Status veraltet", PartySync.memberSyncLabel(MemberSyncInfo(MemberSync.Stale)))
        assertEquals("", PartySync.memberSyncLabel(MemberSyncInfo(MemberSync.Unknown)))
    }

    @Test
    fun positionFieldsAreOptionalOnTheWire() {
        val old = PartyApi.json.decodeFromString(PartyPresence.serializer(), """{"member_id":"guest","status":"ready","media_key":"movie|tt1||"}""")
        assertNull(old.positionMs)
        val plain = PartyApi.json.encodeToJsonElement(PartyPresence.serializer(), old).jsonObject
        assertTrue("position_ms" !in plain && "position_at" !in plain && "playing" !in plain)
        val reported = PartyApi.json.decodeFromString(
            PartyPresence.serializer(),
            """{"member_id":"guest","status":"ready","position_ms":5,"position_at":7,"playing":true,"future":1}""",
        )
        assertEquals(5L, reported.positionMs)
        assertEquals(true, reported.playing)
    }

    @Test
    fun browserHlsStateIsOptional() {
        val old = PartyApi.json.decodeFromString(PartyBrowserHls.serializer(), """{"url":null}""")
        assertNull(old.state)
        val failed = PartyApi.json.decodeFromString(PartyBrowserHls.serializer(), """{"url":null,"state":"failed"}""")
        assertEquals("failed", failed.state)
    }
}
