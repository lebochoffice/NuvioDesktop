package com.nuvio.app.features.party

import kotlin.test.Test
import kotlin.test.assertEquals

class PartyInviteLinkTest {
    @Test
    fun watchInNuvioUsesTheOriginalUpstreamInvite() {
        assertEquals("https://nuvio.tv/party/UXZ83H", partyInviteLink("UXZ83H", customBackend = false))
    }

    @Test
    fun theBrowserOriginIsProductionByDefault() {
        assertEquals(WATCH_PARTY_BROWSER_ORIGIN, watchPartyBrowserOrigin) // Tests are built without the preview property.
    }

    @Test
    fun customBackendKeepsTheDeepLink() {
        assertEquals("nuvio://party/UXZ83H", partyInviteLink("UXZ83H", customBackend = true))
    }
}
