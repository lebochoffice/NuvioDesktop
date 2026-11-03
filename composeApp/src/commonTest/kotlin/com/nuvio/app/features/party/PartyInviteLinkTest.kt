package com.nuvio.app.features.party

import kotlin.test.Test
import kotlin.test.assertEquals

class PartyInviteLinkTest {
    @Test
    fun officialBackendInvitesPointToTheBrowserWatchParty() {
        assertEquals("https://nuvio-watch-friends.pages.dev/party/UXZ83H", partyInviteLink("UXZ83H", customBackend = false))
    }

    @Test
    fun defaultBuildUsesProductionAndTheTestBuildOnlyTheExactPreview() {
        assertEquals(WATCH_PARTY_BROWSER_ORIGIN, watchPartyBrowserOrigin) // Tests are built without the preview property.
        assertEquals(
            "https://feature-party-premium-ui.nuvio-watch-friends.pages.dev/party/UXZ83H",
            partyInviteLink("UXZ83H", customBackend = false, origin = WATCH_PARTY_BROWSER_PREVIEW_ORIGIN),
        )
        assertEquals("nuvio://party/UXZ83H", partyInviteLink("UXZ83H", customBackend = true, origin = WATCH_PARTY_BROWSER_PREVIEW_ORIGIN))
    }

    @Test
    fun customBackendKeepsTheDeepLink() {
        assertEquals("nuvio://party/UXZ83H", partyInviteLink("UXZ83H", customBackend = true))
    }
}
