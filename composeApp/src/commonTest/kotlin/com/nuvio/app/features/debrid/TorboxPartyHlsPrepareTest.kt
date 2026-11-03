package com.nuvio.app.features.debrid

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

// prepareTorboxPartyHls without network: one createstream per preparation,
// bounded playlist polling and distinct failure reasons.
class TorboxPartyHlsPrepareTest {
    private val key = "account-secret"
    private val file = TorboxPartyFile(11, 0, torboxAccountFingerprint(key))
    private fun ok(url: String) = DebridApiResponse<JsonElement>(200,
        Json.parseToJsonElement("""{"success":true,"data":{"hls_url":"$url"}}"""), "")
    private fun status(code: Int) = DebridApiResponse<JsonElement>(code, Json.parseToJsonElement("""{"success":false}"""), "")

    private suspend fun prepare(
        create: DebridApiResponse<JsonElement>,
        probes: List<Int>,
        calls: MutableList<String> = mutableListOf(),
        pauses: MutableList<Long> = mutableListOf(),
    ): TorboxPartyHlsResult {
        var i = 0
        return prepareTorboxPartyHls(
            file, key,
            onProcessing = { calls += "processing" },
            createStream = { _, torrentId, fileId -> calls += "create-$torrentId-$fileId"; create },
            probe = { _, _ -> probes.getOrElse(i++) { probes.last() } },
            pause = { pauses += it },
        )
    }

    @Test
    fun readyAfterTranscodingWithASingleCreateStream() = runTest {
        val calls = mutableListOf<String>()
        val result = prepare(ok("https://stream.torbox.app/a.m3u8"), listOf(404, 404, 202, 200), calls)
        assertIs<TorboxPartyHlsResult.Ready>(result)
        assertEquals(listOf("create-11-0", "processing"), calls) // No duplicate TorBox session while polling.
    }

    @Test
    fun deniedRequestFailedAndUnsupportedAreDistinct() = runTest {
        assertEquals(TorboxHlsFailure.Denied, (prepare(status(403), listOf(200)) as TorboxPartyHlsResult.Failed).reason)
        assertEquals(TorboxHlsFailure.RequestFailed, (prepare(status(500), listOf(200)) as TorboxPartyHlsResult.Failed).reason)
        val missing = DebridApiResponse<JsonElement>(200, Json.parseToJsonElement("""{"success":true,"data":{"presigned_token":"x"}}"""), "")
        val unsupported = prepare(missing, listOf(200)) as TorboxPartyHlsResult.Failed
        assertEquals(TorboxHlsFailure.Unsupported, unsupported.reason)
        assertTrue("presigned_token" in unsupported.message && "\"x\"" !in unsupported.message)
        assertEquals(TorboxHlsFailure.Unsupported, (prepare(ok("https://cdn.example.net/a.m3u8"), listOf(200)) as TorboxPartyHlsResult.Failed).reason)
        assertEquals(TorboxHlsFailure.Denied, (prepare(ok("https://stream.torbox.app/a.m3u8"), listOf(404, 410)) as TorboxPartyHlsResult.Failed).reason)
        assertEquals(TorboxHlsFailure.Unsupported, (prepare(ok("https://stream.torbox.app/a.m3u8"), listOf(498)) as TorboxPartyHlsResult.Failed).reason)
    }

    @Test
    fun aPlaylistThatNeverAppearsEndsAsNotReadyAfterTheBoundedSchedule() = runTest {
        val calls = mutableListOf<String>()
        val pauses = mutableListOf<Long>()
        val result = prepare(ok("https://stream.torbox.app/a.m3u8"), listOf(404), calls, pauses)
        assertEquals(TorboxHlsFailure.NotReady, (result as TorboxPartyHlsResult.Failed).reason)
        assertEquals(TORBOX_PLAYLIST_POLL_DELAYS_MS, pauses) // Bounded, no endless retries.
        assertEquals(1, calls.count { it.startsWith("create") })
    }

    @Test
    fun accountChangeAndMissingKeyNeverCallTheApi() = runTest {
        val calls = mutableListOf<String>()
        val other = prepareTorboxPartyHls(file.copy(accountFingerprint = "other"), key,
            createStream = { _, _, _ -> calls += "create"; ok("https://stream.torbox.app/a.m3u8") })
        assertIs<TorboxPartyHlsResult.Failed>(other)
        val blank = prepareTorboxPartyHls(file, "", createStream = { _, _, _ -> calls += "create"; ok("https://stream.torbox.app/a.m3u8") })
        assertIs<TorboxPartyHlsResult.Failed>(blank)
        assertEquals(emptyList(), calls)
    }
}
