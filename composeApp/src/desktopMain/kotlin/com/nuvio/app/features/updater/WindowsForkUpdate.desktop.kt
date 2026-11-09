package com.nuvio.app.features.updater

import com.nuvio.app.core.storage.DesktopStorage
import com.nuvio.app.features.settings.AppIconRepository
import com.sun.nio.file.ExtendedOpenOption.NOSHARE_DELETE
import com.sun.nio.file.ExtendedOpenOption.NOSHARE_WRITE
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.delay
import java.awt.EventQueue
import java.io.File
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.FileAlreadyExistsException
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.Path
import java.nio.file.StandardOpenOption.READ
import java.util.Base64
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resumeWithException
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine

internal object DesktopWindowsForkUpdate : WindowsForkUpdateInstaller {
    // Release decision after signed MSI acceptance. No environment or UI override.
    override val installationReleased = false
    var closeApplication: (() -> Unit)? = null // Accessed on the desktop event thread.
    var playerOpen = false // Set and read on the desktop event thread.
    private val handoffRoot get() = DesktopStorage.cacheDir.resolve("update-handoff")

    fun holdStartupLease(): FileChannel {
        val gate = Files.createDirectories(handoffRoot).resolve("instance.lock")
        try { Files.createFile(gate) } catch (_: FileAlreadyExistsException) {}
        return FileChannel.open(gate, READ, NOSHARE_WRITE, NOSHARE_DELETE, NOFOLLOW_LINKS)
    }

    fun takeResult(): Pair<ForkInstallResult?, Int?>? {
        val result = handoffRoot.resolve("result")
        if (!Files.isRegularFile(result, NOFOLLOW_LINKS) || Files.size(result) > 128) return null
        val fields = Files.readString(result).trim().split('|')
        if (fields.size != 3) return null
        Files.delete(result)
        val outcome = when (fields[0]) {
            "installed" -> ForkInstallResult.Installed
            "restart" -> ForkInstallResult.RestartRequired
            "cancelled" -> ForkInstallResult.Cancelled
            else -> null
        }
        return outcome to fields[2].toIntOrNull()
    }
    override val canDownload: Boolean by lazy {
        val trust = javaClass.getResourceAsStream("/fork-updater/windows-update-trust.ps1")
            ?.bufferedReader()?.use { it.readText() }
        val prefix = "\$familySignerSha256 = '"
        trust?.lineSequence()?.any { it.startsWith(prefix) &&
            it.removePrefix(prefix).matches(Regex("[a-f0-9]{64}'")) } == true
    }

    override suspend fun download(update: AppUpdate, progress: (Long, Long?) -> Unit): String {
        check(canDownload)
        return AppUpdaterPlatform.downloadWindowsForkUpdate(update, progress)
    }

    override suspend fun verify(update: AppUpdate, path: String) = runInterruptible(Dispatchers.IO) {
        val file = File(path).toPath().toRealPath().toFile()
        FileChannel.open(file.toPath(), READ, NOSHARE_WRITE, NOSHARE_DELETE).use { verifyLocked(update, file) }
    }

    override suspend fun install(update: AppUpdate, path: String, partyActive: () -> Boolean): ForkInstallResult {
        check(installationReleased && canDownload)
        val caller = currentCoroutineContext()
        verify(update, path)
        val file = File(path).toPath().toRealPath().toFile()
        val directory = Files.createTempDirectory(handoffRoot, "attempt-")
        var process: Process? = null
        var handedOff = false
        var resultPrepared = false
        try {
            val (helper, input) = startVerifier(update, file, directory)
            process = helper
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
            while (!Files.exists(directory.resolve("ready"))) {
                if (Files.exists(directory.resolve("other-instance"))) throw ForkInstallBlockedByInstance()
                if (!helper.isAlive || System.nanoTime() >= deadline) throw ForkWindowsInstallerFailure(null)
                delay(50)
            }
            input.get(1, TimeUnit.SECONDS)
            suspendCoroutine<Unit> { continuation ->
                EventQueue.invokeLater {
                    try {
                        caller.ensureActive()
                        if (partyActive()) throw ForkInstallBlockedByParty()
                        if (playerOpen) throw ForkInstallBlockedByPlayback()
                        if (AppIconRepository.state.value.pending != null) throw ForkInstallBlockedBySettings()
                        val close = checkNotNull(closeApplication)
                        Files.writeString(handoffRoot.resolve("result"), "failed|interrupted|")
                        resultPrepared = true
                        Files.createFile(directory.resolve("armed"))
                        close()
                        continuation.resume(Unit)
                    } catch (failure: Exception) {
                        continuation.resumeWithException(failure)
                    }
                }
            }
            handedOff = true
            return ForkInstallResult.HandedOff
        } finally {
            if (!handedOff) {
                process?.destroyForcibly()
                if (resultPrepared) runCatching { Files.deleteIfExists(handoffRoot.resolve("result")) }
                runCatching { Files.deleteIfExists(directory.resolve("armed")) }
                runCatching { Files.deleteIfExists(directory.resolve("ready")) }
                runCatching { Files.deleteIfExists(directory.resolve("other-instance")) }
                runCatching { Files.deleteIfExists(directory) }
            }
        }
    }

    private fun verifyLocked(update: AppUpdate, file: File) {
        runWindowsMsiVerifier(
            verifierScript() + "\ntry { \$null = Get-VerifiedFamilyUpdate; exit 0 } catch { exit 1 }",
            verifierVariables(update, file),
        )
    }

    private fun startVerifier(update: AppUpdate, file: File, handoff: Path): Pair<Process, FutureTask<Unit>> =
        startWindowsMsiVerifier(
            verifierScript("install-windows-update.ps1"),
            verifierVariables(update, file) + mapOf(
                "NUVIO_UPDATE_HANDOFF" to handoff.toString(),
                "NUVIO_UPDATE_PARENT" to ProcessHandle.current().pid().toString(),
            ),
        )

    private fun verifierScript(handoffScript: String? = null): String {
        val scripts = listOf("windows-msi-identity.ps1", "windows-update-trust.ps1", "verify-windows-update.ps1")
        return (scripts + listOfNotNull(handoffScript)).joinToString("\n") { name ->
            checkNotNull(javaClass.getResourceAsStream("/fork-updater/$name")).bufferedReader().use { it.readText() }
        }
    }

    private fun verifierVariables(update: AppUpdate, file: File): Map<String, String> {
        check(canDownload)
        check(file.name == update.assetName && file.length() == update.assetSizeBytes)
        return mapOf(
            "NUVIO_VERIFY_UPDATE_PATH" to file.absolutePath,
            "NUVIO_VERIFY_UPDATE_SHA256" to requireNotNull(update.assetSha256),
            "NUVIO_VERIFY_UPDATE_VERSION" to requireNotNull(forkMsiProductVersion(update.tag)),
            "NUVIO_VERIFY_INSTALLED_VERSION" to requireNotNull(forkMsiProductVersion(AppUpdaterPlatform.currentVersionName)),
            "NUVIO_VERIFY_RUNNING_LAUNCHER" to File(requireNotNull(System.getProperty("jpackage.app-path"))).canonicalPath,
        )
    }
}

internal fun runWindowsMsiVerifier(
    script: String,
    variables: Map<String, String> = emptyMap(),
    timeoutMillis: Long = 90_000,
) {
    val (process, input) = startWindowsMsiVerifier(script, variables)
    try {
        check(process.waitFor(timeoutMillis, TimeUnit.MILLISECONDS)) { "MSI verifier timed out." }
        input.get(5, TimeUnit.SECONDS)
        check(process.exitValue() == 0)
    } finally {
        if (process.isAlive) process.destroyForcibly()
        input.cancel(true)
    }
}

private fun startWindowsMsiVerifier(script: String, variables: Map<String, String>): Pair<Process, FutureTask<Unit>> {
    val payload = Base64.getEncoder().encode(script.toByteArray(Charsets.UTF_8))
    // Only the fixed bootstrap goes on the Windows command line.
    val bootstrap = "try { & ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString(" +
        "[Convert]::FromBase64String([Console]::In.ReadToEnd())))) } catch { exit 1 }; exit 1"
    val encoded = Base64.getEncoder().encodeToString(bootstrap.toByteArray(Charsets.UTF_16LE))
    val process = ProcessBuilder(
        systemTool("WindowsPowerShell/v1.0/powershell.exe"),
        "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded,
    ).redirectOutput(ProcessBuilder.Redirect.DISCARD).redirectError(ProcessBuilder.Redirect.DISCARD)
        .apply {
            environment()["PSModulePath"] = systemTool("WindowsPowerShell/v1.0/Modules")
            environment().putAll(variables)
        }.start()
    val input = FutureTask<Unit> {
        process.outputStream.use { it.write(payload) }
    }
    try {
        // Keep the process timeout effective even if the stdin pipe stops draining.
        Thread(input, "nuvio-msi-verifier-stdin").apply { isDaemon = true }.start()
        return process to input
    } catch (failure: Exception) {
        process.destroyForcibly()
        input.cancel(true)
        throw failure
    }
}

private fun systemTool(path: String): String =
    File(requireNotNull(System.getenv("SystemRoot")), "System32/$path").absolutePath
