package com.nuvio.app.features.party

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PartyHostOnlyControlTest {
    private val media = PartyMedia(type = "movie", metaId = "film", metaType = "movie")
    private val guest = ActiveParty(
        id = "party", code = "ABCDEF", memberId = "guest", hostMemberId = "host",
        members = emptyList(), presence = emptyMap(), media = media, maxMembers = 8,
        connected = true, hostOnly = true,
    )

    @Test
    fun syncedGuestIsLockedButHostAndUnrestrictedGuestsAreNot() {
        assertTrue(guest.blocksManualPlayback(media.key, solo = false))
        assertFalse(guest.copy(memberId = "host").blocksManualPlayback(media.key, solo = false))
        assertFalse(guest.copy(hostOnly = false).blocksManualPlayback(media.key, solo = false))
        assertFalse(guest.blocksManualPlayback("another movie", solo = false))
    }

    @Test
    fun explicitSoloAllowsLocalControlWithoutChangingPartyPermission() {
        assertFalse(guest.blocksManualPlayback(media.key, solo = true))
        assertFalse(guest.canControl)
        assertTrue(guest.blocksManualPlayback(media.key, solo = false))
    }
}
