package com.nuvio.app

import com.nuvio.app.core.deeplink.AppDeepLinkRepository
import com.nuvio.app.features.party.PARTY_CODE_LENGTH
import com.nuvio.app.features.party.normalizePartyCode
import io.ktor.http.Url
import java.io.IOException
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.Path
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.nio.file.StandardCopyOption.REPLACE_EXISTING
import java.nio.file.StandardOpenOption.CREATE
import java.nio.file.StandardOpenOption.WRITE
import java.nio.file.StandardWatchEventKinds.ENTRY_CREATE
import java.nio.file.StandardWatchEventKinds.ENTRY_MODIFY
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runInterruptible

internal class WindowsPartyInvitation(val code: String?) {
    fun dispatch() {
        if (code == null) {
            AppDeepLinkRepository.rejectPartyInvitation()
        } else {
            AppDeepLinkRepository.handleUrl("nuvio://party/$code")
        }
    }
}

private val partyUri = Regex("^nuvio://party(?:[/?#].*)?$", RegexOption.IGNORE_CASE)

internal fun windowsPartyInvitation(value: String): WindowsPartyInvitation? {
    val input = value.trim()
    if (!partyUri.matches(input)) return null
    val url = runCatching { Url(input) }.getOrNull()
    val parts = url?.pathSegments.orEmpty().dropWhile(String::isEmpty).dropLastWhile(String::isEmpty)
    val rawCode = when (parts.size) {
        0 -> url?.parameters?.get("code")
        1 -> parts.single()
        else -> null
    }
    val compact = rawCode?.uppercase()?.filterNot { it == '-' || it == ' ' }
    val code = compact?.takeIf { it.length == PARTY_CODE_LENGTH && normalizePartyCode(it) == it }
    return WindowsPartyInvitation(code)
}

/** A per-user inbox for validated party invitations only. No network listener. */
internal class WindowsPartyLinks private constructor(
    private val directory: Path,
    private val primaryLock: FileChannel?,
) : AutoCloseable {
    private val pending = directory.resolve("pending")
    private val claimed = directory.resolve("claimed")

    fun forward(invitation: WindowsPartyInvitation): Boolean {
        if (primaryLock != null) return false
        return runCatching {
            val temporary = Files.createTempFile(directory, "party-", ".tmp")
            try {
                Files.writeString(temporary, invitation.code ?: "-")
                Files.move(temporary, pending, ATOMIC_MOVE, REPLACE_EXISTING)
            } finally {
                Files.deleteIfExists(temporary)
            }
        }.isSuccess
    }

    suspend fun listen(onInvitation: (WindowsPartyInvitation) -> Unit) {
        if (primaryLock == null) return
        directory.fileSystem.newWatchService().use { watcher ->
            directory.register(watcher, ENTRY_CREATE, ENTRY_MODIFY)
            while (true) {
                val invitation = runInterruptible(Dispatchers.IO) { takePending() }
                if (invitation != null) onInvitation(invitation)
                val key = runInterruptible(Dispatchers.IO) { watcher.take() }
                key.pollEvents()
                if (!key.reset()) return
            }
        }
    }

    private fun takePending(): WindowsPartyInvitation? {
        return try {
            Files.move(pending, claimed, ATOMIC_MOVE, REPLACE_EXISTING)
            try {
                if (!Files.isRegularFile(claimed, NOFOLLOW_LINKS)) return null
                val ageMs = System.currentTimeMillis() - Files.getLastModifiedTime(claimed, NOFOLLOW_LINKS).toMillis()
                if (ageMs !in 0L..60_000L) return null
                val payload = Files.newInputStream(claimed, NOFOLLOW_LINKS).use { it.readNBytes(8).decodeToString() }
                when {
                    payload == "-" -> WindowsPartyInvitation(null)
                    payload.length == PARTY_CODE_LENGTH && normalizePartyCode(payload) == payload ->
                        WindowsPartyInvitation(payload)
                    else -> null
                }
            } finally {
                Files.deleteIfExists(claimed)
            }
        } catch (_: IOException) {
            null
        }
    }

    override fun close() {
        primaryLock?.close()
    }

    companion object {
        fun open(): WindowsPartyLinks? = runCatching {
            val local = System.getenv("LOCALAPPDATA")?.takeIf(String::isNotBlank)?.let { Path.of(it) }
                ?: Path.of(System.getProperty("user.home"), "AppData", "Local")
            val directory = Files.createDirectories(local.resolve("NuvioFamilyBeta").resolve("party-links"))
            val channel = FileChannel.open(directory.resolve("instance.lock"), CREATE, WRITE, NOFOLLOW_LINKS)
            val primary = try {
                channel.tryLock() != null
            } catch (error: Exception) {
                channel.close()
                throw error
            }
            if (!primary) channel.close()
            WindowsPartyLinks(directory, channel.takeIf { primary })
        }.getOrNull()
    }
}
