package com.nuvio.app.features.party

import com.nuvio.app.features.player.syncAllSummary
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PartySyncAllTest {
    private val media = PartyMedia(type = "movie", metaId = "tt1", metaType = "movie")

    private fun party(
        self: String = "guest",
        presence: Map<String, PartyPresence> = emptyMap(),
        members: List<String> = listOf("host", "guest"),
    ) = ActiveParty(
        id = "p", code = "C", memberId = self, hostMemberId = "host",
        members = members.map { PartyMember(it, it) }, presence = presence, media = media,
        maxMembers = 4, connected = true,
    )

    private fun playback(seq: Long = 5, member: String = "host", syncAll: String? = "sa-1", waiting: Boolean = false, paused: Boolean = false) =
        PartyPlayback(seq = seq, memberId = member, paused = paused, positionMs = 60_000, at = 1_000, mediaKey = media.key,
            waiting = waiting, syncAll = syncAll)

    @Test
    fun aNewPartyStartsInEventSyncWhileHostsWithoutTheFieldStayLive() {
        assertEquals(PartySyncMode.Event, PartySyncMode.NewPartyDefault)
        assertEquals("event", PartySyncMode.NewPartyDefault.wire) // Actively announced.
        assertEquals(PartySyncMode.Live, PartySyncMode.fromWire(null)) // Older host / TV: unchanged fallback.
    }

    @Test
    fun onlyTheCurrentHostCanRequestTheOneTimeAlignment() {
        assertTrue(PartySync.isSyncAllAlignment(playback(), party()))
        assertFalse(PartySync.isSyncAllAlignment(playback(member = "g2"), party())) // A guest's revision.
        assertFalse(PartySync.isSyncAllAlignment(playback(syncAll = null), party()))
        assertFalse(PartySync.isSyncAllAlignment(playback(waiting = true), party()))
        assertFalse(PartySync.isSyncAllAlignment(playback(), party(self = "host"))) // The host itself never re-seeks.
    }

    @Test
    fun syncAllSeeksOnceInBothModesButNeverOnPlainReAnchors() {
        val before = playback(seq = 4, syncAll = null)
        val next = playback(seq = 5)
        // Event sync: an explicit alignment, even without a timeline jump.
        assertTrue(PartySync.eventNeedsPosition(before, next, align = PartySync.isSyncAllAlignment(next, party())))
        assertFalse(PartySync.eventNeedsPosition(before, next.copy(syncAll = null), align = false))
        // Live sync: forced immediate position.
        assertTrue(PartySync.needsImmediatePosition(before, next, forced = PartySync.isSyncAllAlignment(next, party())))
        // Duplicates and older copies are rejected by the seq ordering before any apply.
        assertFalse(PartySync.isNewer(next, next))
        assertFalse(PartySync.isNewer(playback(seq = 3), next))
    }

    @Test
    fun theAlignmentIdIsWireOnlyAndPresenceAnnouncesSupport() {
        val wire = PartyApi.json.encodeToJsonElement(PartyPlayback.serializer(), playback()).jsonObject
        assertEquals("\"sa-1\"", wire["sync_all"].toString())
        val plain = PartyApi.json.encodeToJsonElement(PartyPlayback.serializer(), playback(syncAll = null)).jsonObject
        assertFalse("sync_all" in plain) // Ordinary revisions keep the legacy payload.
        val presence = PartyApi.json.encodeToJsonElement(PartyPresence.serializer(),
            PartyPresence("guest", syncAllSupport = PARTY_SYNC_ALL_PROTOCOL)).jsonObject
        assertEquals("1", presence["sync_all"].toString())
    }

    @Test
    fun theHostSummaryNeverCountsMembersWithoutSupportAsSynchronized() {
        val now = 100_000L
        val hostPlayback = PartyPlayback(seq = 5, memberId = "host", paused = true, positionMs = 60_000, at = now, mediaKey = media.key)
        fun synced(id: String, support: Boolean) = PartyPresence(id, status = PartyMemberStatus.Ready, mediaKey = media.key,
            positionMs = 60_000, positionAt = now, playing = false, syncAllSupport = if (support) PARTY_SYNC_ALL_PROTOCOL else null)
        val hostView = party(
            self = "host",
            members = listOf("host", "desktop", "tv", "solo"),
            presence = mapOf(
                "desktop" to synced("desktop", support = true),
                "tv" to synced("tv", support = false), // In position, but no confirmed support.
                "solo" to synced("solo", support = true).copy(solo = true),
            ),
        )
        val summary = syncAllSummary(hostView, hostPlayback, now, elapsedMs = 5_000)
        assertTrue(summary.startsWith("Alle synchron (1)"), summary)
        assertTrue("1 allein" in summary, summary)
        assertTrue("1 ohne Unterstützung (ältere App/TV)" in summary, summary)
    }
}
