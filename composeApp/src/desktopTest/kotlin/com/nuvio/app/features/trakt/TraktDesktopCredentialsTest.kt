package com.nuvio.app.features.trakt

import kotlin.test.Test
import kotlin.test.assertNull

class TraktDesktopCredentialsTest {
    @Test
    fun desktopHasNoLegacySecret() {
        assertNull(traktLegacyClientSecret)
    }
}
