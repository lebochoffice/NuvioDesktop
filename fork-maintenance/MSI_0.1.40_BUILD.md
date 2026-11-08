# Windows-MSI 0.1.40-watchparty – Buildnachweis

Commit `60d59f75` (P0-Korrektur nach 0.1.39) auf `feature/party-premium-ui`, Arbeitsbaum sauber (03.11.2026). Keine Installation, kein App-Start, keine zusätzlichen Tests.

## Build

- Gradle `:composeApp:packageReleaseMsi` mit:
  - `-Pnuvio.desktop.versionName=0.1.40-watchparty`
  - `-Pnuvio.desktop.versionCode=140`
  - `-Pnuvio.webview2.dir=fork-maintenance/local/webview2-sdk/1.0.4078.44`
- JDK 21.0.12: `BUILD SUCCESSFUL in 2m 2s`. Log: `fork-maintenance/local/msi-0.1.40-build.log`.
- Der SDK-Pfad war bewusst **relativ** angegeben: So ließ sich die Pfad-Reparatur aus `d2cc4cdd` im echten Build prüfen. `WebView2Loader.dll` ist enthalten.

## Ergebnis

- Datei: `composeApp/build/compose/release-msis/Nuvio-Windows-x64-0.1.40-watchparty.msi`
- Größe: **193339580 Bytes**
- SHA-256: `3cd632e5227ecf9f3449a6e0f8c95c94e28b9becadef2244646cb0b4acbdbcb2`
- MSI-Produktversion: 1.1.40
- App-Version: `0.1.40-watchparty`
- Signatur: `NotSigned`

## Verifikation (nur lesend)

- `verify-msi.ps1` bestanden (inklusive `guestCommandSequencer`).
- Die JAR wurde direkt aus dem MSI-Cabinet entpackt: 74560358 Bytes, bytegleich mit dem Staging-Stand.
- **P0-Korrektur enthalten:**
  - `PartyCommands` kennt keine Ablehnung `superseded` mehr, der Revisionsverlauf ist entfernt (keine Klasse `PartyRevision`).
  - Command-ID/ACK, `onCommand`, `reportApplied` und `pendingApply` sind vorhanden.
  - `REMOTE_APPLY_GRACE` kommt nicht vor.
- IntroDB `https://api.introdb.app`, Einladungsorigin `https://nuvio-watch-friends.pages.dev/party/`, TorBox-HLS mit `browser_hls`.
- Native Dateien: `player_bridge.dll`, `libmpv-2.dll`, `nuvio_engine.dll` und `WebView2Loader.dll`. Diese ist bytegleich mit der signierten SDK-Datei (Authenticode Valid) und in `runtime-files.txt` eingetragen.
- `player-ui` ist bytegleich mit dem Quellstand, die JAR enthält keine Sicherungskopien.
- Updater: nur `lebochoffice`, kein `NuvioMedia`, Asset-Filter `WatchParty`, SHA-256-Prüfung.

## Browser

- Die Feature-Preview `https://feature-party-premium-ui.nuvio-watch-friends.pages.dev` liefert den Stand mit der P0-Korrektur aus: Text „Verbinde neu …“, Diagnose `realtimeLog`, Host-Sequencer. Sie enthält keinen geheimen Schlüssel.
- Production `https://nuvio-watch-friends.pages.dev` ist unverändert und alt. Desktop-Einladungen führen dorthin, deshalb die Preview für Tests von Hand öffnen.
