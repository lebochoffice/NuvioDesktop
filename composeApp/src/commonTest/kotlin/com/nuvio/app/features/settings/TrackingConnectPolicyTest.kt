package com.nuvio.app.features.settings

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class TrackingConnectPolicyTest {
    @Test
    fun connectRequiresConfiguredCredentialsAndAnIdleLogin() {
        assertFalse(trackingConnectEnabled(false, false))
        assertFalse(trackingConnectEnabled(false, true))
        assertFalse(trackingConnectEnabled(true, true))
        assertTrue(trackingConnectEnabled(true, false))
    }
}
