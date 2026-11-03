package com.nuvio.app.features.party

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Guest playback command (browser party, fork protocol 1). Guests no longer
 * assign revisions themselves: the host is the single sequencer. It accepts or
 * rejects each command ID exactly once and publishes accepted ones as normal
 * `state` revisions, so every client orders them with the same seq.
 *
 * The epoch is (hostMemberId, mediaKey): after a host or media change, older
 * commands never become valid again. baseSeq is the revision the guest saw.
 */
@Serializable
internal data class PartyCommand(
    @SerialName("command_id") val commandId: String,
    @SerialName("member_id") val memberId: String,
    val paused: Boolean,
    @SerialName("position_ms") val positionMs: Long,
    @SerialName("base_seq") val baseSeq: Long? = null,
    @SerialName("media_key") val mediaKey: String,
    @SerialName("host_member_id") val hostMemberId: String,
)

internal data class PartyRevision(val seq: Long, val actorId: String?, val system: Boolean)

internal data class PartyCommandResult(val accepted: Boolean, val seq: Long?, val reason: String? = null)

internal sealed interface PartyCommandDecision {
    data object Accept : PartyCommandDecision
    data class Reject(val reason: String) : PartyCommandDecision
}

internal object PartyCommands {
    const val PROTOCOL = 1
    const val HISTORY_LIMIT = 32
    const val PROCESSED_LIMIT = 64
    private val ID = Regex("^[A-Za-z0-9-]{8,64}$")

    fun validId(id: String): Boolean = ID.matches(id)

    /**
     * Accepts a command only if nothing a different member did happened after
     * the revision the guest saw. The guest's own earlier commands (rapid
     * toggling) and coordinator waits ("system") do not conflict.
     */
    fun decide(
        command: PartyCommand,
        party: ActiveParty,
        current: PartyPlayback?,
        history: List<PartyRevision>,
    ): PartyCommandDecision {
        fun reject(reason: String) = PartyCommandDecision.Reject(reason)
        if (!validId(command.commandId) || command.positionMs < 0L) return reject("invalid")
        if (!party.isHost || command.hostMemberId != party.memberId || command.mediaKey != party.media.key) return reject("stale_epoch")
        if (command.memberId == party.memberId || party.members.none { it.id == command.memberId }) return reject("not_member")
        if (party.hostOnly) return reject("host_only")
        if (current == null) return PartyCommandDecision.Accept
        if (current.mediaKey != null && current.mediaKey != party.media.key) return reject("stale_epoch")
        val base = command.baseSeq ?: return reject("superseded")
        if (base > current.seq) return reject("stale_epoch")
        if (base == current.seq) return PartyCommandDecision.Accept
        if (current.seq - base > HISTORY_LIMIT) return reject("superseded")
        val newer = history.filter { it.seq > base }
        val covered = (base + 1..current.seq).all { seq -> newer.any { it.seq == seq } }
        if (!covered) return reject("superseded")
        return if (newer.all { it.system || it.actorId == command.memberId }) PartyCommandDecision.Accept else reject("superseded")
    }
}

/** Host-side ordering memory: accepted revisions and processed command IDs. */
internal class PartyCommandLedger {
    private val history = ArrayDeque<PartyRevision>()
    private val processed = LinkedHashMap<String, PartyCommandResult>()

    fun record(seq: Long, actorId: String?, system: Boolean) {
        history.addLast(PartyRevision(seq, actorId, system))
        while (history.size > PartyCommands.HISTORY_LIMIT) history.removeFirst()
    }

    fun revisions(): List<PartyRevision> = history.toList()

    fun result(commandId: String): PartyCommandResult? = processed[commandId]

    fun remember(commandId: String, result: PartyCommandResult) {
        processed[commandId] = result
        while (processed.size > PartyCommands.PROCESSED_LIMIT) processed.remove(processed.keys.first())
    }

    /** Media change: older revisions no longer describe the current epoch. */
    fun resetRevisions() = history.clear()

    fun clear() {
        history.clear()
        processed.clear()
    }
}
