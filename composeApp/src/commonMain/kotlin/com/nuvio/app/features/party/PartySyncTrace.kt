package com.nuvio.app.features.party

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlin.time.Clock

/** Opt-in, bounded local diagnostics. No logger/Sentry, arbitrary text, IDs or URLs. */
internal object PartySyncTrace {
    enum class Event { Playback, WaitStarted, WaitEnded, Sample, BufferStart, BufferEnd, SeekCommand, SeekDrift, Rate }
    enum class Source { Local, Command, Realtime, Snapshot, Coordinator, Native }
    data class Entry(
        val at: Long, val event: Event, val source: Source, val seq: Long?,
        val paused: Boolean?, val waiting: Boolean?, val waitingMembers: Int?,
        val localWaiting: Boolean?, val loadingMembers: Int?, val bufferingMembers: Int?,
        val positionMs: Long?, val expectedMs: Long?, val bufferAheadMs: Long?, val rate: Float?,
    )
    data class Snapshot(val enabled: Boolean = false, val total: Long = 0, val entries: List<Entry> = emptyList())
    private val mutable = MutableStateFlow(Snapshot())
    val state = mutable.asStateFlow()
    val enabled get() = mutable.value.enabled
    fun enable() { mutable.value = Snapshot(enabled = true) }
    fun disable() { mutable.value = Snapshot() }
    fun record(
        event: Event, source: Source = Source.Native, playback: PartyPlayback? = null,
        waitingMembers: Int? = null, positionMs: Long? = null, expectedMs: Long? = null,
        bufferAheadMs: Long? = null, rate: Float? = null,
        localWaiting: Boolean? = null, loadingMembers: Int? = null, bufferingMembers: Int? = null,
    ) {
        if (!enabled) return
        val entry = Entry(Clock.System.now().toEpochMilliseconds(), event, source, playback?.seq,
            playback?.paused, playback?.waiting, waitingMembers, localWaiting, loadingMembers, bufferingMembers, positionMs, expectedMs, bufferAheadMs,
            rate?.takeIf { it.isFinite() })
        mutable.update { current ->
            if (!current.enabled) current else current.copy(total = current.total + 1, entries = (current.entries + entry).takeLast(240))
        }
    }
    fun text(snapshot: Snapshot): String = buildString {
        appendLine("local_sync_trace_v1 events=${snapshot.total} retained=${snapshot.entries.size}")
        appendLine("utc_ms,event,source,seq,paused,waiting,waiting_members,local_waiting,loading_members,buffering_members,position_ms,expected_ms,buffer_ahead_ms,rate")
        snapshot.entries.forEach { e ->
            appendLine(listOf(e.at, e.event, e.source, e.seq, e.paused, e.waiting, e.waitingMembers,
                e.localWaiting, e.loadingMembers, e.bufferingMembers, e.positionMs, e.expectedMs, e.bufferAheadMs, e.rate).joinToString(",") { it?.toString().orEmpty() })
        }
    }
}
