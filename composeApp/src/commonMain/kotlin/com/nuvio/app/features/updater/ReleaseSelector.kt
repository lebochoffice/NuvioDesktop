package com.nuvio.app.features.updater

internal object ReleaseSelector {
    private val forkTag = Regex("^v?(\\d+\\.\\d+\\.\\d+)-watchparty$")

    fun forkVersion(tag: String?): SemanticVersion? =
        tag?.let(forkTag::matchEntire)?.groupValues?.get(1)?.let(VersionUtils::parse)

    fun latestForkRelease(releases: List<GitHubReleaseDto>): GitHubReleaseDto? =
        releases.filterNot { it.draft || it.prerelease }
            .mapNotNull { release -> forkVersion(release.tagName)?.let { it to release } }
            .maxByOrNull { it.first }?.second

    private val prereleaseNamePattern = Regex(
        "(?:^|[\\s._-])(alpha|beta|rc|preview)(?:[\\s._-]|$)",
        RegexOption.IGNORE_CASE
    )

    fun eligibleReleases(
        releases: List<GitHubReleaseDto>,
        channel: UpdateChannel
    ): List<GitHubReleaseDto> {
        if (channel == UpdateChannel.ALL_RELEASES) {
            return releases.filterNot(GitHubReleaseDto::draft)
        }

        return releases
            .asSequence()
            .filterNot(GitHubReleaseDto::draft)
            .mapNotNull { release ->
                val version = releaseVersion(release) ?: return@mapNotNull null
                ReleaseCandidate(
                    release = release,
                    version = version,
                    prerelease = isPrerelease(release, version)
                )
            }
            .filter { candidate -> channel == UpdateChannel.BETA || !candidate.prerelease }
            .sortedByDescending(ReleaseCandidate::version)
            .map(ReleaseCandidate::release)
            .toList()
    }

    private fun releaseVersion(release: GitHubReleaseDto): SemanticVersion? =
        VersionUtils.parse(release.tagName) ?: VersionUtils.parse(release.name)

    private fun isPrerelease(
        release: GitHubReleaseDto,
        version: SemanticVersion
    ): Boolean = release.prerelease ||
        version.prerelease.isNotEmpty() ||
        prereleaseNamePattern.containsMatchIn(release.name.orEmpty())

    private data class ReleaseCandidate(
        val release: GitHubReleaseDto,
        val version: SemanticVersion,
        val prerelease: Boolean
    )
}
