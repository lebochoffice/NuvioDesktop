# Persönlicher Nuvio-Fork

Repository: https://github.com/lebochoffice/NuvioDesktop · Default Branch: **Dev**.

`origin` bezeichnet den persönlichen Fork. `upstream` bezeichnet das offizielle NuvioMedia-Repository; dessen lokale Push-Adresse ist `DISABLED`. Es wurde nichts ins offizielle Repository geschrieben.

## Update-PRs

**Fork - Review upstream updates** läuft täglich um 07:23 UTC oder auf manuellen Aufruf, ausschließlich im persönlichen Fork auf `Dev`. Er liest den offiziellen `Dev`-Stand und aktualisiert nur den eigenen Vorschlagsbranch `updates/nuvio-dev`, ohne Force-Push. Anschließend erstellt er einen Draft-PR nach `Dev` oder verwendet den vorhandenen PR weiter. Eigene Änderungen bleiben im Zielbranch erhalten; Konflikte werden zur menschlichen Prüfung im PR sichtbar. Es werden weder Upstream-Code ausgeführt noch `Dev` gemergt, PRs genehmigt, Tags gesetzt, Releases erstellt oder Deployments ausgeführt.

Ein Upstream-Force-Push oder manuelle, divergierende Änderungen am Vorschlagsbranch führen absichtlich zu einem Fehler statt zu einem überschreibenden Push. Dann den Branch/PR manuell prüfen. Bei einem öffentlichen Repository kann GitHub geplante Läufe nach längerer Inaktivität deaktivieren. Zeitpläne sind keine garantierte Ausführung zu einer bestimmten Minute.

Der geerbte `Update Sideload Source`-Workflow ist im persönlichen Fork gesperrt, damit er bei einem Release nicht automatisch Änderungen nach `Dev` schreibt. Die bestehenden offiziellen Release-Workflows bleiben manuell; für diese Anpassung den getrennten Fork-MSI-Workflow verwenden.

## Windows-MSI nach manueller Prüfung

**Fork - Windows MSI** prüft Pull Requests nach `Dev` mit Browser-Tests und den bestehenden Kotlin-Party-Tests. **Ein MSI entsteht nur bei einem manuellen Workflow-Aufruf auf `Dev`**, also nachdem die Änderungen geprüft und selbst zusammengeführt wurden. Es wird als Actions-Artefakt für 14 Tage bereitgestellt. Es wird kein GitHub Release veröffentlicht, keine App installiert und keine App gestartet.

Der Windows-Runner ist `windows-2022`, mit Temurin JDK 21, vorhandenem MSVC/Windows-SDK, dem Gradle-Wrapper und der vorgesehenen WebView2-SDK-Version. Der öffentliche libmpv-LFS-Inhalt wird aus dem offiziellen Repository gelesen. Sentry-Upload-/Signing-/Notarisierungs-/Trakt-Geheimnisse werden dafür nicht verlangt. Die zusätzlichen Integrationen sind ohne deren Konfiguration nicht aktiviert. Das MSI ist unsigniert.

`verify-msi.ps1` öffnet die Installer-Datenbank ausschließlich lesend, prüft MSI-Metadaten und Hash sowie die zur Paketierung verwendete Anwendung auf Java-Runtime, native Bibliotheken, öffentliche Backend-Konfiguration und den Watch-in-Browser-Code. Es ruft kein `msiexec` auf. Der Prüfbericht unterscheidet deshalb die MSI-Datenbank von der geprüften Build-Ausgabe.

## GitHub-Einstellungen

1. **Actions aktivieren**, falls GitHub im neu erstellten Fork noch keine Workflows ausführt. Keine Schreib-Tokens oder Secrets an fremde PRs freigeben.
2. Unter **Settings → Actions → General → Workflow permissions** müssen die explizit angeforderten `contents: write` / `pull-requests: write` für den Update-Job zulässig sein. Für den Standard-`GITHUB_TOKEN` muss GitHub das Erstellen von PRs erlauben. Der betreffende UI-Schalter erwähnt auch Genehmigungen; unser Workflow genehmigt trotzdem niemals einen PR.
3. Falls GitHub das Aktualisieren von `.github/workflows` über den Standardtoken verweigert, optional ein auf **diesen Fork beschränktes** Fine-Grained-Token mit Contents/Workflows/Pull-requests-Schreibrecht als Actions-Secret `FORK_SYNC_TOKEN` hinterlegen. Niemals einen Token in Dateien, Chat, Logs oder URLs schreiben. Keine pauschalen Kontorechte erteilen.
4. Unter **Settings → Secrets and variables → Actions → Variables** eintragen: `NUVIO_SUPABASE_URL` und `NUVIO_SUPABASE_ANON_KEY`. Verwende dieselben bereits autorisierten **öffentlichen** Werte wie in deiner lokalen `local.properties` / `browser-site/.env.local`. Keine Service-Role-/Signing-/Debrid-Schlüssel.
5. Default Branch auf **Dev** belassen, **Auto-Merge deaktiviert** lassen. Für Dev nach Möglichkeit eine Regel „Änderungen nur per Pull Request“ sowie die erfolgreichen Fork-CI-Prüfungen verlangen. Bei einem allein verwalteten Fork keine zusätzliche fremde Freigabe erzwingen, wenn niemand sonst reviewen kann. Nicht notwendige Bypass-Rechte vermeiden.
6. Den Update-Workflow einmal manuell testen. Bei identischem Upstream-Stand ist „Nothing to propose“ das richtige Ergebnis. Einen PR erst nach eigener Prüfung zusammenführen. Danach **Fork - Windows MSI → Run workflow → Dev**. Nach erfolgreichem Lauf das MSI unter **Artifacts** herunterladen und den beiliegenden SHA-256-Bericht prüfen.

Der Quellcode-Connector selbst bietet keine Actions-/Variablen-Administration. Über die vorhandene GitHub-Anmeldung des Fork-Eigentümers wurden Actions aktiviert vorgefunden, lesende Standardrechte und die PR-Erlaubnis geprüft sowie beide öffentlichen Repository-Variables eingetragen und zurückgelesen. Private Zugangsdaten wurden dabei weder gedruckt noch in Projektdateien gespeichert. Noch nicht verifizierte Einstellungen stehen im Integrationsbericht.

## Lokale Arbeit

`browser-site/` enthält den eigenständigen Browser-Gast mit Hosting-Anleitung. `fork-maintenance/` bewahrt das Patch-/Vorbereitungs-Kit. `local.properties`, `.env.local`, Caches, Backups und Build-Ausgaben sind nicht Teil der veröffentlichten Änderungen. Die öffentlichen Werte werden beim Build in die Anwendung eingebaut; private Zugangsdaten gehören grundsätzlich nicht ins Projekt.

Für neue Änderungen einen eigenen Branch von `origin/Dev` anlegen, nach Tests in den eigenen Fork pushen und einen PR **im eigenen Fork** mit Basis `Dev` erstellen. Keine PRs an NuvioMedia eröffnen, wenn dies nicht ausdrücklich gewünscht ist.

Das ursprünglich genannte Download-Paket war nicht verfügbar. Der Fork-Eigentümer hat anschließend ausdrücklich die eigene Erstellung beauftragt. `Nuvio-Fork-Auto-Updates.zip` wird deshalb aus diesen geprüften Workflows, Skripten und Anleitungen neu erstellt. Es enthält keine lokale Konfiguration, Anmeldesitzung oder privaten Schlüssel und ist kein angeblich geprüftes fremdes Download-Paket.

Quellen: [Workflow-Rechte](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository), [Auslöser und Default Branch](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows), [manueller Workflow-Aufruf](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).
