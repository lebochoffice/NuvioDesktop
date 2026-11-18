package com.nuvio.app.features.party

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PartySyncTraceTest {
    @Test fun disabledByDefaultAndBoundedWithoutSensitiveIdentityFields() {
        PartySyncTrace.disable()
        PartySyncTrace.record(PartySyncTrace.Event.Sample)
        assertTrue(PartySyncTrace.state.value.entries.isEmpty())
        PartySyncTrace.enable()
        try {
            val playback = PartyPlayback(1, "private-member-id", false, 0, at = 0, mediaKey = "private-file-id")
            repeat(300) { PartySyncTrace.record(PartySyncTrace.Event.Playback, PartySyncTrace.Source.Realtime, playback) }
            val snapshot = PartySyncTrace.state.value
            assertEquals(300L, snapshot.total)
            assertEquals(240, snapshot.entries.size)
            val text = PartySyncTrace.text(snapshot)
            assertFalse(text.contains("private-member-id"))
            assertFalse(text.contains("private-file-id"))
            assertTrue(text.contains("Realtime"))
        } finally { PartySyncTrace.disable() }
    }
}
