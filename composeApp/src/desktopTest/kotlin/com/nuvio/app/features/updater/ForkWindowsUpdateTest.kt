package com.nuvio.app.features.updater

import kotlinx.coroutines.runBlocking
import org.junit.Assume.assumeTrue
import java.io.File
import java.net.URI
import kotlin.io.path.createTempDirectory
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ForkWindowsUpdateTest {
    @Test
    fun `windows verifier reads a large UTF8 script and drains output`() {
        assumeTrue(System.getProperty("os.name").startsWith("Windows", ignoreCase = true))
        val script = "# payload padding\n".repeat(3000) + """
            if ([int]('é'[0]) -ne 233) { exit 8 }
            [Console]::Out.Write('x' * 65536)
            [Console]::Error.Write('y' * 65536)
            exit 0
        """.trimIndent()
        runWindowsMsiVerifier(script)
    }

    @Test
    fun `windows verifier requires explicit successful exit`() {
        assumeTrue(System.getProperty("os.name").startsWith("Windows", ignoreCase = true))
        for (script in listOf("exit 7", "if (", "Write-Output 'no exit'")) {
            assertFailsWith<IllegalStateException>(script) { runWindowsMsiVerifier(script) }
        }
    }

    @Test
    fun `windows verifier fails closed on timeout`() {
        assumeTrue(System.getProperty("os.name").startsWith("Windows", ignoreCase = true))
        val failure = assertFailsWith<IllegalStateException> {
            runWindowsMsiVerifier("Start-Sleep -Seconds 30; exit 0", timeoutMillis = 2_000)
        }
        assertEquals("MSI verifier timed out.", failure.message)
    }

    @Test
    fun `windows downloads only follow HTTPS redirects to GitHub asset hosts`() {
        val initial = URI("https://github.com/lebochoffice/NuvioDesktop/releases/download/v0.1.63-watchparty/update.msi")
        assertTrue(isAllowedWindowsUpdateRedirect(URI("https://release-assets.githubusercontent.com/asset?signature=test"), initial))
        assertTrue(isAllowedWindowsUpdateRedirect(URI("https://objects.githubusercontent.com/asset"), initial))
        for (target in listOf(
            "http://release-assets.githubusercontent.com/asset",
            "https://release-assets.githubusercontent.com.evil.example/asset",
            "https://release-assets.githubusercontent.com:8443/asset",
            "https://name@release-assets.githubusercontent.com/asset",
            "https://github.com/NuvioMedia/NuvioDesktop/releases/download/v1.0.0/update.msi",
        )) {
            assertFalse(isAllowedWindowsUpdateRedirect(URI(target), initial))
        }
    }

    @Test
    fun `windows status mode blocks downloads and rejects even an existing invalid msi`() = runBlocking {
        assumeTrue(System.getProperty("os.name").startsWith("Windows", ignoreCase = true))
        assertFalse(windowsForkUpdateInstaller()?.installationReleased ?: true)
        val directory = createTempDirectory("nuvio-blocked-update-test").toFile()
        try {
            val invalidMsi = File(directory, "Nuvio-WatchParty-Windows-x64-0.1.63-watchparty.msi")
                .apply { writeText("not an installer") }
            assertTrue(AppUpdaterPlatform.isStatusOnlyForkUpdater)
            assertFalse(AppUpdaterPlatform.canInstallDownloadedUpdate())
            val download = AppUpdaterPlatform.downloadUpdateAsset("invalid-url", invalidMsi.name) { _, _ ->
                error("A blocked download must not report progress.")
            }
            assertEquals("Installation is disabled.", download.exceptionOrNull()?.message)
            val install = AppUpdaterPlatform.installDownloadedUpdate(invalidMsi.absolutePath)
            assertEquals("Installation is disabled.", install.exceptionOrNull()?.message)
        } finally { directory.deleteRecursively() }
    }

    @Test
    fun `updates are downloaded only from this fork's github releases`() {
        assertTrue(isForkReleaseAsset("https://github.com/lebochoffice/NuvioDesktop/releases/download/v0.1.38-watchparty/Nuvio-WatchParty-Windows-x64-0.1.38-watchparty.msi"))
        assertFalse(isForkReleaseAsset("https://github.com/NuvioMedia/NuvioDesktop/releases/download/0.1.40/Nuvio-Windows-x64-0.1.40.msi"))
        assertFalse(isForkReleaseAsset("https://example.test/Nuvio-WatchParty-Windows-x64.msi"))
        assertFalse(isForkReleaseAsset("https://github.com/lebochoffice/NuvioDesktop/releases/download/../../evil.msi"))
        assertFalse(isForkReleaseAsset("http://github.com/lebochoffice/NuvioDesktop/releases/download/v1/a.msi"))
    }

    @Test
    fun `sha256 of the downloaded file is computed exactly`() {
        val dir = createTempDirectory("nuvio-update-test").toFile()
        try {
            val file = File(dir, "a.msi").apply { writeText("abc") }
            assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", sha256Hex(file))
        } finally { dir.deleteRecursively() }
    }

    @Test
    fun `windows installs only msi files interactively with a verbose log`() {
        val msi = File("C:/updates/Nuvio-WatchParty-Windows-x64-0.1.38-watchparty.msi")
        val command = windowsInstallerCommand(msi)
        assertEquals(listOf("msiexec", "/i", msi.absolutePath, "/l*v"), command.take(4))
        assertTrue(command.last().endsWith("-install.log"))
        assertFalse("/quiet" in command || "/qn" in command) // Never silent.
        assertFailsWith<IllegalArgumentException> { windowsInstallerCommand(File("C:/updates/setup.exe")) }
    }

    @Test
    fun `desktop release source points to the fork`() {
        assertEquals("lebochoffice", forkReleaseOwner)
        assertEquals("NuvioDesktop", forkReleaseRepo)
    }
}
