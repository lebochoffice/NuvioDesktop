package com.nuvio.app.features.trakt

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

class TraktPublicClientTest {
    private val json = Json { encodeDefaults = true }

    @Test
    fun desktopNeedsOnlyPublicClientId() {
        assertTrue(traktCredentialsConfigured("test-client", true, null))
        assertFalse(traktCredentialsConfigured("  ", true, null))
        assertFalse(traktCredentialsConfigured("", true, "legacy"))
    }

    @Test
    fun publicRequestsOmitSecretEvenWhenDefaultsAreEncoded() {
        val bodies = listOf(
            json.encodeToString(TraktDeviceTokenRequest("test-device", "test-client")),
            json.encodeToString(TraktRefreshTokenRequest("test-refresh", "test-client", redirectUri = "https://example.test/")),
            json.encodeToString(TraktRevokeRequest("test-token", "test-client")),
        )
        for (body in bodies) {
            val request = json.parseToJsonElement(body).jsonObject
            assertTrue("client_id" in request)
            assertFalse("client_secret" in request)
        }
    }

    @Test
    fun deviceResponseHandlesSuccessErrorsAndExpiry() {
        assertIs<TraktDeviceTokenResult.Authorized>(decodeTraktDeviceTokenResult(200,
            """{"access_token":"test-access","refresh_token":"test-refresh","token_type":"bearer","created_at":1,"expires_in":604800}"""))
        assertIs<TraktDeviceTokenResult.Failed>(decodeTraktDeviceTokenResult(200, "{}"))
        assertIs<TraktDeviceTokenResult.Failed>(decodeTraktDeviceTokenResult(400, """{"error":"invalid_client"}"""))
        assertIs<TraktDeviceTokenResult.Pending>(decodeTraktDeviceTokenResult(400, ""))
        assertIs<TraktDeviceTokenResult.Denied>(decodeTraktDeviceTokenResult(418, ""))
        assertIs<TraktDeviceTokenResult.Expired>(decodeTraktDeviceTokenResult(410, ""))
        assertIs<TraktDeviceTokenResult.SlowDown>(decodeTraktDeviceTokenResult(429, ""))
    }
}
