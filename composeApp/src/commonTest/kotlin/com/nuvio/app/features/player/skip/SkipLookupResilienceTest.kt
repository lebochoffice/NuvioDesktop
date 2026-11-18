package com.nuvio.app.features.player.skip

import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class SkipLookupResilienceTest {
    private val intro = SkipInterval(startTime = 128.0, endTime = 160.0, type = "intro", provider = "introdb")
    private val aniOp = SkipInterval(startTime = 30.0, endTime = 120.0, type = "op", provider = "aniskip")
    private val aniEd = SkipInterval(startTime = 1300.0, endTime = 1390.0, type = "ed", provider = "aniskip")
    private val episodeMs = 2_640_000L

    // --- Providers in parallel, each with its own bound ---------------------------------------

    @Test
    fun introDataThatIsImmediatelyAvailableIsDeliveredAtOnce() = runTest {
        val outcome = resolveParallelSkipProviders(introDb = { listOf(intro) }, anime = { emptyList() })
        assertEquals(listOf(intro), outcome.intervals)
        assertTrue(outcome.complete)
    }

    @Test
    fun anIntroDbAnswerAfterMoreThanFourSecondsIsNoLongerLost() = runTest {
        // Previously one 4 s timeout covered everything and discarded this answer.
        val outcome = resolveParallelSkipProviders(
            introDb = { delay(4_500); listOf(intro) },
            anime = { emptyList() },
        )
        assertEquals(listOf(intro), outcome.intervals)
        assertTrue(outcome.complete)
        assertEquals(4_500, currentTime)
    }

    @Test
    fun aStalledSimklOrAnimeChainCannotDiscardAFastIntroDbAnswer() = runTest {
        val outcome = resolveParallelSkipProviders(
            introDb = { delay(150); listOf(intro) },
            anime = { delay(60_000); emptyList() },
        )
        assertEquals(listOf(intro), outcome.intervals)
        assertFalse(outcome.complete) // The anime part timed out: transient, not cacheable.
        assertEquals(SkipLookupLimits.ANIME_TIMEOUT_MS, currentTime)
    }

    @Test
    fun introDbDataIsShownImmediatelyWhileTheAnimeChainIsStillRunning() = runTest {
        val delivered = mutableListOf<Pair<Long, List<SkipInterval>>>()
        val result = resolveSkipIntervalsWithRetry(
            attempt = { partial ->
                resolveParallelSkipProviders(
                    introDb = { delay(150); listOf(intro) },
                    anime = { delay(5_000); listOf(aniEd) },
                    onIntroDb = partial,
                )
            },
            onIntervals = { delivered += currentTime to it },
        )
        assertTrue(result.complete)
        // An intro at 0 s needs the button at once, not after the slower provider.
        assertEquals(listOf(150L to listOf(intro), 5_000L to listOf(intro, aniEd)), delivered)
    }

    @Test
    fun aTransientProviderFailureKeepsTheOtherDataButIsNotComplete() = runTest {
        val outcome = resolveParallelSkipProviders(introDb = { null }, anime = { listOf(aniOp) })
        assertEquals(listOf(aniOp), outcome.intervals)
        assertFalse(outcome.complete)
    }

    @Test
    fun providerPriorityIsIntroDbThenAnimeSourcesPerSegmentCategory() {
        val merged = mergeSkipProviderResults(listOf(intro), listOf(aniOp, aniEd))
        assertEquals(listOf(intro, aniEd), merged) // IntroDB wins the opening, AniSkip fills the ending.
    }

    // --- Bounded retry, late data, episode scope -------------------------------------------------

    @Test
    fun noIntroForThisEpisodeIsAFinalAnswerWithoutRetries() = runTest {
        var attempts = 0
        val delivered = mutableListOf<List<SkipInterval>>()
        val result = resolveSkipIntervalsWithRetry(
            attempt = { attempts++; SkipLookupOutcome.NoData },
            onIntervals = { delivered += it },
        )
        assertTrue(result.complete)
        assertEquals(1, attempts)
        assertTrue(delivered.isEmpty()) // No interval is invented.
    }

    @Test
    fun aTransientErrorIsRetriedAndLateDataStillReachesTheRunningEpisode() = runTest {
        var attempts = 0
        val delivered = mutableListOf<List<SkipInterval>>()
        val result = resolveSkipIntervalsWithRetry(
            attempt = { if (++attempts == 1) SkipLookupOutcome.Failed else SkipLookupOutcome(listOf(intro), complete = true) },
            onIntervals = { delivered += it },
        )
        assertTrue(result.complete)
        assertEquals(2, attempts)
        assertEquals(listOf(listOf(intro)), delivered)
        assertEquals(SkipLookupLimits.RETRY_DELAYS_MS.first(), currentTime)
    }

    @Test
    fun persistentFailuresStopAfterTheBoundedRetries() = runTest {
        var attempts = 0
        val result = resolveSkipIntervalsWithRetry(attempt = { attempts++; SkipLookupOutcome.Failed }, onIntervals = {})
        assertFalse(result.complete)
        assertEquals(1 + SkipLookupLimits.RETRY_DELAYS_MS.size, attempts) // No endless loop.
        assertEquals(SkipLookupLimits.RETRY_DELAYS_MS.sum(), currentTime)
    }

    @Test
    fun partialDataIsShownAtOnceAndOnlyReplacedByACompleteAnswer() = runTest {
        var attempts = 0
        val delivered = mutableListOf<List<SkipInterval>>()
        resolveSkipIntervalsWithRetry(
            attempt = {
                when (++attempts) {
                    1 -> SkipLookupOutcome(listOf(intro), complete = false)   // Anime part failed.
                    2 -> SkipLookupOutcome(listOf(intro), complete = false)   // Still failing: no re-delivery.
                    else -> SkipLookupOutcome(listOf(intro, aniEd), complete = true)
                }
            },
            onIntervals = { delivered += it },
        )
        assertEquals(listOf(listOf(intro), listOf(intro, aniEd)), delivered)
    }

    @Test
    fun aHangingAttemptIsBoundedAndRetried() = runTest {
        var attempts = 0
        val result = resolveSkipIntervalsWithRetry(
            attempt = { if (++attempts == 1) { delay(120_000); SkipLookupOutcome.NoData } else SkipLookupOutcome(listOf(intro), true) },
            onIntervals = {},
        )
        assertTrue(result.complete)
        assertEquals(SkipLookupLimits.ATTEMPT_TIMEOUT_MS + SkipLookupLimits.RETRY_DELAYS_MS.first(), currentTime)
    }

    @Test
    fun anEpisodeChangeCancelsTheLookupSoLateDataNeverReachesTheNextEpisode() = runTest {
        val delivered = mutableListOf<List<SkipInterval>>()
        val job = launch {
            resolveSkipIntervalsWithRetry(
                attempt = { delay(3_000); SkipLookupOutcome(listOf(intro), complete = true) },
                onIntervals = { delivered += it },
            )
        }
        advanceTimeBy(1_000); runCurrent()
        job.cancel() // The episode-keyed LaunchedEffect restarts on an episode change.
        advanceTimeBy(10_000); runCurrent()
        assertTrue(delivered.isEmpty())
    }

    // --- Real answers versus transient errors --------------------------------------------------

    @Test
    fun aniSkipNotFoundIsARealEmptyAnswerButServerErrorsAreTransient() {
        assertEquals(false, aniSkipResponseOf(404, """{"found":false,"results":[],"statusCode":404}""")?.found)
        assertNull(aniSkipResponseOf(500, "oops"))
        assertNull(aniSkipResponseOf(429, ""))
        assertNull(aniSkipResponseOf(200, "<html>proxy error</html>"))
        val found = aniSkipResponseOf(200, """{"found":true,"results":[{"interval":{"startTime":28.7,"endTime":118.7},"skipType":"op"}]}""")
        assertEquals(1, found?.results?.size)
    }

    // --- Lookup identity and the button target ---------------------------------------------------

    @Test
    fun theLookupUsesTheExactSeasonAndEpisodeAndRejectsMissingOrForeignIds() {
        assertEquals(SkipIntervalLookup.Imdb("tt1234567", 5, 8), resolveSkipIntervalLookup("tt1234567:5:8", season = 5, episode = 8))
        assertEquals(SkipIntervalLookup.Imdb("tt1234567", 5, 8), resolveSkipIntervalLookup("tt1234567:5:8", season = null, episode = null))
        assertNull(resolveSkipIntervalLookup(null, season = 5, episode = 8))
        assertNull(resolveSkipIntervalLookup("tt1234567", season = null, episode = null)) // No episode: never guess one.
        assertNull(resolveSkipIntervalLookup("tmdb:1399:1:1", season = 1, episode = 1))
    }

    @Test
    fun anIntroStartingAtZeroSkipsToItsEnd() {
        val atZero = SkipInterval(startTime = 0.0, endTime = 31.0, type = "intro", provider = "introdb")
        assertEquals(31_000L, atZero.internalSkipAction(listOf(atZero), episodeMs)?.targetMs)
    }

    @Test
    fun anIntroAfterARecapHasItsOwnTarget() {
        val recap = SkipInterval(startTime = 0.0, endTime = 95.0, type = "recap", provider = "introdb")
        val later = SkipInterval(startTime = 240.0, endTime = 251.0, type = "intro", provider = "introdb")
        val intervals = listOf(recap, later)
        assertEquals(95_000L, recap.internalSkipAction(intervals, episodeMs)?.targetMs)
        assertEquals(251_000L, later.internalSkipAction(intervals, episodeMs)?.targetMs)
    }
}
