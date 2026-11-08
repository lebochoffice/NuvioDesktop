package com.nuvio.app.features.party

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.jsonObject

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

    private fun decide(command: PartyCommand, current: PartyPlayback?, party: ActiveParty = party()) =
        PartyCommands.decide(command, party, current)

    @Test
    fun browserPausePlayAndSeekOnTheCurrentRevisionAreAccepted() {
        assertEquals(PartyCommandDecision.Accept, decide(command(paused = true), state(10)))
        assertEquals(PartyCommandDecision.Accept, decide(command(paused = false), state(10, paused = true)))
        assertEquals(PartyCommandDecision.Accept, decide(command(id = "seek-0000001", paused = false), state(10)))
    }

    // Regression 0.1.39: a stale base revision (lost/delayed broadcast,
    // reconnect, host action in between) rejected the command as "superseded",
    // and the browser fell back to an outdated party state.
    @Test
    fun staleOrMissingBaseRevisionIsNoReasonToRejectAnAbsoluteCommand() {
        assertEquals(PartyCommandDecision.Accept, decide(command(base = 3), state(12)))
        assertEquals(PartyCommandDecision.Accept, decide(command(base = null), state(12)))
        assertEquals(PartyCommandDecision.Accept, decide(command(base = 13), state(12))) // Host lagged behind a guest revision.
        assertEquals(PartyCommandDecision.Accept, decide(command(base = 1), state(10L + 1_000L)))
    }

    @Test
    fun hostLocalActionAndBrowserCommandAreOrderedByArrivalAtTheHost() {
        // Host pressed Play (seq 11); the browser Pause (seen seq 10) arrives later: it is the newer action.
        assertEquals(PartyCommandDecision.Accept, decide(command(paused = true), state(11)))
        // Browser Pause accepted as seq 11; the host's own Play (seq 12) is newer everywhere.
        assertTrue(PartySync.isNewer(state(12), state(11, actor = "guest", paused = true)))
    }

    @Test
    fun simultaneousBrowserCommandsAreBothExecutedInArrivalOrder() {
        assertEquals(PartyCommandDecision.Accept, decide(command(id = "cmd-guest-01"), state(10)))
        assertEquals(PartyCommandDecision.Accept, decide(command(id = "cmd-guest2-1", member = "guest2", paused = false), state(11, actor = "guest", paused = true)))
    }

    @Test
    fun hostOnlyMembershipAndRoleAreEnforcedByTheHost() {
        assertEquals(PartyCommandDecision.Reject("host_only"), decide(command(), state(10), party(hostOnly = true)))
        assertEquals(PartyCommandDecision.Reject("not_member"), decide(command(member = "stranger"), state(10)))
        assertEquals(PartyCommandDecision.Reject("not_member"), decide(command(member = "host"), state(10)))
        // Non-host desktops never sequence.
        assertEquals(PartyCommandDecision.Reject("stale_epoch"), decide(command(), state(10), party(memberId = "desk")))
        assertEquals(PartyCommandDecision.Reject("invalid"), decide(command(id = "bad id"), state(10)))
    }

    @Test
    fun hostChangeAndMediaChangeEndTheEpoch() {
        assertEquals(PartyCommandDecision.Reject("stale_epoch"), decide(command(host = "old-host"), state(10)))
        assertEquals(PartyCommandDecision.Reject("stale_epoch"), decide(command(mediaKey = otherMedia.key), state(10)))
        // After the film changed, a command for the previous film is never valid.
        assertEquals(PartyCommandDecision.Reject("stale_epoch"), decide(command(), state(0, mediaKey = otherMedia.key), party(partyMedia = otherMedia)))
        // The host's own revision still belongs to the previous film.
        assertEquals(PartyCommandDecision.Reject("stale_epoch"), decide(command(mediaKey = otherMedia.key), state(3), party(partyMedia = otherMedia)))
    }

    @Test
    fun duplicateCommandIdKeepsTheFirstResult() {
        val ledger = PartyCommandLedger()
        ledger.remember("cmd-00000001", PartyCommandResult(accepted = true, seq = 11))
        assertEquals(PartyCommandResult(accepted = true, seq = 11), ledger.result("cmd-00000001"))
        repeat(PartyCommands.PROCESSED_LIMIT) { ledger.remember("cmd-x-${it.toString().padStart(4, '0')}", PartyCommandResult(false, 1, "host_only")) }
        assertNull(ledger.result("cmd-00000001"))
        ledger.remember("cmd-00000002", PartyCommandResult(accepted = true, seq = 12))
        ledger.clear()
        assertNull(ledger.result("cmd-00000002"))
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
