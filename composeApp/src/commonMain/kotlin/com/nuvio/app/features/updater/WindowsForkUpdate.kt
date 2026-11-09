package com.nuvio.app.features.updater

internal const val forkUpdateRepository = "lebochoffice/NuvioDesktop"
internal const val maximumForkMsiBytes = 1024L * 1024 * 1024

internal fun forkMsiProductVersion(tag: String): String? {
    val parts = Regex("^v?(0|[1-9][0-9]{0,2})\\.(0|[1-9][0-9]{0,2})\\.(0|[1-9][0-9]{0,4})-watchparty$")
        .matchEntire(tag)?.groupValues ?: return null
    val major = parts[1].toInt().coerceAtLeast(1)
    val minor = parts[2].toInt()
    val patch = parts[3].toInt()
    if (major > 255 || minor > 255 || patch > 65535) return null
    return "$major.$minor.$patch"
}

internal fun windowsForkUpdate(release: GitHubReleaseDto): AppUpdate? {
    val tag = release.tagName ?: return null
    if (!tag.startsWith("v") || release.draft || release.prerelease || forkMsiProductVersion(tag) == null) return null
    val name = "Nuvio-WatchParty-Windows-x64-${tag.removePrefix("v")}.msi"
    val asset = release.assets.singleOrNull { it.name == name } ?: return null
    val url = "https://github.com/$forkUpdateRepository/releases/download/$tag/$name"
    if (asset.browserDownloadUrl != url || asset.size == null || asset.size !in 1L..maximumForkMsiBytes) return null
    val digest = sha256FromDigest(asset.digest) ?: return null
    return AppUpdate(tag, release.name ?: tag, release.body.orEmpty(), release.htmlUrl, name, url, asset.size, digest)
}

internal enum class ForkInstallResult { HandedOff, Installed, RestartRequired, Cancelled }
internal class ForkInstallBlockedByParty : IllegalStateException()
internal class ForkInstallBlockedByPlayback : IllegalStateException()
internal class ForkInstallBlockedBySettings : IllegalStateException()
internal class ForkInstallBlockedByInstance : IllegalStateException()
internal class ForkWindowsInstallerFailure(val exitCode: Int?) : IllegalStateException()

internal interface WindowsForkUpdateInstaller {
    val canDownload: Boolean
    val installationReleased: Boolean
    suspend fun download(update: AppUpdate, progress: (Long, Long?) -> Unit): String
    suspend fun verify(update: AppUpdate, path: String)
    suspend fun install(update: AppUpdate, path: String, partyActive: () -> Boolean): ForkInstallResult
}

internal expect fun windowsForkUpdateInstaller(): WindowsForkUpdateInstaller?
