package com.nuvio.app.features.simkl

import com.sun.jna.Platform
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull

class SimklDeviceSessionFileTest {
    @Test
    fun `restart restores the rotated session and disconnect deletes it`() {
        val root = Files.createTempDirectory("simkl-session-test")
        val profileA = root.resolve("profile-a.dat")
        val profileB = root.resolve("profile-b.dat")
        try {
            SimklDeviceSessionFile(profileA).save("synthetic-initial-refresh-token")
            SimklDeviceSessionFile(profileA).save("synthetic-rotated-refresh-token")
            if (Platform.isWindows()) {
                assertFalse(Files.readAllBytes(profileA).decodeToString().contains("synthetic-"))
            }
            assertEquals("synthetic-rotated-refresh-token", SimklDeviceSessionFile(profileA).load())
            assertNull(SimklDeviceSessionFile(profileB).load())
            SimklDeviceSessionFile(profileA).save(null)
            assertNull(SimklDeviceSessionFile(profileA).load())
        } finally {
            Files.deleteIfExists(profileA)
            Files.deleteIfExists(profileB)
            Files.delete(root)
        }
    }
}
