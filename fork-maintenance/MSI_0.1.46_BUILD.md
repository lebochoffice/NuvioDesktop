# Windows-MSI 0.1.46-watchparty – Buildnachweis (Test-Build)

Commit `f74221e9` auf `feature/party-premium-ui`, synchron mit GitHub, Arbeitsbaum sauber (04.11.2026). Keine Installation, kein App-Start, kein Live-Test.

**Test-Build:**
- Browser-Einladungen zeigen auf `https://feature-party-premium-ui.nuvio-watch-friends.pages.dev`.
- Die Familienfreigabe nutzt `https://nuvio-party-share.leboch-office.workers.dev`.
- **Nicht als offizielles Release verwenden.**

## Build

- Gradle `:composeApp:packageReleaseMsi` mit:
  - `-Pnuvio.desktop.versionName=0.1.46-watchparty`
  - `-Pnuvio.desktop.versionCode=146`
  - `-Pnuvio.party.browserOrigin=preview`
  - `-Pnuvio.party.shareWorker=https://nuvio-party-share.leboch-office.workers.dev`
  - `-Pnuvio.webview2.dir=fork-maintenance/local/webview2-sdk/1.0.4078.44`
- JDK 21.0.12: `BUILD SUCCESSFUL in 3m 12s`. Log: `fork-maintenance/local/msi-0.1.46-build.log`.
- `buildWindowsPlayerBridge` lief diesmal. Grund: Die Branch-Wechsel beim Cherry-Pick haben das Änderungsdatum der Quelle aktualisiert. Die Quelle ist unverändert gegenüber `HEAD`.

## Ergebnis

- Datei: `composeApp/build/compose/release-msis/Nuvio-Windows-x64-0.1.46-watchparty.msi`
- Größe: **193478844 Bytes**
- SHA-256: `583cf1df85c172a88847b6d82097536106247ba7efee9b1b800ff0ce20863d94`
- MSI-Produktversion: 1.1.46; App-Version `0.1.46-watchparty`
- Signatur: `NotSigned`

## Verifikation (nur lesend)

- `verify-msi.ps1` ohne `-AllowPreviewOrigin`: abgelehnt wegen der Preview-Adresse, wie vorgesehen.
- `verify-msi.ps1 -AllowPreviewOrigin`: bestanden. `guestCommandSequencer`, `exactPausedSeek` und „Watch in Browser“ sind enthalten.
- `PartyBrowserConfig` in der JAR enthält die Preview-Adresse und die Worker-Adresse.
- `PartyFamilyShare` ist mit `Retry-After`-Behandlung enthalten, ebenso `TorboxHlsCandidate$KeyOnlyInTokenParameter`.
- Im Build-Log stehen keine Tokens, Stream-Adressen oder Keys.
- Die 13 älteren MSIs sind unverändert; ihre SHA-256 wurden vor und nach dem Build verglichen.
