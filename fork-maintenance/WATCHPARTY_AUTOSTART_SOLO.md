# Browser: automatischer Start und „Allein schauen“

Branch `feature/party-premium-ui`, Basis `dce0c0e7`. Lokal, nicht committet. Kein Build. Nur die Browserseite ist betroffen; Desktop, Abgleichsregeln (`applySync`) und das Befehlsprotokoll sind unverändert.

## Automatischer Start

- Der Ablauf ist unverändert: Host-Quelle → `startStream` → `loadedmetadata` → `resyncNow` → `applySync(true)` → `play()`.
- Neu ist der Zustand `autoStart` mit diesen Stufen:
  - `loaded`: Quelle geladen
  - `synced`: Party-Position übernommen; der Host hat pausiert
  - `playing`: Wiedergabe läuft
  - `muted`: ohne Ton gestartet, weil die Autoplay-Regel greift
  - `blocked`: auch der stumme Start ist blockiert
- Die Stufen sind in der Debug-Ansicht sichtbar, ebenso `awaitingPartyState` und `soloMode`.
- **Quelle vor dem ersten Party-Zustand:** Statt „Noch kein Playback-Zustand“ heißt es jetzt „Warte auf die Party-Zeit des Hosts …“. Der Start läuft automatisch weiter, sobald der Zustand eintrifft.
- **Blockiertes Autoplay:** Der Player versucht einmal einen stummen Start. Klappt das, erscheint „Stumm gestartet … Tippe auf 🔊“; die Synchronisierung bleibt aktiv. Ist auch der stumme Start blockiert, gilt die bisherige Meldung mit manuellem Neuversuch.
- **Meldung nach dem Laden:** Bei automatischem Start „Quelle geladen. Party-Zeit wird übernommen …“ statt der Klick-Aufforderung.

## „Allein schauen“ / „Zur Party“

- Der Button sitzt in der Steuerleiste und ist nur aktiv, wenn eine Quelle geladen ist. Der Hinweis zeigt „Allein“.
- Die Mitgliedschaft und die Quelle bleiben bestehen, die Wiedergabe läuft lokal weiter. Presence meldet `behind`; darauf wartet der Desktop-Koordinator nicht.
- **Nichts wird gesendet:** `sendControl` sendet nicht im Solo-Modus. `seekTo` steuert die Party nur noch, wenn der Player synchron ist. Das schließt auch die bisherige Lücke, dass ±10 s und die Zeitleiste ohne Synchronisierung trotzdem einen Befehl schickten.
- **Eingehende Party-Zustände** ändern den Player nicht, weil `syncEnabled` aus ist.
- Play spielt lokal und holt nicht automatisch in die Party zurück.
- Ein Realtime-Verlust pausiert nicht, und nach dem Reconnect gibt es keinen automatischen Wiedereinstieg.
- Eine erneuerte Host-Quelle läuft an derselben Stelle lokal weiter.
- Ein Filmwechsel beendet den Modus. Ein Widerruf der Freigabe stoppt weiterhin sofort.
- **„Zur Party“** und auch der Refresh-Button beenden den Modus und übernehmen die aktuelle Party-Zeit (`resyncNow`).

## Dateien

- `browser-site/src/main.js`
- `browser-site/index.html` (Button `#ctlSolo`)
- `browser-site/src/style.css`
- `browser-site/tests/personal-hls-integration.test.js` (7 neue Tests)

## Tests (lokal ausführen)

```powershell
Set-Location 'C:\Users\Alanp\Desktop\Chatgpt\Codex\Nuvio-Watch\NuvioDesktop\browser-site'; npm.cmd test
```

Abgedeckt:
- Start ohne Klick
- stummer Start bei blockiertem Autoplay und Einschalten des Tons
- Autoplay auch stumm blockiert, danach manueller Neuversuch
- Quelle vor dem ersten Party-Zustand
- Solo: keine Befehle, keine Fremdeingriffe, Presence `behind`
- Solo bei Realtime-Verlust und Rückkehr zur Party-Zeit
- Solo bei erneuerter Quelle und bei Filmwechsel

Nicht live getestet: echtes Autoplay-Verhalten von Chrome, Safari (iOS) und Firefox.

## Nächster Schritt

Für den Live-Test reicht ein neues Preview-Deployment; ein neuer MSI ist nicht nötig, weil der Desktop unverändert ist.

## Testergebnis (03.11.2026, lokal)

- Browser `npm test`: 167/167 bestanden (7 neue Tests).
- Fork-Invarianten: OK.
- Nicht live getestet.
