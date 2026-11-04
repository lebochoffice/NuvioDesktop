package com.nuvio.app.features.party

import com.nuvio.app.features.addons.RawHttpResponse
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

// The host's own video link: syntax, VOD playlist check and key protection,
// without network (fetch is injected).
class PartyHostHlsTest {
    private val keys = listOf("account-secret")
    private val vod = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg0.ts\n#EXTINF:6.0,\nseg1.ts\n#EXT-X-ENDLIST\n"
    private val live = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg0.ts\n"
    private val master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nvariant/720.m3u8\n"

    private fun response(url: String, body: String, status: Int = 200, finalUrl: String = url) =
        RawHttpResponse(status = status, statusText = "", url = finalUrl, body = body, headers = emptyMap())

    private suspend fun check(url: String, pages: Map<String, RawHttpResponse>, fetched: MutableList<String> = mutableListOf()) =
        checkPartyHostHls(url, keys) { target -> fetched += target; pages[target] ?: response(target, "", 404) }

    @Test
    fun onlyPublicHttpsLinksWithoutCredentialsOrKeysPassTheSyntaxCheck() {
        assertNull(partyHostHlsProblem("https://cdn.example.net/movie/index.m3u8?sig=abc", keys))
        for (bad in listOf("", "http://cdn.example.net/a.m3u8", "https://localhost/a.m3u8", "https://192.168.1.4/a.m3u8",
            "https://10.0.0.1/a.m3u8", "https://user:pw@cdn.example.net/a.m3u8", "https://cdn.example.net/a.m3u8#t=1",
            "https://cdn.example.net/a b.m3u8", "https://nas.local/a.m3u8", "https://cdn.example.net/a.m3u8?token=account-secret",
            "https://cdn.example.net/account%2Dsecret/a.m3u8", "https://cdn.example.net/" + "a".repeat(PARTY_HOST_HLS_MAX_LENGTH))) {
            assertNotNull(partyHostHlsProblem(bad, keys), bad)
        }
        // The problem text never repeats the link (it may carry tokens).
        assertTrue("account-secret" !in partyHostHlsProblem("https://cdn.example.net/a?token=account-secret", keys).orEmpty())
    }

    @Test
    fun aFinishedMediaPlaylistIsAcceptedAndLiveOrNonHlsIsRejected() = runTest {
        val url = "https://cdn.example.net/movie/index.m3u8"
        assertEquals(PartyHostHlsCheck.Ok(url), check(url, mapOf(url to response(url, vod))))
        assertIs<PartyHostHlsCheck.Problem>(check(url, mapOf(url to response(url, live))))
        assertIs<PartyHostHlsCheck.Problem>(check(url, mapOf(url to response(url, "<html>login</html>"))))
        assertIs<PartyHostHlsCheck.Problem>(check(url, mapOf(url to response(url, vod, status = 403))))
        assertIs<PartyHostHlsCheck.Problem>(check(url, emptyMap()))
    }

    @Test
    fun aMasterPlaylistIsAcceptedOnlyIfItsFirstVariantIsAFinishedVod() = runTest {
        val url = "https://cdn.example.net/movie/master.m3u8?sig=1"
        val variant = "https://cdn.example.net/movie/variant/720.m3u8"
        val fetched = mutableListOf<String>()
        assertEquals(PartyHostHlsCheck.Ok(url), check(url, mapOf(url to response(url, master), variant to response(variant, vod)), fetched))
        assertEquals(listOf(url, variant), fetched)
        assertIs<PartyHostHlsCheck.Problem>(check(url, mapOf(url to response(url, master), variant to response(variant, live))))
        assertEquals("https://cdn.example.net/root/a.m3u8", resolveHlsUri("https://cdn.example.net/x/y.m3u8", "/root/a.m3u8"))
        assertNull(resolveHlsUri("https://cdn.example.net/x/y.m3u8", "http://other.example/a.m3u8"))
    }

    @Test
    fun accountKeysInsideThePlaylistAndRedirectsToPrivateHostsAreRejected() = runTest {
        val url = "https://cdn.example.net/movie/index.m3u8"
        val keyed = vod.replace("seg0.ts", "seg0.ts?token=account-secret")
        val problem = check(url, mapOf(url to response(url, keyed)))
        assertIs<PartyHostHlsCheck.Problem>(problem)
        assertTrue("account-secret" !in problem.message)
        assertIs<PartyHostHlsCheck.Problem>(check(url, mapOf(url to response(url, vod, finalUrl = "https://127.0.0.1/index.m3u8"))))
    }

    @Test
    fun aTorBoxLinkWithTheKeyInTokenIsSharedOnlyWithoutTheKeyAndOnlyOnTorBoxHosts() = runTest {
        val keyed = "https://flux-007.wnam.tb-cdn.io/stream/p/0/0/0/0?token=account-secret"
        val keyFree = "https://flux-007.wnam.tb-cdn.io/stream/p/0/0/0/0"
        val fetched = mutableListOf<String>()
        assertEquals(PartyHostHlsCheck.Ok(keyFree, keyRemoved = true), check(keyed, mapOf(keyFree to response(keyFree, vod)), fetched))
        assertTrue(fetched.none { "account-secret" in it }) // The keyed address is never requested.
        val refused = check(keyed, mapOf(keyFree to response(keyFree, vod, status = 401)))
        assertIs<PartyHostHlsCheck.Problem>(refused)
        assertTrue("ohne Account-Key" in refused.message && "account-secret" !in refused.message)
        assertIs<PartyHostHlsCheck.Problem>(check(keyed, mapOf(keyFree to response(keyFree, vod, finalUrl = "https://cdn.example.net/x.m3u8"))))
        // Outside TorBox the key stays blocked, wherever it is.
        assertIs<PartyHostHlsCheck.Problem>(check("https://cdn.example.net/a.m3u8?token=account-secret", emptyMap()))
    }

    @Test
    fun aSuggestionShowsOnlyTheHostName() {
        assertEquals("cdn.example.net", partyHlsDisplayHost("https://cdn.example.net/a.m3u8?token=private"))
        assertEquals("unbekannter Host", partyHlsDisplayHost("not a url"))
    }
    @Test
    fun memberNamesUseTheAccountNameThenTheMailLocalPartThenANumber() {
        assertEquals("Anna", partyMemberLabel("Anna", 0))
        assertEquals("Mitglied 2", partyMemberLabel("Nuvio-Mitglied", 1))
        assertEquals("Mitglied 3", partyMemberLabel("  ", 2))
        assertEquals("Mitglied 1", partyMemberLabel("Nuvio", 0))
        assertEquals("max.mustermann", partyEmailName("max.mustermann@example.test"))
        assertNull(partyEmailName("a@example.test")) // Too short to be a name.
        assertNull(partyEmailName(null)); assertNull(partyEmailName("no-at-sign"))
        assertTrue("@" !in partyEmailName("x<y>z@example.test").orEmpty())
    }
}
