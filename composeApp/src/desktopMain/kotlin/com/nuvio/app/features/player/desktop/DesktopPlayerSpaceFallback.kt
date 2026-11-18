package com.nuvio.app.features.player.desktop

import java.awt.event.KeyEvent

/**
 * Space fallback for the desktop player.
 *
 * The player shortcuts live in the embedded controls WebView. While that WebView
 * owns keyboard focus, Windows delivers Space to it and AWT never sees the key.
 * When the focus has fallen back to the AWT/Compose window instead (for example
 * after the paused "You're watching" state rebuilt the Compose layer above the
 * native surface), Space reached nobody and playback could not be resumed.
 *
 * This state machine only reacts to keys that reached AWT, so it can never
 * double a toggle the WebView already handled. One physical press (including
 * auto-repeat) produces exactly one toggle on release; the matching press and
 * typed events are consumed so Compose cannot act on them as well.
 */
internal class DesktopPlayerSpaceFallback {
    enum class Result { Ignore, Consume, Toggle }

    private var pressed = false

    fun onKey(id: Int, keyCode: Int, keyChar: Char, modifiersEx: Int, eligible: Boolean): Result {
        val isSpace = keyCode == KeyEvent.VK_SPACE || (id == KeyEvent.KEY_TYPED && keyChar == ' ')
        if (!isSpace) return Result.Ignore
        val blockingModifiers = KeyEvent.CTRL_DOWN_MASK or KeyEvent.ALT_DOWN_MASK or KeyEvent.META_DOWN_MASK or KeyEvent.ALT_GRAPH_DOWN_MASK
        if (!eligible || modifiersEx and blockingModifiers != 0) {
            pressed = false
            return Result.Ignore
        }
        return when (id) {
            KeyEvent.KEY_PRESSED -> {
                pressed = true
                Result.Consume
            }
            KeyEvent.KEY_TYPED -> if (pressed) Result.Consume else Result.Ignore
            KeyEvent.KEY_RELEASED -> if (pressed) {
                pressed = false
                Result.Toggle
            } else {
                Result.Ignore
            }
            else -> Result.Ignore
        }
    }

    fun reset() {
        pressed = false
    }
}
