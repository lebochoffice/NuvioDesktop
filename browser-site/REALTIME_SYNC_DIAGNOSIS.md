# TorBox-HLS: Realtime-Diagnose und Synchronisierung

Branch: `feature/torbox-hls-mvp`, bestehender Worktree. Kein Test, Build, lokaler Server, Commit, Push, Merge oder Deployment wurde durch den Agenten gestartet. Der Nutzer hat Bild und Ton der persönlichen TorBox-Quelle bestätigt. Das bestätigt weder den Empfang von Playback-Broadcasts noch die Korrektheit dieser neuen Änderungen im echten Browser.

## Wahrscheinlichste Ursache, noch ohne Live-Nachweis

Ein alter pausierter Host-Zustand bleibt im Browser aktiv, wenn neuere Realtime-Zustände fehlen oder verworfen werden. `applySync()` richtet das Video jede Sekunde wieder nach diesem Zustand aus. Ein lokales Browser-Play ist im synchronisierten Modus kein Host-Play. Der Browser darf einen tatsächlich pausierten Host nicht eigenmächtig ignorieren.

Die beobachteten langen Verzögerungen passen zum 45-Sekunden-RPC-Fallback des Browsers. Eine Aktion kann je nach Phase beispielsweise erst nach 30 Sekunden sichtbar werden. Der Desktop speichert seinen neuen Zustand zusätzlich erst nach 1,5 Sekunden; ein früher RPC kann deshalb noch den vorherigen Zustand liefern. Die konkreten Ursachen fehlender Broadcasts sind ohne Messung nicht bewiesen. Dass der Host eine offizielle App verwendet, beweist allein keine Inkompatibilität. Der lokale Dev-Quellcode ist kein Nachweis über deren installierte Version.

## Codebelege zur Kette

1. `features/player/PlayerScreenRuntimeGestureActions.kt`: Play/Pause setzt `shouldPlay`, steuert den Player und ruft `publishPartyPlayback()` auf. Seek-Aktionen veröffentlichen ebenfalls ihren Zielzeitpunkt.
2. `features/player/PlayerScreenRuntimeParty.kt`, `publishPartyPlayback()`: Übergibt `paused = !shouldPlay`, Position und Rate an `PartyRepository.publishPlayback()`.
3. `features/party/PartyRepository.kt`, `publish()` / `nextPlayback()`: Erhöht `seq`, ergänzt Mitglied/Medienkennung und sendet sofort `channel.send("state", ...)`. `schedulePersist()` speichert nach `PERSIST_DELAY = 1.5.seconds`. Der Empfänger darf daher Snapshot-Ankunftszeit nicht als Playback-Reihenfolge behandeln.
4. `features/party/PartyChannel.kt`: Privater Kanal `watch-party:<partyId>`, Broadcast-Ereignis `state`. `send()` kehrt bei nicht abonniertem Kanal ohne Versand zurück. Sendefehler werden im Repository mit `runCatching` behandelt. Aus dem Quellcode folgt somit keine Zustellgarantie für eine installierte App.
5. `src/session.js`: Derselbe private Kanal, angemeldetes JWT, `receive('state')` → `acceptPlayback()`. `validPlayback`, Host-/Medienprüfung und Sequenzvergleich bleiben erhalten. Ein verspäteter Snapshot mit gleicher oder niedrigerer Ordnung darf einen neueren Broadcast nicht überschreiben. Ein wirklich neuerer pausierter Zustand bleibt gültig.
6. `src/protocol.js`: `isNewerPlayback()` verwendet wie `PartySync.isNewer()` Sequenznummer und bei Gleichstand Mitgliedskennung. `expectedPositionMs()` rechnet die Position eines laufenden Hosts gegen die Serverzeit fort.
7. `src/main.js`: Der akzeptierte Playback-Callback führt `applySync()` sofort aus, zusätzlich existiert der Ein-Sekunden-Abgleich. Die persönliche HLS-Quelle verwendet denselben Player und denselben Playback-Zustand, keine eigene Party-Zeitachse.

Kotlin-Pfade beziehen sich auf `composeApp/src/commonMain/kotlin/com/nuvio/app/`. Die Desktop-Dateien wurden für diesen Auftrag nur gelesen, nicht verändert.

## Bestätigte Browser-Probleme und Änderungen

- **Presence-Rückkopplung:** Bisher reichten ein offenes Play-Promise oder ein Seek für `buffering`. Der Desktop-Koordinator wertet `loading`/`buffering` derselben Medienkennung als wartende Mitglieder und kann die gesamte Party pausieren (`PartySync.waitingMemberIds`, `PartyRepository.coordinatorLoop`). Dort gelten drei Sekunden Resume-Schonzeit, ein 0,5-Sekunden-Tick und 15 Sekunden Warteobergrenze. Jetzt zählt tatsächliches Buffering bzw. fehlende Suchbarkeit, wie beim Desktop erst nach einer Sekunde. Kurze Start-/Seek-Aufträge allein melden keinen Pufferstillstand. Statuswechsel werden gesendet; unveränderte Statuswerte werden nicht jede Sekunde erneut übertragen.
- **Seek-Verzögerung:** Ein alter Buffering-Zustand blockierte neue Seeks; `seeked` startete keinen unmittelbaren Abgleich. Nun wird der neueste Host-Zustand nach Abschluss des nativen Seeks sofort angewendet, auch wenn das alte Ziel noch puffert. Bei abgeschlossener nativer Suche entfällt unnötiges Warten auf die Fünf-Sekunden-Grenze. Derselbe Zustand erzeugt beim Buffering weiterhin keine Seek-Schleife. Ein neuer Host-Befehl darf die alte Pufferposition verlassen.
- **Pause-Verzögerung:** Host-Pause wird vor Metadaten-/Suchbarkeitsprüfungen angewendet. Sie muss nicht auf `canplay` oder einen neuen Suchbereich warten. `playing`/`canplay` stoßen den Abgleich sofort an.
- **Interne Events:** Eigene Pause-Aufträge werden über erwartete Pause-Ereignisse statt nur über ein Ein-Sekunden-Fenster erkannt. Im persönlichen HLS-Modus sind Seeking-Ereignisse ohne Bediengeste kein Beweis für manuelles Spulen; so werden auch nicht ausdrücklich gemeldete HLS-Gap-Sprünge berücksichtigt. Maus-/Touch-Gesten und passende native Tasten markieren manuelle Steuerung. Normales manuelles Spulen schaltet den Sync weiterhin ab. Diese Erkennung muss besonders mit nativen Browserkontrollen, Tastatur und Zugänglichkeitshilfen praktisch geprüft werden.
- **Veralteter Zustand sichtbar:** Der Synchronisieren-Klick fordert zusätzlich einen aktuellen Zustand beim Host an. Wenn der empfangene Zustand pausiert ist, zeigt die Oberfläche dies ausdrücklich. Er wird nicht als vermeintlicher Wiedergabefehler übergangen.
- **Diagnose:** Jeder State-Eingang erhält Quelle, Zeit und feste Annahme-/Ablehnungsgründe. Realtime-Fehlertexte enthalten keine rohen SDK-Ausnahmen. Playback-Fehler bleiben feste Codes/Meldungen. Die 45-Sekunden-Heartbeat-Abfrage bleibt als Fallback unverändert.

Die bisherige TorBox-URL-Verarbeitung, privaten Kanäle, Anmeldung, Chat und Medien-/Mitgliedschaftsprüfungen bleiben bestehen. Die persönliche URL wird weder in Diagnosefelder noch in Party-Nachrichten übernommen.

## Diagnose lokal einschalten

Auf der Browser-Party-Seite in den Entwicklerwerkzeugen **nur diesen festen Ausdruck** ausführen:

```javascript
sessionStorage.setItem('nuvio-party-debug', '1');
location.reload();
```

Danach der Party beitreten, persönliche URL ausschließlich im HLS-Eingabefeld laden und unter dem Playerbereich **Lokale Sync-Diagnose** ausklappen. Das Flag gilt nur für diesen Browser-Tab/Ursprung, ändert keinen Server und aktiviert keine Veröffentlichung. Im sessionStorage steht nur dieses Flag; Diagnosewerte bleiben im Arbeitsspeicher/DOM. Auth-/Gerätespeicherung bleibt wie bisher.

Angezeigt werden Verbindungsstatus, Zahl der State-Eingänge, letzte Realtime-/Annahmezeit (Unix-Millisekunden), letzte Ereignisquelle und Entscheidung, Kandidaten-/akzeptierte Sequenz, Host paused/waiting, errechnete Host-Position, Browser-Position und Differenz in Sekunden, Sync aktiv, Buffering, Seeking, ausstehender Play-Auftrag und letzter fester Playback-Fehlercode. Zähler gelten seit Laden dieses Tabs. Es gibt keine Rohpayloads, Mitgliedskennungen, Medienkennungen, URLs, Header, Token, Netzwerkprotokolle oder Analytics.

Zum Ausschalten:

```javascript
sessionStorage.removeItem('nuvio-party-debug');
location.reload();
```

## Beobachtungen richtig einordnen

| Befund bei Desktop-Play/Pause/Seek | Bedeutung / nächster Schritt |
| --- | --- |
| Nicht `SUBSCRIBED` | Privater Kanal nicht verbunden. Gleiche Backend-Konfiguration, gültige Anmeldung, Browser-Netzwerk und Backend-Freigabe prüfen. RPC-Beitritt allein genügt nicht. |
| `SUBSCRIBED`, Realtime-Zähler wächst bei Host-Aktionen nicht | Keine State-Events erreichen den Browser-Handler. Aktuell verwendete Desktop-Version/Verbindung und Broadcast-Zustellung untersuchen; die Anzeige erfindet keinen fehlenden Host-Zustand. |
| Neue Sequenzen nur mit `acceptedSource: snapshot` | Der Fallback liefert Zustände, unmittelbare Realtime-Zustellung fehlt oder wird verworfen. Nicht durch kürzeres Polling als gelöst deklarieren. |
| `lastDecision: invalid_playback` | Wire-Daten erfüllen den bestehenden Vertrag nicht. Nicht blind Zeichenketten in Zahlen/Booleans umwandeln. Installierte Version auf Kompatibilität prüfen. |
| `wrong_media` / `not_host` | Zustand passt nicht zum autoritativen Party-Snapshot. Medien-/Hostwechsel prüfen; Sicherheitsprüfung nicht entfernen. |
| `not_newer` nach einem Snapshot | Bei schon neuerem Realtime-Zustand korrekt. `acceptedSource` und `playbackSeq` zeigen den weiterhin aktiven Zustand. |
| Neue akzeptierte Sequenz mit `hostPaused: true`, `hostWaiting: true` | Der Host/Koordinator meldet eine Wartepause. Das ist keine lokale Browser-Autoplay-Pause; andere wartende Mitglieder und anhaltendes Buffering prüfen. |
| `hostPaused: false`, `syncActive: false`, `NotAllowedError` | Autoplay gesperrt. Synchronisieren ausdrücklich anklicken; nicht automatisch die Nutzerfreigabe umgehen. |
| `hostPaused: false`, Sync aktiv, Seeking/Buffering anhaltend | Native Medienpipeline lädt/sucht noch. Tatsächliche Stream-/Seek-Probleme untersuchen; funktionierender Realtime-Empfang bestätigt keinen erfolgreichen Seek. |

## Regressionen und manuelle Befehle

Ergänzt, **nicht ausgeführt**: State-Broadcast über den tatsächlichen Session-Handler; verzögerter älterer Snapshot nach Realtime-Play; neuerer Snapshot als Fallback; Ablehnungsgründe ohne Rohdaten; unmittelbares Host-Play/Pause im HLS-Player; Seek während altem Buffering ohne wiederholte Korrektur; Schonzeit bei kurzen Ladephasen; stille HLS-Seeks und verspätete Pause-Events; Opt-in und Geheimnisfreiheit der Diagnose.

```powershell
Set-Location 'C:\Users\Alanp\Desktop\Chatgpt\Codex\Nuvio-Watch\NuvioDesktop\browser-site'
node --test tests/session.test.js tests/personal-hls-integration.test.js tests/personal-hls.test.js
npm test
```

Optional, falls Playwright/Chromium bereits eingerichtet sind (synthetische Quellen, startet einen lokalen Vite-Server):

```powershell
node checks/browser-smoke.mjs
```

Danach einen separat bereitgestellten Stand mit diesen Änderungen verwenden (dieser Auftrag hat nichts deployed). Alternativ später selbst `npm run dev` starten. Mit aktiver Diagnose Play/Pause sowie kurze, lange und schnelle aufeinanderfolgende Seeks am Desktop durchführen. Bei jeder Aktion Realtime-Zähler, akzeptierte Sequenz, Quelle und Host-Pause vergleichen. Nach wenigen Sekunden die tatsächliche Browserposition/Bild/Ton kontrollieren. Ebenso eine Pufferlücke und manuelles Spulen per Maus/Touch/Tastatur prüfen. Bei Host-Pause während Buffering muss das Video sofort pausieren; nach Host-Play muss es ohne wiederholte Suchaufträge anlaufen, soweit Quelle und Autoplay-Regeln dies erlauben.

Nur den Text der lokalen Diagnose bei Bedarf weitergeben. Keine HAR-Dateien, Konsole mit Netzwerkfehlern, vollständigen Seiten-Dumps oder Screenshots mit HLS-Eingaben veröffentlichen. Ohne diesen neuen echten Lauf sind Broadcast-Empfang der installierten offiziellen App und erfolgreiche Synchronisierung weiterhin offen.
