package com.nuvio.app.features.party

internal data class PartyMediaRequest(
    val id: Int,
    val partyId: String,
    val hostId: String,
    val memberId: String,
    val currentMediaKey: String,
    val media: PartyMedia,
) {
    fun isCurrent(party: ActiveParty): Boolean =
        party.isHost && party.id == partyId && party.memberId == hostId &&
            memberId != hostId && party.member(memberId) != null && party.media.key == currentMediaKey

    fun mediaForOwnSelection(requestId: Double, party: ActiveParty): PartyMedia? =
        media.takeIf { requestId == id.toDouble() && party.connected && isCurrent(party) }
}

// Only identity and short display text travel on the party channel. Never send
// a source URL, addon configuration, headers, tokens or playback as a proposal.
internal fun PartyMedia.forMediaRequest(): PartyMedia? {
    val mediaId = Regex("[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}")
    if (type != metaType || !mediaId.matches(metaId)) return null
    val displayTitle = title.filterNot(Char::isISOControl).trim().take(200)
    if (displayTitle.isEmpty()) return null
    return when (metaType) {
        "movie" -> if (season == null && episode == null)
            PartyMedia(type = type, metaId = metaId, metaType = metaType, title = displayTitle) else null
        "series" -> if (season != null && season >= 0 && episode != null && episode > 0 &&
            videoId != null && mediaId.matches(videoId)) {
            PartyMedia(type = type, metaId = metaId, metaType = metaType, videoId = videoId,
                season = season, episode = episode, title = displayTitle)
        } else null
        else -> null
    }
}

internal fun ActiveParty.canRequestMedia(media: PartyMedia): Boolean =
    connected && !isHost && member(memberId) != null && member(hostMemberId) != null &&
        media.key != this.media.key && media.forMediaRequest() != null
