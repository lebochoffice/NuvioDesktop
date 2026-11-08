package com.nuvio.app.features.updater

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

// Fork update contract: tags "v<core>-watchparty", one
// "Nuvio-WatchParty-Windows-x64-<version>.msi" asset with a GitHub sha256 digest.
class ForkUpdateTest {
    private val windowsSelector = AppUpdateAssetSelector(
        fileExtensions = listOf(".msi"),
        preferredNameFragments = listOf("x64", "windows", "win"),
        fallbackNameFragments = listOf("universal", "all"),
        requiredNameFragments = listOf("WatchParty", "windows"),
    )

    @Test
    fun `fork versions compare by their numeric core on the single desktop channel`() {
        assertTrue(VersionUtils.isRemoteNewerLegacy("v0.1.38-watchparty", "0.1.37-watchparty-fixes"))
        assertTrue(VersionUtils.isRemoteNewerLegacy("v0.2.0-watchparty", "0.1.99-watchparty"))
        assertFalse(VersionUtils.isRemoteNewerLegacy("v0.1.37-watchparty", "0.1.37-watchparty-fixes"))
        assertFalse(VersionUtils.isRemoteNewerLegacy("0.1.34-alpha", "0.1.37-watchparty-fixes")) // Older official build.
    }

    @Test
    fun `only the fork watch party msi is eligible - official or other assets are ignored`() {
        val assets = listOf(
            candidate("Nuvio-Windows-x64-0.1.38.msi"),
            candidate("Nuvio-WatchParty-Windows-x64-0.1.38-watchparty.msi"),
            candidate("Nuvio-WatchParty-Windows-x64-0.1.38-watchparty.exe"),
        )
        assertEquals("Nuvio-WatchParty-Windows-x64-0.1.38-watchparty.msi", selectBestUpdateAsset(assets, windowsSelector)?.name)
        assertNull(selectBestUpdateAsset(listOf(candidate("Nuvio-Windows-x64-0.1.40.msi")), windowsSelector))
    }

    @Test
    fun `github sha256 digests are parsed strictly`() {
        val hex = "f1a41d6e3af2b4d3af4ead4758a9ee3086279b208cda84c74b0a39562c137a4f"
        assertEquals(hex, sha256FromDigest("sha256:$hex"))
        assertEquals(hex, sha256FromDigest("SHA256:${hex.uppercase()}"))
        assertNull(sha256FromDigest(null))
        assertNull(sha256FromDigest("md5:abc"))
        assertNull(sha256FromDigest("sha256:1234"))
        assertNull(sha256FromDigest("sha256:${"z".repeat(64)}"))
    }

    @Test
    fun `selected update carries the release digest`() {
        val hex = "a".repeat(64)
        val body = """[{"tag_name":"v0.1.38-watchparty","name":"Nuvio Watch Party 0.1.38","draft":false,"prerelease":false,
            "assets":[{"name":"Nuvio-WatchParty-Windows-x64-0.1.38-watchparty.msi","browser_download_url":"https://github.com/lebochoffice/NuvioDesktop/releases/download/v0.1.38-watchparty/Nuvio-WatchParty-Windows-x64-0.1.38-watchparty.msi","size":10,"digest":"sha256:$hex"}]}]"""
        val update = AppUpdaterRepository.selectUpdate(body, UpdateChannel.ALL_RELEASES, emptyList(), windowsSelector)
        assertEquals("v0.1.38-watchparty", update?.tag)
        assertEquals(hex, update?.assetSha256)
    }

    private fun candidate(name: String) = AppUpdateAssetCandidate(name = name, downloadUrl = "https://example.test/$name")
}
