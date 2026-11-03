# Windows-MSI 0.1.44-watchparty – Buildnachweis (Test-Build)

Commit `343d5e6d` auf `feature/party-premium-ui`, Arbeitsbaum sauber (03.11.2026). Keine Installation, kein App-Start, kein Live-Test.

**Test-Build:** Die Browser-Einladung zeigt auf die Preview `https://feature-party-premium-ui.nuvio-watch-friends.pages.dev`. **Nicht als offizielles Release verwenden.**

**Inhalt seit 0.1.43:**
- Video-Link des Hosts für alle (mit Prüfung und Zustimmung)
- Vorschläge aus dem Browser mit Bestätigung durch den Host
- Auto-Sync für den eigenen Video-Link
- TorBox ohne Account-Key (Variante A, live ungeprüft)
- „Mit TorBox-Datei verknüpfen“
- Startseite ohne Fehlermeldung
- zwei Einladungsbuttons: „Watch in Nuvio – Copy link“ (`https://nuvio.tv/party/<CODE>`) und „Watch in Browser – Copy link“
- Die Familienfreigabe mit Account-Key ist **nicht** enthalten (siehe `WATCHPARTY_FAMILY_SHARE_SECURITY.md`).

## Build

- Gradle `:composeApp:packageReleaseMsi` mit:
  - `-Pnuvio.desktop.versionName=0.1.44-watchparty`
  - `-Pnuvio.desktop.versionCode=144`
  - `-Pnuvio.party.browserOrigin=preview`
  - `-Pnuvio.webview2.dir=fork-maintenance/local/webview2-sdk/1.0.4078.44`
- JDK 21.0.12: `BUILD SUCCESSFUL in 2m 8s`. Log: `fork-maintenance/local/msi-0.1.44-build.log`.
- `buildWindowsPlayerBridge` war `SKIPPED`; `player_bridge.cpp` ist unverändert.

## Ergebnis

- Datei: `composeApp/build/compose/release-msis/Nuvio-Windows-x64-0.1.44-watchparty.msi`
- Größe: **193446076 Bytes**
- SHA-256: `9f9a05fef5dee3baafcf1a8df461a6856de5ab712ff1fa0a1501d7eda1ee51c8`
- MSI-Produktversion: 1.1.44
- Signatur: `NotSigned`

## Verifikation (nur lesend)

- `verify-msi.ps1` **ohne** `-AllowPreviewOrigin`: abgelehnt wegen der Preview-Adresse, wie vorgesehen.
- `verify-msi.ps1 -AllowPreviewOrigin`: bestanden.
  - `browserInviteOrigin` ist die Preview.
  - `guestCommandSequencer`, `exactPausedSeek` und „Watch in Browser“ sind enthalten.
  - Ergebnis: `Nuvio-Windows-x64-0.1.44-watchparty-verification.json`.
- Die JAR enthält `PartyHostHlsKt`, `PartyHlsSuggestion`, `TorboxCloudChoice` und `TorboxHlsCandidate$KeyOnlyInTokenParameter`.
- `player-ui/party.js` ist bytegleich mit dem Quellstand und enthält „Watch in Nuvio“.
- Die elf älteren MSIs (0.1.33 bis 0.1.43) sind unverändert; ihre SHA-256 wurden vor und nach dem Build verglichen.
