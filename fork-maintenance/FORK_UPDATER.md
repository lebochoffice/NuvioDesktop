# Upstream-Sync und Fork-Updater

Stand 03.11.2026, Branch `feature/party-premium-ui`. Nichts committet, gepusht, gemergt oder veröffentlicht. Keine Tests oder Builds in diesem Auftrag ausgeführt.

## Pipeline

1. **Offizielles Update** → `Fork - Review upstream updates` (täglich 07:23 UTC und manuell) führt `fork-maintenance/upstream-pr.sh` aus.
2. **Fork-Integration:**
   - Vorhanden: Der offizielle `Dev`-Tip wird nach `updates/nuvio-dev` gepusht.
   - Neu: Auf `updates/nuvio-integration` wird `origin/Dev` mit dem Tip gemergt (`--no-ff`, kein Push auf Dev).
3. **Konfliktprüfung und Fork-Invarianten:**
   - Bei Konflikt: Merge abgebrochen, Entwurfs-PR „(conflict)“ von `updates/nuvio-dev`, Lauf fehlgeschlagen.
   - Der Prüfer `check-fork-invariants.sh` wird **aus dem Fork-Dev** genommen, nicht aus dem gemergten Code, und macht nur `grep`/`test`.
   - Er prüft: `browser-site`, Bridge-Marker und v2-Host in `party.js`, Cloudflare-Origin, Host-Sequencer für Browserbefehle (`PartyCommands.kt`, `command`-Event, `awaitingApply`, `COMMAND_PROTOCOL`; ab 0.1.39 statt `REMOTE_APPLY_GRACE`), TorBox-HLS, `browser_hls`, IntroDB-Guard, Fork-Updater (Owner `lebochoffice`, Prüfsummenpflicht) und die Fork-Workflows.
   - Fehlt etwas: Entwurfs-PR „(invariants)“, Lauf fehlgeschlagen.
4. **Sauber:** Entwurfs-PR „Integrate Nuvio Desktop Dev updates (checked)“ von `updates/nuvio-integration` nach `Dev`. Force-with-lease gilt nur für diesen Integrationsbranch, nie für Dev.
5. **CI auf dem PR** (`Fork - Windows MSI`): Fork-Invarianten, Browser-Tests (`npm test`) und Vite-Build, Desktop-Tests `*Party*Test`, Fork- und App-Updater-Tests, `ReleaseSelector`, `VersionUtils` (ohne das upstream-eigene `LinuxUpdateInstallTest`, das nur auf Linux-Pfaden läuft). Ein Fehler blockiert den Merge, sofern Dev diese Checks als „required“ verlangt.
6. **Freigabe:** Standard ist der manuelle Merge. Auto-Merge nur mit der Repository-Variable `FORK_AUTO_MERGE=true`, und dann erst nach grünen Pflicht-Checks.
7. **Release** (`Fork - Release Windows MSI`, nur manuell und mit Freigabe über die Umgebung `fork-release`):
   - Prüft Version und Tag: neu, numerischer Kern größer als jede bisherige `v*-watchparty`-Release.
   - Dann Invarianten, Browser-Tests, Desktop-Tests, MSI-Build (`build-ci.ps1`) und `verify-msi.ps1`.
   - Dann eine GitHub-Release `v<version>` auf genau dem geprüften Commit mit:
     - `Nuvio-WatchParty-Windows-x64-<version>.msi`
     - `.msi.sha256`
     - Verifikations-JSON
     - Release Notes mit Quellcommit und SHA-256
8. **Desktop-App:** erkennt die Release und installiert nach Klick auf „Update“.

## Desktop-Updater (nur Desktop-Build des Forks)

- Quelle: `lebochoffice/NuvioDesktop` (`AppUpdaterPlatform.desktop.kt`). Android/iOS sind unverändert, sie verifizieren keine Prüfsummen.
- Asset: nur `.msi` mit `WatchParty` und `windows` im Namen, also kein offizielles `Nuvio-Windows-…msi` und kein `.exe`.
- Download nur von `https://github.com/lebochoffice/NuvioDesktop/releases/download/…`; die Weiterleitung zum GitHub-CDN ist erlaubt.
- **SHA-256-Pflicht:** GitHub liefert für jedes Release-Asset einen `digest` (`sha256:…`). Fehlt er oder stimmt er nicht, wird die Datei gelöscht und eine Meldung angezeigt; der Installer startet nicht.
- Installation:
  - `msiexec /i <msi> /l*v <log>`, interaktiv mit Windows-Installer-Oberfläche und UAC-Abfrage, nie still.
  - Bei Fehlern setzt Windows Installer auf die installierte Version zurück (Rollback), das Log liegt neben dem MSI.
  - Die `UpgradeCode` ist unverändert (Major Upgrade).

## Versionsstrategie

- Tag und App-Version: `v<MAJOR>.<MINOR>.<PATCH>-watchparty`, z. B. `v0.1.38-watchparty`.
- Der numerische Kern steigt mit jeder Fork-Release und liegt stets über dem offiziellen Kern der integrierten Upstream-Version sowie über der letzten Fork-Release.
- Desktop nutzt den Einzelkanal `ALL_RELEASES` mit `isRemoteNewerLegacy`, also einem Vergleich der Zahlenteile. Damit ist `0.1.38-…` neuer als `0.1.37-watchparty-fixes`; ein gleicher Kern gilt nicht als neu.
- Version-Code: `MAJOR·10000 + MINOR·100 + PATCH`. MSI-Produktversion über die bestehende `jpackageCompatibleVersion`, z. B. `1.1.38`; steigt monoton, Windows erkennt das Upgrade.

## Erster Wechsel (wichtig)

- Installierte Builds bis einschließlich **0.1.37** fragen noch `NuvioMedia/NuvioDesktop` ab. Aktuell ist die offizielle neueste Release `0.1.34-alpha` (am 03.11.2026 per API gelesen) und damit älter, also wird kein offizielles Update angeboten.
- Sobald die offizielle Version 0.1.37 übersteigt, würden alte Fork-Builds ein **unverändertes offizielles** Update anbieten.
- Deshalb den neuen Updater zügig über einen neuen MSI manuell installieren. Ab dann laufen Updates über die App.

## Einmalige GitHub-Einstellungen

1. Secret `FORK_SYNC_TOKEN`: fein-granularer PAT nur für `lebochoffice/NuvioDesktop` (Contents und Pull requests: write). Ohne ihn starten PRs von GitHub Actions keine CI-Workflows.
2. Repository-Variablen:
   - `NUVIO_SUPABASE_URL=https://api.nuvio.tv`
   - `NUVIO_SUPABASE_ANON_KEY=sb_publishable_…`
   - neu: `NUVIO_INTRODB_API_URL=https://api.introdb.app`
   - optional: `FORK_AUTO_MERGE=true`
3. Branch-Schutz für `Dev`: PR erforderlich, Pflicht-Checks (`browser`, `windows`, `PR Template Check`), kein Force-Push.
4. Umgebung `fork-release` mit „Required reviewers“ (du) als Release-Freigabe.
5. Später für die öffentliche Verteilung: Code-Signing (Authenticode) ergänzen. Aktuell ist der MSI unsigniert.

## Tests (lokal ausführen)

```powershell
.\gradlew.bat :composeApp:desktopTest --tests '*Fork*UpdateTest' --tests '*AppUpdate*Test' --tests '*UpdateChannelTest' --tests '*Party*Test' --tests '*ReleaseSelector*' --tests '*VersionUtils*' --no-configuration-cache --console=plain
bash fork-maintenance/check-fork-invariants.sh
```
