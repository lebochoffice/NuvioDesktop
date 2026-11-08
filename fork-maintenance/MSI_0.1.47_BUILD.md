# Windows-MSI 0.1.47-watchparty – Buildnachweis (Test-Build)

Commit `b4c32d5a` auf `feature/party-premium-ui`, synchron mit GitHub (04.11.2026). Keine Installation, kein Live-Test. Neu gegenüber 0.1.46: das überarbeitete Watch-Party-Menü. Die Versionsnummer 0.1.47 wurde gewählt, damit die 0.1.46-MSI nicht überschrieben wird.

- Gradle `:composeApp:packageReleaseMsi` mit:
  - `-Pnuvio.desktop.versionName=0.1.47-watchparty`
  - `-Pnuvio.desktop.versionCode=147`
  - `-Pnuvio.party.browserOrigin=preview`
  - `-Pnuvio.party.shareWorker=https://nuvio-party-share.leboch-office.workers.dev`
  - `-Pnuvio.webview2.dir=fork-maintenance/local/webview2-sdk/1.0.4078.44`
- `BUILD SUCCESSFUL in 2m 17s`, Bridge `SKIPPED`. Log: `fork-maintenance/local/msi-0.1.47-build.log`.
- Datei: `composeApp/build/compose/release-msis/Nuvio-Windows-x64-0.1.47-watchparty.msi`
- Größe: **193491132 Bytes**
- SHA-256: `81a4586ac5f2dc82ca071d04195c6a237418ec0a82784c9d958e91da9beef070`
- MSI-Produktversion: 1.1.47; nicht signiert
- **Verifikation:**
  - `verify-msi.ps1` ohne `-AllowPreviewOrigin`: abgelehnt (Preview), wie vorgesehen.
  - Mit dem Schalter: bestanden (`guestCommandSequencer`, `exactPausedSeek`).
  - `party.js` enthält das neue Menü, `PartyBrowserConfig` die Worker-Adresse.
  - Die 14 älteren MSIs sind unverändert (SHA-256 vor und nach dem Build verglichen).
