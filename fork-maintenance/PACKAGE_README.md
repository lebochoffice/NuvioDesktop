# Nuvio-Fork-Auto-Updates – neu erstelltes Paket

Dieses Paket wurde auf ausdrücklichen Wunsch des Fork-Eigentümers neu erstellt, weil die zuvor genannte Download-Datei nicht verfügbar war. Es enthält die überprüften Automationsdateien für `lebochoffice/NuvioDesktop`, nicht die Nuvio-Anwendung oder Videos.

Die Einrichtung ist bereits im persönlichen Fork erfolgt. Die Hauptanleitung steht in `fork-maintenance/README.md`. Änderungen am Desktop und Browser stehen separat als Draft-PR zur menschlichen Prüfung. Die MSI-CI ist nach deren manueller Übernahme auf Dev nutzbar. Ein manueller MSI-Aufruf auf dem alten Upstream-Stand ohne Browser-Anpassung ist absichtlich kein erfolgreicher Bridge-Build.

Enthalten:

- Zwei Fork-Workflows: tägliche/manuelle Update-Draft-PRs und manuell angeforderte Windows-MSI-Artefakte.
- Der geerbte Sideload-Workflow mit Sperre gegen automatische Fork-Commits.
- Update-, Build- und read-only MSI-Verifikationsskripte.
- Einrichtungshinweise sowie Dokumentation der bereinigten, URL-losen Gitverweise.
- GPL-3.0-Lizenz.

Es gibt keinen automatischen Merge, keine automatische Genehmigung, kein Deployment und keine Veröffentlichung eines Releases. Es werden keine privaten Schlüssel, Benutzerkontositzungen, realen Medien-URLs, lokalen `.env`-/`local.properties`-Dateien oder Build-Ausgaben eingepackt.

Bei Wiederherstellung zuerst entpacken und mit dem aktuellen Fork vergleichen. Die enthaltenen Workflows sind repospezifisch und gehören auf dessen Default Branch Dev. Keine Dateien ungeprüft in das offizielle NuvioMedia-Repository übernehmen. Die öffentlichen Backend-Werte bleiben GitHub-Repository-Variables; die lokale Anmeldung und eventuelle Tokens werden nicht durch dieses Archiv eingerichtet.
