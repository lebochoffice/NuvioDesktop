package com.nuvio.app.features.updater

import com.nuvio.app.core.build.AppVersionConfig

internal actual fun windowsForkUpdateInstaller(): WindowsForkUpdateInstaller? = null

actual object AppUpdaterPlatform {
    actual val isSupported: Boolean = true
    actual val isDebugBuild: Boolean
        get() = AndroidAppUpdaterPlatform.isDebugBuild()
    actual val hasSingleUpdateChannel: Boolean = false
    actual val isStatusOnlyForkUpdater: Boolean = false
    actual fun getLastSuccessfulForkCheck(): Long? = null
    actual fun setLastSuccessfulForkCheck(epochMillis: Long) = Unit
    // Upstream behaviour unchanged here; only the fork's desktop build enforces checksums.
    actual val requiresUpdateChecksum: Boolean = false
    actual fun verifyDownloadedUpdate(path: String, expectedSha256: String): Result<Unit> = Result.success(Unit)

    actual val releaseSource: AppUpdateReleaseSource = AppUpdateReleaseSource(
        owner = "NuvioMedia",
        repo = "NuvioMobile",
        channelBranch = "cmp-rewrite",
        userAgent = "NuvioMobile",
    )

    actual val assetSelector: AppUpdateAssetSelector
        get() = AppUpdateAssetSelector(
            fileExtensions = listOf(".apk"),
            contentTypes = listOf("application/vnd.android.package-archive"),
            preferredNameFragments = AndroidAppUpdaterPlatform.getSupportedAbis(),
            fallbackNameFragments = listOf("universal", "all"),
        )

    actual val currentVersionName: String = AppVersionConfig.VERSION_NAME

    actual fun getSupportedAbis(): List<String> = AndroidAppUpdaterPlatform.getSupportedAbis()

    actual fun getIgnoredTag(): String? = AndroidAppUpdaterPlatform.getIgnoredTag()

    actual fun setIgnoredTag(tag: String?) {
        AndroidAppUpdaterPlatform.setIgnoredTag(tag)
    }

    actual fun getUpdateChannel(): String? = AndroidAppUpdaterPlatform.getUpdateChannel()

    actual fun setUpdateChannel(channel: String) {
        AndroidAppUpdaterPlatform.setUpdateChannel(channel)
    }

    actual fun deleteDownloadedUpdate(path: String) {
        AndroidAppUpdaterPlatform.deleteDownloadedUpdate(path)
    }

    actual suspend fun downloadUpdateAsset(
        assetUrl: String,
        assetName: String,
        onProgress: (downloadedBytes: Long, totalBytes: Long?) -> Unit,
    ): Result<String> = AndroidAppUpdaterPlatform.downloadUpdateAsset(assetUrl, assetName, onProgress)

    actual fun canInstallDownloadedUpdate(): Boolean = AndroidAppUpdaterPlatform.canRequestPackageInstalls()

    actual fun openInstallPermissionSettings() {
        AndroidAppUpdaterPlatform.openUnknownSourcesSettings()
    }

    actual fun installDownloadedUpdate(path: String): Result<Unit> = AndroidAppUpdaterPlatform.installDownloadedUpdate(path)
}
