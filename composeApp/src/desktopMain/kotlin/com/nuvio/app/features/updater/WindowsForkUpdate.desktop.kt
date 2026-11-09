package com.nuvio.app.features.updater

import com.sun.nio.file.ExtendedOpenOption.NOSHARE_DELETE
import com.sun.nio.file.ExtendedOpenOption.NOSHARE_WRITE
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import java.nio.channels.FileChannel
import java.nio.file.StandardOpenOption.READ
import java.util.Base64
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit

internal object DesktopWindowsForkUpdate : WindowsForkUpdateInstaller {
    // Release decision after signed MSI acceptance. No environment or UI override.
    override val installationReleased = false
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
        return withContext(Dispatchers.IO + NonCancellable) {
            val file = File(path).toPath().toRealPath().toFile()
            FileChannel.open(file.toPath(), READ, NOSHARE_WRITE, NOSHARE_DELETE).use {
                verifyLocked(update, file)
                caller.ensureActive()
                if (partyActive()) throw ForkInstallBlockedByParty()
                val command = windowsInstallerCommand(file).toMutableList().apply {
                    this[0] = systemTool("msiexec.exe")
                    add("/norestart")
                }
                val process = try {
                    ProcessBuilder(command).redirectOutput(ProcessBuilder.Redirect.DISCARD)
                        .redirectError(ProcessBuilder.Redirect.DISCARD).start()
                } catch (_: IOException) {
                    throw ForkWindowsInstallerFailure(null)
                }
                when (val code = process.waitFor()) {
                    0 -> ForkInstallResult.Installed
                    3010, 1641 -> ForkInstallResult.RestartRequired
                    1602 -> ForkInstallResult.Cancelled
                    else -> throw ForkWindowsInstallerFailure(code)
                }
            }
        }
    }

    private fun verifyLocked(update: AppUpdate, file: File) {
        check(canDownload)
        val expected = requireNotNull(forkMsiProductVersion(update.tag))
        val installed = requireNotNull(forkMsiProductVersion(AppUpdaterPlatform.currentVersionName))
        val digest = requireNotNull(update.assetSha256)
        val launcher = File(requireNotNull(System.getProperty("jpackage.app-path")))
        check(file.name == update.assetName && file.length() == update.assetSizeBytes)
        val script = listOf("windows-msi-identity.ps1", "windows-update-trust.ps1", "verify-windows-update.ps1")
            .joinToString("\n") { name ->
                checkNotNull(javaClass.getResourceAsStream("/fork-updater/$name")).bufferedReader().use { it.readText() }
            }
        runWindowsMsiVerifier(
            script,
            mapOf(
                "NUVIO_VERIFY_UPDATE_PATH" to file.absolutePath,
                "NUVIO_VERIFY_UPDATE_SHA256" to digest,
                "NUVIO_VERIFY_UPDATE_VERSION" to expected,
                "NUVIO_VERIFY_INSTALLED_VERSION" to installed,
                "NUVIO_VERIFY_RUNNING_LAUNCHER" to launcher.canonicalPath,
            ),
        )
    }
}

internal fun runWindowsMsiVerifier(
    script: String,
    variables: Map<String, String> = emptyMap(),
    timeoutMillis: Long = 90_000,
) {
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
        check(process.waitFor(timeoutMillis, TimeUnit.MILLISECONDS)) { "MSI verifier timed out." }
        input.get(5, TimeUnit.SECONDS)
        check(process.exitValue() == 0)
    } finally {
        if (process.isAlive) process.destroyForcibly()
        input.cancel(true)
    }
}

private fun systemTool(path: String): String =
    File(requireNotNull(System.getenv("SystemRoot")), "System32/$path").absolutePath
