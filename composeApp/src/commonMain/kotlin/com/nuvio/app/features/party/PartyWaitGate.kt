package com.nuvio.app.features.party

/** Host-local receipt times: legacy TV clients need no new protocol fields. */
internal class PartyWaitGate {
    private data class Sample(
        val presence: PartyPresence,
        val receivedAt: Long,
        val blockedSince: Long?,
        val readySince: Long?,
        var qualified: Boolean,
    )
    private val samples = mutableMapOf<String, Sample>()

    fun clear() = samples.clear()
    fun retain(memberIds: Set<String>) { samples.keys.retainAll(memberIds) }

    /** Reject provably reordered reports; position data never becomes a command. */
    fun observe(presence: PartyPresence, nowMs: Long): Boolean {
        val old = samples[presence.memberId]?.takeIf { it.presence.mediaKey == presence.mediaKey }
        val fresh = old?.takeIf { nowMs - it.receivedAt <= STALE_MS }
        val previousAt = fresh?.presence?.positionAt
        val nextAt = presence.positionAt
        if (previousAt != null && nextAt != null && nextAt < previousAt) return false
        val blocked = blocks(presence)
        val wasBlocked = fresh?.let { blocks(it.presence) } == true
        val held = fresh?.qualified == true &&
            (fresh.readySince == null || nowMs - fresh.readySince < READY_HOLD_MS)
        samples[presence.memberId] = Sample(
            presence, nowMs,
            if (blocked) fresh?.blockedSince?.takeIf { wasBlocked || held } ?: nowMs else fresh?.blockedSince?.takeIf { held },
            if (presence.status == PartyMemberStatus.Ready) fresh?.readySince ?: nowMs else null,
            held,
        )
        return true
    }

    fun recovered(nowMs: Long): Set<String> = samples.filterValues {
        nowMs - it.receivedAt <= STALE_MS && it.readySince?.let { since -> nowMs - since >= READY_HOLD_MS } == true
    }.keys

    fun waiting(party: ActiveParty, ignored: Set<String>, nowMs: Long): List<String> {
        val admitted = party.members.map { it.id }.toSet() + party.memberId
        retain(party.presence.keys.intersect(admitted))
        return samples.filter { (id, sample) ->
            val current = party.presence[id]
            if (id in ignored || current?.mediaKey != party.media.key || current.solo == true ||
                sample.presence.mediaKey != party.media.key || nowMs - sample.receivedAt > STALE_MS) return@filter false
            if (blocks(sample.presence)) {
                val sustained = sample.blockedSince?.let { nowMs - it >= BUFFER_HOLD_MS } == true
                if (sustained) sample.qualified = true
                sustained
            } else {
                sample.qualified && sample.presence.status == PartyMemberStatus.Ready &&
                    sample.readySince?.let { nowMs - it < READY_HOLD_MS } == true
            }
        }.keys.toList()
    }

    private fun blocks(p: PartyPresence) = p.solo != true &&
        p.status in setOf(PartyMemberStatus.Loading, PartyMemberStatus.Buffering)

    companion object {
        const val BUFFER_HOLD_MS = 2_000L
        const val READY_HOLD_MS = 1_000L
        const val STALE_MS = 30_000L
    }
}

/** No threshold inflation: only persistent automatic drift may trigger a seek. */
internal class PartyDriftGate {
    private var driftSince: Long? = null
    private var lastSeek: Long? = null
    private var recoveryUntil = Long.MIN_VALUE

    fun resetDrift() { driftSince = null }
    fun recovering(nowMs: Long) {
        resetDrift()
        recoveryUntil = nowMs + RECOVERY_MS
    }
    fun seeked(nowMs: Long) {
        resetDrift()
        lastSeek = nowMs
    }
    fun allowSeek(needsSeek: Boolean, nowMs: Long): Boolean {
        if (!needsSeek || nowMs < recoveryUntil) { resetDrift(); return false }
        val since = driftSince ?: nowMs.also { driftSince = it }
        return nowMs - since >= DRIFT_HOLD_MS && lastSeek?.let { nowMs - it >= SEEK_COOLDOWN_MS } != false
    }
    companion object {
        const val DRIFT_HOLD_MS = 2_000L
        const val SEEK_COOLDOWN_MS = 4_000L
        const val RECOVERY_MS = 2_500L
    }
}
