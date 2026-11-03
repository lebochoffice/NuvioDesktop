package com.nuvio.app.features.debrid

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

class TorboxPartyHlsTest {
    private fun response(url: String) = Json.parseToJsonElement("""{"success":true,"data":{"hls_url":"$url","user_token":"account-secret"}}""")
    @Test fun `only the prepared hls url is projected from a secret bearing response`() {
        assertEquals("https://stream.torbox.app/session/master.m3u8?token=scoped", torboxShareableHls(response("https://stream.torbox.app/session/master.m3u8?token=scoped"), "account-secret"))
    }
    @Test fun `account keys cannot pass in raw encoded query or path`() {
        for (url in listOf("https://stream.torbox.app/a?token=account-secret", "https://stream.torbox.app/a?token=account%2Dsecret", "https://stream.torbox.app/account%2Dsecret/a")) {
            assertNull(torboxShareableHls(response(url), "account-secret"))
        }
    }
    @Test fun `invalid responses unsupported domains and credentials fail closed`() {
        for (json in listOf("null", "[]", "{}", """{"success":{},"data":{}}""", """{"success":false,"data":{"hls_url":"https://stream.torbox.app/a"}}""")) {
            assertNull(torboxShareableHls(Json.parseToJsonElement(json), "account-secret"))
        }
        for (url in listOf("http://stream.torbox.app/a", "https://127.0.0.1/a", "https://other.example/a", "https://user:secret@stream.torbox.app/a")) {
            assertNull(torboxShareableHls(response(url), "account-secret"))
        }
    }
    @Test fun `panel status distinguishes the phases and counts a ready source as sent only while sharing`() {
        assertEquals("Nicht verfügbar", torboxHlsStatusLabel(TorboxHlsPhase.Unavailable, sharing = true))
        assertEquals("HLS wird vorbereitet …", torboxHlsStatusLabel(TorboxHlsPhase.Preparing, sharing = true))
        assertEquals("An Teilnehmer gesendet", torboxHlsStatusLabel(TorboxHlsPhase.Ready, sharing = true))
        assertEquals("HLS bereit (Share my stream ist aus)", torboxHlsStatusLabel(TorboxHlsPhase.Ready, sharing = false))
        assertEquals("Zugriff verweigert", torboxHlsStatusLabel(TorboxHlsPhase.Denied, sharing = true))
        assertEquals("Link abgelaufen – wird erneuert …", torboxHlsStatusLabel(TorboxHlsPhase.Expired, sharing = true))
        assertEquals("API-Anfrage fehlgeschlagen", torboxHlsStatusLabel(TorboxHlsPhase.Failed, sharing = false))
        assertEquals("TorBox verarbeitet den Stream, Playlist noch nicht fertig …", torboxHlsStatusLabel(TorboxHlsPhase.Processing, sharing = true))
        assertEquals("Playlist nicht rechtzeitig fertig", torboxHlsStatusLabel(TorboxHlsPhase.NotReady, sharing = true))
        assertEquals("Quelle nicht unterstützt", torboxHlsStatusLabel(TorboxHlsPhase.Unsupported, sharing = true))
    }
    @Test fun `createstream results are told apart without guessing fields or keeping values`() {
        val missing = torboxHlsCandidate(Json.parseToJsonElement("""{"success":true,"data":{"presigned_token":"SECRET_VALUE","user_token":"account-secret","stream_id":1}}"""), "account-secret")
        assertEquals(TorboxHlsCandidate.Missing(listOf("presigned_token", "stream_id", "user_token")), missing)
        assertTrue("SECRET_VALUE" !in missing.toString() && "account-secret" !in missing.toString())
        assertEquals(TorboxHlsCandidate.UnsafeHost("cdn.example.net"), torboxHlsCandidate(response("https://cdn.example.net/a.m3u8"), "account-secret"))
        assertEquals(TorboxHlsCandidate.ContainsAccountKey, torboxHlsCandidate(response("https://stream.torbox.app/account-secret/a"), "account-secret"))
        assertEquals(TorboxHlsCandidate.ContainsAccountKey, torboxHlsCandidate(response("https://stream.torbox.app/a?x=account-secret&token=account-secret"), "account-secret"))
        assertEquals(TorboxHlsCandidate.Url("https://stream.torbox.app/a.m3u8"), torboxHlsCandidate(response("https://stream.torbox.app/a.m3u8"), "account-secret"))
        assertEquals(TorboxHlsCandidate.Invalid, torboxHlsCandidate(Json.parseToJsonElement("""{"success":false}"""), "account-secret"))
    }
    @Test fun `playlist polling waits for long transcodes but stays bounded`() {
        assertEquals(2_000L, TORBOX_PLAYLIST_POLL_DELAYS_MS.first())
        val total = TORBOX_PLAYLIST_POLL_DELAYS_MS.sum()
        assertTrue(total in 9 * 60_000L..10 * 60_000L + 30_000L, "total=$total")
        assertTrue(TORBOX_PLAYLIST_POLL_DELAYS_MS.all { it <= 15_000L })
    }
    @Test fun `browser state names follow the panel phase`() {
        assertEquals("preparing", torboxBrowserState(TorboxHlsPhase.Preparing))
        assertEquals("preparing", torboxBrowserState(TorboxHlsPhase.Expired))
        assertEquals("processing", torboxBrowserState(TorboxHlsPhase.Processing))
        assertEquals("denied", torboxBrowserState(TorboxHlsPhase.Denied))
        assertEquals("failed", torboxBrowserState(TorboxHlsPhase.Failed))
        assertEquals("failed", torboxBrowserState(TorboxHlsPhase.NotReady))
        assertEquals("unsupported", torboxBrowserState(TorboxHlsPhase.Unsupported))
    }
    @Test fun `a key only in the token parameter yields the key free variant, never the keyed url`() {
        for (url in listOf("https://stream.torbox.app/stream/p/0/0/0/0?token=account-secret", "https://stream.torbox.app/stream/p/0/0/0/0?token=account%2Dsecret&res=1")) {
            val candidate = torboxHlsCandidate(response(url), "account-secret")
            assertIs<TorboxHlsCandidate.KeyOnlyInTokenParameter>(candidate)
            assertTrue(candidate.keyFreeUrl.startsWith("https://stream.torbox.app/stream/p/0/0/0/0"))
            assertTrue("account" !in candidate.keyFreeUrl && "token" !in candidate.keyFreeUrl, candidate.keyFreeUrl)
        }
        assertTrue("res=1" in (torboxHlsCandidate(response("https://stream.torbox.app/a?token=account-secret&res=1"), "account-secret") as TorboxHlsCandidate.KeyOnlyInTokenParameter).keyFreeUrl)
    }
    @Test fun `cloud choices list only video files with their real ids`() {
        val choices = torboxCloudVideoChoices(cloud("""[
            {"id":21,"hash":"a","files":[{"id":3,"short_name":"Zeta.S01E02.mkv","size":2147483648},{"id":4,"name":"readme.txt"}]},
            {"id":22,"hash":"b","files":[{"id":0,"name":"alpha.bin","mimetype":"video/mp4"},{"id":"bad","name":"x.mkv"}]},
            {"id":"bad","hash":"c","files":[{"id":1,"name":"y.mkv"}]}
        ]"""))
        assertEquals(listOf(TorboxCloudChoice(22, 0, "alpha.bin", null), TorboxCloudChoice(21, 3, "Zeta.S01E02.mkv", 2147483648)), choices)
    }
    private fun cloud(json: String) = Json { ignoreUnknownKeys = true }.decodeFromString<List<TorboxCloudItemDto>>(json)
    @Test fun `an addon stream maps only to a unique file of the user's own TorBox cloud`() {
        val items = cloud("""[
            {"id":11,"hash":"ABCDEF","files":[{"id":0,"name":"Film.2024.2160p.mkv"},{"id":1,"name":"sample.mkv"},{"id":2,"name":"info.nfo"}]},
            {"id":12,"hash":"123456","files":[{"id":5,"name":"Only.Video.mp4","mimetype":"video/mp4"},{"id":6,"name":"cover.jpg"}]},
            {"id":13,"hash":"dup","files":[{"id":1,"name":"a.mkv"}]},
            {"id":14,"hash":"DUP","files":[{"id":1,"name":"a.mkv"}]},
            {"id":"x","hash":"badid","files":[{"id":1,"name":"a.mkv"}]}
        ]""")
        assertEquals(11 to 0, matchTorboxCloudFile(items, "abcdef", "Film.2024.2160p.mkv"))
        assertEquals(11 to 0, matchTorboxCloudFile(items, "abcdef", "/some/dir/film.2024.2160P.MKV")) // Case and path insensitive.
        assertNull(matchTorboxCloudFile(items, "abcdef", null)) // Two video files: not unique.
        assertEquals(12 to 5, matchTorboxCloudFile(items, "123456", null)) // The only video file.
        assertNull(matchTorboxCloudFile(items, "abcdef", "other.mkv")) // No file with that name.
        assertNull(matchTorboxCloudFile(items, "dup", "a.mkv")) // Hash not unique.
        assertNull(matchTorboxCloudFile(items, "badid", "a.mkv")) // No valid id.
        assertNull(matchTorboxCloudFile(items, "ffff", "a.mkv")) // Not in the cloud.
        assertNull(matchTorboxCloudFile(items, " ", "a.mkv"))
    }
}
