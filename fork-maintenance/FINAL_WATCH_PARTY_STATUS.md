# Watch Party / TorBox / Windows – Arbeitsstand

Historischer Stand 0.1.34: Die aktualisierte Anbindung an das bestehende Sharing in 0.1.35 ist in [TORBOX_PARTY_HLS.md](TORBOX_PARTY_HLS.md) beschrieben. Insbesondere ist die automatische Vorbereitung jetzt im Player angeschlossen.

Dieser Stand ist eine Vorschau, keine bestätigte vollständige Freigabe. Feature-Branch `feature/torbox-hls-mvp`, vorhandener Worktree und lokale Änderungen wurden erhalten. Keine Tests ausgeführt, kein Push/Merge/Deployment und keine App gestartet oder installiert. Der ausdrücklich beauftragte MSI-Build ist davon getrennt.

## Phasen und technische Grenzen

1. **Synchronisierung:** Die vorhandene Realtime-Diagnose und die Browser-Korrekturen bleiben enthalten: sofortiger Abgleich akzeptierter Zustände, Schutz vor älteren Snapshots, Host-Pause vor Seek-Prüfungen, Seek-Queue, kurze Buffering-Schonzeit, Play-Promise-Identität und interne Videoevent-Erkennung. Siehe `browser-site/REALTIME_SYNC_DIAGNOSIS.md`. Ein Verbindungsabbruch pausiert sicher; nach Wiederverbindung ausdrücklich neu synchronisieren. Erfolgreiche Synchronisierung und Reconnect mit der installierten offiziellen App sind weiterhin nicht live bestätigt. Eine installierte Version ist nicht durch Quellcodevergleich nachgewiesen.
2. **Automatische TorBox-Erzeugung:** Transportmethoden `TorboxApiClient.createStream` und `getStreamData` sowie validierte Query-Builder ergänzt. Es wird keine neue Anmeldung implementiert und kein Schlüssel hardcodiert. Die Methoden sind noch nicht an den Player angeschlossen. Automatische Dateiauflösung, Antwortauswertung, Laufzeit-/Ablaufverwaltung und Erneuerung sind ausdrücklich **nicht fertig**. Die vorhandene Account-/Debrid-Integration arbeitet mit Downloadlinks; die exakten Torrent-/Datei-IDs dürfen nicht aus CDN-Adressen geraten werden. Serienpakete erfordern die ausgewählte Episode und Datei.
3. **Gastfreigabe:** Keine automatische Freigabe des TorBox-Kontos/Streamtokens implementiert. Eigene persönliche HLS-URL bleibt sicherer Fallback. Ein statischer Pages-Client kann einen bereits an Gäste ausgegebenen Provider-Link nicht an die Nuvio-Mitgliedschaft binden oder nachträglich entziehen. Der bestehende Share-Schalter erhält im Windows-Overlay eine zusätzliche ausdrückliche Bestätigung. Einladungslink kopieren aktiviert Sharing nicht mehr. Die URL-Freigabe ist keine widerrufbare TorBox-Gastsession.
4. **Browser steuert Desktop:** Nicht aktiviert. `PartyApi.update` zeigt den RPC `watch_party_update` mit Party-/Device-ID und Playback. Es liegen hier keine SQL-Implementierung oder überprüften Serverregeln vor, die Gastberechtigung, Identitätsbindung, konkurrierende Sequenzen und Replay-Schutz belegen. Daher keine frei erfundenen RPCs und keine reine `member_id`-Broadcast-Autorisierung. Bestehende Desktop-Steuerung und `hostOnly` bleiben erhalten; Browseraktionen bleiben lokal.
5. **Oberfläche:** Die persönliche Website ist Vorgabe für neue Browser-Einladungen. Bestehende eigene Site-Einstellungen werden erhalten. Status benennt fehlende automatische TorBox-Gastsessions und die lokale Browsersteuerung. Kein irreführender Zustand „Bereit zum Teilen“. Normale Nuvio-Party-Links bleiben unverändert. Die persönliche HLS-Beta-Eingabe bleibt ausklappbar.
6. **Tests:** Neue TorBox-Query-Tests ergänzen die vorhandenen Browser-/Party-Regressionsentwürfe. Keine davon hier ausgeführt. Keine erfundenen Live-Ergebnisse. Nicht implementierte Gastfreigabe oder autorisierte Fernsteuerung werden nicht durch scheinbar erfolgreiche Mock-Tests als funktionierend ausgegeben.
7. **MSI:** Direkter lokaler `:composeApp:packageReleaseMsi`-Task, Versionsüberschreibung `0.1.34-torbox-hls-preview` / Code 34. Die bestehende `jpackageCompatibleVersion`-Funktion hebt den Major-Anteil 0 auf 1 an: MSI-Produktversion deshalb `1.1.34`. Der bestehende CI-Schutz für Dev wird nicht umgangen oder verändert. Die tatsächlichen Metadaten und Dateihashes kommen aus dem fertigen Artefakt/Verifier. Der Build wurde nach den letzten Codeänderungen erneut angestoßen.

## Offizielle API-Prüfung

Quelle: [TorBox OpenAPI](https://api.torbox.app/openapi.json), öffentlich gelesen am 02.11.2026. Bei beiden Endpunkten ist die Erfolgsantwort als freies JSON ohne definierte Felder beschrieben. Es wurde deshalb kein Playlist-/Token-/Expiry-Feld erfunden.

- `GET /v1/api/stream/createstream`: API-Key per Bearer; `id` ist erforderlich. Optional sind `file_id` (Vorgabe 0), `type` (Vorgabe torrent), Audio-/Untertitel-/Auflösungsindex und Scrobbling. Unsere torrentbezogene Transportmethode verlangt ausdrücklich eine ausgewählte Datei und schaltet zusätzliches Scrobbling aus.
- `GET /v1/api/stream/getstreamdata`: `token` und `presigned_token` erforderlich, optional Track-/Auflösungsindizes. Beschreibung nennt File-Token und Presigned-Token. Diese dürfen nicht mit dem vollständigen Account-API-Key verwechselt werden. Die Transportmethode reicht den Account-Key nur als Authorization-Header weiter; Stream-Token-Querys dürfen nicht geloggt werden.

Die OpenAPI beschreibt damit keine verifizierte Berechtigung für Gäste ohne eigenen Account, keine verbindliche separate Session pro Zuschauer, keine zugesicherte Ablaufzeit und keinen hier belegten mitgliedsbezogenen Widerruf. Das ist kein Beweis, dass TorBox eine solche Funktion grundsätzlich verbietet; die erforderliche sichere Zusicherung fehlt für diese Integration. [API-/Developer-Bedingungen](https://torbox.app/policies/api-developer-terms), [Nutzungsbedingungen](https://www.torbox.app/terms) und Tarif-/Fair-Use-Berechtigung müssen für den konkreten Account gelten. Keine Tarif- oder DRM-Umgehung.

Für eine vollständige nächste Integration fehlen: ein belastbares Beispiel-/Schemaset der aktuellen Streamantworten ohne echte Schlüssel; bestätigter Session-/Ablauf-/Widerrufsvertrag und Freigaberecht für mehrere Zuschauer; geprüfte Backend-Regeln für autorisierte Gaststeuerung. Keine privaten Schlüssel in Chats, Repositories oder Protokolle übernehmen. Ein etwaiger zusätzlicher Backend-Dienst wäre eine separate Architekturentscheidung, hier nicht angelegt.

## Sicherheitsbewertung

Persönliche HLS-URLs verlassen weder diesen Player noch gelangen sie in Party-Nachrichten. Streamanbieter und Browser-Netzwerkansicht sehen zwangsläufig die Medienanfragen. Ein geteilter Provider-Link bleibt ein kopierbares Bearer-Geheimnis; Mitgliedschaftsverlust beendet nur den Player, entzieht keinen kopierten CDN-Link. Keine Videodaten über Pages, kein Proxy/FFmpeg/VLC/Streamingserver.

Die neuen API-Methoden sind reine Transportgrundlage und werden nicht automatisch aufgerufen. Weder verbrauchte Streamkontingente noch Account-Berechtigungen wurden durch Live-Anfragen geprüft. Keine vollständigen Account-Schlüssel im Browser/Sharing. Das Windows-Overlay verlangt Zustimmung vor dem manuellen Sharing; es ist keine Garantie für andere Playeroberflächen oder die Sicherheit eines vom Nutzer ausgewählten Provider-Links.

## Dateien dieser Erweiterung

- `composeApp/src/commonMain/kotlin/com/nuvio/app/features/debrid/DebridApiClients.kt`: dokumentierte Stream-Transportmethoden, freie JSON-Antwort statt erfundener DTOs.
- `composeApp/src/commonMain/kotlin/com/nuvio/app/features/debrid/TorboxStreamRequest.kt`: exakte Dateiauswahl und Query-Validierung.
- `composeApp/src/commonTest/kotlin/com/nuvio/app/features/debrid/TorboxStreamRequestTest.kt`: nicht ausgeführte Regressionen.
- `composeApp/src/desktopMain/resources/player-ui/party.js`: Site-Vorgabe, ehrliche Einschränkungen, getrennte Einladungs-/Sharing-Einwilligung.
- Diese Dokumentation; Browser-Änderungen aus den vorangegangenen Aufträgen bleiben uncommitted erhalten.
- `fork-maintenance/verify-msi.ps1`: optional exakte MSI-Auswahl, damit mehrere alte Installer erhalten bleiben; zusätzlicher Vergleich von JAR-Dateiname/-Größe aus MSI-Dateitabelle und Staging. Die bisherige Marker-/Runtime-/Backendprüfung bleibt bestehen. Diese Prüfung extrahiert keinen Cabinet-Inhalt und ist kein vollständiger byteweiser Vergleich aller MSI-Dateien.

## Manuelle Tests

```powershell
Set-Location 'C:\Users\Alanp\Desktop\Chatgpt\Codex\Nuvio-Watch\NuvioDesktop\browser-site'
npm test
# Optional, sofern Playwright und Chromium eingerichtet sind:
node checks/browser-smoke.mjs
Set-Location ..
.\gradlew.bat :composeApp:desktopTest --tests '*TorboxStreamRequestTest' --tests '*Party*Test' --no-configuration-cache --console=plain
```

Anschließend den geänderten Browserstand separat bereitstellen oder manuell lokal starten. Die öffentliche Pages-Seite wurde nicht aktualisiert. Echte TorBox-Quelle nur im HLS-Eingabefeld eingeben. Realtime-Zähler, Quelle, Sequenz und `hostPaused` bei Host-Play/Pause/Seek prüfen; Gap-Recovery, Logout, Reconnect, Filmwechsel, Entfernen und Party-Ende mit mehreren Teilnehmern kontrollieren. Siehe Browser-Diagnoseanleitung. Das MSI enthält die Desktop-Bridge, nicht automatisch ein Deployment des Browserprojekts.

## Sicherer CI-Ausweg

Der vorhandene Workflow `Fork - Windows MSI` baut einen Installer nur per `workflow_dispatch` auf geprüftem Dev. Ein lokaler Feature-Build verwendet direkt Gradle. Falls der lokale Build blockiert ist: Änderungen nach manueller Prüfung selbst committen/pushen, PR gegen den eigenen Dev erstellen, prüfen und erst nach eigener Freigabe übernehmen. Danach Workflow manuell starten. Der Workflow führt Tests aus; das ist eine spätere ausdrückliche Nutzeraktion. Keine Änderung der Branch-Schutzprüfung und kein automatischer Release. Öffentliche Backendwerte gehören in Repository Variables, keine privaten TorBox-/Service-Role-Schlüssel.

## Tatsächliches Build-Ergebnis

Der abschließende Build nach den Codeänderungen meldete `BUILD SUCCESSFUL in 2m 18s`, 24 Tasks, davon 9 ausgeführt. Es wurden keine Test-Tasks angefordert oder ausgeführt. Der zunächst eingeschränkt gestartete Prozess konnte seinen lokalen Gradle-Daemon nicht erreichen; der erlaubte lokale Build außerhalb dieser Prozessbeschränkung funktionierte ohne globale Sicherheitsänderung.

- Datei: `C:\Users\Alanp\Desktop\Chatgpt\Codex\Nuvio-Watch\NuvioDesktop\composeApp\build\compose\release-msis\Nuvio-Windows-x64-0.1.34-torbox-hls-preview.msi`
- Größe: **193286332 Bytes**.
- App-Versionsname: `0.1.34-torbox-hls-preview`, Code 34; aus MSI gelesene Produktversion: **1.1.34**.
- SHA-256: `d44021573b5dc05029cee7d1f04c4293a5381e11d86cf2864b2a628320bf30c3`.
- Signaturstatus: `NotSigned`.
- Read-only Verifikation erfolgreich: MSI-Metadaten, JAR-Name/-Größe, Watch-in-Browser-Marker, öffentliche Nuvio-Backendkonfiguration, Java-Runtime, WebView2Loader, Player-DLLs und Runtime-Index.
- Zusätzliche Artefaktprüfung: `player-ui/party.js` im gepackten JAR ist bytegenau gleich dem aktuellen Quellstand (SHA-256 `1BBB34E111B6080893F7E2E1E0F501A87F53B8AF21D084F75E103F8FA2A6DB72`). Die neue `TorboxStreamRequestKt.class` ist vorhanden.
- Verifikationsmanifest neben dem MSI: `Nuvio-Windows-x64-0.1.34-torbox-hls-preview-verification.json`.
- Lokales Buildprotokoll: `fork-maintenance/local/msi-preview-build.log` (nicht für Veröffentlichung vorgesehen).

Der Verifier wurde mit explizitem `-MsiPath` auf den neuen Installer angewendet. Vorhandene ältere MSI-Dateien wurden nicht entfernt. Die Cabinet-Inhalte wurden nicht separat extrahiert; der Markercheck betrifft das Staging-JAR, dessen Dateimetadaten mit der MSI-Tabelle übereinstimmen. Keine Installation, kein App-Start, keine tatsächliche Wiedergabeprüfung und keine vollständige Freigabe. Der Installer enthält die Desktop-Anpassung; der separate Browserstand ist noch manuell bereitzustellen.

Erneute read-only Prüfung, falls gewünscht:

```powershell
.\fork-maintenance\verify-msi.ps1 -MsiPath '.\composeApp\build\compose\release-msis\Nuvio-Windows-x64-0.1.34-torbox-hls-preview.msi'
```
