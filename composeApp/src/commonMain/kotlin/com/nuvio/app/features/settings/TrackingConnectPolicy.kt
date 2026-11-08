package com.nuvio.app.features.settings

// Shared by the Trakt, Simkl and MDBList connection cards.
internal fun trackingConnectEnabled(credentialsConfigured: Boolean, isLoading: Boolean): Boolean =
    credentialsConfigured && !isLoading
