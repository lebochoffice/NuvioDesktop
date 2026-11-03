# Windows-MSI 0.1.45-watchparty – Buildnachweis (Test-Build)

Commit `707088db` auf `feature/party-premium-ui`, Arbeitsbaum sauber (03.11.2026). Keine Installation, kein App-Start, kein Live-Test.

**Test-Build:** Die Browser-Einladung zeigt auf die Preview `https://feature-party-premium-ui.nuvio-watch-friends.pages.dev`. **Nicht als offizielles Release verwenden.**

**Inhalt seit 0.1.44:**
- strenge Allowlist der offiziellen TorBox-Stream-Hosts: `torbox.app`, `tb-cdn.cx`, `tb-cdn.io`, `tb-cdn.pw`, `tb-cdn.sh`, `tb-cdn.st`, `tb-cdn.to` und `tb-cdn.earth`
- Weiterleitungen und die erste Variante müssen auf diesen Hosts bleiben
- Freigabe ohne Account-Key (Variante A) auf allen drei Wegen: Nuvio-Cloud, LeLibrary und „Video-Link für alle teilen“
- Links mit vollständigem Account-Key bleiben gesperrt

## Build

- Gradle `:composeApp:packageReleaseMsi` mit:
  - `-Pnuvio.desktop.versionName=0.1.45-watchparty`
  - `-Pnuvio.desktop.versionCode=145`
  - `-Pnuvio.party.browserOrigin=preview`
  - `-Pnuvio.webview2.dir=fork-maintenance/local/webview2-sdk/1.0.4078.44`
- JDK 21.0.12: `BUILD SUCCESSFUL in 2m 23s`. Log: `fork-maintenance/local/msi-0.1.45-build.log`.
- `buildWindowsPlayerBridge` war `SKIPPED`; `player_bridge.cpp` ist unverändert.

## Ergebnis

- Datei: `composeApp/build/compose/release-msis/Nuvio-Windows-x64-0.1.45-watchparty.msi`
- Größe: **193450172 Bytes**
- SHA-256: `dc79ac1522a9a291d61670d2d4674c65f1484c2e4d5fa3960fd17ee10e9d5ce7`
- MSI-Produktversion: 1.1.45
- Signatur: `NotSigned`

## Verifikation (nur lesend)

- `verify-msi.ps1` **ohne** `-AllowPreviewOrigin`: abgelehnt wegen der Preview-Adresse, wie vorgesehen.
- `verify-msi.ps1 -AllowPreviewOrigin`: bestanden.
  - `browserInviteOrigin` ist die Preview.
  - `guestCommandSequencer`, `exactPausedSeek` und „Watch in Browser“ sind enthalten.
  - Ergebnis: `Nuvio-Windows-x64-0.1.45-watchparty-verification.json`.
- `TorboxPartyHlsKt` in der JAR enthält `tb-cdn.io`, `tb-cdn.earth`, `isTorboxStreamHost` und `torboxKeyFreeUrl`.
- `player-ui/party.js` ist bytegleich mit dem Quellstand.
- Die zwölf älteren MSIs (0.1.33 bis 0.1.44) sind unverändert; ihre SHA-256 wurden vor und nach dem Build verglichen.
