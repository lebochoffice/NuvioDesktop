package com.nuvio.app.features.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nuvio.app.features.updater.AppUpdaterPlatform
import com.nuvio.app.features.updater.ForkUpdateTransfer
import com.nuvio.app.features.updater.LocalForkUpdater
import com.nuvio.app.features.updater.ReleaseLookup
import com.nuvio.app.features.updater.UpdateLookupError
import kotlin.time.Instant
import nuvio.composeapp.generated.resources.*
import org.jetbrains.compose.resources.stringResource

@Composable
internal fun ForkUpdateSettingsSection(isTablet: Boolean) {
    val controller = LocalForkUpdater.current ?: return
    val state by controller.forkStatus.collectAsStateWithLifecycle()
    val fork = state.fork
    val upstream = state.upstream
    val forkRelease = fork?.release
    val comparison = state.versionComparison
    val transfer = state.transfer
    val downloading = transfer == ForkUpdateTransfer.Downloading || transfer == ForkUpdateTransfer.Verifying
    val busy = downloading || transfer == ForkUpdateTransfer.Installing
    val ready = transfer in setOf(ForkUpdateTransfer.Ready, ForkUpdateTransfer.PartyActive,
        ForkUpdateTransfer.InstallFailed, ForkUpdateTransfer.InstallCancelled)
    var confirm by remember(forkRelease?.update, transfer) { mutableStateOf(false) }
    val status = when {
        state.checking -> Res.string.fork_updates_checking
        fork?.error != null -> fork.error.messageRes()
        fork == null -> Res.string.fork_updates_not_checked
        forkRelease == null -> Res.string.fork_updates_no_release
        comparison == null -> Res.string.fork_updates_unknown_version
        comparison > 0 -> Res.string.fork_updates_available
        else -> Res.string.fork_updates_current
    }
    SettingsSection(title = stringResource(Res.string.fork_updates_title), isTablet = isTablet) {
        SettingsGroup(isTablet = isTablet) {
            Column(
                modifier = Modifier.fillMaxWidth().padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(stringResource(Res.string.fork_updates_installed, AppUpdaterPlatform.currentVersionName))
                Text(stringResource(Res.string.fork_updates_found, releaseLabel(fork)))
                Text(stringResource(status), style = MaterialTheme.typography.titleSmall)
                Text(stringResource(
                    Res.string.fork_updates_last_check,
                    state.lastSuccessfulCheck?.let { Instant.fromEpochMilliseconds(it).toString() }
                        ?: stringResource(Res.string.fork_updates_not_checked),
                ))
                Text(stringResource(Res.string.fork_updates_upstream, releaseLabel(upstream)))
                if (forkRelease != null && forkRelease.notes.isNotBlank()) {
                    Text(stringResource(Res.string.fork_updates_changelog), style = MaterialTheme.typography.titleSmall)
                    Text(forkRelease.notes.take(4000))
                }
                OutlinedButton(
                    enabled = !state.checking && !busy,
                    onClick = { controller.checkForUpdates(force = true, showNoUpdateFeedback = false) },
                ) { Text(stringResource(Res.string.fork_updates_check_now)) }
                if (transfer != ForkUpdateTransfer.Idle) {
                    Text(stringResource(transfer.messageRes()))
                    state.installerExitCode?.let { Text(stringResource(Res.string.fork_updates_exit_code, it)) }
                }
                if (transfer == ForkUpdateTransfer.Downloading) {
                    val progress = state.progress
                    if (progress == null) LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                    else LinearProgressIndicator(progress = { progress }, modifier = Modifier.fillMaxWidth())
                }
                if (downloading) {
                    OutlinedButton(onClick = controller::cancelForkDownload) {
                        Text(stringResource(Res.string.fork_updates_cancel_download))
                    }
                } else if (ready && controller.isForkInstallationReleased) {
                    OutlinedButton(enabled = !state.checking, onClick = { confirm = true }) {
                        Text(stringResource(Res.string.fork_updates_install))
                    }
                } else if (!ready && !busy && state.canUseUpdate && controller.canDownloadForkUpdate &&
                    transfer !in setOf(ForkUpdateTransfer.Installed, ForkUpdateTransfer.RestartRequired)) {
                    OutlinedButton(enabled = !state.checking, onClick = controller::downloadForkUpdate) {
                        Text(stringResource(Res.string.fork_updates_download))
                    }
                }
                if ((comparison ?: 0) > 0 && !state.canUseUpdate) Text(stringResource(Res.string.fork_updates_no_package))
                if (!controller.canDownloadForkUpdate) Text(stringResource(Res.string.fork_updates_signer_missing))
                if (!controller.isForkInstallationReleased) Text(stringResource(Res.string.fork_updates_install_disabled))
            }
        }
    }
    if (confirm && ready && controller.isForkInstallationReleased) {
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text(stringResource(Res.string.fork_updates_install)) },
            text = { Text(stringResource(Res.string.fork_updates_confirm_install, forkRelease?.tag.orEmpty())) },
            confirmButton = {
                TextButton(onClick = { confirm = false; controller.confirmForkInstallation() }) {
                    Text(stringResource(Res.string.fork_updates_install))
                }
            },
            dismissButton = {
                TextButton(onClick = { confirm = false }) { Text(stringResource(Res.string.fork_updates_dismiss)) }
            },
        )
    }
}

private fun ForkUpdateTransfer.messageRes() = when (this) {
    ForkUpdateTransfer.Idle -> Res.string.fork_updates_not_checked
    ForkUpdateTransfer.Downloading -> Res.string.fork_updates_downloading
    ForkUpdateTransfer.Verifying -> Res.string.fork_updates_verifying
    ForkUpdateTransfer.Ready -> Res.string.fork_updates_ready
    ForkUpdateTransfer.Installing -> Res.string.fork_updates_installing
    ForkUpdateTransfer.Installed -> Res.string.fork_updates_installed_restart_app
    ForkUpdateTransfer.RestartRequired -> Res.string.fork_updates_restart_windows
    ForkUpdateTransfer.Cancelled, ForkUpdateTransfer.InstallCancelled -> Res.string.fork_updates_cancelled
    ForkUpdateTransfer.DownloadFailed -> Res.string.fork_updates_download_failed
    ForkUpdateTransfer.VerificationFailed -> Res.string.fork_updates_verification_failed
    ForkUpdateTransfer.InstallFailed -> Res.string.fork_updates_install_failed
    ForkUpdateTransfer.PartyActive -> Res.string.fork_updates_party_active
}

@Composable
private fun releaseLabel(lookup: ReleaseLookup?): String = lookup?.release?.tag ?: stringResource(
    lookup?.error?.messageRes() ?: if (lookup == null) Res.string.fork_updates_not_checked
    else Res.string.fork_updates_no_release,
)

private fun UpdateLookupError.messageRes() = when (this) {
    UpdateLookupError.Network -> Res.string.fork_updates_network
    UpdateLookupError.RateLimited -> Res.string.fork_updates_rate_limit
    UpdateLookupError.GitHub -> Res.string.fork_updates_github
}
