package com.nuvio.app.features.party

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull

/**
 * Shared start: the host announces a start time in SERVER time (party clock),
 * so no member needs an identical device clock. Members only show the
 * countdown; at the start the host plays through the existing play path,
 * and everyone follows the authoritative party state as usual.
 */
data class PartyCountdown(val startAt: Long, val seconds: Int, val mediaKey: String)

internal sealed interface PartyCountdownSignal {
    data object Cancel : PartyCountdownSignal
    data class Start(val countdown: PartyCountdown) : PartyCountdownSignal
}

internal const val PARTY_COUNTDOWN_MIN_S = 1
internal const val PARTY_COUNTDOWN_MAX_S = 10

/** Only the current host's announcement for the current title, close to now; anything else is ignored. */
internal fun partyCountdownFrom(senderId: String?, hostMemberId: String?, mediaKey: String, payload: JsonObject, nowMs: Long): PartyCountdownSignal? {
    if (senderId == null || senderId != hostMemberId) return null
    if ((payload["cancel"] as? JsonPrimitive)?.booleanOrNull == true) return PartyCountdownSignal.Cancel
    if ((payload["media_key"] as? JsonPrimitive)?.contentOrNull != mediaKey) return null
    val seconds = (payload["seconds"] as? JsonPrimitive)?.intOrNull?.takeIf { it in PARTY_COUNTDOWN_MIN_S..PARTY_COUNTDOWN_MAX_S } ?: return null
    val startAt = (payload["start_at"] as? JsonPrimitive)?.longOrNull ?: return null
    if (startAt - nowMs !in -2_000L..(PARTY_COUNTDOWN_MAX_S * 1_000L + 1_000L)) return null
    return PartyCountdownSignal.Start(PartyCountdown(startAt, seconds, mediaKey))
}
