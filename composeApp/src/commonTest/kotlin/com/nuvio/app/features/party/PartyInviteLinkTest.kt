package com.nuvio.app.features.party

import kotlin.test.Test
import kotlin.test.assertEquals

class PartyInviteLinkTest {
    @Test
    fun officialBackendInvitesPointToTheBrowserWatchParty() {
        assertEquals("https://nuvio-watch-friends.pages.dev/party/UXZ83H", partyInviteLink("UXZ83H", customBackend = false))
    }

    @Test
    fun customBackendKeepsTheDeepLink() {
        assertEquals("nuvio://party/UXZ83H", partyInviteLink("UXZ83H", customBackend = true))
    }
}
