package com.nuvio.app.features.player.desktop

import java.util.Collections
import kotlin.test.Test
import kotlin.test.assertEquals

private val noNativeCreate: NativePlayerCreate = { _, _, _, _, _, _, _, _, _ ->
    error("native create must not run in seek unit tests")
}

// Paused watch party alignment uses the bridge's frame-accurate seek; a stale
// bridge DLL without that export falls back to the keyframe seek once and for good.
class NativePlayerExactSeekTest {
    @Test
    fun exactSeekUsesTheExactBridgeEntry() {
        val calls = Collections.synchronizedList(mutableListOf<String>())
        val controller = NativePlayerController(
            host = NativePlayerHost(),
            nativeCreate = noNativeCreate,
            nativeDispose = {},
            nativeSeekTo = { handle, ms -> calls += "keyframe-$handle-$ms" },
            nativeSeekToExact = { handle, ms -> calls += "exact-$handle-$ms" },
        )
        controller.setNativeHandleForTest(42L)
        controller.seekToExact(300_000L)
        controller.seekTo(10_000L)
        assertEquals(listOf("exact-42-300000", "keyframe-42-10000"), calls.toList())
    }

    @Test
    fun missingExactExportFallsBackToTheKeyframeSeek() {
        val calls = Collections.synchronizedList(mutableListOf<String>())
        var exactAttempts = 0
        val controller = NativePlayerController(
            host = NativePlayerHost(),
            nativeCreate = noNativeCreate,
            nativeDispose = {},
            nativeSeekTo = { handle, ms -> calls += "keyframe-$handle-$ms" },
            nativeSeekToExact = { _, _ -> exactAttempts++; throw UnsatisfiedLinkError("seekToExact") },
        )
        controller.setNativeHandleForTest(7L)
        controller.seekToExact(1_000L)
        controller.seekToExact(2_000L)
        assertEquals(listOf("keyframe-7-1000", "keyframe-7-2000"), calls.toList())
        assertEquals(1, exactAttempts) // Not retried on every seek.
    }

    @Test
    fun noHandleNoSeek() {
        val calls = mutableListOf<String>()
        val controller = NativePlayerController(
            host = NativePlayerHost(),
            nativeCreate = noNativeCreate,
            nativeDispose = {},
            nativeSeekTo = { _, _ -> calls += "keyframe" },
            nativeSeekToExact = { _, _ -> calls += "exact" },
        )
        controller.seekToExact(1_000L)
        assertEquals(emptyList(), calls)
    }
}

// Same reflection hook as NativePlayerControllerTeardownTest (private there).
private fun NativePlayerController.setNativeHandleForTest(value: Long) {
    javaClass.getDeclaredField("handle").also { field ->
        field.isAccessible = true
        field.setLong(this, value)
    }
}
