# Windows-MSI 0.1.42-watchparty – Buildnachweis

Commit `d4e6868a` auf `feature/party-premium-ui`, Arbeitsbaum sauber (03.11.2026). Keine Installation, kein App-Start, keine zusätzlichen Tests.

**Inhalt seit 0.1.41:**
- Layout der Einstellung „Host-Stream automatisch verwenden“, Automatik standardmäßig an
- klare Meldungen zum Browser-HLS
- Abweichung pro Teilnehmer
- Weiterspielen nach Party-Ende
- Pause-Parität und Wiederbeitritt nach Reload
- Bereich „Video-Link“
- **exakter Seek bei Party-Pausen**

## Build

- Gradle `:composeApp:packageReleaseMsi` mit:
  - `-Pnuvio.desktop.versionName=0.1.42-watchparty`
  - `-Pnuvio.desktop.versionCode=142`
  - `-Pnuvio.webview2.dir=fork-maintenance/local/webview2-sdk/1.0.4078.44`
- JDK 21.0.12: `BUILD SUCCESSFUL in 2m 7s`. Log: `fork-maintenance/local/msi-0.1.42-build.log`.
- `buildWindowsPlayerBridge` war `SKIPPED`, weil `player_bridge.dll` um 19:46 aus der aktuellen Quelle neu gebaut worden war und neuer ist als `player_bridge.cpp`. Die gepackte DLL ist bytegleich mit genau dieser DLL.

## Ergebnis

- Datei: `composeApp/build/compose/release-msis/Nuvio-Windows-x64-0.1.42-watchparty.msi`
- Größe: **193360060 Bytes**
- SHA-256: `01fb73ea736c15da8f678a3188fad47d020b5295c7fd4bb28f30e11c3f1c3906`
- MSI-Produktversion: 1.1.42
- App-Version: `0.1.42-watchparty`
- Signatur: `NotSigned`

## Verifikation (nur lesend)

- `verify-msi.ps1` bestanden, darunter `guestCommandSequencer` und neu `exactPausedSeek`.
- Die JAR wurde direkt aus dem MSI-Cabinet entpackt: 74580800 Bytes, bytegleich mit dem Staging-Stand.
- **Exakter Seek:**
  - `player_bridge.dll` exportiert `NativePlayerBridge_seekToExact` und enthält `absolute+exact`.
  - `NativePlayerBridge.seekToExact` ist vorhanden, ebenso der Rückfall im Controller.
  - Die Party-Schleife nutzt `seekToExact`.
- `PartySync` enthält `shouldConfirmPausedPosition` (als Sicherheitsnetz) und `memberSync`.
- **Command-ID/ACK** ist vollständig enthalten. `REMOTE_APPLY_GRACE` und `PartyRevision` kommen nicht vor.
- IntroDB `https://api.introdb.app`, Einladungsorigin `https://nuvio-watch-friends.pages.dev/party/`, TorBox-HLS mit `browser_hls`.
- Native Dateien vollständig. `WebView2Loader.dll` ist bytegleich mit der signierten SDK-Datei (Authenticode Valid).
- `player-ui` ist bytegleich mit dem Quellstand, die JAR enthält keine Sicherungskopien.
- Updater: nur `lebochoffice`, kein `NuvioMedia`, Asset-Filter `WatchParty`, SHA-256-Prüfung.
- Alte MSIs (0.1.33 bis 0.1.41) sind unverändert.

## Browser

- Die Preview `https://feature-party-premium-ui.nuvio-watch-friends.pages.dev` liefert den aktuellen Browserstand aus: Schalter, Video-Link, Wiederbeitritt, Abweichung pro Teilnehmer. Sie enthält keinen geheimen Schlüssel. Der Pages-Check für `d4e6868a` ist erfolgreich.
- „Workers Builds“ schlägt weiterhin fehl; siehe `CLOUDFLARE_CHECKS_AND_SECURITY.md`.
- Production ist unverändert.
