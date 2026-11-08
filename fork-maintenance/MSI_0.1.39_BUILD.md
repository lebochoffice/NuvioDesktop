# Windows-MSI 0.1.39-watchparty – Buildnachweis

Commit `8e07fd49` auf `feature/party-premium-ui`, Arbeitsbaum sauber (03.11.2026). Keine Installation, kein App-Start; Tests wurden in diesem Auftrag nicht erneut ausgeführt.

## Build

- Gradle `:composeApp:packageReleaseMsi` mit:
  - `-Pnuvio.desktop.versionName=0.1.39-watchparty`
  - `-Pnuvio.desktop.versionCode=139`
  - `-Pnuvio.webview2.dir=<absoluter Pfad>\fork-maintenance\local\webview2-sdk\1.0.4078.44`
- JDK 21.0.12: `BUILD SUCCESSFUL in 39s`. Log: `fork-maintenance/local/msi-0.1.39-build.log`.
- Vorher wurde die alte Sicherungskopie `player-ui/party.js.pre-browser-bridge.bak` aus dem Ressourcenordner nach `fork-maintenance/local/backup/` verschoben. Die Datei war von Git ignoriert und wäre sonst mitgepackt worden.

### Erster Versuch verworfen (fehlende WebView2Loader.dll)

- Der erste Build (`BUILD SUCCESSFUL in 2m 46s`) hatte das SDK als **relativen** Pfad bekommen.
  - Die Sync-Task `prepareWindowsPlayerRuntime` löst diesen Pfad relativ zu `composeApp/` auf und ließ die DLL deshalb stillschweigend weg.
  - Die Fail-fast-Prüfung löst denselben Pfad mit `File.exists()` gegen das Arbeitsverzeichnis auf und fand die DLL dort. Darum brach der Build nicht ab.
- `verify-msi.ps1` hat den Fehler erkannt („Packaged native runtime entry missing: native/windows/WebView2Loader.dll“).
- Der MSI wurde nicht freigegeben, sondern nach `fork-maintenance/local/broken-msi/Nuvio-Windows-x64-0.1.39-watchparty-NO-WEBVIEW2-DO-NOT-INSTALL.msi` verschoben (193261756 Bytes, SHA-256 `f4e1809755ddb348e46c1b442399beccc7e55041d6c8424b67f7e6df0fc388ad`).
- Ein relativer Pfad wurde also je nach Arbeitsverzeichnis des Gradle-Daemons uneinheitlich aufgelöst. Der 0.1.38-Build mit demselben relativen Pfad war vollständig.
- **Behoben (danach, nicht im MSI 0.1.39 enthalten, nur Build-Skript):**
  - `composeApp/build.gradle.kts` löst `nuvio.webview2.dir` jetzt mit `rootProject.file(...)` auf. Ein relativer Pfad gilt damit immer ab dem Repository-Root.
  - `packageReleaseMsi` bricht zusätzlich ab, wenn `WebView2Loader.dll` im tatsächlich gepackten Runtime-Ordner (`build/native/windows-runtime`) fehlt.
  - `check-fork-invariants.sh` prüft beide Schutzmaßnahmen.
  - Noch nicht durch einen Build bestätigt.

## Ergebnis

- Datei: `composeApp/build/compose/release-msis/Nuvio-Windows-x64-0.1.39-watchparty.msi`
- Größe: **193343676 Bytes**
- SHA-256: `9c1a6e479165043dda5bfd0ede73202d39583de43b6d1b856854105266ad79bc`
- MSI-Produktversion: 1.1.39
- App-Version: `0.1.39-watchparty`
- Signatur: `NotSigned`

## Verifikation (nur lesend)

- `verify-msi.ps1` bestanden. Neu geprüft wird dabei auch `guestCommandSequencer`.
- Die Anwendungs-JAR wurde mit 7-Zip direkt aus dem MSI-Cabinet entpackt: 74564071 Bytes, gleich groß wie in der Dateitabelle und **bytegleich** mit dem Staging-Stand.
- **Command-ID/ACK:**
  - `PartyCommand`, `PartyCommandLedger`, `PartyCommands`, `PartyCommandDecision`, `PartyCommandResult`, `PartyRevision` und `PendingApply` sind vorhanden.
  - Kanal-Event `command`, `onCommand`, `reportApplied`, die Felder `origin_member_id`/`command_id`, die Ankündigung `commands` und die Ablehnungsgründe sind enthalten.
  - Der Player nutzt `pendingApply`. `REMOTE_APPLY_GRACE` kommt nicht mehr vor.
- IntroDB `https://api.introdb.app`, Einladungsorigin `https://nuvio-watch-friends.pages.dev/party/` (bei eigenem Backend `nuvio://party/`), TorBox-HLS mit `browser_hls`, Version `0.1.39-watchparty`.
- Native Dateien: `player_bridge.dll`, `libmpv-2.dll` (115320296 Bytes), `nuvio_engine.dll` und `WebView2Loader.dll`. Diese ist bytegleich mit der signierten SDK-Datei (Authenticode Valid) und in `runtime-files.txt` eingetragen.
- `player-ui`: Alle Dateien sind bytegleich mit dem Quellstand. Die JAR enthält keine Sicherungskopien.
- Updater: Quelle `lebochoffice`, Download nur über `https://github.com/…/releases/download/`, kein `NuvioMedia` in den Updater-Klassen, Asset-Filter `WatchParty`, SHA-256-Prüfung.
- Alte MSIs (0.1.33 bis 0.1.38) sind unverändert.
