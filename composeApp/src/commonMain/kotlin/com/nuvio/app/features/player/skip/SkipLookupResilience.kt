package com.nuvio.app.features.player.skip

import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeoutOrNull

/**
 * One skip lookup. [complete] is true only when every consulted provider gave
 * a real answer (including a real "no data"); a timeout, HTTP error or
 * unreadable response leaves it false. Only complete outcomes may be cached.
 */
internal data class SkipLookupOutcome(val intervals: List<SkipInterval>, val complete: Boolean) {
    companion object {
        val NoData = SkipLookupOutcome(emptyList(), complete = true)
        val Failed = SkipLookupOutcome(emptyList(), complete = false)
    }
}

internal object SkipLookupLimits {
    /** IntroDB normally answers in well under a second; bound it on its own. */
    const val INTRODB_TIMEOUT_MS = 5_000L
    /** Simkl id resolution plus AniSkip/Anime-Skip (several sequential requests). */
    const val ANIME_TIMEOUT_MS = 6_000L
    /** Safety bound for one whole attempt, above both provider bounds. */
    const val ATTEMPT_TIMEOUT_MS = 8_000L
    /** Pauses before the bounded retries of an incomplete lookup (transient failures only). */
    val RETRY_DELAYS_MS: List<Long> = listOf(2_000L, 6_000L)
}

/** Per segment category the first provider wins (IntroDB > AniSkip > Anime-Skip). */
internal fun mergeSkipProviderResults(vararg providerResults: List<SkipInterval>): List<SkipInterval> {
    val chosen = LinkedHashMap<String, SkipInterval>()
    for (result in providerResults) {
        for (interval in result) {
            val category = segmentCategory(interval.type) ?: continue
            if (category !in chosen) chosen[category] = interval
        }
    }
    return chosen.values.toList()
}

/**
 * IntroDB and the anime chain run in parallel, each with its own bound, so a
 * slow or failing Simkl/anime lookup can no longer discard an IntroDB answer
 * that already arrived (previously one 4 s timeout covered everything).
 * A provider result of null means a transient failure.
 */
internal suspend fun resolveParallelSkipProviders(
    introDb: suspend () -> List<SkipInterval>?,
    anime: suspend () -> List<SkipInterval>?,
    introDbTimeoutMs: Long = SkipLookupLimits.INTRODB_TIMEOUT_MS,
    animeTimeoutMs: Long = SkipLookupLimits.ANIME_TIMEOUT_MS,
    // IntroDB data is shown as soon as it arrives, even while the anime chain is still
    // running: an intro that starts at 0 s must not wait for the slower provider.
    onIntroDb: (List<SkipInterval>) -> Unit = {},
): SkipLookupOutcome = coroutineScope {
    val introDbResult = async {
        withTimeoutOrNull(introDbTimeoutMs) { introDb() }?.also { if (it.isNotEmpty()) onIntroDb(it) }
    }
    val animeResult = async { withTimeoutOrNull(animeTimeoutMs) { anime() } }
    val fromIntroDb = introDbResult.await()
    val fromAnime = animeResult.await()
    SkipLookupOutcome(
        intervals = mergeSkipProviderResults(fromIntroDb.orEmpty(), fromAnime.orEmpty()),
        complete = fromIntroDb != null && fromAnime != null,
    )
}

/**
 * Runs [attempt] until it is complete, at most 1 + retryDelaysMs.size times.
 * Every non-empty result is delivered at once (late data still reaches the
 * running episode); a complete result ends the loop, also when it is empty.
 * The caller's coroutine is the episode scope: an episode change cancels the
 * loop, so stale results can never reach the next episode.
 */
internal suspend fun resolveSkipIntervalsWithRetry(
    // The argument delivers early partial data (e.g. IntroDB before the anime chain).
    attempt: suspend (partial: (List<SkipInterval>) -> Unit) -> SkipLookupOutcome,
    onIntervals: (List<SkipInterval>) -> Unit,
    retryDelaysMs: List<Long> = SkipLookupLimits.RETRY_DELAYS_MS,
    attemptTimeoutMs: Long = SkipLookupLimits.ATTEMPT_TIMEOUT_MS,
    sleep: suspend (Long) -> Unit = { delay(it) },
): SkipLookupOutcome {
    var delivered = false
    val partial: (List<SkipInterval>) -> Unit = { intervals ->
        if (!delivered && intervals.isNotEmpty()) {
            onIntervals(intervals)
            delivered = true
        }
    }
    var last = SkipLookupOutcome.Failed
    for (index in 0..retryDelaysMs.size) {
        last = withTimeoutOrNull(attemptTimeoutMs) { attempt(partial) } ?: SkipLookupOutcome.Failed
        if (last.intervals.isNotEmpty() && (!delivered || last.complete)) {
            onIntervals(last.intervals)
            delivered = true
        }
        if (last.complete) return last
        retryDelaysMs.getOrNull(index)?.let { sleep(it) }
    }
    return last
}
