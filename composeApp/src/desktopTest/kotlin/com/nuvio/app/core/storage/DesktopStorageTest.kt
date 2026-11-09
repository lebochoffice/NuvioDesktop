package com.nuvio.app.core.storage

import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.FileTime
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals

class DesktopStorageTest {
    @Test
    fun windows_family_paths_are_separate_from_the_legacy_profile() {
        val roaming = Path.of("fixture", "roaming")
        val local = Path.of("fixture", "local")
        assertEquals(roaming.resolve("Nuvio Family"), windowsFamilyDataDirectory(roaming.toString(), local))
        assertEquals(local.resolve("Nuvio Family"), windowsFamilyDataDirectory(" ", local))
        assertNotEquals(roaming.resolve("Nuvio"), windowsFamilyDataDirectory(null, roaming))
    }

    @Test
    fun unchanged_operations_do_not_rewrite_the_store() {
        val directory = Files.createTempDirectory("desktop-storage-test")
        val file = directory.resolve("preferences.properties")
        try {
            val store = DesktopStorage.Store(file)
            store.putString("key", "value")
            val sentinel = FileTime.fromMillis(1_000L)
            Files.setLastModifiedTime(file, sentinel)

            store.putString("key", "value")
            store.remove("missing")
            store.removeAll(listOf("also-missing"))

            assertEquals(sentinel, Files.getLastModifiedTime(file))

            store.putString("key", "updated")

            assertNotEquals(sentinel, Files.getLastModifiedTime(file))
        } finally {
            Files.deleteIfExists(file)
            Files.deleteIfExists(directory)
        }
    }
}
