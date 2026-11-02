# Integrationsstand – 2. November 2026

## Nachgewiesen

- Persönlicher Fork: `lebochoffice/NuvioDesktop`; Default Branch `Dev`, Auto-Merge aus. `origin` zeigt auf den Fork; das offizielle Repository ist lokal als nicht beschreibbarer Upstream hinterlegt.
- Auf Fork-Dev eingerichtet: täglicher/manueller Update-Workflow mit Draft-PRs und ohne Merge/Approval/Release; separater manueller Windows-MSI-Workflow mit read-only PR-Tests. GitHub erkennt beide als `active`. Der geerbte Sideload-Workflow darf im Fork nicht automatisch nach Dev schreiben.
- Desktop-Anpassung erhält normale Einladungen, validiert die Seitenadresse und bestätigt eine erforderliche Streamfreigabe ausdrücklich. Quelländerungen liegen zur eigenen Prüfung vor; sie werden nicht automatisch in Dev zusammengeführt.
- Die vorhandenen 46 Kotlin-Party-Tests bestanden. Der vollständige Windows-MSI-Build mit den vom Eigentümer gelieferten offiziellen öffentlichen Backend-Werten war erfolgreich. Die MSI-Datenbank wurde lesend kontrolliert; die zur Paketierung verwendete Anwendung enthält Java, native Runtime, Backend-Konfiguration und Browser-Link-Code. Keine erzeugte App wurde installiert oder gestartet.
- Browser-Protokoll-/Session-/Brückentests und Produktions-Build bestanden. Ein echter Chrome-Test mit simuliertem RPC-/WebSocket-Backend und selbst erzeugtem VP8/WebM-Video prüfte Anmeldung, Kanal, Chat, Quellenbestätigung, Play/Pause/Seek und Widerruf. Das ist kein Live-Medien-Test.
- Der echte offizielle WebSocket-Endpunkt scheiterte ohne `nuvio_realtime=1` und öffnete mit diesem Parameter. Der Browser wurde entsprechend korrigiert. Öffentliche Auth-Einstellungen antworteten mit HTTP 200.
- Der anschließende echte Beitritt mit einer bereits angemeldeten Browser-Sitzung gelang: privater Kanal `Verbunden`, Desktop-Host und Mitgliedschaft sichtbar, freigegebene Streamquelle empfangen. Die aktuelle MKV-/H.265-/HDR-Quelle wurde ausdrücklich als nicht unterstützt abgelehnt. Keine Zugangsdaten oder Medien-URL wurden in den Prüfbericht übernommen; der Live-Screenshot bleibt lokal. Die Testmitgliedschaft wurde verlassen.
- Fork-Workflows wurden mit actionlint 1.7.12 geprüft, PowerShell-Skripte geparst und Bash-Syntax geprüft.

## Noch offen / manuell

- Das angeforderte `Nuvio-Fork-Auto-Updates.zip` war in Arbeitsordner, Downloads und den geprüften Dokumentordnern nicht auffindbar. Sein Inhalt wurde deshalb nicht als geprüft ausgegeben. Die eingerichteten Update-Workflows sind eine eigenständige, dokumentierte Umsetzung. Paket nachreichen und abgleichen, wenn seine Verwendung zwingend ist.
- Der Connector erlaubt Quellcode-/PR-Änderungen, aber keine Actions-/Variablen-Administration und keinen Branch-Protection-Zugriff. Ein gültiger GitHub-Login im integrierten Browser steht nicht zur Verfügung. Die beiden Repository-Variables für die öffentlichen Backend-Werte, die tatsächliche Erlaubnis zum PR-Erstellen mit `GITHUB_TOKEN` sowie ggf. `FORK_SYNC_TOKEN` sind über GitHub zu prüfen/setzen. Branch-Protection war beim überprüften Fork-Stand noch aus; Details stehen in der Wartungsanleitung.
- Ein tatsächlicher Lauf der neuen Fork-Update-/MSI-Workflows muss unabhängig vom lokalen Build nachgewiesen werden. „GitHub erkennt Workflow als aktiv“ bedeutet nicht, dass er bereits erfolgreich gelaufen ist. Remote-CI-Ergebnisse nur aus den konkreten Actions-Läufen bewerten.
- Die aktuelle Live-Quelle lässt sich im Browser nicht abspielen. Ein vollständiger Live-Test der Video-Synchronisierung benötigt eine eigene berechtigte HTTPS-MP4/WebM-/HLS-Quelle mit passenden Codecs, ohne Sonderheader und mit CORS-Freigabe. Browser können andere Fehler erst beim tatsächlichen Start erkennen.
- Kein echter Chatversand wurde ohne gesonderte Testnachricht ausgelöst. Chat-RPC-/UI-Verhalten ist über die simulierten Integrationstests geprüft.
- Cloudflare Pages selbst veröffentlichen; nichts wurde automatisch deployed. Für eine Verteilung des unsignierten MSI und des GPL-Quellcodes trägt der Fork-Eigentümer die Entscheidung. Die bestehende Nuvio-Paketidentität kann eine vorhandene Installation ersetzen; deshalb wurde nichts installiert.

Die vollständigen lokalen Test-/Build-Logs und MSI-Hashdaten liegen im Arbeitsordner bzw. bei den Build-Artefakten. Der Prüfbericht des MSI trennt die Installer-Datenbank ausdrücklich von der geprüften Build-Ausgabe; es wurde kein Installationstest behauptet.
