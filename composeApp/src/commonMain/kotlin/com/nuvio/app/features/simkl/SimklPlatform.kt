package com.nuvio.app.features.simkl

internal expect object SimklPlatformClock {
    fun nowEpochMs(): Long
}

internal expect object SimklPkceCrypto {
    fun secureRandomBytes(size: Int): ByteArray
    fun sha256(value: ByteArray): ByteArray
}

internal expect object SimklAuthStorage {
    fun loadMetadataPayload(profileId: Int? = null): String?
    fun saveMetadataPayload(payload: String, profileId: Int? = null)
    fun loadAccessToken(): String?
    fun saveAccessToken(value: String?)
    fun loadCodeVerifier(): String?
    fun saveCodeVerifier(value: String?)
    fun loadDeviceSession(profileId: Int): String?
    fun saveDeviceSession(profileId: Int, value: String?)
    fun removeProfile(profileId: Int)
}
