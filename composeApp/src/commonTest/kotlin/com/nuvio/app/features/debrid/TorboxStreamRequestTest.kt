package com.nuvio.app.features.debrid

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class TorboxStreamRequestTest {
    @Test fun `creation preserves exact selected file and disables extra scrobbling`() {
        val query = torboxCreateStreamQuery(42, 7, 2, 1)
        assertTrue(query.contains("id=42"))
        assertTrue(query.contains("file_id=7"))
        assertTrue(query.contains("chosen_audio_index=2"))
        assertTrue(query.contains("chosen_resolution_index=1"))
        assertTrue(query.contains("scrobbling_enabled=false"))
        assertFalse(query.contains("token="))
        assertFalse(torboxCreateStreamQuery(42, 7).contains("chosen_resolution_index"))
    }
    @Test fun `missing or invalid stream inputs fail before network access`() {
        assertFailsWith<IllegalArgumentException> { torboxCreateStreamQuery(42, -1) }
        assertFailsWith<IllegalArgumentException> { torboxCreateStreamQuery(-1, 7) }
        assertFailsWith<IllegalArgumentException> { torboxCreateStreamQuery(42, 7, -1) }
        assertFailsWith<IllegalArgumentException> { torboxStreamDataQuery("", "signed") }
    }
    @Test fun `stream credentials cannot inject query parameters`() {
        val query = torboxStreamDataQuery("synthetic&admin=true", "signed")
        assertFalse(query.contains("&admin=true"))
        assertTrue(query.contains("presigned_token=signed"))
    }
}
