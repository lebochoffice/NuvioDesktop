package com.nuvio.app.features.simkl

import com.nuvio.app.core.storage.DesktopStorage
import com.nuvio.app.core.storage.ProfileScopedKey
import com.sun.jna.Platform
import com.sun.jna.platform.win32.Crypt32Util
import com.sun.jna.platform.win32.WinCrypt
import java.nio.file.Files
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.nio.file.StandardCopyOption.REPLACE_EXISTING
import java.security.MessageDigest
import java.security.SecureRandom

internal actual object SimklPlatformClock {
    actual fun nowEpochMs(): Long = System.currentTimeMillis()
}

internal actual object SimklPkceCrypto {
    private val secureRandom = SecureRandom()

    actual fun secureRandomBytes(size: Int): ByteArray =
        ByteArray(size).also(secureRandom::nextBytes)

    actual fun sha256(value: ByteArray): ByteArray =
        MessageDigest.getInstance("SHA-256").digest(value)
}

internal actual object SimklAuthStorage {
    private const val metadataKey = "simkl_auth_metadata"
    private const val accessTokenKey = "simkl_access_token"
    private const val codeVerifierKey = "simkl_code_verifier"
    private val store = DesktopStorage.store("nuvio_simkl_auth")

    actual fun loadMetadataPayload(profileId: Int?): String? =
        store.getString(metadataProfileKey(profileId))

    actual fun saveMetadataPayload(payload: String, profileId: Int?) {
        store.putString(metadataProfileKey(profileId), payload)
    }

    private fun metadataProfileKey(profileId: Int?): String =
        if (profileId == null) ProfileScopedKey.of(metadataKey) else ProfileScopedKey.of(metadataKey, profileId)

    actual fun loadAccessToken(): String? =
        store.getString(ProfileScopedKey.of(accessTokenKey))

    actual fun saveAccessToken(value: String?) {
        store.putString(ProfileScopedKey.of(accessTokenKey), value)
    }

    actual fun loadCodeVerifier(): String? =
        store.getString(ProfileScopedKey.of(codeVerifierKey))

    actual fun saveCodeVerifier(value: String?) {
        store.putString(ProfileScopedKey.of(codeVerifierKey), value)
    }

    private fun deviceSessionFile(profileId: Int) =
        SimklDeviceSessionFile(DesktopStorage.rootDir.resolve("simkl-device-v2-$profileId.dat"))

    actual fun loadDeviceSession(profileId: Int): String? = deviceSessionFile(profileId).load()

    actual fun saveDeviceSession(profileId: Int, value: String?) = deviceSessionFile(profileId).save(value)

    actual fun removeProfile(profileId: Int) {
        deviceSessionFile(profileId).save(null)
        store.removeAll(
            listOf(
                ProfileScopedKey.of(metadataKey, profileId),
                ProfileScopedKey.of(accessTokenKey, profileId),
                ProfileScopedKey.of(codeVerifierKey, profileId),
            ),
        )
    }
}

internal class SimklDeviceSessionFile(private val file: java.nio.file.Path) {
    fun load(): String? {
        val stored = try {
            Files.readAllBytes(file)
        } catch (_: java.nio.file.NoSuchFileException) {
            return null
        }
        val decoded = if (Platform.isWindows()) {
            Crypt32Util.cryptUnprotectData(stored, WinCrypt.CRYPTPROTECT_UI_FORBIDDEN)
        } else stored
        return try {
            decoded.decodeToString()
        } finally {
            decoded.fill(0)
        }
    }

    fun save(value: String?) {
        if (value == null) {
            Files.deleteIfExists(file)
            return
        }
        val decoded = value.encodeToByteArray()
        try {
            val stored = if (Platform.isWindows()) {
                Crypt32Util.cryptProtectData(decoded, WinCrypt.CRYPTPROTECT_UI_FORBIDDEN)
            } else decoded
            val temporary = Files.createTempFile(file.parent, "simkl-device-", ".tmp")
            try {
                Files.write(temporary, stored)
                Files.move(temporary, file, ATOMIC_MOVE, REPLACE_EXISTING)
            } finally {
                Files.deleteIfExists(temporary)
            }
        } finally {
            decoded.fill(0)
        }
    }
}
