# Windows-MSI 0.1.43-watchparty – Buildnachweis (Test-Build)

Commit `7af93ce7` auf `feature/party-premium-ui`, Arbeitsbaum sauber (03.11.2026). Keine Installation, kein App-Start, kein Live-Test.

**Test-Build:** Einladungen zeigen auf die Preview `https://feature-party-premium-ui.nuvio-watch-friends.pages.dev`. **Nicht als offizielles Release verwenden.**

**Inhalt seit 0.1.42:**
- TorBox-HLS: getrennte Zustände, begrenzte Playlist-Prüfung, nur-HLS-Freigabe, Zuordnung von Addon-Streams per Infohash
- Einladungslink mit Preview-Adresse (nur per Build-Property)
- Browser: Einzelklick Play/Pause, Doppelklick Vollbild
- Browser: Reload ohne erneuten Code

## Build

- Gradle `:composeApp:packageReleaseMsi` mit:
  - `-Pnuvio.desktop.versionName=0.1.43-watchparty`
  - `-Pnuvio.desktop.versionCode=143`
  - `-Pnuvio.party.browserOrigin=preview`
  - `-Pnuvio.webview2.dir=fork-maintenance/local/webview2-sdk/1.0.4078.44`
- JDK 21.0.12: `BUILD SUCCESSFUL in 2m 3s`. Log: `fork-maintenance/local/msi-0.1.43-build.log`.
- `buildWindowsPlayerBridge` war `SKIPPED`; `player_bridge.cpp` ist seit 0.1.42 unverändert.

## Ergebnis

- Datei: `composeApp/build/compose/release-msis/Nuvio-Windows-x64-0.1.43-watchparty.msi`
- Größe: **193388732 Bytes**
- SHA-256: `db812881016a566bc2c945cbdacfe781f3e00f8ef3a6a6ae7c2f6b5b2473b3c3`
- MSI-Produktversion: 1.1.43
- Signatur: `NotSigned`

## Verifikation (nur lesend)

- `verify-msi.ps1` **ohne** `-AllowPreviewOrigin`: abgelehnt („Packaged invite origin is the feature preview …“), wie vorgesehen.
- `verify-msi.ps1 -AllowPreviewOrigin`: bestanden. `browserInviteOrigin` ist die Preview, `guestCommandSequencer` und `exactPausedSeek` sind enthalten, die nativen Dateien sind vollständig. Ergebnis: `Nuvio-Windows-x64-0.1.43-watchparty-verification.json`.
- Die JAR enthält `TorboxHlsFailure`, `TorboxHlsCandidate`, `TorboxHlsPhase` und `PartyBrowserConfig`. `player-ui/party.js` ist bytegleich mit dem Quellstand.
- Die zehn älteren MSIs (0.1.33 bis 0.1.42) sind unverändert (SHA-256 vor und nach dem Build verglichen).
