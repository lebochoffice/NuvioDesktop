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
 * commands never become valid again. baseSeq is the revision the guest saw;
 * it is diagnostic only (see [PartyCommands.decide]).
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

internal data class PartyCommandResult(val accepted: Boolean, val seq: Long?, val reason: String? = null)

internal sealed interface PartyCommandDecision {
    data object Accept : PartyCommandDecision
    data class Reject(val reason: String) : PartyCommandDecision
}

internal object PartyCommands {
    const val PROTOCOL = 1
    const val PROCESSED_LIMIT = 64
    private val ID = Regex("^[A-Za-z0-9-]{8,64}$")

    fun validId(id: String): Boolean = ID.matches(id)

    /**
     * Commands are absolute (pause/play at a position, seek to a position), so
     * the host orders them by arrival, like any member's own action. A stale
     * baseSeq (lost or delayed broadcast, reconnect) is not a reason to reject:
     * 0.1.39 did that, and guests then fell back to an outdated party state.
     * Only validity, epoch, membership and host-only decide.
     */
    fun decide(command: PartyCommand, party: ActiveParty, current: PartyPlayback?): PartyCommandDecision {
        fun reject(reason: String) = PartyCommandDecision.Reject(reason)
        if (!validId(command.commandId) || command.positionMs < 0L) return reject("invalid")
        if (!party.isHost || command.hostMemberId != party.memberId || command.mediaKey != party.media.key) return reject("stale_epoch")
        if (current?.mediaKey != null && current.mediaKey != party.media.key) return reject("stale_epoch")
        if (command.memberId == party.memberId || party.members.none { it.id == command.memberId }) return reject("not_member")
        if (party.hostOnly) return reject("host_only")
        return PartyCommandDecision.Accept
    }
}

/** Host-side memory of processed command IDs: a retry is never executed twice. */
internal class PartyCommandLedger {
    private val processed = LinkedHashMap<String, PartyCommandResult>()

    fun result(commandId: String): PartyCommandResult? = processed[commandId]

    fun remember(commandId: String, result: PartyCommandResult) {
        processed[commandId] = result
        while (processed.size > PartyCommands.PROCESSED_LIMIT) processed.remove(processed.keys.first())
    }

    fun clear() = processed.clear()
}
