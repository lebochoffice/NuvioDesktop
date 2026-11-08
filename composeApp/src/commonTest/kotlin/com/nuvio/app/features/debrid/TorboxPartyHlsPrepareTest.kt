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
    fun aKeyBearingHlsUrlIsUsedOnlyWithoutTheKeyAndOnlyIfTorBoxServesIt() = runTest {
        val probed = mutableListOf<String>()
        suspend fun run(code: Int) = prepareTorboxPartyHls(file, key,
            createStream = { _, _, _ -> ok("https://stream.torbox.app/stream/p/0/0/0/0?token=$key") },
            probe = { url, _ -> probed += url; code },
            pause = {},
        )
        val ready = run(200)
        assertIs<TorboxPartyHlsResult.Ready>(ready)
        assertTrue(key !in ready.url && "token" !in ready.url)
        val refused = run(401) as TorboxPartyHlsResult.Failed
        assertEquals(TorboxHlsFailure.Unsupported, refused.reason)
        assertTrue("Account-Key" in refused.message && key !in refused.message)
        assertTrue(probed.none { key in it }) // The keyed URL is never requested or shared.
    }

    @Test
    fun aCdnStreamIsPreparedAndAnUnsafeRedirectStopsTheShare() = runTest {
        val cdn = "https://flux-007.wnam.tb-cdn.io/stream/p/0/0/0/0"
        assertIs<TorboxPartyHlsResult.Ready>(prepare(ok(cdn), listOf(200)))
        val keyed = prepareTorboxPartyHls(file, key, createStream = { _, _, _ -> ok("$cdn?token=$key") }, probe = { url, _ -> if (key in url) 500 else 200 }, pause = {})
        assertIs<TorboxPartyHlsResult.Ready>(keyed)
        assertTrue(key !in keyed.url)
        val unsafe = prepare(ok(cdn), listOf(TORBOX_PROBE_UNSAFE_HOST)) as TorboxPartyHlsResult.Failed
        assertEquals(TorboxHlsFailure.Unsupported, unsafe.reason)
        assertEquals(TorboxHlsFailure.Unsupported, (prepare(ok("https://evil-tb-cdn.io/a"), listOf(200)) as TorboxPartyHlsResult.Failed).reason)
    }

    @Test
    fun aPermanentTorBoxErrorSuchAs422EndsAtOnceInsteadOfPollingForTenMinutes() = runTest {
        for (code in listOf(422, 400, TORBOX_PROBE_NOT_HLS)) {
            val pauses = mutableListOf<Long>()
            val failed = prepare(ok("https://flux-007.wnam.tb-cdn.io/stream/p/0/0/0/0"), listOf(code), pauses = pauses) as TorboxPartyHlsResult.Failed
            assertEquals(TorboxHlsFailure.Unsupported, failed.reason)
            assertEquals(emptyList(), pauses, "HTTP $code must not be polled")
        }
        // Real processing states are still polled, bounded as before.
        val pauses = mutableListOf<Long>()
        assertIs<TorboxPartyHlsResult.Ready>(prepare(ok("https://stream.torbox.app/a.m3u8"), listOf(404, 503, 429, 200), pauses = pauses))
        assertEquals(3, pauses.size)
    }

    @Test
    fun withTheFamilyShareTheOriginalAddressWithItsTokenIsUsedUnchanged() = runTest {
        val keyed = "https://flux-007.wnam.tb-cdn.io/stream/p/0/0/0/0?token=$key"
        val probed = mutableListOf<Pair<String, String>>()
        val ready = prepareTorboxPartyHls(file, key, createStream = { _, _, _ -> ok(keyed) },
            probe = { url, checkKey -> probed += url to checkKey; TORBOX_PROBE_OK_NEEDS_TOKEN }, pause = {}, familyShare = true)
        assertIs<TorboxPartyHlsResult.Ready>(ready)
        assertEquals(keyed, ready.url); assertTrue(ready.familyOnly); assertTrue(ready.propagateToken)
        assertEquals(listOf(keyed to ""), probed) // Host-side probe of the original; no key-in-body check on it.
        // Without the share service the keyed address is never used, and a 422 for
        // the key-free address ends at once with a clear message.
        probed.clear()
        val refused = prepareTorboxPartyHls(file, key, createStream = { _, _, _ -> ok(keyed) },
            probe = { url, checkKey -> probed += url to checkKey; 422 }, pause = {}) as TorboxPartyHlsResult.Failed
        assertTrue("Freigabedienst" in refused.message && key !in refused.message)
        assertTrue(probed.single().first.let { key !in it })
        // A foreign host stays blocked even with the share service.
        assertIs<TorboxPartyHlsResult.Failed>(prepareTorboxPartyHls(file, key,
            createStream = { _, _, _ -> ok("https://evil-tb-cdn.io/a?token=$key") }, probe = { _, _ -> 200 }, pause = {}, familyShare = true))
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
