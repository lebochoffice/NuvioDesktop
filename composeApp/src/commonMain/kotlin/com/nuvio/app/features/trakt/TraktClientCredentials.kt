package com.nuvio.app.features.trakt

internal expect val traktLegacyClientSecret: String?

internal fun traktCredentialsConfigured(clientId: String, desktop: Boolean, legacySecret: String?): Boolean =
    clientId.isNotBlank() && (desktop || !legacySecret.isNullOrBlank())
