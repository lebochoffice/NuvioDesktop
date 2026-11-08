package com.nuvio.app

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class WindowsPartyLinksTest {
    @Test
    fun normalizesPartyCodeFromWindowsLaunchArgument() {
        assertEquals("KWWWF9", windowsPartyInvitation("nuvio://party/KWWWF9")?.code)
        assertEquals("KWWWF9", windowsPartyInvitation("NUVIO://PARTY/kww-wf9")?.code)
        assertEquals("KWWWF9", windowsPartyInvitation("nuvio://party?code=kww-wf9")?.code)
    }

    @Test
    fun malformedPartyInvitationsAreDistinguishedFromOtherActions() {
        for (value in listOf("nuvio://party", "nuvio://party/KWWWF", "nuvio://party/KWWWF9/extra", "nuvio://party/KWWWF9!")) {
            assertNull(assertNotNull(windowsPartyInvitation(value)).code)
        }
        assertNull(windowsPartyInvitation("nuvio://auth/trakt?code=sample"))
        assertNull(windowsPartyInvitation("nuvio://party.example/KWWWF9"))
    }
}
