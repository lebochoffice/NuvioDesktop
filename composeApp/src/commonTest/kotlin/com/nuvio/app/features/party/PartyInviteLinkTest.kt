package com.nuvio.app.features.party

import kotlin.test.Test
import kotlin.test.assertEquals

class PartyInviteLinkTest {
    @Test
    fun watchInNuvioUsesTheOriginalUpstreamInvite() {
        assertEquals("https://nuvio.tv/party/UXZ83H", partyInviteLink("UXZ83H", customBackend = false))
    }

    @Test
    fun theBrowserOriginIsFamilyBetaByDefault() {
        assertEquals("https://family-beta.nuvio-watch-friends.pages.dev", watchPartyBrowserOrigin) // Run without an origin override.
    }

    @Test
    fun customBackendKeepsTheDeepLink() {
        assertEquals("nuvio://party/UXZ83H", partyInviteLink("UXZ83H", customBackend = true))
    }
}
