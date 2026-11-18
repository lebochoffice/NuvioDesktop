package com.nuvio.app.features.player.skip

import com.nuvio.app.features.player.PlayerSettingsRepository
import com.nuvio.app.features.tmdb.TmdbService
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope

object SkipIntroRepository {

    private val cache = HashMap<String, List<SkipInterval>>()
    private val animeSkipShowIdCache = HashMap<String, String>()
    private const val NO_ID = "__none__"

    private val introDbConfigured: Boolean
        get() = IntroDbConfig.URL.isNotBlank()

    suspend fun getMovieSkipIntervals(
        contentId: String?,
        videoId: String?,
        requireSkipIntroEnabled: Boolean = true,
    ): List<SkipInterval> {
        if (!introDbConfigured ||
            (requireSkipIntroEnabled && !PlayerSettingsRepository.uiState.value.skipIntroEnabled)
        ) return emptyList()
        val imdbId = resolveMovieSkipImdbId(
            contentId, videoId,
            resolveTmdb = { TmdbService.tmdbToImdb(it, "movie") },
            resolveAnime = { source, id -> SimklIdResolver.resolveIds(source, id)?.imdb },
        ) ?: return emptyList()
        val cacheKey = "movie:$imdbId"
        cache[cacheKey]?.let { return it }
        val data = SkipIntroApi.getIntroDbMovieSegments(imdbId) ?: return emptyList()
        return data.movieSkipIntervals().also { cache[cacheKey] = it }
    }

    suspend fun getSkipIntervals(
        imdbId: String?,
        season: Int,
        episode: Int,
        requireSkipIntroEnabled: Boolean = true,
    ): List<SkipInterval> = getSkipIntervalsOutcome(imdbId, season, episode, requireSkipIntroEnabled).intervals

    /**
     * IntroDB and the anime chain (Simkl -> AniSkip/Anime-Skip) run in parallel with
     * their own bounds. Only a complete outcome is cached: a transient failure must
     * not hide the button for the rest of the session.
     */
    internal suspend fun getSkipIntervalsOutcome(
        imdbId: String?,
        season: Int,
        episode: Int,
        requireSkipIntroEnabled: Boolean = true,
        onIntroDb: (List<SkipInterval>) -> Unit = {},
    ): SkipLookupOutcome {
        if (imdbId == null) return SkipLookupOutcome.NoData
        val settings = PlayerSettingsRepository.uiState.value
        if (requireSkipIntroEnabled && !settings.skipIntroEnabled) return SkipLookupOutcome.NoData

        val cacheKey = "$imdbId:$season:$episode"
        cache[cacheKey]?.let { return SkipLookupOutcome(it, complete = true) }

        val outcome = resolveParallelSkipProviders(
            introDb = { if (introDbConfigured) fetchFromIntroDb(imdbId, season, episode) else emptyList() },
            anime = { animeIntervalsForImdbEpisode(imdbId, season, episode) },
            onIntroDb = onIntroDb,
        )
        if (outcome.complete) cache[cacheKey] = outcome.intervals
        return outcome
    }

    /** null = a transient failure of AniSkip or Anime-Skip; empty = no anime data. */
    private suspend fun animeIntervalsForImdbEpisode(imdbId: String, season: Int, episode: Int): List<SkipInterval>? =
        coroutineScope {
            // Resolve IMDB -> season-specific MAL/AniList via Simkl full_anime_seasons
            val simklIds = SimklIdResolver.resolveIdsForImdbEpisode(imdbId, season, episode)
                ?: return@coroutineScope emptyList()
            val malId = simklIds.mal
            val anilistId = simklIds.anilist

            // Remap the TVDB episode number to the anime-entry-local episode number.
            val mapping = SimklIdResolver.getEpisodeMapping(simklIds.simklId, simklIds.type)
            val animeEpisode = mapping.firstOrNull { it.tvdbSeason == season && it.tvdbEpisode == episode }
                ?.animeEpisode
                ?: episode

            val aniSkipDeferred = async {
                if (malId != null) fetchFromAniSkip(malId, animeEpisode) else emptyList()
            }
            val animeSkipDeferred = async {
                if (anilistId != null) fetchFromAnimeSkip(anilistId, animeEpisode, season = null) else emptyList()
            }
            val aniSkip = aniSkipDeferred.await()
            val animeSkip = animeSkipDeferred.await()
            if (aniSkip == null || animeSkip == null) null else mergeSkipProviderResults(aniSkip, animeSkip)
        }

    suspend fun getSkipIntervalsForMal(
        malId: String,
        episode: Int,
        requireSkipIntroEnabled: Boolean = true,
        imdbId: String? = null,
        imdbSeason: Int? = null,
        imdbEpisode: Int? = null,
    ): List<SkipInterval> = getSkipIntervalsForMalOutcome(
        malId, episode, requireSkipIntroEnabled, imdbId, imdbSeason, imdbEpisode,
    ).intervals

    internal suspend fun getSkipIntervalsForMalOutcome(
        malId: String,
        episode: Int,
        requireSkipIntroEnabled: Boolean = true,
        imdbId: String? = null,
        imdbSeason: Int? = null,
        imdbEpisode: Int? = null,
    ): SkipLookupOutcome = coroutineScope {
        val settings = PlayerSettingsRepository.uiState.value
        if (requireSkipIntroEnabled && !settings.skipIntroEnabled) return@coroutineScope SkipLookupOutcome.NoData

        val cacheKey = "mal:$malId:$episode"
        cache[cacheKey]?.let { return@coroutineScope SkipLookupOutcome(it, complete = true) }

        val aniSkipDeferred = async { fetchFromAniSkip(malId, episode) }

        val simklIdsDeferred = async { SimklIdResolver.resolveIds("mal", malId) }
        val simklIds = simklIdsDeferred.await()
        val resolvedImdbId = imdbId ?: simklIds?.imdb

        val tvdbDeferred = async {
            if (introDbConfigured && resolvedImdbId != null && imdbSeason == null && simklIds != null) {
                SimklIdResolver.resolveEpisodeTvdb("mal", malId, episode)
            } else null
        }

        // Anime-Skip only needs the AniList id, so it must not depend on the IntroDB episode mapping.
        val anilistId = simklIds?.anilist
        val animeSkipDeferred = async {
            if (anilistId != null) fetchFromAnimeSkip(anilistId, episode, season = null) else emptyList()
        }

        var introDb: List<SkipInterval>? = emptyList()
        if (resolvedImdbId != null && introDbConfigured) {
            val tvdb = tvdbDeferred.await()
            val introDbSeason = imdbSeason ?: tvdb?.first
            if (introDbSeason != null) {
                val introDbEpisode = imdbEpisode ?: tvdb?.second ?: episode
                introDb = fetchFromIntroDb(resolvedImdbId, introDbSeason, introDbEpisode)
            }
        }

        completeOutcome(cacheKey, introDb, aniSkipDeferred.await(), animeSkipDeferred.await())
    }

    suspend fun getSkipIntervalsForKitsu(
        kitsuId: String,
        episode: Int,
        requireSkipIntroEnabled: Boolean = true,
        imdbId: String? = null,
        imdbSeason: Int? = null,
        imdbEpisode: Int? = null,
    ): List<SkipInterval> = getSkipIntervalsForKitsuOutcome(
        kitsuId, episode, requireSkipIntroEnabled, imdbId, imdbSeason, imdbEpisode,
    ).intervals

    internal suspend fun getSkipIntervalsForKitsuOutcome(
        kitsuId: String,
        episode: Int,
        requireSkipIntroEnabled: Boolean = true,
        imdbId: String? = null,
        imdbSeason: Int? = null,
        imdbEpisode: Int? = null,
    ): SkipLookupOutcome = coroutineScope {
        val settings = PlayerSettingsRepository.uiState.value
        if (requireSkipIntroEnabled && !settings.skipIntroEnabled) return@coroutineScope SkipLookupOutcome.NoData

        val cacheKey = "kitsu:$kitsuId:$episode"
        cache[cacheKey]?.let { return@coroutineScope SkipLookupOutcome(it, complete = true) }

        val simklIdsDeferred = async { SimklIdResolver.resolveIds("kitsu", kitsuId) }
        val simklIds = simklIdsDeferred.await()
        val malIdStr = simklIds?.mal
        val resolvedImdbId = imdbId ?: simklIds?.imdb

        val aniSkipDeferred = async {
            if (malIdStr != null) fetchFromAniSkip(malIdStr, episode) else emptyList()
        }

        val tvdbDeferred = async {
            if (introDbConfigured && resolvedImdbId != null && imdbSeason == null && simklIds != null) {
                SimklIdResolver.resolveEpisodeTvdb("kitsu", kitsuId, episode)
            } else null
        }

        // Anime-Skip only needs the AniList id, so it must not depend on the IntroDB episode mapping.
        val anilistId = simklIds?.anilist
        val animeSkipDeferred = async {
            if (anilistId != null) fetchFromAnimeSkip(anilistId, episode, season = null) else emptyList()
        }

        var introDb: List<SkipInterval>? = emptyList()
        if (resolvedImdbId != null && introDbConfigured) {
            val tvdb = tvdbDeferred.await()
            val introDbSeason = imdbSeason ?: tvdb?.first
            if (introDbSeason != null) {
                val introDbEpisode = imdbEpisode ?: tvdb?.second ?: episode
                introDb = fetchFromIntroDb(resolvedImdbId, introDbSeason, introDbEpisode)
            }
        }

        completeOutcome(cacheKey, introDb, aniSkipDeferred.await(), animeSkipDeferred.await())
    }

    /** Merge by priority; cache only when no provider failed transiently (null). */
    private fun completeOutcome(cacheKey: String, vararg providerResults: List<SkipInterval>?): SkipLookupOutcome {
        val intervals = mergeSkipProviderResults(*providerResults.map { it.orEmpty() }.toTypedArray())
        val complete = providerResults.all { it != null }
        if (complete) cache[cacheKey] = intervals
        return SkipLookupOutcome(intervals, complete)
    }

    /** null = transient failure (network, HTTP error, unreadable answer); empty = IntroDB has no segment. */
    private suspend fun fetchFromIntroDb(imdbId: String, season: Int, episode: Int): List<SkipInterval>? {
        return try {
            val data = SkipIntroApi.getIntroDbSegments(imdbId, season, episode) ?: return null
            listOfNotNull(
                data.intro.toSkipIntervalOrNull("intro"),
                data.recap.toSkipIntervalOrNull("recap"),
                data.outro.toSkipIntervalOrNull("outro"),
            )
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            null
        }
    }

    private fun IntroDbSegment?.toSkipIntervalOrNull(type: String): SkipInterval? {
        if (this == null) return null
        val start = startSec ?: startMs?.let { it / 1000.0 }
        val end = endSec ?: endMs?.let { it / 1000.0 }
        if (start == null || end == null || !start.isFinite() || !end.isFinite() || start < 0 || end <= start) return null
        return SkipInterval(startTime = start, endTime = end, type = type, provider = "introdb")
    }

    /** null = transient failure; AniSkip's 404 "No skip times found" is a real empty answer. */
    private suspend fun fetchFromAniSkip(malId: String, episode: Int): List<SkipInterval>? {
        return try {
            val response = SkipIntroApi.getAniSkipTimes(malId, episode) ?: return null
            if (!response.found) return emptyList()
            response.results?.map { result ->
                SkipInterval(
                    startTime = result.interval.startTime,
                    endTime = result.interval.endTime,
                    type = result.skipType,
                    provider = "aniskip",
                )
            } ?: emptyList()
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            null
        }
    }

    /** null = transient failure of an Anime-Skip query; empty = disabled or no data. */
    private suspend fun fetchFromAnimeSkip(anilistId: String, episode: Int, season: Int?): List<SkipInterval>? {
        val settings = PlayerSettingsRepository.uiState.value
        val clientId = settings.animeSkipClientId.trim()
        if (clientId.isBlank()) return emptyList()
        if (!settings.animeSkipEnabled) return emptyList()

        return try {
            val showIds = resolveAnimeSkipShowIds(anilistId, clientId) ?: return null
            if (showIds.isEmpty()) return emptyList()

            var failed = false
            for (showId in showIds) {
                val query = "{ findEpisodesByShowId(showId: \"$showId\") { season number baseDuration timestamps { at type { name } } } }"
                val response = SkipIntroApi.queryAnimeSkip(clientId, query)
                if (response == null) { failed = true; continue }
                val episodes = response.data?.findEpisodesByShowId ?: continue

                val result = episodes
                    .filter { ep ->
                        ep.number?.toIntOrNull() == episode &&
                            (season == null || ep.season?.toIntOrNull() == season)
                    }
                    .bestAnimeSkipIntervals()
                if (result.isNotEmpty()) return result
            }
            if (failed) null else emptyList()
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            null
        }
    }

    /** null = the lookup failed and is not cached; an empty list is a real "no show". */
    private suspend fun resolveAnimeSkipShowIds(anilistId: String, clientId: String): List<String>? {
        animeSkipShowIdCache[anilistId]?.let { cached ->
            return if (cached == NO_ID) emptyList() else listOf(cached)
        }
        val query = "{ findShowsByExternalId(service: ANILIST, serviceId: \"$anilistId\") { id } }"
        val response = try {
            SkipIntroApi.queryAnimeSkip(clientId, query)
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            null
        } ?: return null
        val showIds = response.data?.findShowsByExternalId?.map { it.id } ?: emptyList()

        if (showIds.size == 1) animeSkipShowIdCache[anilistId] = showIds[0]
        else if (showIds.isEmpty()) animeSkipShowIdCache[anilistId] = NO_ID
        return showIds
    }

    suspend fun submitIntro(
        imdbId: String,
        season: Int,
        episode: Int,
        startSec: Double,
        endSec: Double,
        segmentType: String,
    ): Boolean {
        val settings = PlayerSettingsRepository.uiState.value
        val apiKey = settings.introDbApiKey.trim()
        if (!settings.introSubmitEnabled || apiKey.isBlank()) return false

        val request = SubmitIntroRequest(
            imdbId = imdbId,
            season = season,
            episode = episode,
            startSec = startSec,
            endSec = endSec,
            startMs = (startSec * 1000).toLong(),
            endMs = (endSec * 1000).toLong(),
            segmentType = segmentType,
        )

        return SkipIntroApi.submitIntro(apiKey, request)
    }

    suspend fun verifyIntroDbApiKey(apiKey: String): Boolean {
        return SkipIntroApi.verifyIntroDbApiKey(apiKey)
    }

    fun clearCache() {
        cache.clear()
        animeSkipShowIdCache.clear()
        SimklIdResolver.clearCache()
    }
}

internal suspend fun resolveMovieSkipImdbId(
    contentId: String?,
    videoId: String?,
    resolveTmdb: suspend (Int) -> String?,
    resolveAnime: suspend (String, String) -> String?,
): String? {
    val ids = listOfNotNull(contentId, videoId).map(String::trim).distinct()
    val imdbPattern = Regex("tt[0-9]+")
    ids.map { it.substringBefore(':') }.firstOrNull { imdbPattern.matches(it) }?.let { return it }
    return ids.firstNotNullOfOrNull { id ->
        val parts = id.split(':')
        val value = parts.getOrNull(1)?.takeIf { it.isNotEmpty() && it.all(Char::isDigit) }
            ?: return@firstNotNullOfOrNull null
        when (parts.first().lowercase()) {
            "tmdb" -> value.toIntOrNull()?.takeIf { it > 0 }?.let { resolveTmdb(it) }
            "mal", "kitsu" -> resolveAnime(parts.first().lowercase(), value)
            else -> null
        }?.trim()?.takeIf { imdbPattern.matches(it) }
    }
}

/**
 * A show can hold several community entries for the same episode number, some of them incomplete.
 * Pick the entry covering the most segment categories (opening / ending / recap), then the one
 * with the most segments; on a tie the earlier entry wins.
 */
internal fun List<AnimeSkipEpisode>.bestAnimeSkipIntervals(): List<SkipInterval> =
    map { it.timestamps.orEmpty().toAnimeSkipIntervals(it.baseDuration) }
        .filter { it.isNotEmpty() }
        .maxWithOrNull(
            compareBy<List<SkipInterval>>(
                { intervals -> intervals.mapNotNull { segmentCategory(it.type) }.toSet().size },
                { it.size }
            )
        )
        .orEmpty()

/**
 * Anime-Skip timestamps only mark where a segment starts; each one ends where the next begins.
 * The last timestamp has no known end. Only an ending may run to the end of the episode, and only
 * when it starts in the second half of it (if the duration is known); an open-ended intro or recap
 * is dropped, since stretching it would skip the whole episode.
 */
internal fun List<AnimeSkipTimestamp>.toAnimeSkipIntervals(baseDuration: Double? = null): List<SkipInterval> {
    val sorted = sortedBy { it.at }
    return sorted.mapIndexedNotNull { i, ts ->
        val type = when (ts.type.name.lowercase()) {
            "intro", "new intro" -> "op"
            "credits", "new credits" -> "ed"
            "mixed intro" -> "mixed-op"
            "mixed credits" -> "mixed-ed"
            "recap" -> "recap"
            else -> return@mapIndexedNotNull null
        }
        val next = sorted.getOrNull(i + 1)
        val endTime = when {
            next != null -> next.at.takeIf { it > ts.at } ?: return@mapIndexedNotNull null
            segmentCategory(type) == "ending" && (baseDuration == null || ts.at >= baseDuration / 2) ->
                Double.MAX_VALUE
            else -> return@mapIndexedNotNull null
        }
        SkipInterval(startTime = ts.at, endTime = endTime, type = type, provider = "animeskip")
    }
}

internal fun segmentCategory(type: String): String? = when (type.lowercase()) {
    "intro", "op", "mixed-op" -> "opening"
    "outro", "ed", "mixed-ed", "credits", "ending" -> "ending"
    "recap" -> "recap"
    else -> null
}
