# TorBox HLS über Nuvios bestehende Streamfreigabe – 0.1.35

Historischer Buildstand: Die endgültige Aufteilung **Original für Desktop, optionales HLS für Browser** und die Invite-Korrektur sind in [STREAM_ROUTING_AND_INVITES.md](STREAM_ROUTING_AND_INVITES.md) dokumentiert. Diese neuen Änderungen sind noch nicht gebaut.

Branch: `feature/torbox-hls-mvp`, vorhandener Worktree. Keine Tests ausgeführt, keine App gestartet/installiert, kein Push/Merge/Deployment. Diese Datei ersetzt die Aussagen zum nicht angeschlossenen Transport aus `FINAL_WATCH_PARTY_STATUS.md`.

## Tatsächlich implementierter Pfad

1. Die bestehenden TorBox-Debrid-Resolver behalten Torrent-ID und **die tatsächlich ausgewählte Datei-ID** aus ihrer vorhandenen Datei-/Episodenauswahl. Keine Ableitung von IDs aus CDN-URLs. Zusätzlich wird nur ein SHA-256-Fingerabdruck des verwendeten Account-Keys gespeichert, nie der Key im Streammodell.
2. TorBox-Torrentdateien aus der Cloud Library erhalten dieselbe Referenz, auch beim dortigen Cache-Hit. Sie wird im vorhandenen `PlayerLaunch.stream` an den Player weitergegeben.
3. `BindPartyEffects` bereitet für den Host mit passender Party-/Medienkennung automatisch `createstream` vor. Der vorhandene gespeicherte TorBox-Key wird ausschließlich im Desktop für den API-Aufruf verwendet. Accountwechsel mit alten IDs wird abgewiesen. Ein Coroutine-Effekt pro Party/Datei/Account verhindert neue Erzeugungen bei jedem Rendering oder Sharing-Toggle.
4. Der vorbereitete Link stammt ausschließlich aus dem belegten Feld `data.hls_url`. HTTPS, erlaubte TorBox-Domain, fehlende Userinfo/Fragmente und das Fehlen des vollständigen Account-Keys in URL/decodiertem Pfad/Query werden geprüft. Ganze API-Antworten mit beispielsweise `user_token` werden **nicht** in `PartyStream` übernommen. Eine Playlist-Probe prüft HTTP-Ergebnis, `#EXTM3U` und sichtbare Account-Keys im obersten Manifest. Auf die Bereitschaft derselben Session wird bis ungefähr 30 Sekunden gewartet; es werden deshalb keine weiteren Streams erzeugt.
5. `currentPartyStream()` liefert bei einer bekannten TorBox-Datei nur das vorbereitete Ergebnis für genau diese Datei/Medienkennung. Die ursprüngliche Desktop-Quelle und deren Wiedergabe bleiben bestehen. Während der Vorbereitung oder bei Fehlern gibt es keine Ersatzfreigabe der ungeeigneten ursprünglichen Datei.
6. **Nur der vorhandene Sharing-Schalter** erteilt Zustimmung. Danach nimmt die bereits bestehende `LaunchedEffect(sharing, sharedStream)` die Quelle entgegen und verwendet unverändert `PartyRepository.shareStream()` → `sendStream()` → `stream` mit `PartyStream`. Keine zweite Sharing-Funktion, kein neuer Kanal, keine TorBox-Gastanmeldung.
7. Sharing aus sendet den bestehenden Null-Stream. Party-Ende/Logout/Medien- oder Accountwechsel beenden die Vorbereitung über deren Lebenszyklus. Ein bereits an einen Gast ausgegebener Provider-Link ist dadurch nicht beim CDN widerrufen.
8. Alle 60 Sekunden wird nur das oberste Manifest geprüft. Nach 401/403/404/410 wird die alte Freigabe zurückgenommen und eine neue vorbereitet. Maximal drei Erneuerungen pro Effekt; danach verständlicher Fehler statt endloser Streamerzeugung. Netzwerkfehler allein erzeugen keine neue Session. Ein später im obersten Manifest erkannter Account-Key stoppt die Freigabe. Sharing bleibt bei einer automatischen Erneuerung nur im bereits erteilten Einwilligungszustand.
9. Browser-Gäste laden die empfangene bestehende Streamfreigabe über den vorhandenen Player/hls.js; Dateiendung ist bei `stream_type: hls` nicht nötig. Relative Segmente verarbeitet hls.js gegen die jeweilige Playlist-Basis. Der persönliche HLS-Beta-Modus behält seinen Vorrang als bewusster Fallback.

## Belegte TorBox-Felder und verbleibende Voraussetzungen

Geprüft wurden die aktuelle [TorBox OpenAPI](https://api.torbox.app/openapi.json) und der öffentliche offizielle Webclient:

- [streamFunctions-2d701a3f.js](https://torbox.app/assets/streamFunctions-2d701a3f.js): Aufruf von `createstream`, Audio-/Untertitel-/Auflösungsparameter; Aufruf von `getstreamdata` mit Account-Token und Presigned-Token.
- [Stream-4643cac0.js](https://torbox.app/assets/Stream-4643cac0.js): Verwendung von `data.hls_url`, Metadaten und Track-Indizes.

Das sind echte Felder des offiziellen Clients, keine erfundenen Response-Beispiele. Die OpenAPI selbst lässt die Erfolgsantworten weiterhin untypisiert. Der neue Pfad benötigt beim Erstellen eine erfolgreiche Antwort mit direkt nutzbarer `data.hls_url`; andere Antwortvarianten scheitern mit einer festen Meldung. **Es gab keine API-Anfrage mit einem persönlichen TorBox-Key und keinen selbst ausgeführten Live-Test.**

Wichtige Korrektur zur vorherigen Dokumentation: Der offizielle Webclient setzt bei `getstreamdata` den Account-Token auch als Queryparameter. Diese URL darf deshalb niemals als Gast-`PartyStream` verwendet werden. Die vorbereitete HLS-URL wird gesondert gegen den vollständigen Account-Key geprüft. Falls TorBox nur einen solchen Link liefert, bleibt die Freigabe gesperrt. Kein Entfernen vermeintlich unnötiger Tokens und keine Umgehung von Pro-/CORS-Vorgaben.

Nicht automatisch zuordenbar sind externe Add-ons mit ausschließlich einer URL ohne vertrauenswürdige Torrent-/Dateireferenz sowie Cloud-Usenet/Webdownloads. Dafür bleibt der bisherige Pfad bzw. persönliche HLS-Fallback bestehen. Die Domainfreigabe ist derzeit auf `torbox.app` und dessen Subdomains begrenzt; ein anderes CDN wird nicht geraten oder stillschweigend erlaubt. Redirects bei der Desktop-Manifestprobe werden nicht verfolgt.

Die Probe des obersten Manifests bestätigt weder Codecs noch CORS, Video-/Audiosegmente, Unter-Playlists, DRM, Mehr-IP-Berechtigung oder fehlerfreie Wiedergabe. Insbesondere prüft sie nicht rekursiv sämtliche Segment-/Key-URLs und garantiert keine jederzeitige Erreichbarkeit. Ein nur beim Gast oder in einem Segment auftretender Ablauf-/IP-Fehler löst keinen erfundenen Rückkanal zum Host aus; der Gast erhält den bestehenden Netzwerk-/Formatfehler. Erneuerung reagiert auf beim Host erkennbaren Manifestzugriffsverlust, nicht auf eine unbestätigte Ablaufzeit aus geratenen Response-Feldern.

## Header, Sicherheit, Steuerung

HLS unterstützt im Browser `Accept` und `Accept-Language`, sofern TorBox/CORS es zulässt. Byte-Range-Requests verwaltet hls.js selbst, damit keine widersprüchlichen Range-Header entstehen. Native HLS wird bei benötigten eigenen Headern nicht verwendet. `Authorization`, Cookie, Referer, User-Agent und Antwortheader-Umschreibung bleiben abgewiesen; es wird kein Account-Key an Gäste verteilt. Die automatisch erzeugte `PartyStream`-Quelle enthält keine eigenen Header. hls.js läuft ohne Debug-Logging und ohne Cross-Origin-Cookies. Keine Rohantworten/Exceptions in Statusmeldungen.

Der vorbereitete Streamlink ist ein Bearer-Geheimnis für die Party-Mitglieder. Kein neuer Zugriffsschutz oder Widerrufsserver wird behauptet. Gleichzeitige IPs, Tarif-/Fair-Use-Regeln und Freigaberecht müssen für den konkreten TorBox-Zugang gelten. Funktionierendes Host-Manifest ist kein Nachweis für Gastzugriff. Kein Proxy, kein FFmpeg/VLC, keine Videodaten über Pages.

Realtime-/Snapshot-/Clock- und Playerkorrekturen aus den vorherigen Aufträgen bleiben erhalten; siehe `browser-site/REALTIME_SYNC_DIAGNOSIS.md`. Sie müssen nun mit diesem Host-MSI und dem geänderten Browserstand live geprüft werden. Die öffentliche Pages-Seite wurde nicht deployed. Für `watch_party_update` liegt weiterhin nur der Desktop-Aufruf, keine überprüfte serverseitige Autorisierung vor. Deshalb keine bidirektionale Gaststeuerung ergänzt und keine freie `member_id`-Autorisierung eingebaut. Browseraktionen bleiben lokal.

## Geänderte Bereiche

- Debrid-/Cloud-Auflösung, `StreamItem` und `PlayerLaunch.stream`: ausgewählte TorBox-Identität erhalten.
- `TorboxPartyHls.kt`: tatsächliche HLS-Antwort projizieren, Account-Key-Schutz und Manifestprobe.
- `PlayerScreenRuntimeParty.kt`, Runtime-State und Party-Overlay: Vorbereitung/Erneuerung und Übergabe an **bestehende** Freigabe, sichtbarer Status.
- Browser `protocol.js`/`main.js`: sichere HLS-Header; bestehender Streamempfang/Player unverändert im selben Party-System.
- Neue `TorboxPartyHlsTest`; bestehende Query-/Realtime-Tests ergänzt um erlaubte Header und Laden/Zurücknehmen des vorhandenen Stream-Broadcasts. Tests geschrieben, nicht ausgeführt.

## Manuelle Befehle

```powershell
Set-Location 'C:\Users\Alanp\Desktop\Chatgpt\Codex\Nuvio-Watch\NuvioDesktop\browser-site'
npm test
Set-Location ..
.\gradlew.bat :composeApp:desktopTest --tests '*Torbox*Test' --tests '*Party*Test' --no-configuration-cache --console=plain
```

Danach manuell:

1. Exakte Episode/Datei über Nuvios TorBox-Debrid-Auflösung und separat über Cloud-Torrents wählen. Party starten, Status abwarten. Vor Zustimmung dürfen keine Streamnachrichten mit URL an Gäste gehen.
2. „Share my stream“ bestätigen. Bestehenden Browserlink kopieren. Gast mit Nuvio-Konto beitreten, **freigegebenen Stream laden**, synchronisieren. Keine manuelle TorBox-URL sollte bei einer zulässigen vorbereiteten Quelle erforderlich sein.
3. Bild/Ton und Host-Play/Pause/Seek vergleichen. Realtime-Zähler und Sequenzen müssen unmittelbar wachsen; ein nur per Snapshot reagierender Client ist nicht als erfolgreich zu bewerten.
4. Sharing ausschalten: automatischer Gastplayer muss stoppen. Wieder einschalten: gültige vorbereitete Quelle ohne erneute Create-Anfrage. Bewusst persönliche HLS-Quelle bleibt gemäß vorhandenem Fallback-Verhalten unabhängig.
5. Film-/Datei-/Accountwechsel, Party-Ende, Logout und Reconnect prüfen. Alte Quelle darf nicht wieder erscheinen. Mehrere Gäste/IPs und ablaufende Manifest-/Segmentlinks separat prüfen.
6. Fehlende Berechtigung, Key-haltige/fehlende HLS-URL, fremdes CDN oder inkompatible Quelle: fester Fehler, keine Schlüssel im Broadcast oder Log, persönliche HLS weiterhin möglich.

Keine HAR-Dateien, Rohantworten oder Screenshots mit URLs veröffentlichen. Erst erfolgreiche manuelle Tests und ein echter zulässiger TorBox-Mehrteilnehmertest bestätigen die Funktion im Betrieb.

## Abschließender MSI-Build und Prüfung

Der letzte Build des endgültigen Desktop-Quellstands meldete `BUILD SUCCESSFUL in 2m 51s` (9 Tasks ausgeführt, 15 aktuell). Keine Tests angefordert/ausgeführt. Ein zuvor erkannter Compilerfehler bei einer optionalen Cloud-Datei-ID wurde mit nullable-sicherer Zuordnung behoben.

- Pfad: `C:\Users\Alanp\Desktop\Chatgpt\Codex\Nuvio-Watch\NuvioDesktop\composeApp\build\compose\release-msis\Nuvio-Windows-x64-0.1.35-torbox-party-hls.msi`
- App-Version: `0.1.35-torbox-party-hls`, Versionscode 35.
- MSI-Produktversion aus der Datenbank: **1.1.35** (bestehende jpackage-Versionsabbildung).
- Größe: **193302716 Bytes**.
- SHA-256: `e51aed1f6ec27c718ebbb240dc5fe97ccdad8bd577e8126696a05e3b544f86c6`.
- Authenticode: `NotSigned`.

Die vorhandene read-only Verifikation war erfolgreich: Produktmetadaten, MSI-JAR-Dateiname/-Größe passend zum Staging, Browser-Bridge-Marker, öffentliche Nuvio-Konfiguration, Java- und Windows-Player-/WebView2-Runtime. Zusätzlich sind die kompilierten Klassen `TorboxPartyHlsKt` und `TorboxPartyFile` im gepackten Anwendungs-JAR vorhanden; das gepackte `player-ui/party.js` stimmt per SHA-256 mit dem aktuellen Quellstand überein. Cabinet-Inhalte wurden nicht separat extrahiert. Keine Installation oder App-Ausführung. Manifest liegt als `Nuvio-Windows-x64-0.1.35-torbox-party-hls-verification.json` daneben.

Erneute read-only Prüfung:

```powershell
.\fork-maintenance\verify-msi.ps1 -MsiPath '.\composeApp\build\compose\release-msis\Nuvio-Windows-x64-0.1.35-torbox-party-hls.msi'
```

Der neue Desktop-MSI allein aktualisiert die öffentliche Pages-Website nicht. Die Browseränderungen müssen separat nach manueller Prüfung bereitgestellt werden. Keine Aussage über bestandene Tests, echte API-Berechtigung, mehrere IPs oder erfolgreiche Live-Synchronisierung wird aus dem Packaging-Erfolg abgeleitet.
