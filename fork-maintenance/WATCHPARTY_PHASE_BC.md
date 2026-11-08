# Watch Party Phase B (gemeinsamer Countdown) und Phase C (Intelligente Wiedergabe)

Lokal, nicht committet. Kein MSI. Nicht live getestet.

**Unverändert:** Sync-Algorithmus, Command-ID/ACK, exakter Seek, Drift-Korrektur, Player-Bridge, Play/Pause-Protokoll. Phase C ändert das Verhalten nur, wenn der Expertenschalter bewusst ausgeschaltet wird.

## Phase B: Gemeinsamer Countdown

- **Host, solange die Party pausiert ist:** „Gemeinsam starten“ unter dem Sync-Button, Länge 1–10 s (− / +), Standard 3 s.
  - Die Bereitschaft stammt aus den echten Statusberichten: „Alle bereit“ oder „Wartet auf: Niki“.
  - Offline-Mitglieder und solche, die allein schauen, blockieren nicht. Der Button heißt dann „Trotzdem starten“.
- **Ablauf:**
  - Der Host sendet das neue, optionale Realtime-Ereignis `countdown` mit `start_at` in **Server-Zeit** (Party-Uhr). Geräteuhren müssen also nicht gleich gehen.
  - Alle zeigen „Start in 3 … 2 … 1“ (Desktop als Hinweis, Browser in der Statuszeile).
  - Zum Startzeitpunkt startet **nur der Host**, über den bestehenden Play-Weg (`setPlaybackPlaying`). Alle folgen dem autoritativen Party-Stand wie bisher.
  - Gäste starten nicht selbst. Deshalb gibt es keinen Konflikt mit dem Sync-Loop.
- **Abbruch:** „Abbrechen“ (Host), ein Play/Pause vor dem Start, ein Titelwechsel, ein Host-Wechsel oder das Party-Ende.
- **Geprüft wird** (`partyCountdownFrom`): nur Ereignisse des aktuellen Hosts, nur für den aktuellen Titel, Länge 1–10 s, Startzeit nahe jetzt. Wie bei allen Realtime-Ereignissen prüft der Server den Absender nicht. Ein gefälschter Countdown könnte aber nur eine Anzeige auslösen, keinen Start.
- **Grenze:** Gäste starten mit der Netzwerklatenz des Play-Ereignisses (typisch 0,1–0,3 s). Die bestehende Drift-Korrektur gleicht das aus.

## Phase C: Intelligente Wiedergabe

- **Aufruf:** Link „Intelligente Wiedergabe“ unter dem Sync-Button. Er öffnet eine eigene Ansicht im Party-Reiter mit „Zurück zur Party“.
- **Automatik (nur Anzeige):**
  - eigener Status, Tempo-Korrektur aktiv / bereit / aus
  - Anzahl der Seek- und Tempo-Korrekturen, Puffer-Ereignisse, gelernter Seek-Vorlauf, letzte Korrektur
  - für Gäste „Neu synchronisieren“ (= „Mich synchronisieren“)
  - Die Werte kommen aus Zählern im bestehenden Sync-Loop und steuern nichts.
- **Experte:** Schalter „Mini-Korrekturen per Tempo“, standardmäßig **an**, also unverändert. Aus heißt: Abweichungen unter der Seek-Schwelle von 1,5 s werden nicht per Tempo ausgeglichen, größere weiter per Seek. Die Einstellung gilt für die laufende Sitzung.
- **Nicht umgesetzt:** eine Anzeige der Browser-Gäste in dieser Ansicht. Der Browser hat dafür seine eigene, optionale Diagnose. Weitere Expertenoptionen (z. B. Schwellen) bewusst nicht, um die Sync-Architektur nicht umzubauen.

## Geänderte Dateien

- **Desktop:**
  - neu: `party/PartyCountdown.kt`
  - `PartyRepository.kt` (Ereignis, Start, Abbruch), `PartyChannel.kt`
  - `PartySync.kt` (`allowNudge`, Standard an)
  - `PlayerScreenRuntimeParty.kt` (Countdown-Ablauf, Zähler)
  - `PlayerScreenRuntimeState.kt`, `PlayerControlParty.kt`, `PlayerScreenRuntimePartyControls.kt`
  - `party.js`, `party.css`
- **Browser:** `session.js` (Ereignis `countdown` nur vom Host), `main.js` (Anzeige)
- **Tests:**
  - neu: `PartyCountdownTest.kt` (Prüfung des Ereignisses, Expertenschalter)
  - `personal-hls-integration.test.js` (Anzeige in Server-Zeit, kein eigener Start, Abbruch, ungültige Ereignisse)

## Testbefehle

```powershell
Set-Location 'C:\Users\Alanp\Desktop\Chatgpt\Codex\Nuvio-Watch\NuvioDesktop\browser-site'; npm.cmd test
Set-Location 'C:\Users\Alanp\Desktop\Chatgpt\Codex\Nuvio-Watch\NuvioDesktop'; $env:JAVA_HOME='C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot'; .\gradlew.bat :composeApp:desktopTest --tests '*Party*Test' --tests '*MemberSync*' --tests '*PausedPosition*' --tests '*NativePlayerExactSeek*' --tests '*Torbox*Test' --tests '*PartyHostHls*' --tests '*PartyFamilyShare*' --no-configuration-cache --console=plain
```

## Testergebnis (04.11.2026, lokal)

- Browser `npm test`: 220/220 bestanden. Log: `fork-maintenance/local/browser-tests-phase-bc.log`.
- Desktop: 162/162 bestanden, darunter `PartyCountdownTest` 2/2. Log: `fork-maintenance/local/desktop-tests-phase-bc.log`.
- Fork-Invarianten: OK.
