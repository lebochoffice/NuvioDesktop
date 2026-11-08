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
8. **Windows-Desktop-App:** erkennt die Release. Download braucht einen Zertifikat-Pin. Die Installation bleibt bis zur separaten Freigabe gesperrt.

## Desktop-Updater (nur Desktop-Build des Forks)

- Quelle: `lebochoffice/NuvioDesktop` (`AppUpdaterPlatform.desktop.kt`). Android/iOS sind unverändert, sie verifizieren keine Prüfsummen.
- Asset: nur `.msi` mit `WatchParty` und `windows` im Namen, also kein offizielles `Nuvio-Windows-…msi` und kein `.exe`.
- Download nur von `https://github.com/lebochoffice/NuvioDesktop/releases/download/…`; die Weiterleitung zum GitHub-CDN ist erlaubt.
- **SHA-256-Pflicht:** GitHub liefert für jedes Release-Asset einen `digest` (`sha256:…`). Fehlt er oder stimmt er nicht, wird die Datei gelöscht und eine Meldung angezeigt; der Installer startet nicht.
- Der vorhandene Download- und Installer-Code bleibt bis zur Abnahme der neuen MSI-Identität und der Prüfung von Signatur und Paketidentität gesperrt.

## Windows-Paketidentität und Umstieg von 1.1.58

- Produkt und Installationsverzeichnis heißen **Nuvio Family**. Der UpgradeCode ist dauerhaft `{DFE71C5B-C265-42CE-A025-396193575A13}`. jpackage erzeugt den ProductCode. Für jede veröffentlichte MSI eine neue, höhere numerische ProductVersion verwenden.
- Die Paketprüfung weist Upgrade-Regeln für andere Produktfamilien ab. 1.1.58 und die offizielle App gehören zur alten gemeinsamen Upgrade-Familie. Vor einem manuellen Umstieg installierten ProductCode, Version, Installationspfad und Herkunft anhand der bekannten Altinstallation prüfen. Bei unklarer Zuordnung stoppen. Keine automatische Deinstallation.
- Windows-Daten liegen künftig in `%APPDATA%\Nuvio Family` und `%LOCALAPPDATA%\Nuvio Family`. Der erste Start verwendet ein neues Profil. Für einen später separat freigegebenen Import zuerst die eindeutig zugeordneten Altdaten sichern und beide Anwendungen schließen. Nur bestätigte Profile, Einstellungen und Addon-Konfiguration übernehmen. WebView2-Daten und Party-Link-Warteschlangen bleiben getrennt. DPAPI-Sitzungen nur unter demselben Windows-Konto auf demselben System prüfen. Bei nicht lesbaren Sitzungen bei Simkl oder Trakt neu anmelden.
- Der Fork meldet `Nuvio.Family.Party` als auswählbaren Handler an. Eine vorhandene `nuvio://`-Zuordnung bleibt bestehen. Windows kann den Family-Handler nach ausdrücklicher Auswahl als Standard verwenden.
- Vor Freigabe auf einer isolierten Windows-Testumgebung Neuinstallation, Parallelbetrieb mit Original und 1.1.58, Upgrade zwischen zwei Family-Versionen und Deinstallation prüfen. Dabei Daten, Registry, Verknüpfungen, Deep Links und das Verhalten nach einem fehlgeschlagenen Upgrade prüfen.

### Windows-Abnahme mit zwei Family-MSIs

Je ein Testpaket A und B mit steigender MSI-Produktversion verwenden. Für jedes Paket den passenden Staging-Ordner behalten. `verify-msi.ps1 -RepoPath <Build-Ordner> -MsiPath <Datei> -ExpectedProductVersion <Version>` prüft x64, Identität, Upgrade-Tabelle, Launcher und Protokoll. `-AllowPreviewOrigin` ist ausschließlich für lokale Tests vorgesehen. A und B müssen denselben UpgradeCode, verschiedene ProductCodes und verschiedene SHA-256-Werte haben.

1. **Saubere VM:** A installieren und den tatsächlichen Launcher unter `%ProgramFiles%\Nuvio Family` prüfen. Mit `-InstalledExePath` und `-ExpectForkFallback` den freien `nuvio`-Fallback prüfen. Einen privaten Testlink bei geschlossener und bei laufender App öffnen. In A ein Testprofil und eine erkennbare Einstellung anlegen.
2. **A → B:** B interaktiv mit ausführlichem MSI-Log installieren. Nur B darf als Family-Produkt eingetragen sein. Testprofil, Einstellungen und Deep Links erneut prüfen. Den ProductCode von A im Log als einziges entferntes Produkt bestätigen.
3. **Parallelbetrieb:** Aus getrennten Snapshots jeweils einmal das Original und einmal den Fork 1.1.58 installieren. Beide verwenden die alte gemeinsame Upgrade-Familie, daher getrennte Durchläufe. Vorher ProductCode, Installationspfad, einen Profilmarker und den Protokollhandler festhalten. A installieren und auf B aktualisieren. Altprodukt, Profilmarker und Windows-Standardzuordnung vergleichen. Family muss ein separates Profil öffnen und als auswählbarer Handler erscheinen. Den Family-Handler über Windows auswählen und Kalt- sowie Warmstart prüfen.
4. **Deinstallation:** B in jedem Szenario entfernen. Prüfen, dass Launcher, Verknüpfungen und Family-Registrierung entfernt sind, der eigene Fallback im sauberen Szenario bereinigt ist und vorhandene fremde Handler, Altprodukte und Profildaten weiter nutzbar sind.
5. **Fehlschlag:** Auf einen Snapshot mit A zurückgehen. B im Ausführungsschritt in der VM kontrolliert abbrechen oder einen Schreibfehler auslösen. Im MSI-Log prüfen, ob der Fehler vor oder nach `RemoveExistingProducts` lag. Ein Abbruch vor dem Entfernen belegt keinen Rollback. Wenn A nach einem späten Fehler fehlt, Wiederherstellung über Snapshot beziehungsweise eine separat freigegebene Reparatur mit A dokumentieren und In-App-Installation gesperrt lassen. Ein nicht erreichter später Fehler bleibt ein offener Abnahmepunkt.

Für VM-Installationen ein separates Log je Lauf verwenden, etwa `msiexec.exe /i "<Paket.msi>" /l*v "<Protokoll.log>"`. jpackage erlaubt manuelle Downgrades innerhalb der Family und entfernt Altprodukte früh. Gleiche numerische Produktversionen, auch mit unterschiedlichen Test-Suffixen, als separate Veröffentlichungen vermeiden. Das Verhalten nach einer späten Störung muss vor der Freigabe praktisch bestätigt sein.

### Windows-Updater und Freigabeschranke

- Status und Download teilen eine GitHub-Antwort. Ein Paket braucht den exakten Fork-Tag, einen zum Tag passenden x64-Dateinamen, die offizielle Asset-URL des Forks, eine Größe bis 1 GiB und einen GitHub-SHA-256-Digest. `v0.1.63-watchparty` entspricht der App-Version `0.1.63-watchparty` und der MSI-Produktversion `1.1.63`. Der Release-Workflow verlangt steigende App- und MSI-Versionen.
- Der vorhandene Downloader begrenzt Windows-Weiterleitungen auf HTTPS und bekannte GitHub-Asset-Hosts. Er prüft die erwartete Dateigröße und legt die Datei zunächst als `.part` ab. Der Verifier prüft SHA-256, Authenticode, MSI-Identität, die zum Release passende Version und die tatsächlich installierte Family-Instanz. Eine Altinstallation aus der gemeinsamen Upgrade-Familie ist keine gültige Update-Basis.
- Vor der Installation sind eine gesonderte Bestätigung, eine erneute Prüfung der Datei und die Prüfung der aktuellen Watch Party erforderlich. Die Datei bleibt während Verifikation und Installer-Aufruf gegen Schreiben und Löschen geöffnet. Der interaktive `msiexec`-Aufruf protokolliert den Lauf. Erfolg, Neustartbedarf und Abbruch richten sich nach dem Exitcode. Windows Restart Manager oder eine Beendigung der laufenden App kann die Anzeige des Ergebnisses verhindern. Dies in der VM prüfen.
- Der öffentliche SHA-256-Pin des **DER-kodierten Blattzertifikats** gehört nach geprüfter Herausgeberidentität in `windows-update-trust.ps1`. Dazu werden öffentliches Code-Signing-Zertifikat, bestätigter Herausgeber, vertrauenswürdige Zertifikatskette und ein genehmigter HTTPS-RFC-3161-Zeitstempeldienst benötigt. In GitHub die Variable `NUVIO_SIGN_TIMESTAMP_URL` setzen. Der Signierjob benötigt Zugriff auf den geschützten privaten Schlüssel über den Windows-Zertifikatspeicher `Cert:\CurrentUser\My` des Release-Dienstkontos, etwa über einen geeigneten Schlüsselanbieter. Der gegenwärtige GitHub-Runner stellt diesen Zugang nicht bereit. Keine Schlüsseldatei im Repository oder als Release-Artefakt hinterlegen.
- Der Workflow signiert nach dem MSI-Postprocessing und verifiziert die signierte Datei erneut. Erst danach erzeugt er die endgültige Prüfsumme. Ohne Pin oder verfügbaren Signierer schlägt der Release-Job fehl. Einen neuen Zertifikat-Pin vor einem Zertifikatswechsel über eine vertrauenswürdige App-Aktualisierung verteilen.
- Download bleibt ohne Pin gesperrt. `installationReleased` bleibt unabhängig davon im Quellcode auf `false`. Erst nach signierten VM-Tests mit gültigem, manipuliertem, unsigniertem und fremd signiertem Paket, aktiver Party, Abbruch und echtem Upgrade darf eine spätere Freigabeentscheidung diesen Wert ändern.

## Versionsstrategie

- Tag und App-Version: `v<MAJOR>.<MINOR>.<PATCH>-watchparty`, z. B. `v0.1.38-watchparty`.
- Der numerische Kern steigt mit jeder Fork-Release und liegt stets über dem offiziellen Kern der integrierten Upstream-Version sowie über der letzten Fork-Release.
- Desktop nutzt den Einzelkanal `ALL_RELEASES` mit `isRemoteNewerLegacy`, also einem Vergleich der Zahlenteile. Damit ist `0.1.38-…` neuer als `0.1.37-watchparty-fixes`; ein gleicher Kern gilt nicht als neu.
- Version-Code: `MAJOR·10000 + MINOR·100 + PATCH`. MSI-Produktversion über die bestehende `jpackageCompatibleVersion`, z. B. `1.1.38`; steigt monoton, Windows erkennt das Upgrade.

## Erster Wechsel (wichtig)

- Installierte Builds bis einschließlich **0.1.37** fragen noch `NuvioMedia/NuvioDesktop` ab. Aktuell ist die offizielle neueste Release `0.1.34-alpha` (am 03.11.2026 per API gelesen) und damit älter, also wird kein offizielles Update angeboten.
- Sobald die offizielle Version 0.1.37 übersteigt, würden alte Fork-Builds ein **unverändertes offizielles** Update anbieten.
- Der erste Wechsel auf die eigene Windows-Installer-Familie erfolgt separat nach manueller Abnahme.

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
