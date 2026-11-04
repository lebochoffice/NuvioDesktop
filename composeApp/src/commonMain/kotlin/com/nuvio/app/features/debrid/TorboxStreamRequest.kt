package com.nuvio.app.features.debrid

// Transport contract from https://api.torbox.app/openapi.json. File selection
// must come from the selected account item, never a guessed first video/episode.
internal fun torboxCreateStreamQuery(
    torrentId: Int,
    fileId: Int,
    audioIndex: Int = 0,
    resolutionIndex: Int? = null,
): String {
    require(torrentId >= 0 && fileId >= 0 && audioIndex >= 0)
    require(resolutionIndex == null || resolutionIndex >= 0)
    return queryString(
        "id" to torrentId.toString(), "file_id" to fileId.toString(),
        "type" to "torrent", "chosen_audio_index" to audioIndex.toString(),
        "chosen_resolution_index" to resolutionIndex?.toString(),
        "scrobbling_enabled" to "false",
    )
}

// Sensitive return value: never log, broadcast or store this query. These are
// credentials. The current official web client uses its account token here;
// this API query must remain desktop-only and must NEVER become a PartyStream.
internal fun torboxStreamDataQuery(fileToken: String, presignedToken: String): String {
    require(fileToken.isNotBlank() && presignedToken.isNotBlank())
    return queryString("token" to fileToken, "presigned_token" to presignedToken)
}
