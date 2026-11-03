# Windows-MSI 0.1.41-watchparty – Buildnachweis

Commit `dce0c0e7` (HLS-Button und automatische Host-Quelle, auf Basis der P0-Korrektur von 0.1.40) auf `feature/party-premium-ui`, Arbeitsbaum sauber (03.11.2026). Keine Installation, kein App-Start, keine zusätzlichen Tests.

## Build

- Gradle `:composeApp:packageReleaseMsi` mit:
  - `-Pnuvio.desktop.versionName=0.1.41-watchparty`
  - `-Pnuvio.desktop.versionCode=141`
  - `-Pnuvio.webview2.dir=fork-maintenance/local/webview2-sdk/1.0.4078.44`
- JDK 21.0.12: `BUILD SUCCESSFUL in 2m 2s`. Log: `fork-maintenance/local/msi-0.1.41-build.log`.

## Ergebnis

- Datei: `composeApp/build/compose/release-msis/Nuvio-Windows-x64-0.1.41-watchparty.msi`
- Größe: **193343676 Bytes**
- SHA-256: `b639c4c73a79d26e43392af4c56e93d6b0ec03d6b17f7dc39316b8adbd347fcb`
- MSI-Produktversion: 1.1.41
- App-Version: `0.1.41-watchparty`
- Signatur: `NotSigned`

## Verifikation (nur lesend)

- `verify-msi.ps1` bestanden (inklusive `guestCommandSequencer`).
- Die JAR wurde direkt aus dem MSI-Cabinet entpackt: 74565018 Bytes, bytegleich mit dem Staging-Stand.
- **Neu in 0.1.41:**
  - Klasse `TorboxHlsPhase` vorhanden.
  - Panel-Zustand mit `hlsAvailable`/`hlsStatus`.
  - Das Ereignis `partyHlsRefresh` wird verarbeitet.
  - Statustexte wie „An Teilnehmer gesendet“ sind enthalten.
  - `party.js` enthält den Button „HLS erstellen / aktualisieren“.
- **Aus 0.1.40 erhalten:**
  - Ordnung in Ankunftsreihenfolge, keine Ablehnung `superseded`, keine Klasse `PartyRevision`.
  - Command-ID/ACK und `pendingApply`.
  - Kein `REMOTE_APPLY_GRACE`.
- IntroDB `https://api.introdb.app`, Einladungsorigin `https://nuvio-watch-friends.pages.dev/party/`, TorBox-HLS mit `browser_hls`.
- Native Dateien: `player_bridge.dll`, `libmpv-2.dll`, `nuvio_engine.dll` und `WebView2Loader.dll`. Diese ist bytegleich mit der signierten SDK-Datei (Authenticode Valid) und in `runtime-files.txt` eingetragen.
- `player-ui` ist bytegleich mit dem Quellstand, die JAR enthält keine Sicherungskopien.
- Updater: nur `lebochoffice`, kein `NuvioMedia`, Asset-Filter `WatchParty`, SHA-256-Prüfung.

## Browser

- Die Feature-Preview `https://feature-party-premium-ui.nuvio-watch-friends.pages.dev` liefert den Stand mit der Checkbox „Host-Stream automatisch verwenden“ und dem Realtime-Neuaufbau aus 0.1.40 aus. Sie enthält keinen geheimen Schlüssel.
- Production ist unverändert und alt.
