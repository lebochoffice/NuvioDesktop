package com.nuvio.app.features.party

import com.nuvio.app.core.storage.DesktopStorage
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

internal object DesktopPartySyncTrace {
    fun start() {
        if (System.getenv("NUVIO_PARTY_SYNC_DIAGNOSTICS") != "1") return
        PartySyncTrace.enable()
        // Disk IO never runs on a player/UI thread. One bounded file per process,
        // refreshed at most once a second; no remote telemetry and no raw input.
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            val file = runCatching {
                DesktopStorage.cacheDir.resolve("party-sync-${ProcessHandle.current().pid()}.csv")
            }.getOrElse { PartySyncTrace.disable(); return@launch }
            val temporary = file.resolveSibling("${file.fileName}.tmp")
            var written = -1L
            while (isActive) {
                delay(1000)
                val snapshot = PartySyncTrace.state.value
                if (written == snapshot.total) continue
                val result = runCatching {
                    Files.writeString(temporary, PartySyncTrace.text(snapshot))
                    Files.move(temporary, file, StandardCopyOption.REPLACE_EXISTING)
                }
                if (result.isFailure) { PartySyncTrace.disable(); break }
                written = snapshot.total
            }
        }
    }
}
