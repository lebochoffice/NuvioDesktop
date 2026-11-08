package com.nuvio.app.features.simkl

import com.nuvio.app.features.addons.RawHttpResponse
import io.ktor.http.parseQueryString
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class SimklDeviceAuthorizationTest {
    @Test
    fun `device grant uses form encoding PKCE and the full verification URL`() = runBlocking {
        val fixture = Fixture(deviceResponse, pending, slowDown, tokens)
        val code = fixture.auth.start(pkce)
        assertEquals("https://simkl.com/pin?code=ABCD", code.browserUrl())
        val session = fixture.auth.poll(code, pkce.verifier, 60_000)
        assertEquals(listOf(2_000L, 2_000L, 7_000L), fixture.delays)
        assertEquals("test-access", session.accessToken)
        assertEquals(71_000L, session.expiresAt)
        val start = fixture.calls.first()
        assertEquals("/oauth2/device", start.path)
        assertEquals("application/x-www-form-urlencoded", start.headers["Content-Type"])
        assertEquals("media:read media:write", start.form["scope"])
        assertEquals("S256", start.form["code_challenge_method"])
        assertEquals(pkce.challenge, start.form["code_challenge"])
        assertNull(start.form["code_verifier"])
        for (call in fixture.calls.drop(1)) {
            assertEquals("/oauth2/token", call.path)
            assertEquals("urn:ietf:params:oauth:grant-type:device_code", call.form["grant_type"])
            assertEquals("device+code", call.form["device_code"])
            assertEquals(pkce.verifier, call.form["code_verifier"])
            assertNull(call.form["user_code"])
            assertNull(call.form["client_secret"])
        }
    }

    @Test
    fun `expiry and cancellation never make another token request`() = runBlocking {
        val fixture = Fixture(deviceResponse)
        val code = fixture.auth.start(pkce)
        assertEquals(SimklAuthError.AUTHORIZATION_EXPIRED,
            assertFailsWith<SimklOAuthFailure> { fixture.auth.poll(code, pkce.verifier, 1_000) }.reason)
        assertEquals(1, fixture.calls.size)
        val canceled = SimklDeviceAuthorization("test-id",
            request = { _, _, _ -> error("must not poll") },
            now = { 0 },
            wait = { throw CancellationException() },
        )
        assertFailsWith<CancellationException> { canceled.poll(code, pkce.verifier, 60_000) }
        Unit
    }

    @Test
    fun `server expiry and denial end polling with distinct feedback`() = runBlocking {
        for ((code, reason) in listOf(
            "expired_token" to SimklAuthError.AUTHORIZATION_EXPIRED,
            "access_denied" to SimklAuthError.AUTHORIZATION_DENIED,
        )) {
            val fixture = Fixture(deviceResponse, response(400, """{"error":"$code"}"""))
            val device = fixture.auth.start(pkce)
            assertEquals(reason,
                assertFailsWith<SimklOAuthFailure> { fixture.auth.poll(device, pkce.verifier, 60_000) }.reason)
            assertEquals(2, fixture.calls.size)
        }
    }

    @Test
    fun `refresh rotates credentials and revoke sends the current refresh token`() = runBlocking {
        val fixture = Fixture(tokens, response(200, ""), response(400, """{"error":"invalid_grant"}"""))
        val old = SimklV2Session("test-id", "old-access", "old-refresh", 1, SIMKL_DEVICE_SCOPE)
        val renewed = fixture.auth.refresh(old)
        fixture.auth.revoke(renewed)
        assertEquals("refresh_token", fixture.calls[0].form["grant_type"])
        assertEquals("old-refresh", fixture.calls[0].form["refresh_token"])
        assertEquals("/oauth2/revoke", fixture.calls[1].path)
        assertEquals("test-refresh", fixture.calls[1].form["token"])
        assertEquals("refresh_token", fixture.calls[1].form["token_type_hint"])
        assertEquals(SimklAuthError.AUTHORIZATION_REVOKED,
            assertFailsWith<SimklOAuthFailure> { fixture.auth.refresh(old) }.reason)
    }

    @Test
    fun `provider error details never reach diagnostics and unsafe links are ignored`() = runBlocking {
        val fixture = Fixture(response(400, """{"error":"unauthorized_client","error_description":"private-device-secret"}"""))
        val error = assertFailsWith<SimklOAuthFailure> { fixture.auth.start(pkce) }
        assertEquals(SimklAuthError.INVALID_CLIENT_ID, error.reason)
        assertFalse(error.toString().contains("private-device-secret"))
        val code = SimklDeviceCode("x", "y", "https://simkl.com/pin", "https://other.example/", 60)
        assertEquals("https://simkl.com/pin", code.browserUrl())
        assertTrue(SimklDeviceCode("x", "y", "http://simkl.com/pin", null, 60).browserUrl() == null)
    }

    private class Fixture(vararg responses: RawHttpResponse) {
        var now = 0L
        val calls = mutableListOf<Call>()
        val delays = mutableListOf<Long>()
        private val queue = ArrayDeque(responses.toList())
        val auth = SimklDeviceAuthorization("test-id", request = { url, headers, body ->
            calls += Call(url.substringAfter(".com").substringBefore('?'), headers, parseQueryString(body))
            queue.removeFirst()
        }, now = { now }, wait = {
            delays += it
            now += it
        })
    }

    private class Call(val path: String, val headers: Map<String, String>, val form: io.ktor.http.Parameters)

    private companion object {
        val pkce = SimklPkceMaterial("test+verifier", "test-challenge", "test-state")
        val deviceResponse = response(200, """{
            "device_code":"device+code","user_code":"ABCD",
            "verification_uri":"https://simkl.com/pin",
            "verification_uri_complete":"https://simkl.com/pin?code=ABCD","expires_in":60,"interval":2
        }""")
        val pending = response(400, """{"error":"authorization_pending"}""")
        val slowDown = response(400, """{"error":"slow_down"}""")
        val tokens = response(200, """{
            "access_token":"test-access","refresh_token":"test-refresh","expires_in":60,
            "token_type":"Bearer","scope":"media:read media:write"
        }""")
        fun response(status: Int, body: String) = RawHttpResponse(status, "", "https://api.simkl.com", body, emptyMap())
    }
}
