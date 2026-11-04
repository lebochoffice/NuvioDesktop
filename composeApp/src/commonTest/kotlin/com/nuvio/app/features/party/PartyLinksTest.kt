package com.nuvio.app.features.party

import com.nuvio.app.features.addons.RawHttpResponse
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

// Shared separate video (links protocol 1): proposals, identity and revision,
// the host-side file check and command epochs. No network (fetch injected).
class PartyLinksTest {
    private val media = PartyMedia(type = "movie", metaId = "tt1", metaType = "movie")
    private val keys = listOf("account-secret")

    private fun party(hostOnly: Boolean = false, memberId: String = "host") = ActiveParty(
        id = "room", code = "UXZ83H", memberId = memberId, hostMemberId = "host",
        members = listOf(PartyMember("host", "Host"), PartyMember("guest", "Guest")),
        presence = emptyMap(), media = media, maxMembers = 4, connected = true, hostOnly = hostOnly,
    )

    private fun command(key: String, memberId: String = "guest") = PartyCommand(
        commandId = "cmd-00000001", memberId = memberId, paused = true, positionMs = 1_000L, mediaKey = key, hostMemberId = "host",
    )

    @Test
    fun youTubeProposalsKeepOnlyTheVideoIdAndFilesNeedAMatchingPublicHttpsPath() {
        val yt = assertNotNull(PartyLinks.candidate("youtube", "https://www.youtube.com/watch?v=M7lc1UVf-VE&si=TRACKING", "M7lc1UVf-VE"))
        assertEquals("https://www.youtube.com/watch?v=M7lc1UVf-VE", yt.url)
        assertNull(PartyLinks.candidate("youtube", null, "../evil"))
        assertNull(PartyLinks.candidate("youtube", "https://www.youtube.com/watch?v=M7lc1UVf-VE", null))
        assertEquals("mp4", PartyLinks.candidate("mp4", "https://cdn.example.net/clip.MP4?sig=1", null)?.kind)
        assertEquals("webm", PartyLinks.candidate("webm", "https://cdn.example.net/clip.webm", null)?.kind)
        for (bad in listOf("https://cdn.example.net/clip.webm", "http://cdn.example.net/clip.mp4", "https://192.168.1.2/clip.mp4",
            "https://localhost/clip.mp4", "https://user:pw@cdn.example.net/clip.mp4", "https://cdn.example.net/clip.mp4#t=3",
            "https://cdn.example.net/clip.mkv")) assertNull(PartyLinks.candidate("mp4", bad, null), bad)
        assertNull(PartyLinks.candidate("hls", "https://cdn.example.net/a.m3u8", null)) // HLS keeps its own path.
    }

    @Test
    fun everyReplacementIsANewRevisionWithItsOwnKeyAndTheWireFormatIsStable() {
        val candidate = PartyLinks.candidate("youtube", null, "M7lc1UVf-VE")!!
        val first = PartyLinks.source(candidate, media.key, null, "YouTube", id = PartyLinks.newId(Random(1)))
        val second = PartyLinks.source(candidate, media.key, first, "YouTube\u0000 neu")
        assertEquals(1, first.rev); assertEquals(2, second.rev)
        assertEquals(PartyLinks.key(first.id, 1), first.key); assertNotEquals(first.key, second.key)
        assertEquals("YouTube neu", second.label)
        assertNull(first.url) // YouTube: only the ID travels.
        assertTrue(PartyLinks.valid(first, media.key)); assertFalse(PartyLinks.valid(first, "movie|tt2||"))
        assertFalse(PartyLinks.valid(first.copy(key = PartyLinks.key(first.id, 9)), media.key))
        assertFalse(PartyLinks.valid(first.copy(videoId = "bad"), media.key))
        assertTrue(PartyLinks.isLinkKey(first.key)); assertFalse(PartyLinks.isLinkKey(media.key))
        val json = Json.encodeToString(PartySharedSource.serializer(), first)
        assertTrue(json.contains("\"video_id\":\"M7lc1UVf-VE\"") && json.contains("\"party_key\":\"movie|tt1||\""), json)
        val file = PartyLinks.source(PartyLinks.candidate("mp4", "https://cdn.example.net/a.mp4", null)!!, media.key, second, "MP4")
        assertEquals(3, file.rev); assertTrue(PartyLinks.valid(file, media.key))
    }

    @Test
    fun linkCommandsHaveTheirOwnEpochAndTheSameMembershipAndHostOnlyRules() {
        val source = PartyLinks.source(PartyLinks.candidate("youtube", null, "M7lc1UVf-VE")!!, media.key, null, "YouTube")
        assertEquals(PartyCommandDecision.Accept, PartyLinks.decide(command(source.key), party(), source))
        assertEquals(PartyCommandDecision.Reject("stale_epoch"), PartyLinks.decide(command(PartyLinks.key(source.id, 0)), party(), source)) // Old revision.
        assertEquals(PartyCommandDecision.Reject("stale_epoch"), PartyLinks.decide(command(media.key), party(), source)) // Film command.
        assertEquals(PartyCommandDecision.Reject("stale_epoch"), PartyLinks.decide(command(source.key), party(), null)) // Link ended.
        assertEquals(PartyCommandDecision.Reject("host_only"), PartyLinks.decide(command(source.key), party(hostOnly = true), source))
        assertEquals(PartyCommandDecision.Reject("not_member"), PartyLinks.decide(command(source.key, "stranger"), party(), source))
        assertEquals(PartyCommandDecision.Reject("stale_epoch"), PartyLinks.decide(command(source.key), party(memberId = "guest"), source))
        // The film's sequencer never accepts a link command.
        assertEquals(PartyCommandDecision.Reject("stale_epoch"), PartyCommands.decide(command(source.key), party(), null))
    }

    private fun reply(status: Int, url: String, headers: Map<String, String> = emptyMap()) =
        RawHttpResponse(status = status, statusText = "", url = url, body = "", headers = headers)

    @Test
    fun aFileIsSharedOnlyWithRangeSupportAMatchingTypeAndNoPrivateRedirect() = runTest {
        val url = "https://cdn.example.net/clip.mp4?sig=1"
        val mp4 = PartyLinks.candidate("mp4", url, null)!!
        assertNull(PartyLinks.checkFile(mp4, keys) { reply(206, it, mapOf("Content-Type" to "video/mp4")) })
        assertNull(PartyLinks.checkFile(mp4, keys) { reply(206, it, mapOf("content-type" to "application/octet-stream")) })
        assertNotNull(PartyLinks.checkFile(mp4, keys) { reply(200, it, mapOf("Content-Type" to "video/mp4")) }) // No seeking.
        assertNotNull(PartyLinks.checkFile(mp4, keys) { reply(206, it, mapOf("Content-Type" to "text/html")) })
        assertNotNull(PartyLinks.checkFile(mp4, keys) { reply(403, it) })
        assertNotNull(PartyLinks.checkFile(mp4, keys) { reply(410, it) })
        val fetched = mutableListOf<String>()
        assertNotNull(PartyLinks.checkFile(mp4, keys) { target ->
            fetched += target
            if (target == url) reply(302, target, mapOf("Location" to "https://192.168.1.5/clip.mp4")) else reply(206, target)
        })
        assertEquals(listOf(url), fetched) // The private target is never requested.
        assertNull(PartyLinks.checkFile(mp4, keys) { target ->
            if (target == url) reply(302, target, mapOf("Location" to "/moved/clip.mp4")) else reply(206, target, mapOf("Content-Type" to "video/mp4"))
        })
        val keyed = PartyLinks.candidate("mp4", "https://cdn.example.net/clip.mp4?token=account-secret", null)!!
        var called = false
        assertNotNull(PartyLinks.checkFile(keyed, keys) { called = true; reply(206, it) })
        assertFalse(called) // An account key is never sent anywhere.
    }

    @Test
    fun theHostAnnouncesTheLinkCapabilityAsAnOptionalStatusField() {
        val encoded = Json.encodeToString(PartyPresence.serializer(), PartyPresence(memberId = "host", links = PartyLinks.PROTOCOL))
        assertTrue(encoded.contains("\"links\":1"), encoded)
        val legacy = Json { ignoreUnknownKeys = true }.decodeFromString(PartyPresence.serializer(), "{\"member_id\":\"guest\",\"status\":\"ready\"}")
        assertNull(legacy.links)
    }
}
