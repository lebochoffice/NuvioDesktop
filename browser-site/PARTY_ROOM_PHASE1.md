# Browser-Party-Room Phase 1

Der Browser erstellt eine Party über den vorhandenen NUVIO-RPC und verwendet danach dieselbe Mitgliedschaft, denselben privaten Realtime-Kanal und denselben Chat wie Browsergäste. Serverantworten bestimmen die Hostrolle. Das Create-Ergebnis muss das eigene Mitglied als Host und als Teilnehmer enthalten. Hostaktionen laufen zusätzlich über autorisierte Backend-RPCs.

## Medienauswahl

Vor der Erstellung ist mit dem bekannten Vertrag ein echter Film oder eine konkrete Episode erforderlich. Die Oberfläche sucht im Film- und Serienkatalog von Cinemeta. Nach Auswahl lädt sie die bestätigte Medienidentität, den Titel und verfügbare Metadaten. Bei Serien werden Staffel und Episode aus der bestätigten Episodenliste ausgewählt. Alternativ akzeptiert die manuelle Eingabe eine IMDb-ID oder einen HTTPS-Titellink von IMDb. Cinemeta erhält Suchbegriffe und angefragte Medien-IDs, aber keine NUVIO-Zugangsdaten. Netzwerk- oder CORS-Probleme bei Cinemeta verhindern die Bestätigung eines Titels.

Die Abfrage entspricht der [offiziellen Stremio-Dokumentation](https://stremio.github.io/stremio-addon-sdk/advanced.html). Erfolgsantworten des NUVIO-Backends werden nach dem vorhandenen PartyApi-Vertrag verarbeitet. Browser-Host-Erstellung gegen das offizielle Backend wurde während der Implementierung nicht live ausgeführt.

## Lokale Abnahme

Aus dem Repository starten, mit der vorhandenen öffentlichen Supabase-Konfiguration in der lokalen Browserkonfiguration.

```powershell
npm.cmd --prefix browser-site run dev
```

1. http://127.0.0.1:5173/ öffnen. „Party erstellen“ aufklappen, nach einem Film oder einer Serie suchen und einen Treffer auswählen. Bei einer Serie Staffel und Episode auswählen. Alternativ den manuellen IMDb-Pfad prüfen.
2. Mit dem vorhandenen NUVIO-Konto anmelden und „Party erstellen“ klicken. Ein Videolink ist für den RPC nicht erforderlich. Erst eine erfolgreiche Serverantwort öffnet den Room als Host. Der Videobereich zeigt „Noch kein Video freigegeben“.
3. Party-Code und lokalen Einladungslink prüfen. Den Link in einem zweiten Browserprofil mit einem weiteren autorisierten Konto öffnen. Alternativ mit dem Code am Desktop beitreten. Den erfolgreichen Beitritt im Room prüfen.
4. Chat über „Teilnehmer & Chat“ öffnen. Nachrichten in beide Richtungen senden. Host-only umschalten, ein Mitglied entfernen und anschließend die Party beenden.
5. Vor dem Beenden den Room neu laden. Der Browser merkt sich nur den Party-Code und verwendet den bestehenden Join-RPC zur Wiederherstellung. Der Server muss erneut dieselbe Hostmitgliedschaft bestätigen. Falls er einen neuen Gast erzeugt oder den Join ablehnt, bleibt die Hostverwaltung gesperrt.
6. Realtime-Verlust und Wiederverbindung prüfen. Mitgliederänderungen werden zusätzlich per Heartbeat aktualisiert. Der Status im Room muss den Verbindungszustand anzeigen.
7. Die bestehende Desktop-gehostete Browserparty separat prüfen. Gastplayer, Host-only/Solo, HLS und Einladungsdesign müssen weiterhin funktionieren.

Bei einer Ablehnung die angezeigte RPC-Fehlerkennung und Meldung festhalten. Insbesondere Berechtigungsfehler, unbekannte Signatur und Medienvalidierung getrennt behandeln. Keine Tokens oder Passwörter weitergeben.

## Phase 2

> Stand Phase 2: Der Browser-Host gibt jetzt direkte Videolinks frei und steuert die Wiedergabe selbst, siehe `PARTY_ROOM_PHASE2.md`. Die Aussagen unten zur ausgeblendeten Wiedergabe gelten nur für Phase 1.

Ein Browser-Host verwaltet in dieser Phase den Room. Der Player ist für diese Rolle ausgeblendet. Eine vom Backend zum Host beförderte Browsersitzung wechselt ebenfalls in diesen Verwaltungsmodus.

Der Desktop-Host übernimmt bisher Playback-Veröffentlichung, Host-Sequenzierung von Gastbefehlen, Streamangebote, Statusantworten sowie Countdown und Bereitschaftskoordination. Diese Pflichten werden hier nicht als Browser-Wiedergabekoordinator implementiert. Für vollständige host-unabhängige Wiedergabe sind sie mit serverseitigen Berechtigungen und realer Wiedergabe gemeinsam abzunehmen.

Die bestehenden RPCs reichen als clientseitige Anschlussstellen für diese Verwaltungsoberfläche. Ob das offizielle Backend Browser-Create, nullable Playback und die Wiederherstellung einer Hostmitgliedschaft tatsächlich zulässt, bleibt eine Live-Abnahme. Es wurden keine Backend-Regeln verändert.

### Offener Backend-Vertrag

Der Desktop-Aufruf von `watch_party_create` enthält immer `p_media`. `PartyInfo.media` ist im Desktop-Snapshot Pflicht, und der Wiedergabeschlüssel hängt von Medientyp, Medien-ID und gegebenenfalls Staffel/Episode ab. Ob das Backend `p_media: null` zulässt, lässt sich ohne serverseitige Definition oder autorisierten Live-Aufruf nicht feststellen. Ein leerer Snapshot wäre auch bei akzeptiertem Aufruf mit dem bestehenden Desktop inkompatibel. Falls der Server bisher ein Medium voraussetzt, ist die kleinste Vertragsänderung ein ausdrücklich unterstützter Room-Typ mit serverseitig zugewiesener, stabiler Identität und einem für Browser und Desktop gültigen Schlüssel. Join, Preview, Heartbeat und die autorisierte Playback-Aktualisierung müssen dieselbe Identität zurückgeben.

Für gemeinsame Videolinks fehlt außerdem ein bestätigter Vertrag für die aktuelle Quelle und ihre Revision, einschließlich Widerruf und Wiederherstellung nach Reload. Desktop hält seine aktuelle Freigabe im Speicher und sendet sie auf `state_request` erneut. Das sichert keinen Browser-Host-Reload ab. `stream_suggest` enthält eine behauptete Mitglieds-ID, aber keine serverseitig belegte Senderidentität. Der vorhandene Desktop-Empfänger behandelt den Namen deshalb nur als Anzeige und prüft den Vorschlag vor einer Hostfreigabe. Für bestätigte Vorschläge und Quellenwechsel ist eine serverseitige Bindung an Mitgliedschaft, Hostrolle und Quellenrevision erforderlich.

## Manuelle Tests

```powershell
node --test browser-site/tests/session.test.js browser-site/tests/room-media.test.js browser-site/tests/personal-hls-integration.test.js
npm.cmd --prefix browser-site test
```

Tests wurden bei der Implementierung nicht ausgeführt. Für eine spätere Preview sind die aktualisierten Browserdateien über den bestehenden Pages-Build zu veröffentlichen. Der Desktop benötigt ausschließlich für den korrigierten Hinweistext einen späteren Neubau.
