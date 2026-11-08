package com.nuvio.app.features.party

import com.nuvio.app.features.addons.RawHttpResponse
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

// Desktop client of the family share Worker, without network or a session.
class PartyFamilyShareTest {
    private val fakeToken = "FAKE_ACCOUNT_TOKEN_FOR_TESTS"
    private val address = "https://flux-007.wnam.tb-cdn.io/stream/p/0/0/0/0?token=$fakeToken"
    private val sent = mutableListOf<Triple<String, String, String>>()
    private val original = Triple(PartyFamilyShare.workerOrigin, PartyFamilyShare.post, PartyFamilyShare.accessToken)
    private val originalDevice = PartyFamilyShare.deviceId

    private fun configure(status: Int = 200, body: String = """{"ok":true,"rev":3}""", session: String? = "host-session", headers: Map<String, String> = emptyMap()) {
        PartyFamilyShare.workerOrigin = "https://share.example.test"
        PartyFamilyShare.accessToken = { session }
        PartyFamilyShare.deviceId = { "device-1" }
        PartyFamilyShare.post = { url, token, payload -> sent += Triple(url, token, payload); RawHttpResponse(status, "", url, body, headers) }
    }

    @AfterTest
    fun restore() {
        PartyFamilyShare.workerOrigin = original.first
        PartyFamilyShare.post = original.second
        PartyFamilyShare.accessToken = original.third
        PartyFamilyShare.deviceId = originalDevice
    }

    @Test
    fun theHostPublishesTheOriginalAddressOnlyToTheShareServiceWithItsOwnSession() = runTest {
        configure()
        val result = PartyFamilyShare.publish("party-1", "movie|tt1||", address, listOf("m-anna"), propagateToken = true)
        assertEquals(3, result.rev)
        val (url, token, payload) = sent.single()
        assertEquals("https://share.example.test/v1/share", url)
        assertEquals("host-session", token)
        val body = Json.parseToJsonElement(payload).jsonObject
        assertEquals(address, body["url"]!!.jsonPrimitive.content) // Token kept unchanged.
        assertEquals(listOf("m-anna"), body["admitted"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals("true", body["propagate_token"]!!.jsonPrimitive.content)
        assertEquals(FAMILY_SHARE_TTL_S.toString(), body["ttl_s"]!!.jsonPrimitive.content) // Short-lived, renewed by the host.
        assertTrue(FAMILY_SHARE_RENEW_MS < FAMILY_SHARE_TTL_S * 1000L)
        assertTrue(fakeToken !in result.message)
    }

    @Test
    fun withoutAdmittedMembersNothingIsPublishedAndTheShareIsRevoked() = runTest {
        configure()
        val result = PartyFamilyShare.publish("party-1", "movie|tt1||", address, emptyList(), propagateToken = false)
        assertNull(result.rev)
        assertEquals("https://share.example.test/v1/revoke", sent.single().first)
        assertTrue(fakeToken !in sent.single().third)
    }

    @Test
    fun refusalsAndMissingSessionsShareNothingAndNeverEchoTheAddress() = runTest {
        configure(status = 403, body = """{"error":"not_host"}""")
        val refused = PartyFamilyShare.publish("party-1", "movie|tt1||", address, listOf("m-anna"), propagateToken = false)
        assertNull(refused.rev); assertTrue(fakeToken !in refused.message)
        sent.clear()
        configure(session = null)
        assertNull(PartyFamilyShare.publish("party-1", "movie|tt1||", address, listOf("m-anna"), propagateToken = false).rev)
        assertTrue(sent.isEmpty()) // No session: no request at all.
    }

    @Test
    fun aThrottledShareIsRetriedAfterRetryAfterWithoutLosingTheState() = runTest {
        configure(status = 429, body = """{"error":"rate_limited"}""", headers = mapOf("retry-after" to "120"))
        val throttled = PartyFamilyShare.publish("party-1", "movie|tt1||", address, listOf("m-anna"), propagateToken = false)
        assertEquals(120_000L, throttled.retryAfterMs); assertNull(throttled.rev)
        assertTrue(fakeToken !in throttled.message)
        configure(status = 429, body = "{}")
        assertEquals(60_000L, PartyFamilyShare.publish("party-1", "movie|tt1||", address, listOf("m-anna"), propagateToken = false).retryAfterMs)
        configure(status = 429, body = "{}", headers = mapOf("Retry-After" to "1"))
        assertEquals(10_000L, PartyFamilyShare.publish("party-1", "movie|tt1||", address, listOf("m-anna"), propagateToken = false).retryAfterMs)
        configure()
        assertNull(PartyFamilyShare.publish("party-1", "movie|tt1||", address, listOf("m-anna"), propagateToken = false).retryAfterMs)
    }

    @Test
    fun notConfiguredMeansDisabled() = runTest {
        PartyFamilyShare.workerOrigin = ""
        assertEquals(false, PartyFamilyShare.configured)
        assertEquals("", PartyFamilyShare.publish("party-1", "movie|tt1||", address, listOf("m-anna"), propagateToken = false).message)
        assertEquals(false, PartyFamilyShare.revoke("party-1"))
    }
}
