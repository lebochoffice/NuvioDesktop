package com.nuvio.app.features.party

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PartyMediaRequestTest {
    private val current = PartyMedia(type = "movie", metaId = "tt1234567", metaType = "movie", title = "Current movie")
    private val next = current.copy(metaId = "tt2345678", title = "Next movie")
    private val guest = ActiveParty(
        id = "party", code = "ABCDEF", memberId = "guest", hostMemberId = "host",
        members = listOf(PartyMember("guest", "Guest"), PartyMember("host", "Host")),
        presence = emptyMap(), media = current, maxMembers = 8, connected = true, hostOnly = true,
    )

    @Test
    fun connectedGuestCanRequestDifferentMediaEvenWithHostOnlyEnabled() {
        assertTrue(guest.canRequestMedia(next))
        assertFalse(guest.canRequestMedia(current))
        assertFalse(guest.copy(connected = false).canRequestMedia(next))
        assertFalse(guest.copy(hostMemberId = "guest").canRequestMedia(next))
        assertFalse(guest.copy(members = listOf(PartyMember("guest", "Guest"))).canRequestMedia(next))
    }

    @Test
    fun concreteEpisodeKeepsOnlyMediaIdentityAndShortDisplayTitle() {
        val episode = PartyMedia(type = "series", metaId = "tt1234567", metaType = "series",
            videoId = "tt1234567:2:3", season = 2, episode = 3, title = "Series\u0000",
            description = "Private metadata", poster = "https://example.test/poster",
            source = PartySource(addonId = "private-addon"))
        val request = assertNotNull(episode.forMediaRequest())
        assertEquals(episode.key, request.key)
        assertEquals("tt1234567:2:3", request.videoId)
        assertEquals("Series", request.title)
        assertNull(request.source)
        assertNull(request.poster)
        assertNull(request.description)
        assertNull(episode.copy(videoId = null).forMediaRequest())
        assertNull(episode.copy(episode = null).forMediaRequest())
        assertNull(episode.copy(metaId = "https://example.test/episode").forMediaRequest())
    }

    @Test
    fun onlyTheCurrentHostCanManageARequestFromAStillPresentMember() {
        val host = guest.copy(memberId = "host")
        val request = PartyMediaRequest(1, host.id, "host", "guest", current.key, next)
        assertTrue(request.isCurrent(host))
        assertFalse(request.isCurrent(guest))
        assertFalse(request.isCurrent(host.copy(hostMemberId = "guest")))
        assertFalse(request.isCurrent(host.copy(id = "another-party")))
        assertFalse(request.isCurrent(host.copy(media = next)))
        assertFalse(request.isCurrent(host.copy(members = listOf(PartyMember("host", "Host")))))
        assertEquals(current, host.media)
        assertEquals("ABCDEF", host.code)
    }

    @Test
    fun ownSourceSelectionUsesTheExactCurrentEpisodeAndRejectsStaleActions() {
        val host = guest.copy(memberId = "host")
        val episode = PartyMedia(type = "series", metaType = "series", metaId = "tt2345678",
            videoId = "tt2345678:2:3", season = 2, episode = 3, title = "Series")
        val request = PartyMediaRequest(7, host.id, "host", "guest", current.key, episode)
        assertEquals(episode, request.mediaForOwnSelection(7.0, host))
        assertNull(request.mediaForOwnSelection(6.0, host))
        assertNull(request.mediaForOwnSelection(7.0, guest))
        assertNull(request.mediaForOwnSelection(7.0, host.copy(connected = false)))
        assertNull(request.mediaForOwnSelection(7.0, host.copy(media = next)))
        assertNull(request.mediaForOwnSelection(7.0, host.copy(members = listOf(PartyMember("host", "Host")))))
        assertEquals(current, host.media)
    }
}
