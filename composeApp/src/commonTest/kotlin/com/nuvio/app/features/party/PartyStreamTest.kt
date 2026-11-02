package com.nuvio.app.features.party

import com.nuvio.app.features.streams.StreamBadge
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
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
        badges = listOf(StreamBadge(name = "HDR", imageURL = "https://example.com/hdr.png")),
    )

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
    fun completeAccountKeysAreForbiddenInBothSourcesAndHeaders() {
        val accountKey = "synthetic-account-secret"
        assertFalse(stream.containsAccountKey(accountKey))
        assertTrue(stream.copy(headers = mapOf("Authorization" to "Bearer $accountKey")).containsAccountKey(accountKey))
        assertTrue(stream.copy(browserHls = PartyBrowserHls("https://stream.example.test/a?token=synthetic%2Daccount%2Dsecret")).containsAccountKey(accountKey))
        assertFalse(stream.copy(browserHls = PartyBrowserHls("https://stream.example.test/a?token=scoped")).containsAccountKey(accountKey))
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
