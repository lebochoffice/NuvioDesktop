# Smart Video Link Phase 2: Gemeinsame YouTube-, MP4- und WebM-Wiedergabe

Stand:
- **Phase 2a** (`8aeda48e5`): Browser-Gäste, der Desktop-Host steuert nur.
- **Phase 2b** (darauf aufbauend): Wiedergabe direkt im NUVIO-Desktop-Player, siehe Abschnitt 9. Implementiert, **nicht getestet, nicht gebaut, nicht committet**.

## 1. Ergebnis in Kürze

| Quelle | Browser-Gäste | Desktop-Host | Desktop-Gäste |
|---|---|---|---|
| **YouTube** | offizieller IFrame-Player | offizieller IFrame-Player **im NUVIO-Player** (Phase 2b), steuert die Party-Zeit | offizieller IFrame-Player **im NUVIO-Player** (Phase 2b) |
| **MP4 / WebM** (direkt, HTTPS) | HTML5-`<video>` über den bestehenden Sync-Pfad (`applySync`) | HTML5-`<video>` **im NUVIO-Player** (Phase 2b); prüft die Datei vorher (HTTP 206, Typ) | HTML5-`<video>` **im NUVIO-Player** (Phase 2b) |
| HLS / TorBox (Film) | unverändert | unverändert | unverändert |

**Warum nicht mpv** (auch in Phase 2b):
- **YouTube:** mpv müsste das Video extrahieren (`ytdl`). Das ist ausgeschlossen.
- **MP4/WebM:** Der mpv-Player des Films trägt alles, was er abspielt, als Fortschritt und Verlauf des geöffneten Titels ein. Außerdem führt er dessen Party-Sync aus: Veröffentlichung, Warten auf Puffernde, Drift-Korrektur, Countdown-Start. Eine fremde Datei darin würde die Film-Position der Party und den Verlauf verfälschen.
  - Abhilfe wäre, die Film-Party-Logik der `PlayerScreenRuntime` vollständig umzuschalten. Das ist der empfindlichste Teil der Synchronisierung und gezielt ausgeschlossen.
  - Die Dateien sind ohnehin geprüft browserkompatibel (MP4/WebM), WebView2 (Chromium) spielt sie also genauso ab wie die Browser-Gäste.

## 2. Protokoll (Fork, „links“-Protokoll 1, rein additiv)

| Element | Inhalt |
|---|---|
| Host-Fähigkeit | Host-`status` mit `links: 1`, zusätzlich zu `commands: 1`. Browser zeigen „Für Party vorschlagen“ für YouTube, MP4 und WebM nur dann. |
| Vorschlag | `stream_suggest`. **YouTube:** `kind: "youtube"`, `video_id`, `url` = kanonische `watch?v=<ID>`-Adresse ohne Tracking-Parameter; der Host baut sie aus der ID neu. **Dateien:** `kind: "mp4"`/`"webm"` mit `url`. HLS-Vorschläge bleiben unverändert und haben kein `kind`. |
| Entscheidung | `stream_suggest_result` vom Host mit `target_member_id` und `status: accepted|declined`. Nur Anzeige beim Vorschlagenden. |
| Freigabe | `shared_source` vom Host mit `{member_id, media_key: <Film>, source: null | {key, id, rev, kind, video_id?, url?, label, party_key}}`. |
| Quellenidentität | `key = "link:<id>:<rev>"`. `id`: 16 zufällige Zeichen, neu bei jeder Annahme. `rev`: steigt bei jeder Ersetzung. |
| Party-Zeit | Normale `state`-Revisionen mit `media_key = key`, eigener `seq`. Nur der Host veröffentlicht sie. **Nie persistiert.** |
| Gastbefehle | Normale `command`-Ereignisse mit `media_key = key`. Der Host ordnet sie mit demselben Ledger und denselben Regeln ein (`PartyLinks.decide`: Mitgliedschaft, Host-only, Epoche). |
| Status, Countdown | Browser melden Status mit `media_key = key`, der Host pausiert den Film deshalb nie für sie (`waitingMemberIds` filtert auf den Film). Ein Countdown mit `media_key = key` startet den Link. |
| Später Beitritt, Reconnect | Der Host beantwortet jedes `state_request` mit `shared_source` (auch `null`) und dem letzten Link-Stand. |

**Verspätete Ereignisse:**
- Ein Browser akzeptiert, solange ein Link aktiv ist, nur `state` mit genau dessen `key` und nur vom aktuellen Host.
- Film-Stände, Stände ohne Schlüssel und Stände einer früheren Revision werden verworfen (`wrong_media`).
- Ein neuer Link oder sein Ende setzt Party-Zeit, offene Befehle und Mitgliedsstatus zurück (neue Epoche).
- Medien- und Hostwechsel beenden den Link.

**Ältere Clients:**
- Offizielle Apps und alte Fork-Builds kennen `shared_source` nicht. Link-Stände ignorieren sie wegen des fremden `media_key`.
- Ein älterer Host bekommt nie YouTube-Vorschläge, weil er `links: 1` nicht meldet.

## 3. Backend und Berechtigungen

- **Keine Migration nötig.** Es wird keine RPC und keine Tabelle verwendet oder geändert.
  - Link-Stände gehen nur über den bestehenden privaten Realtime-Kanal `watch-party:<id>`.
  - `watch_party_update` bekommt weiterhin nur Film-Stände.
- **Berechtigung:** Wie bei allen bestehenden Ereignissen prüft der Server Realtime-Absender nicht.
  - Clients akzeptieren `shared_source`, Link-`state` und Entscheidungen nur, wenn `member_id == host_member_id` aus dem letzten **Server-Snapshot** ist.
  - Ein Gast kann damit nichts freigeben, nur vorschlagen.
  - Ein Mitglied, das Realtime-Nachrichten fälscht, könnte sich als Host ausgeben. Das gilt heute schon für Film-Stände und `stream`, ist also kein neues Risiko.
- **Optional, später** (nur nach gesonderter Freigabe, nicht vorbereitet als Pflicht): Eine Realtime-Autorisierung (RLS auf `realtime.messages`), die `shared_source` und Link-`state` nur vom Host zulässt, würde das Fälschen serverseitig verhindern. Das offizielle Backend ist nicht einsehbar; ob dort eine solche Policy möglich ist, muss der Betreiber prüfen.

## 4. YouTube-Einbettung und Referrer

- **Seite:** `index.html`-Meta und `public/_headers` setzen weiterhin `Referrer-Policy: no-referrer`. Bleibt so, weil der Pfad `/party/<CODE>` sonst an Medienanbieter ginge.
- **Iframe:** `youtube-player.js` setzt `referrerpolicy="strict-origin-when-cross-origin"` (Eigenschaft und Attribut).
  - Nach der Fetch-Spezifikation gilt das Element-Attribut für die Iframe-Navigation vor der Dokument-Policy.
  - YouTube erhält damit nur die **Herkunft** (`https://<preview>/`), nie den Pfad mit dem Party-Code. Das behebt Fehler 153 gezielt, ohne die Seite zu lockern.
- **API-Skript:** Für `iframe_api` ist kein Referer nötig.
- **CSP:** `script-src` erlaubt `https://www.youtube.com/iframe_api` und `/s/player/`, `frame-src` erlaubt `https://www.youtube.com/embed/`. Keine Änderung nötig.
- **Preview-Passwort:** Login-Seite (`same-origin`), Gate und Cookies sind unverändert.
- **Live zu prüfen:** Fehler 153 in Chrome, Firefox, Safari und iOS Safari.
  - Falls ein Browser das Attribut ignoriert, wäre die nächste, ebenfalls gezielte Stufe: nur für die App-Seite `strict-origin` als Dokument-Policy. Auch dann ginge nur die Herkunft an Dritte, nie der Pfad.
- **YouTube-Regeln:** Branding, eigene Bedienelemente, Werbung und Einbettungsverbote bleiben unangetastet. Es wird nichts heruntergeladen oder umgeleitet.

## 5. Synchronisierung

- **MP4/WebM:** exakt der bestehende HTML5-Pfad:
  - Seek, Nudging und Hysterese, Stall-Tracker und Fairness-Budget
  - „Allein schauen“ und „Zur Party“
  - Gastbefehle, Autoplay mit stumm-Fallback
  - Nur die Party-Zeit ist die des Links.
- **YouTube** (`link-sync.js`), bewusst ruhiger:
  - Kein Tempo-Nudging.
  - Seek erst ab 2 s Abweichung, bei Pause ab 0,75 s.
  - Mindestens 5 s zwischen Korrektur-Seeks, höchstens 3 pro Minute. Danach erscheint der Hinweis „holt gerade nicht ein“ und der Status `behind`, aber keine Schleife.
  - **Puffern und Werbung (Zustand 3):** abwarten, nie dagegen seeken.
  - **Autoplay blockiert:** kein erneutes automatisches `play()`; erst das Tippen auf Play im YouTube-Player startet.
  - **Play/Pause im YouTube-Player:** mit Gaststeuerung ein Party-Befehl; sonst „Allein schauen“ mit Hinweis. Eigene Aufrufe in den letzten 2 s zählen nicht als Nutzeraktion.
  - **Nicht einbettbar** (101/150), privat (100), Fehler 153, API nicht ladbar: kurze Fehlermeldung, Status ohne erfundenen Sync-Zustand.
- **Lokaler Smart Video Link:** wird nicht übernommen. Ein Hinweis bietet „Zur Party“ an und wechselt dann zum gemeinsamen Video.

## 6. Geänderte Dateien

- **Desktop:**
  - `PartyLinks.kt` (neu)
  - `PartyModels.kt` (`PartyPresence.links`)
  - `PartyHostHls.kt` (`PartyHlsSuggestion.kind`/`videoId`)
  - `PartyRepository.kt`
  - `PartyChannel.kt`
  - `PlayerControlParty.kt`
  - `PlayerScreenRuntimePartyControls.kt`
  - `player-ui/party.js`
- **Browser:**
  - `shared-source.js`, `link-sync.js`, `player-adapters.js` (neu)
  - `youtube-player.js`
  - `session.js`
  - `main.js`
- **Tests:**
  - `PartyLinksTest.kt` (neu)
  - `shared-source.test.js` (neu)
  - `session.test.js`
  - `personal-hls-integration.test.js` (Harness um die neuen Module ergänzt)
- **Fork-Invarianten:** neue Marker in `check-fork-invariants.sh`.

## 7. Manuelle Testbefehle

```powershell
cd browser-site; npm test; cd ..
.\gradlew.bat :composeApp:desktopTest --tests '*Party*Test' --tests '*MemberSync*' --tests '*PausedPosition*' --tests '*NativePlayerExactSeek*' --tests '*Torbox*Test' --tests '*PartyHostHls*' --tests '*PartyFamilyShare*' --tests '*PartyLinks*' '-Pnuvio.webview2.dir=fork-maintenance/local/webview2-sdk/1.0.4078.44' --no-configuration-cache --console=plain
bash fork-maintenance/check-fork-invariants.sh
```

## 8. Erforderliche Live-Tests

1. **YouTube-Vorschlag:** Browser-Gast schlägt einen YouTube-Link vor → Desktop-Host sieht „YouTube-Vorschlag“ → „Für alle abspielen“. Prüfen:
   - Der Film des Hosts pausiert.
   - Alle Browser laden das Video.
   - Play, Pause, ±10 s, „Von vorn“ und Countdown aus dem Party-Menü folgen bei allen.
2. **Ablehnen:** Der Gast sieht „abgelehnt“.
3. **Fehler 153:** Chrome, Firefox, Safari (macOS) und iOS Safari prüfen.
4. **Werbung:** Video mit Werbung. Nach der Werbung holt der Gast ohne Seek-Schleife auf.
5. **Nicht einbettbar:** Ein solches Video zeigt eine kurze Fehlermeldung, ein privates eine andere.
6. **Gaststeuerung:** Mit Host-only an pausiert ein Gast im YouTube-Player → „Allein“ → „Zur Party“. Mit Host-only aus wird die Pause zum Party-Befehl.
7. **MP4/WebM:**
   - Datei mit Range-Support → geteilt, Sync wie beim Film.
   - Datei ohne Range-Support → „Nicht geteilt“ beim Host.
   - Datei mit falschem Codec → kurze Fehlermeldung im Browser.
8. **Später Beitritt und Reconnect:**
   - Ein neuer Browser-Gast tritt während des Videos bei und landet an der Party-Position.
   - WLAN kurz trennen → danach wieder synchron.
   - Den Link beenden, während ein Gast offline ist → nach dem Reconnect zurück zum Film.
9. **Ende:** „Beenden“ → alle Browser zurück zur Film-Quelle; TorBox-HLS und Desktop-zu-Desktop laufen unverändert weiter.
10. **Film- oder Hostwechsel** beendet den Link bei allen.

## 9. Phase 2b: Gemeinsame Videos direkt im NUVIO-Desktop-Player

### Aufbau
- **Overlay:** Die Player-Oberfläche (`controls.html`, WebView2 über mpv) bleibt eine `file://`-Seite. Es gibt keine Änderung an Bildern, Speicher oder bestehenden Funktionen der Oberfläche.
- **Neue Seite:** `link-player.html` (mit `link-player.js` und `link-policy.js`, im selben Ordner) liefert WebView2 zusätzlich über einen **virtuellen HTTPS-Host** aus: `https://nuvio-link.example/`.
  - `player_bridge.cpp` nutzt dafür `ICoreWebView2_3::SetVirtualHostNameToFolderMapping` mit `DENY_CORS`.
  - YouTube erhält damit eine echte Einbettungs-Herkunft statt `file://`; das verhindert Fehler 153.
  - Ohne `ICoreWebView2_3` (sehr alte Runtime) bleibt alles wie bisher, nur YouTube meldet dann einen Fehler.
- **Einbindung:** `party.js` legt während eines gemeinsamen Videos eine Ebene über das (pausierte) mpv-Bild:
  - die Link-Seite als Iframe
  - darunter eine Leiste mit Play/Pause, −10 s, +10 s, Zeit, Status/Countdown, „Allein schauen“/„Zur Party“, „Party“ und (nur Host) „Video beenden“
  - Kopfzeile, Party-Menü, Dialoge und Hinweise bleiben darüber erreichbar.
- **Film-Steuerung:** Mittelknöpfe, Zeitleiste, Skip-/Next-Hinweise sind ausgeblendet. Tastatur (Leertaste/K, Pfeile, J/L) und Klicks erreichen mpv nicht, solange das Video läuft; die Tasten steuern stattdessen das gemeinsame Video.
- **Härtung der WebView:**
  - Pop-up-Fenster werden blockiert (z. B. der YouTube-Logo-Link).
  - Die Hauptseite kann nur innerhalb des lokalen Player-Ordners navigieren, eingebettete Inhalte können sie nicht wegleiten.
  - Nachrichten zwischen Overlay und Link-Seite werden nur von genau dem jeweiligen Fenster (`event.source`) und von der Herkunft `https://nuvio-link.example` angenommen.
  - Die Link-Seite hat eine eigene CSP: nur YouTube-API, -Player und -Embed, Medien über HTTPS, kein `eval`.

### Synchronisierung
- **Party-Zeit:**
  - Kotlin übergibt den rohen Link-Stand (Position, `at`, Tempo, Pause, `seq`, Quellen-Key) und den Versatz zur Serverzeit.
  - Die Seite rechnet die Party-Zeit selbst fort: `Position + (Jetzt + Versatz − at) · Tempo`.
  - Ein Stand mit anderem Key (alte Revision) wird verworfen. Ein neuer Key ersetzt den Player vollständig, und Rückrufe des alten Players werden ignoriert.
- **YouTube:** gleiche Regeln wie im Browser (`link-policy.js` = `link-sync.js`, durch einen Test abgesichert):
  - Kein Tempo-Nudging.
  - Seek ab 2 s Abweichung, bei Pause ab 0,75 s.
  - Mindestens 5 s zwischen Korrektur-Seeks, höchstens 3 pro Minute.
  - Beim Puffern und während Werbung wird nicht geseekt.
  - Bei blockiertem Autoplay startet erst der Klick auf Play.
- **MP4/WebM:**
  - Seek ab 1,5 s Abweichung, bei Pause ab 0,5 s.
  - Mindestens 3 s zwischen Korrektur-Seeks, höchstens 5 pro Minute.
  - Sanftes Nudging (±5 %) mit Hysterese 0,25 s/0,08 s wie `PartySync`.
  - Bei blockiertem Autoplay startet das Video stumm.
- **Steuerung:**
  - **Host:** Leiste, Tasten und Play/Pause im YouTube-Player setzen die Party-Zeit (`setLink`, `controlLink`). Countdown über das Party-Menü.
  - **Desktop-Gast mit Gaststeuerung:** dieselben Aktionen als vom Host eingereihte Befehle mit dem Link-Key (`commandLink`), genau wie bei Browser-Gästen.
  - **Host-only:** Eine eigene Aktion schaltet ehrlich auf „Allein“. „Zur Party“ übernimmt wieder die Party-Zeit.
- **Gäste:** Desktop-Gäste übernehmen nur Link-Stände des Hosts für die aktuelle Revision (`accept`) und Countdowns mit dem Link-Key. Der Film-Countdown und die Film-Runtime ignorieren beides.
- **Reconnect, später Beitritt:**
  - Neuer Key → neue Epoche und `state_request`.
  - Der Host beantwortet jedes `state_request` mit `shared_source` und dem Link-Stand.
- **„Alle synchronisieren“:** bleibt für den Film. Für das Video gleichen die Seiten ohnehin jede Sekunde mit der Party-Zeit ab.

### Neu bzw. geändert
- **Neu:**
  - `player-ui/link-player.html`, `link-player.js`, `link-policy.js`
  - `browser-site/tests/desktop-link-player.test.js` (Regelgleichheit, Nachrichtenprotokoll, Verdrahtung)
- **Geändert:**
  - `player_bridge.cpp` (virtueller Host, Pop-up-Sperre, Navigationsschutz)
  - `NativePlayerBridge.kt` (Assets)
  - `party.js`, `party.css`
  - `PlayerControlParty.kt`, `PlayerScreenRuntimePartyControls.kt`, `PartyRepository.kt`
  - `check-fork-invariants.sh`
- **Wichtig:** `player_bridge.cpp` hat sich geändert. Der nächste Build baut die Player-Bridge neu (`buildWindowsPlayerBridge`), dafür ist `-Pnuvio.webview2.dir=…` nötig.

### Offene Einschränkungen
- **Statusanzeige:** Desktop-Teilnehmer melden für das Video keinen eigenen Status (Puffert/Synchron) an die anderen; es gibt nur ihre lokale Anzeige. Browser-Gäste melden ihn wie bisher.
- **Herkunft für YouTube:** Ob YouTube `https://nuvio-link.example` als Herkunft akzeptiert (kein Fehler 153), lässt sich nur live prüfen. Falls nicht, wäre ein anderer virtueller Hostname der nächste Versuch.
- **Steuerung:** Die NUVIO-Zeitleiste steuert das Video nicht; dafür gibt es die eigene Leiste, die Tasten und die YouTube-Bedienelemente.
- **Bildmodi:** Bild-in-Bild und Vollbild des YouTube-Players innerhalb von WebView2 sind live zu prüfen.
