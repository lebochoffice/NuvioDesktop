# Mobile-Synchronisierung und Browser-Steuerung

Branch `feature/party-mobile-sync-control`, abgezweigt von `feature/torbox-hls-mvp` (`ca86fc4b`, PR #2 noch offen). Nur Browser-Code (`browser-site/`) geändert. Desktop-Originalstream, Kotlin-Code und `party.js` sind unverändert. Browser-Testsuite lokal ausgeführt (Node 24.19.0, `node --test`): 89/89 bestanden. Nicht ausgeführt: Vite-Build, Playwright-Smoke-Test, Live-Tests auf Smartphones bzw. Cloudflare-Preview.

## Ursachen

**Bestätigt (aus dem Code abgeleitet):**

1. **Party-weite Pausen durch kurze Stalls.** Der Browser meldete `buffering` bereits nach 1 s `waiting`. Der Desktop-Koordinator (`PartyRepository.coordinatorLoop`, Takt 0,5 s, `RESUME_GRACE` 3 s, `WAIT_LIMIT` 15 s) pausiert dann **alle** mit `waiting=true`. Über Mobilfunk führen häufige Kurz-Stalls so zu wiederholten Party-Stopps und anschließendem Nachlaufen.
2. **Seek-Verfolgung nach dem Puffern.** Nach einem Stall von z. B. 2 s lag der Gast > 1,5 s zurück und sprang exakt auf die Host-Zeit, also wieder in einen ungepufferten Bereich. Der neue Segmentdownload kostet erneut Zeit, sodass der Gast systematisch hinterherläuft (typisch 1–2 s im WLAN, mehr über Mobilfunk).
3. **Rate-Flattern.** Die Rate-Korrektur hatte keine Hysterese (an bei > 0,25 s, sofort aus darunter). Um 0,25 s herum wechselte `playbackRate` jede Sekunde zwischen 1,0 und 1,05; auf mobilen Geräten hörbar/sichtbar als Ruckeln.
4. **Unbegrenzter Back-Buffer** (hls.js-Default `Infinity`) kann auf Mobilgeräten SourceBuffer-Quoten auslösen; Eviction führt zu zusätzlichen Stalls.

**Plausibel, nicht ohne Live-Messung bestätigt:** TorBox-Segmentladezeiten über Mobilfunk nahe oder über der Segmentdauer; Realtime-Latenz des Gateways über Mobilfunk; iOS-Safari-Stalls ohne `waiting`-Event; Uhrversatz der Clock-Synchronisierung. Die neue Diagnose trennt diese Ursachen (siehe unten).

**TorBox-Qualitätsstufen:** Der Desktop ruft `createstream` ohne `chosen_resolution_index` auf; TorBox erzeugt pro Session eine Transcoding-Ausgabe. Ob die gelieferte Playlist mehrere Varianten enthält, ließ sich ohne echten Link nicht prüfen. Daher wird eine Auswahl **nur** angezeigt, wenn hls.js tatsächlich ≥ 2 unterschiedliche Auflösungen meldet; sonst bleibt sie verborgen.

## Implementierte Optimierungen (`src/sync-policy.js`, `src/main.js`)

- **Buffering-Hysterese:** `buffering` erst nach 2,5 s ununterbrochenem Stall; zurück zu `ready` erst nach 0,75 s stabiler Wiedergabe.
- **Fairness-Budget:** Pro Browser-Gast höchstens 2 party-weite Wartevorgänge je 120 s. Danach meldet er `behind` (der Koordinator wartet darauf nicht) und holt allein auf. Die bestehende Desktop-Regel (`WAIT_LIMIT`, `ignoredWaiting`) bleibt unverändert.
- **Intelligentes Nachholen:** Liegt das Ziel im Puffer, wird exakt gesprungen. Ist es ungepuffert, wird um die **gemessene** Erholungszeit (EWMA, max. 3 s) vorausgesprungen, sodass der Gast nach dem Download synchron ankommt.
- **Keine Seek-Kaskaden:** Für denselben Party-Befehl kein erneuter Seek, solange gepuffert wird oder ein Seek noch nicht abgeschlossen ist (bis `seeked`/`canplay`/`playing` oder 4 s Cooldown). Neue Host-Befehle werden wie bisher sofort bzw. nach `seeked` übernommen.
- **Rate-Hysterese wie Desktop** (`PartySync`: Start 250 ms, Stop 80 ms, ±5 %), kein Nudging während Stall/Seek, `playbackRate` wird nur bei Änderung gesetzt.
- **Realtime-Play/Pause** wird weiterhin sofort angewendet (`acceptPlayback` → `applySync`, Pause ohne Warten auf Metadaten/Puffer).
- **hls.js-Tuning** für Desktop-Freigabe und persönliches HLS: `backBufferLength: 30`, `maxMaxBufferLength: 120`, `startFragPrefetch: true`. ABR und Vorwärtspuffer bleiben auf Default, also keine Qualitätsbegrenzung für schnelle Desktop-Browser.
- **Qualitätsauswahl** Auto/720p/1080p/4K (bzw. tatsächliche Höhe) nur für echte Varianten. Der Wechsel erfolgt über `hls.loadLevel` am nächsten Fragment, ohne Pufferleerung. iOS-natives HLS und progressive Quellen zeigen keine Auswahl.
- **iOS Safari:** natives HLS bleibt für Desktop-Freigaben ohne Header aktiv; Seek-Vorlauf und Hysterese gelten ebenso. **Android/Chrome:** hls.js mit Tuning.

## Lokaler Diagnosemodus

Aktivierung wie bisher lokal: `sessionStorage.setItem('nuvio-party-debug', '1')`, danach neu laden. Neue Felder, ausschließlich Zahlen und feste Bezeichner:

`playbackMode`, `videoWidth`/`videoHeight`, `bandwidthKbps` (hls.js-Schätzung), `qualityVariants`, `bufferAheadSeconds`, `lastSegmentLoadMs`/`lastSegmentDurationSeconds`, `realtimeLatencyMs` (Server-Zeit Senden→Empfang, inkl. Uhrfehler), `driftSeconds`, `bufferingEvents`, `stallsSinceLoad`, `partyWaitsInWindow`, `selfCatchUp`, `seekLeadSeconds`, `rateNudging`, `playbackRate`, `guestControl`, `commandPending`, `commandsSent`, `lastCommandResult`.

**Interpretation:** Hohe `realtimeLatencyMs` bei kleinem `bufferAheadSeconds`-Einbruch deutet auf Netzwerk-/Gateway-Latenz hin. Ist `lastSegmentLoadMs` ≥ Segmentdauer × 1000 und gibt es häufige `bufferingEvents`, reicht die Bandbreite nicht für die gelieferte Variante.

## Browser-Steuerung

**Weg:** derselbe Nuvio-Befehl wie bei Desktop-Gästen (`watch_party_update` + `state`-Broadcast), aber strenger:

1. Nur wenn der **autoritative DB-Snapshot** (Join/Heartbeat) `host_only=false` meldet, ein Realtime-Kanal besteht und der Browser nicht Host ist. Ein Broadcast kann diese Berechtigung nicht erteilen.
2. Nur echte Bediengesten (Pointer/Tastatur am Video) erzeugen Befehle. Eigene programmatische Pausen, Seeks und `play()`-Versuche sowie hls.js-interne Sprünge werden nie als Befehl gesendet, daher keine Endlosschleifen.
3. **Zuerst persistieren:** `watch_party_update` läuft unter dem Supabase-JWT des Gastes mit `p_device_id`. Gesendet wird `seq = aktuell + 1`, die eigene `member_id` aus dem Join-Snapshot, die aktuelle `media_key`, `waiting=false`.
4. **Nur bestätigte Zustände verteilen:** Der `state`-Broadcast wird nur gesendet, wenn die Server-Antwort `host_only=false`, dieselbe Medienkennung und genau diese `seq`, `member_id` und `paused` zurückgibt. Ablehnung, Fehler, fremde/ältere Werte oder ein inzwischen aktiviertes Host-only führen zu keinem Broadcast; der Party-Zustand wird wiederhergestellt.
5. **Gleichzeitige Befehle:** wie `PartySync.isNewer`: höhere `seq`, bei Gleichstand höhere `member_id`. Ein eigener ausstehender Befehl wird nur optimistisch befolgt, solange kein neuerer Party-Zustand vorliegt. Weitere Gesten während eines laufenden Befehls werden zum letzten zusammengefasst.
6. **Veraltete Snapshots** können neuere Befehle nicht überschreiben (Ordnung in `acceptPlayback`).
7. **Host-only:** Gesten trennen wie bisher nur lokal von der Party-Zeit; keine RPC, kein Broadcast. Host deaktiviert die Gaststeuerung über den vorhandenen Desktop-Schalter (`watch_party_set_host_only` + `control` → Browser lädt den Snapshot neu).
8. **Session-Ende/Entfernung:** Ein ausstehender Befehl wird nach `close()` verworfen und nie verteilt.

Desktop-Empfänger übernehmen solche Befehle bereits heute (`PartyRepository.accept`: bei `host_only=false` jedes Mitglied, Ordnung nach `isNewer`). Es ist **keine Desktop-Änderung** nötig.

## Backend-Berechtigungsstatus

**Nicht verifizierbar:** Die SQL-Definition von `watch_party_update` liegt nicht in diesem Repository (offizielles Nuvio-Backend). Belegt ist nur: Der Aufruf läuft authentifiziert (JWT + Gerätekennung) und gibt einen Snapshot zurück. Ob der Server `host_only`, die Mitgliedschaft, die Übereinstimmung von `member_id` mit dem Aufrufer und die Sequenzordnung erzwingt, ist **nicht belegt**.

Die Browser-Implementierung verlässt sich deshalb nicht darauf: Sie sendet bei `host_only=true` nie, und ohne exakte Server-Bestätigung verteilt sie nichts. **Bestehende Restschwäche (auch bei Desktop-Gästen):** Realtime-`state`-Broadcasts tragen eine vom Absender gesetzte `member_id`. Ein Party-Mitglied könnte bei `host_only=true` einen Broadcast mit der Host-ID fälschen. Das lässt sich clientseitig nicht beheben.

**Erforderliche Backend-Erweiterung (exakt):**

1. `watch_party_update(p_party_id, p_device_id, p_media, p_playback)`:
   - Aufrufer über `auth.uid()` + `p_device_id` auf eine aktive, nicht entfernte Mitgliedschaft der Party auflösen, sonst `not_member`.
   - `p_playback.member_id` muss dieser Mitglieds-ID entsprechen, sonst `forbidden`.
   - `host_only=true` und Aufrufer ≠ Host → `host_only`. `p_media` nur vom Host.
   - Nur speichern, wenn neuer als der gespeicherte Zustand (`seq` größer, oder gleich und `member_id` größer); sonst unveränderten Snapshot zurückgeben.
   - `p_playback.media_key` muss der aktuellen Medienkennung entsprechen.
2. **Server-seitiger Broadcast:** `AFTER UPDATE OF playback` → `realtime.send(playback, 'state', 'watch-party:' || id, true)`.
3. **Realtime Authorization** auf `realtime.messages`: Clients dürfen auf `watch-party:*` keine Nachrichten mit `event = 'state'` senden, nur Mitglieder dürfen den Kanal abonnieren.
4. Danach Desktop und Browser so anpassen, dass sie `state` nur aus Server-Herkunft akzeptieren. Das erfordert ein neues MSI und ist bewusst **nicht** Teil dieser Änderung.

## Geänderte Dateien

- `browser-site/src/sync-policy.js` (neu): Schwellen, Seek-Ziel/-Vorlauf, Stall-Hysterese/Fairness, Qualitätsoptionen, hls.js-Tuning.
- `browser-site/src/main.js`: Sync-Integration, Qualitätsauswahl, Gaststeuerung, Diagnose.
- `browser-site/src/session.js`: `canControl`, `prepareControl`, `commitControl`, Realtime-Latenz.
- `browser-site/src/personal-hls.js`: Tuning, `onInstance`-Hook (ohne URL).
- `browser-site/index.html`: Qualitätsauswahl, Steuerungshinweis.
- Tests: `tests/sync-policy.test.js` (neu, 7), `tests/session.test.js` (+4), `tests/personal-hls-integration.test.js` (+11, 2 an die neue Hysterese angepasst, Harness erweitert).

## Manuelle Tests

```powershell
Set-Location 'C:\Users\Alanp\Desktop\Chatgpt\Codex\Nuvio-Watch\NuvioDesktop\browser-site'
node --test tests/sync-policy.test.js tests/session.test.js tests/personal-hls-integration.test.js
npm.cmd test
npm.cmd run build
```

Live mit MSI 0.1.36 und Cloudflare-Preview:

1. Smartphone im WLAN, dann über Mobilfunk, Diagnose aktiv: `driftSeconds` im Lauf < 0,3 s, `partyWaitsInWindow` ≤ 2, keine Party-Pausen bei kurzen Stalls.
2. Host springt weit in ungepufferte Bereiche: Der Gast landet nach dem Laden synchron (`seekLeadSeconds` > 0), ohne Sprungkaskade.
3. Host-only **aus**: Browser-Pause/-Play/-Sprung steuert Desktop-Host und weitere Gäste; Host-only **an**: Browser-Gesten wirken nur lokal.
4. Zwei Gäste lösen gleichzeitig Befehle aus: Alle Geräte landen im selben Zustand.
5. Qualitätsauswahl erscheint nur bei echter Mehrfach-Variante; TorBox-Ergebnis dokumentieren.
6. iPhone Safari (natives HLS) und Android Chrome (hls.js) getrennt prüfen.

## Cloudflare und MSI

Alle Änderungen betreffen **nur die Browser-Seite (Cloudflare Pages)**. **Kein neuer MSI erforderlich:** Desktop-Protokoll, Originalstream, Koordinator und `party.js` sind unverändert, und Desktop-Empfänger verarbeiten Gastbefehle bereits. Ein MSI wird erst für die optionale Server-Herkunftsprüfung (Backend-Erweiterung, Punkt 4) nötig.
