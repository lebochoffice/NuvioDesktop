package com.nuvio.app.features.debrid

import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

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
        assertEquals("Fehlgeschlagen", torboxHlsStatusLabel(TorboxHlsPhase.Failed, sharing = false))
    }
}
