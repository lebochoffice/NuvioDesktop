package com.nuvio.app.features.updater

import java.io.File
import kotlin.io.path.createTempDirectory
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ForkWindowsUpdateTest {
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
