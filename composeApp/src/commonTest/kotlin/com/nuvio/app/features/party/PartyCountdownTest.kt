package com.nuvio.app.features.party

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

// Shared start (Phase B) and the optional tempo nudge (Phase C).
class PartyCountdownTest {
    private val key = "movie|tt1||"
    private fun payload(json: String): JsonObject = Json.parseToJsonElement(json).jsonObject

    @Test
    fun onlyTheHostsAnnouncementForThisTitleCloseToNowStartsACountdown() {
        val now = 100_000L
        val ok = payload("""{"member_id":"host","media_key":"$key","start_at":${now + 3_000},"seconds":3}""")
        assertEquals(PartyCountdownSignal.Start(PartyCountdown(now + 3_000, 3, key)), partyCountdownFrom("host", "host", key, ok, now))
        assertNull(partyCountdownFrom("guest", "host", key, ok, now)) // Not the host.
        assertNull(partyCountdownFrom("host", "host", "movie|tt9||", ok, now)) // Other title.
        for (seconds in listOf(0, 11)) {
            assertNull(partyCountdownFrom("host", "host", key, payload("""{"media_key":"$key","start_at":${now + 3_000},"seconds":$seconds}"""), now))
        }
        assertNull(partyCountdownFrom("host", "host", key, payload("""{"media_key":"$key","start_at":${now + 60_000},"seconds":3}"""), now)) // Too far ahead.
        assertNull(partyCountdownFrom("host", "host", key, payload("""{"media_key":"$key","start_at":${now - 5_000},"seconds":3}"""), now)) // Long over.
        assertEquals(PartyCountdownSignal.Cancel, partyCountdownFrom("host", "host", key, payload("""{"cancel":true}"""), now))
        assertNull(partyCountdownFrom("guest", "host", key, payload("""{"cancel":true}"""), now)) // Only the host cancels.
    }

    @Test
    fun theExpertOptionTurnsTempoNudgesIntoNoActionButKeepsSeeks() {
        val playing = PartyPlayback(seq = 1, memberId = "host", paused = false, positionMs = 60_000, at = 0, mediaKey = key)
        val drift = 60_000L + PartySync.NUDGE_START_MS + 100
        assertEquals(PartyCorrection.InSync, PartySync.correction(drift, 60_000, playing, nudging = false, allowNudge = false))
        // Default (option on): unchanged behaviour.
        assertEquals(true, PartySync.correction(drift, 60_000, playing, nudging = false) is PartyCorrection.Nudge)
        // Large drift still seeks either way.
        val far = 60_000L + PartySync.SEEK_THRESHOLD_MS + 500
        assertEquals(true, PartySync.correction(far, 60_000, playing, nudging = false, allowNudge = false) is PartyCorrection.Seek)
    }
}
