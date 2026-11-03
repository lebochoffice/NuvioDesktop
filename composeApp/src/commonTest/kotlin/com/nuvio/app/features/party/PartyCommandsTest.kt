package com.nuvio.app.features.party

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.jsonObject

// Written for 0.1.39; not executed while implementing (run locally).
class PartyCommandsTest {
    private val media = PartyMedia(type = "movie", metaId = "tt1", metaType = "movie")
    private val otherMedia = PartyMedia(type = "movie", metaId = "tt2", metaType = "movie")

    private fun party(hostOnly: Boolean = false, memberId: String = "host", hostMemberId: String = "host", partyMedia: PartyMedia = media) = ActiveParty(
        id = "room",
        code = "UXZ83H",
        memberId = memberId,
        hostMemberId = hostMemberId,
        members = listOf(PartyMember("host", "Host"), PartyMember("guest", "Guest"), PartyMember("guest2", "Guest 2"), PartyMember("desk", "Desk")),
        presence = emptyMap(),
        media = partyMedia,
        maxMembers = 4,
        connected = true,
        hostOnly = hostOnly,
    )

    private fun state(seq: Long, actor: String = "host", paused: Boolean = false, mediaKey: String = media.key) =
        PartyPlayback(seq = seq, memberId = "host", paused = paused, positionMs = 1_000, at = 1_000, mediaKey = mediaKey,
            originMemberId = actor.takeIf { it != "host" })

    private fun command(
        id: String = "cmd-00000001",
        member: String = "guest",
        paused: Boolean = true,
        base: Long? = 10,
        mediaKey: String = media.key,
        host: String = "host",
    ) = PartyCommand(commandId = id, memberId = member, paused = paused, positionMs = 5_000, baseSeq = base, mediaKey = mediaKey, hostMemberId = host)

    private fun decide(command: PartyCommand, ledger: PartyCommandLedger, current: PartyPlayback?, party: ActiveParty = party()) =
        PartyCommands.decide(command, party, current, ledger.revisions())

    private fun PartyCommandLedger.accepted(seq: Long, actor: String, system: Boolean = false) = apply { record(seq, actor, system) }

    @Test
    fun browserPauseOnCurrentRevisionIsAccepted() {
        assertEquals(PartyCommandDecision.Accept, decide(command(paused = true), PartyCommandLedger(), state(10)))
    }

    @Test
    fun browserPlayAndSeekOnCurrentRevisionAreAccepted() {
        assertEquals(PartyCommandDecision.Accept, decide(command(paused = false), PartyCommandLedger(), state(10, paused = true)))
        assertEquals(PartyCommandDecision.Accept, decide(command(id = "seek-0000001", paused = false), PartyCommandLedger(), state(10)))
    }

    @Test
    fun rapidTogglesOfTheSameGuestChainOnTheSameBase() {
        // Pause (base 10) became seq 11; the following Play still carries base 10.
        val ledger = PartyCommandLedger().accepted(11, "guest")
        assertEquals(PartyCommandDecision.Accept, decide(command(id = "cmd-00000002", paused = false), ledger, state(11, actor = "guest", paused = true)))
        ledger.accepted(12, "guest")
        assertEquals(PartyCommandDecision.Accept, decide(command(id = "cmd-00000003", paused = true), ledger, state(12, actor = "guest")))
    }

    @Test
    fun hostLocalActionAfterTheGuestsBaseSupersedesTheGuestCommand() {
        // Browser pressed Pause while it still saw seq 10; the host pressed Play (seq 11) first.
        val ledger = PartyCommandLedger().accepted(11, "host")
        assertEquals(PartyCommandDecision.Reject("superseded"), decide(command(paused = true), ledger, state(11)))
    }

    @Test
    fun desktopPlayRightAfterAcceptedBrowserPauseIsANewerRevision() {
        // Browser Pause accepted as seq 11; the host's own Play is seq 12 and wins everywhere.
        val ledger = PartyCommandLedger().accepted(11, "guest").accepted(12, "host")
        val hostPlay = state(12)
        assertTrue(PartySync.isNewer(hostPlay, state(11, actor = "guest", paused = true)))
        // A late retry of the old pause with base 10 must not undo the host's Play.
        assertEquals(PartyCommandDecision.Reject("superseded"), decide(command(id = "cmd-00000009"), ledger, hostPlay))
    }

    @Test
    fun simultaneousBrowserCommandsFirstWinsSecondIsRejected() {
        val ledger = PartyCommandLedger().accepted(11, "guest")
        assertEquals(PartyCommandDecision.Reject("superseded"), decide(command(id = "cmd-guest2-1", member = "guest2", paused = false), ledger, state(11, actor = "guest", paused = true)))
    }

    @Test
    fun coordinatorWaitsDoNotConflictWithGuestCommands() {
        val ledger = PartyCommandLedger().accepted(11, "host", system = true)
        assertEquals(PartyCommandDecision.Accept, decide(command(paused = false), ledger, state(11, paused = true)))
    }

    @Test
    fun outOfOrderOrUnknownBaseIsRejected() {
        val ledger = PartyCommandLedger().accepted(12, "guest") // seq 11 is not covered
        assertEquals(PartyCommandDecision.Reject("superseded"), decide(command(), ledger, state(12, actor = "guest")))
        assertEquals(PartyCommandDecision.Reject("stale_epoch"), decide(command(base = 13), ledger, state(12, actor = "guest")))
        assertEquals(PartyCommandDecision.Reject("superseded"), decide(command(base = null), ledger, state(12, actor = "guest")))
        assertEquals(PartyCommandDecision.Reject("superseded"), decide(command(base = 1), ledger, state(10L + PartyCommands.HISTORY_LIMIT)))
    }

    @Test
    fun hostOnlyMembershipAndRoleAreEnforcedByTheHost() {
        val ledger = PartyCommandLedger()
        assertEquals(PartyCommandDecision.Reject("host_only"), decide(command(), ledger, state(10), party(hostOnly = true)))
        assertEquals(PartyCommandDecision.Reject("not_member"), decide(command(member = "stranger"), ledger, state(10)))
        assertEquals(PartyCommandDecision.Reject("not_member"), decide(command(member = "host"), ledger, state(10)))
        // Non-host desktops never sequence.
        assertEquals(PartyCommandDecision.Reject("stale_epoch"), decide(command(), ledger, state(10), party(memberId = "desk")))
        assertEquals(PartyCommandDecision.Reject("invalid"), decide(command(id = "bad id"), ledger, state(10)))
    }

    @Test
    fun hostChangeAndMediaChangeEndTheEpoch() {
        val ledger = PartyCommandLedger()
        assertEquals(PartyCommandDecision.Reject("stale_epoch"), decide(command(host = "old-host"), ledger, state(10)))
        assertEquals(PartyCommandDecision.Reject("stale_epoch"), decide(command(mediaKey = otherMedia.key), ledger, state(10)))
        // After the film changed, a command for the previous film is never valid.
        assertEquals(
            PartyCommandDecision.Reject("stale_epoch"),
            decide(command(), ledger, state(0, mediaKey = otherMedia.key), party(partyMedia = otherMedia)),
        )
        ledger.accepted(11, "host")
        ledger.resetRevisions()
        assertEquals(PartyCommandDecision.Reject("superseded"), decide(command(base = 10), ledger, state(11)))
    }

    @Test
    fun duplicateCommandIdKeepsTheFirstResult() {
        val ledger = PartyCommandLedger()
        ledger.remember("cmd-00000001", PartyCommandResult(accepted = true, seq = 11))
        assertEquals(PartyCommandResult(accepted = true, seq = 11), ledger.result("cmd-00000001"))
        repeat(PartyCommands.PROCESSED_LIMIT) { ledger.remember("cmd-x-${it.toString().padStart(4, '0')}", PartyCommandResult(false, 1, "superseded")) }
        assertNull(ledger.result("cmd-00000001"))
    }

    @Test
    fun commandFieldsAreOptionalForOlderClientsAndOmittedWhenAbsent() {
        val legacy = PartyApi.json.decodeFromString(PartyPlayback.serializer(), """{"seq":3,"member_id":"host","paused":true,"position_ms":1,"at":2}""")
        assertNull(legacy.commandId)
        assertEquals("host", legacy.actorId)
        val plain = PartyApi.json.encodeToJsonElement(PartyPlayback.serializer(), legacy).jsonObject
        assertTrue("command_id" !in plain && "origin_member_id" !in plain)
        val sequenced = PartyApi.json.decodeFromString(
            PartyPlayback.serializer(),
            """{"seq":4,"member_id":"host","paused":true,"position_ms":1,"at":2,"origin_member_id":"guest","command_id":"cmd-00000001","future":1}""",
        )
        assertEquals("guest", sequenced.actorId)
        val command = PartyApi.json.decodeFromString(
            PartyCommand.serializer(),
            """{"command_id":"cmd-00000001","member_id":"guest","paused":false,"position_ms":10,"base_seq":null,"media_key":"movie|tt1||","host_member_id":"host"}""",
        )
        assertNull(command.baseSeq)
    }

    @Test
    fun pendingApplyIsEventBasedAndYieldsToRealLocalActions() {
        // Browser Pause received; player still playing → wait/retry, never publish.
        assertEquals(PendingApply.Waiting, PartySync.pendingApply(pendingPaused = true, shouldPlay = false, isPlaying = true, driftMs = 0))
        assertEquals(PendingApply.Applied, PartySync.pendingApply(pendingPaused = true, shouldPlay = false, isPlaying = false, driftMs = 100))
        // Host presses Play immediately after the browser Pause: superseded, no revert.
        assertEquals(PendingApply.Superseded, PartySync.pendingApply(pendingPaused = true, shouldPlay = true, isPlaying = true, driftMs = 0))
        // Seek command while HLS seeks: play state reached, position still far.
        assertEquals(PendingApply.Seeking, PartySync.pendingApply(pendingPaused = false, shouldPlay = true, isPlaying = true, driftMs = 30_000))
        assertEquals(PendingApply.Applied, PartySync.pendingApply(pendingPaused = false, shouldPlay = true, isPlaying = true, driftMs = -400))
    }
}
