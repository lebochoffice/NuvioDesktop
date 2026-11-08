package com.nuvio.app.features.party

import com.nuvio.app.features.player.sanitizePlaybackHeaders
import com.nuvio.app.features.streams.StreamBadge
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerialName
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive

class PartyStreamTest {
    private val stream = PartyStream(
        mediaKey = "movie|tt1||",
        url = "https://cdn.example.com/movie.mkv",
        headers = mapOf("Referer" to "https://example.com"),
        responseHeaders = mapOf("Content-Type" to "video/x-matroska"),
        name = "TB HD",
        description = "Movie 2017\n1.5 GB",
        addonName = "Torrentio",
        addonId = "addon:torrentio",
        addonLogo = "https://example.com/logo.png",
        filename = "movie.mkv",
        videoSize = 1_500_000_000L,
        bingeGroup = "torrentio|720p",
        streamType = "mkv",
        badges = listOf(StreamBadge(name = "HDR", imageURL = "https://example.com/hdr.png")),
    )

    @Test
    fun hostConsentProducesFourIndependentStreamOffers() {
        val party = ActiveParty(
            id = "party", code = "UXZ83H", memberId = "host", hostMemberId = "host",
            members = emptyList(), presence = emptyMap(), media = PartyMedia("movie", "tt1", "movie"),
            maxMembers = 8, connected = true,
        )
        val browser = PartyBrowserHls("https://stream.example.test/master.m3u8")
        assertNull(party.streamOffer(stream, browser))

        val desktopOnly = assertNotNull(party.copy(sharing = true).streamOffer(stream, browser))
        assertEquals(stream, desktopOnly.forDesktop())
        assertEquals(PartyBrowserHls(state = "disabled"), desktopOnly.browserHls)

        val browserOnly = assertNotNull(party.copy(browserSharing = true).streamOffer(stream, browser))
        assertNull(browserOnly.forDesktop())
        assertEquals("", browserOnly.url)
        assertEquals(stream.mediaKey, browserOnly.mediaKey)
        assertEquals(browser, browserOnly.browserHls)
        assertTrue(browserOnly.headers.isEmpty())

        val both = party.copy(sharing = true, browserSharing = true)
        val combined = assertNotNull(both.streamOffer(stream, browser))
        assertEquals(stream, combined.forDesktop())
        assertEquals(browser, combined.browserHls)
        assertEquals(desktopOnly, both.copy(browserSharing = false).streamOffer(combined, combined.browserHls))
        assertEquals(browserOnly, both.copy(sharing = false).streamOffer(combined, combined.browserHls))
        assertEquals(stream, both.streamOffer(stream, PartyBrowserHls(state = "preparing"))?.forDesktop())
        assertEquals(browserOnly, both.streamOffer(stream.copy(url = "http://localhost/video"), browser))
        assertEquals(browserOnly, both.streamOffer(stream.copy(mediaKey = "previous-title"), browser))
        assertNull(both.copy(hostMemberId = "new-host").streamOffer(stream, browser))
    }

    @Test
    fun remoteLinksCanBeShared() {
        assertTrue(isShareableStreamUrl("https://cdn.example.com/movie.mkv"))
        assertTrue(isShareableStreamUrl("http://192.168.1.20:8096/video"))
    }

    @Test
    fun localAndNonWebLinksCannotBeShared() {
        assertFalse(isShareableStreamUrl("http://127.0.0.1:11470/stream"))
        assertFalse(isShareableStreamUrl("http://localhost:8080/video"))
        assertFalse(isShareableStreamUrl("http://[::1]:8080/video"))
        assertFalse(isShareableStreamUrl("http://0.0.0.0/video"))
        assertFalse(isShareableStreamUrl("file:///data/movie.mkv"))
        assertFalse(isShareableStreamUrl("magnet:?xt=urn:btih:abc"))
    }

    @Test
    fun sharedStreamKeepsCardDetailsAndHeaders() {
        val item = stream.toStreamItem()
        assertEquals("https://cdn.example.com/movie.mkv", item.playableDirectUrl)
        assertEquals("TB HD", item.streamLabel)
        assertEquals("Movie 2017\n1.5 GB", item.streamSubtitle)
        assertEquals("Torrentio", item.addonName)
        assertEquals("https://example.com/logo.png", item.addonLogo)
        assertEquals(1_500_000_000L, item.behaviorHints.videoSize)
        assertEquals("movie.mkv", item.behaviorHints.filename)
        assertEquals(mapOf("Referer" to "https://example.com"), item.behaviorHints.proxyHeaders?.request)
        assertEquals("HDR", item.badges.single().name)
        assertFalse(item.isTorrentStream)
    }

    @Test
    fun sharedStreamSurvivesTheWire() {
        val encoded = PartyApi.json.encodeToString(PartyStream.serializer(), stream)
        assertEquals(stream, PartyApi.json.decodeFromString(PartyStream.serializer(), encoded))
    }

    @Test
    fun browserHlsCannotChangeDesktopQualityHeadersOrMetadata() {
        val shared = stream.copy(browserHls = PartyBrowserHls("https://stream.example.test/master.m3u8"))
        assertEquals(stream, shared.forDesktop())
        assertEquals(stream.toStreamItem(), shared.toStreamItem())
        val renewed = shared.copy(browserHls = PartyBrowserHls("https://stream.example.test/renewed.m3u8"))
        assertEquals(shared.forDesktop(), renewed.forDesktop())
        val pending = shared.copy(browserHls = PartyBrowserHls())
        assertEquals(stream, pending.forDesktop())
        val json = PartyApi.json.encodeToJsonElement(PartyStream.serializer(), shared) as JsonObject
        assertEquals(stream.url, json.getValue("url").jsonPrimitive.content)
        assertEquals(shared, PartyApi.json.decodeFromString(PartyStream.serializer(), json.toString()))
    }

    @Test
    fun previousDesktopWireModelIgnoresTheOptionalBrowserSource() {
        val shared = stream.copy(browserHls = PartyBrowserHls("https://stream.example.test/master.m3u8"))
        val encoded = PartyApi.json.encodeToString(PartyStream.serializer(), shared)
        val legacy = PartyApi.json.decodeFromString(LegacyDesktopStream.serializer(), encoded)
        assertEquals(stream.mediaKey, legacy.mediaKey)
        assertEquals(stream.url, legacy.url)
        assertEquals(stream.headers, legacy.headers)
        assertEquals(stream.filename, legacy.filename)
        assertEquals(stream.videoSize, legacy.videoSize)
        // Conversely a pre-extension message still decodes to the same original.
        val oldWire = PartyApi.json.encodeToString(PartyStream.serializer(), stream)
        assertEquals(stream, PartyApi.json.decodeFromString(PartyStream.serializer(), oldWire))
    }

    @Test
    fun detectsCompleteAccountKeysInSourcesAndHeaders() {
        val accountKey = "synthetic-account-secret"
        assertFalse(stream.containsAccountKey(accountKey))
        assertTrue(stream.copy(headers = mapOf("Authorization" to "Bearer $accountKey")).containsAccountKey(accountKey))
        assertTrue(stream.copy(browserHls = PartyBrowserHls("https://stream.example.test/a?token=synthetic%2Daccount%2Dsecret")).containsAccountKey(accountKey))
        assertFalse(stream.copy(browserHls = PartyBrowserHls("https://stream.example.test/a?token=scoped")).containsAccountKey(accountKey))
    }

    @Test
    fun consentedOriginalKeepsPlaybackCredentialsForTheCurrentGuest() {
        val original = stream.copy(
            url = "https://cdn.example.com/movie.mkv?token=synthetic-account-key",
            headers = mapOf(
                "Authorization" to "Bearer synthetic-account-key",
                "Cookie" to "session=synthetic-session",
                "Referer" to "https://addon.example",
                "Origin" to "https://addon.example",
                "User-Agent" to "Synthetic Player",
            ),
        )
        val host = ActiveParty(
            id = "party", code = "UXZ83H", memberId = "host", hostMemberId = "host",
            members = emptyList(), presence = emptyMap(), media = PartyMedia("movie", "tt1", "movie"),
            maxMembers = 8, connected = true, sharing = true, browserSharing = true,
        )
        val guest = host.copy(memberId = "guest", sharing = false)
        val browser = PartyBrowserHls("https://stream.example.test/master.m3u8")
        val offer = assertNotNull(host.streamOffer(original, browser))
        val wire = PartyApi.json.encodeToString(PartyStream.serializer(), offer)
        val received = PartyApi.json.decodeFromString(PartyStream.serializer(), wire)
        val item = assertNotNull(guest.desktopStreamFor(guest.media.key, received)).toStreamItem()
        assertEquals(original.url, item.playableDirectUrl)
        assertEquals(original.headers, item.behaviorHints.proxyHeaders?.request)
        assertEquals(original.headers, sanitizePlaybackHeaders(item.behaviorHints.proxyHeaders?.request))
        assertEquals(original.responseHeaders, item.behaviorHints.proxyHeaders?.response)
        assertEquals(browser, received.browserHls)

        val revoked = assertNotNull(host.copy(sharing = false).streamOffer(received, received.browserHls))
        assertNull(guest.desktopStreamFor(guest.media.key, revoked))
        assertEquals(browser, revoked.browserHls)
        assertTrue(revoked.headers.isEmpty())
        assertNull(guest.desktopStreamFor(guest.media.key, null))
        assertNull(guest.desktopStreamFor(guest.media.key, original.copy(url = "file:///local/movie.mkv")))
        assertNull(guest.desktopStreamFor("movie|tt2||", received))
        assertNull(host.desktopStreamFor(host.media.key, received))
    }
}

@Serializable
private data class LegacyDesktopStream(
    @SerialName("media_key") val mediaKey: String,
    val url: String,
    val headers: Map<String, String> = emptyMap(),
    val filename: String? = null,
    @SerialName("video_size") val videoSize: Long? = null,
)
