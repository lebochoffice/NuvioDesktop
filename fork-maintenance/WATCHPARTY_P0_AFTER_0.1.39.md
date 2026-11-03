# P0 nach 0.1.39: Realtime-Verbindung und Browsersteuerung

Branch `feature/party-premium-ui`, Basis `d2cc4cdd`, lokal und nicht committet (03.11.2026). Keine Tests, Builds oder Deployments ausgeführt.

## Ursachen

1. **Realtime bleibt dauerhaft „Verbindung unterbrochen“ (Browser).**
   - realtime-js 2.118 entfernt einen Kanal nach `CLOSED` endgültig aus dem Socket (`RealtimeChannel`: `this._onClose(() => this.socket._remove(this))`) und baut ihn nie selbst neu auf.
   - Die Browser-Session hat keinen neuen Kanal angelegt.
   - `CHANNEL_ERROR`/`TIMED_OUT` versucht realtime-js zwar selbst neu, ein dauerhaft scheiternder Rejoin blieb aber ebenfalls hängen.
   - Zusätzlich hat die Seite bei jedem Fehler pausiert und erwartete danach einen manuellen Klick. Der Refresh-Button rief nur `requestState`/`applySync` auf, das repariert keine Subscription.
   - Auslöser für `CLOSED` können Serverneustart, Ablauf des Tokens im Hintergrund-Tab oder Netzwechsel sein. Welcher Auslöser es im Live-Test war, ist nicht belegt; dafür gibt es jetzt das Protokoll.
   - Ausgeschlossen: ein statisches Token. supabase-js 2.118 übergibt Realtime einen `accessToken`-Callback und erneuert das Token bei jedem Heartbeat.
2. **Unzuverlässige Browserbefehle und abweichende Positionen (0.1.39-Host).**
   - `PartyCommands.decide` hat einen Befehl als `superseded` abgelehnt, sobald zwischen der zuletzt gesehenen Revision des Browsers (`base_seq`) und der aktuellen Host-Revision eine Revision eines anderen Akteurs lag oder Revisionen fehlten. Dasselbe galt für `stale_epoch`, wenn `base_seq` größer als die aktuelle Host-Revision war.
   - Typische Anlässe:
     - eine verlorene oder verspätete `state`-Nachricht (Realtime garantiert keine Zustellung)
     - Reconnect
     - eine automatische Host-Revision, etwa Auto-Skip, falls aktiviert
   - Der Browser fiel dann auf seinen eventuell veralteten Party-Zustand zurück: Der Befehl wirkte verloren, und die Positionen liefen auseinander.
   - 0.1.36 hatte diese Ablehnung nicht.
   - Bei unterbrochenem Kanal (Ursache 1) erreichen Befehle den Host nicht und enden nach 8 s als UNKNOWN.
3. **Nebenbefund Host:** `onCommand` hat die Command-ID erst nach `publish` gespeichert. `publish` pausiert beim Senden, ein Retry in diesem Moment wäre ein zweites Mal ausgeführt worden. Außerdem wurde die Hinweis-`seq` nach dem Senden gelesen.

## Korrektur (klein, ohne 0.1.39 zurückzusetzen)

- **Host (`PartyCommands.kt`, `PartyRepository.kt`):**
  - Befehle sind absolut (Pause/Play an Position X, Sprung zu X). Der Host ordnet sie in Ankunftsreihenfolge, wie die eigenen Aktionen jedes Mitglieds.
  - Abgelehnt wird nur noch bei: ungültiger ID, falscher Epoche (Host/Film), Nicht-Mitglied, Host-only.
  - Der Revisionsverlauf ist entfernt.
  - Die Command-ID wird vor `publish` gespeichert (kein doppeltes Ausführen), und die `seq` steht synchron fest.
  - Kein Fallback auf die alte Steuerung nötig; Hosts ohne Ankündigung nutzen weiterhin den alten Weg.
- **Browser (`session.js`):**
  - `CLOSED` → neuer Kanal nach Backoff von 1, 2, 4 … höchstens 30 s.
  - `CHANNEL_ERROR`/`TIMED_OUT` → erst einmal den eigenen Rejoin von realtime-js abwarten; nur wenn er nach 10 s nicht gelungen ist, einen neuen Kanal anlegen.
  - Vor dem Neuaufbau wird die Sitzung über `getSession()` erneuert und `setAuth` gesetzt. Ist die Anmeldung abgelaufen, erscheint eine klare Meldung.
  - Callbacks und Events alter Kanäle werden ignoriert.
  - Bei einer Ablehnung mit neuerer Host-Revision werden `state_request` und Heartbeat-Snapshot angefordert.
- **Browser (`main.js`):**
  - `CONNECTING` gilt als Übergang („Verbinde …“, nach einem Verlust „Verbinde neu …“), nicht als Verlust.
  - Nach dem Wiederverbinden folgt die Wiedergabe automatisch wieder der Party-Zeit. Das gilt nur, wenn sie vorher synchron war; eine bewusste lokale Pause bleibt bestehen.
  - Der Refresh-Button baut einen verlorenen Kanal neu auf.
- **Diagnose** (Debug-Ansicht, `sessionStorage nuvio-party-debug=1`):
  - `realtimeLog`: die letzten 10 Statuswechsel mit ISO-Zeitstempel und fester Kategorie (`auth_token`, `not_authorized`, `rate_limited`, `timeout`, `network`, `other`); niemals Fehlertext, Token, Topic oder URL
  - `realtimeReconnects`
  - `msSinceRealtimeState`: verbunden, aber keine Playback-Nachricht
  - `latestCommandStatus`/`latestCommandReason`: Befehl nicht bestätigt
  - `lastPlaybackError`: Fehler der Streamquelle

## Links (nur dokumentiert)

- **„Einladung kopieren“** (Party-Details, Player-Overlay) enthält Code und `partyInviteLink()`, also immer Production `https://nuvio-watch-friends.pages.dev/party/<CODE>`.
- **„Watch in Browser · Copy link“** in `party.js` nutzt die gespeicherte Adresse, Standard Production. Cloudflare-Preview-Hosts (`<name>.<projekt>.pages.dev`), auch der Branch-Alias `feature-party-premium-ui…`, werden bewusst abgelehnt.
- Die neue Browseroberfläche liegt bisher nur in der Preview. Deshalb öffnen Desktop-Einladungen die alte Oberfläche, und die Live-Tests mit Einladungslink liefen sehr wahrscheinlich gegen die **alte Production-Seite** (alter Steuerweg).
- Für Tests die Preview-URL von Hand öffnen. Ein Production-Deployment wurde nicht durchgeführt.
- Kein Kopieren aktiviert eine Streamfreigabe (`party.js`: „Copying the link must never implicitly enable source sharing.“; die Kotlin-Kopierfunktionen setzen nur die Zwischenablage).

## TorBox-HLS (Analyse, keine Änderung)

- `torboxPartyFile` wird nur gesetzt, wenn der Stream über die **eingebaute TorBox-Debrid-Auflösung** von Nuvio kommt (`DirectDebridResolver`, `DebridProviderApis`, Cloud-Bibliothek). Bei Addon-Streams, auch solchen mit TorBox im Hintergrund, fehlt es. Dann gibt es kein `browser_hls`, und der Browser bekommt die Originalquelle (MKV meist nicht abspielbar).
- `prepareTorboxPartyHls` startet nur beim **Host** in der Party, wenn der Film zur Party passt und ein TorBox-Key gespeichert ist. Es fordert `createStream` an, prüft `data.hls_url` (HTTPS, `*.torbox.app`, kein Account-Key in der URL) und fragt das Manifest bis zu 15 × 2 s ab.
- Fehlermeldungen stehen im Party-Panel als Hinweis zur Freigabe (`torboxPartyStatus`): Key fehlt oder Account geändert, 403 Tarif/Berechtigung, keine sichere `hls_url`, Manifest nicht bereit, Zugriff entzogen bzw. abgelaufen (Erneuerung nach 401/403/404/410, höchstens 3-mal).
- Übertragen wird nur mit **„Share my stream“**. Ist HLS noch nicht vorbereitet, geht `browser_hls.url = null` raus; der Browser zeigt dann „Browser-HLS“ und keine Desktop-URL.
- Ob die TorBox-CDN CORS für die Preview-Adresse erlaubt, ist offline nicht prüfbar. Das zeigt erst der Live-Test in der Browserkonsole.

## Risiken

- Ankunftsreihenfolge statt Konfliktablehnung: Bei fast gleichzeitigen Befehlen gewinnt der zuletzt beim Host eingetroffene. Das ist auf allen Geräten gleich und entspricht 0.1.36.
- Automatische Wiederaufnahme nach einem Reconnect: `play()` ohne neue Geste kann am Handy an der Autoplay-Sperre scheitern. Dann erscheint die bestehende Meldung mit Tippen auf Play.
- Realtime-Payloads sind weiterhin nicht serverseitig authentifiziert (unverändert).
- Auto-Skip ist am Host standardmäßig aus. Wenn aktiviert, springt der Host automatisch und veröffentlicht das für alle. Unverändert, aber beim Test beachten.

## Testergebnis (03.11.2026, lokal)

- Browser `npm test`: 154/154 bestanden (darunter 9 neue P0-Tests).
- Desktop (CI-Auswahl): 98/98 bestanden, `PartyCommandsTest` 9/9; Desktop-Code kompiliert. Log: `fork-maintenance/local/desktop-tests-p0.log`.
- Fork-Invarianten: OK.
- Nicht live getestet.
