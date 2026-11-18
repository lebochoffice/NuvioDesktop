package com.nuvio.app.features.player.desktop

import com.nuvio.app.features.player.desktop.DesktopPlayerSpaceFallback.Result
import java.awt.event.KeyEvent
import kotlin.test.Test
import kotlin.test.assertEquals

class DesktopPlayerSpaceFallbackTest {
    private fun DesktopPlayerSpaceFallback.press(eligible: Boolean = true, modifiers: Int = 0) =
        onKey(KeyEvent.KEY_PRESSED, KeyEvent.VK_SPACE, ' ', modifiers, eligible)
    private fun DesktopPlayerSpaceFallback.typed(eligible: Boolean = true) =
        onKey(KeyEvent.KEY_TYPED, KeyEvent.VK_UNDEFINED, ' ', 0, eligible)
    private fun DesktopPlayerSpaceFallback.release(eligible: Boolean = true, modifiers: Int = 0) =
        onKey(KeyEvent.KEY_RELEASED, KeyEvent.VK_SPACE, ' ', modifiers, eligible)

    @Test
    fun spaceThatReachesAwtTogglesExactlyOnceOnRelease() {
        val fallback = DesktopPlayerSpaceFallback()
        assertEquals(Result.Consume, fallback.press())
        assertEquals(Result.Consume, fallback.typed())
        assertEquals(Result.Toggle, fallback.release())
        // A stray second release (no new press) must not toggle again.
        assertEquals(Result.Ignore, fallback.release())
    }

    @Test
    fun autoRepeatWhileHoldingSpaceStillProducesOneToggle() {
        val fallback = DesktopPlayerSpaceFallback()
        repeat(5) {
            assertEquals(Result.Consume, fallback.press())
            assertEquals(Result.Consume, fallback.typed())
        }
        assertEquals(Result.Toggle, fallback.release())
    }

    @Test
    fun ineligibleWindowsAndModifierChordsAreLeftAlone() {
        val fallback = DesktopPlayerSpaceFallback()
        assertEquals(Result.Ignore, fallback.press(eligible = false))
        assertEquals(Result.Ignore, fallback.release(eligible = false))
        assertEquals(Result.Ignore, fallback.press(modifiers = KeyEvent.CTRL_DOWN_MASK))
        assertEquals(Result.Ignore, fallback.release(modifiers = KeyEvent.CTRL_DOWN_MASK))
        assertEquals(Result.Ignore, fallback.press(modifiers = KeyEvent.ALT_DOWN_MASK))
        assertEquals(Result.Ignore, fallback.release())
    }

    @Test
    fun aPressThatBecomesIneligibleDoesNotToggleLater() {
        val fallback = DesktopPlayerSpaceFallback()
        assertEquals(Result.Consume, fallback.press())
        assertEquals(Result.Ignore, fallback.release(eligible = false)) // e.g. a dialog took over.
        assertEquals(Result.Ignore, fallback.release())
    }

    @Test
    fun otherKeysAreNeverTouched() {
        val fallback = DesktopPlayerSpaceFallback()
        assertEquals(Result.Ignore, fallback.onKey(KeyEvent.KEY_PRESSED, KeyEvent.VK_K, 'k', 0, true))
        assertEquals(Result.Ignore, fallback.onKey(KeyEvent.KEY_TYPED, KeyEvent.VK_UNDEFINED, 'a', 0, true))
        assertEquals(Result.Ignore, fallback.onKey(KeyEvent.KEY_RELEASED, KeyEvent.VK_ENTER, '\n', 0, true))
    }
}
