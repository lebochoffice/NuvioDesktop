package com.nuvio.app.features.updater

import com.nuvio.app.core.build.AppVersionConfig

actual object AppUpdaterPlatform {
    actual val isSupported: Boolean = false
    actual val isDebugBuild: Boolean = false
    actual val hasSingleUpdateChannel: Boolean = false
    actual val requiresUpdateChecksum: Boolean = true
    actual val currentVersionName: String = AppVersionConfig.DESKTOP_VERSION_NAME
    actual val assetSelector = AppUpdateAssetSelector(fileExtensions = emptyList())
    actual val releaseSource: AppUpdateReleaseSource
        get() = throw manualUpdateRequired()

    actual fun getSupportedAbis(): List<String> = emptyList()
    actual fun getIgnoredTag(): String? = null
    actual fun setIgnoredTag(tag: String?) = Unit
    actual fun getUpdateChannel(): String? = null
    actual fun setUpdateChannel(channel: String) = Unit
    actual fun deleteDownloadedUpdate(path: String) = Unit
    actual fun canInstallDownloadedUpdate(): Boolean = false
    actual fun openInstallPermissionSettings() = Unit

    actual suspend fun downloadUpdateAsset(
        assetUrl: String,
        assetName: String,
        onProgress: (downloadedBytes: Long, totalBytes: Long?) -> Unit,
    ): Result<String> = Result.failure(manualUpdateRequired())

    actual fun verifyDownloadedUpdate(path: String, expectedSha256: String): Result<Unit> =
        Result.failure(manualUpdateRequired())

    actual fun installDownloadedUpdate(path: String): Result<Unit> =
        Result.failure(manualUpdateRequired())

    private fun manualUpdateRequired() = UnsupportedOperationException("Desktop updates are installed manually.")
}
