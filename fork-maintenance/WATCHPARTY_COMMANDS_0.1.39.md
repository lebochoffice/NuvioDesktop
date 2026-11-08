# 0.1.39-watchparty: Browsersteuerung mit Command-ID und Bestätigung

Branch `feature/party-premium-ui`, lokal und nicht committet (03.11.2026). Tests am 03.11.2026 lokal ausgeführt (Ergebnis unten). Kein MSI-Build, kein Deployment. MSI 0.1.38 bleibt unverändert.

## Ursache

1. **Jeder steuernde Teilnehmer vergab Revisionen selbst.** Browser und Desktop rechneten `seq = aktuell + 1`. Bei gleichzeitigen Befehlen entstand dieselbe `seq` mehrfach. Die Auflösung über die Member-ID ist zwar überall gleich, folgt aber nicht der Absicht der Nutzer. `watch_party_update` speichert ohne nachgewiesene Reihenfolge.
2. **Echo-Pingpong am Desktop:** Bis zur tatsächlichen Umsetzung eines fremden Befehls hielt die „Outside-Toggle“-Erkennung den alten Player-Zustand für eine Nutzeraktion und veröffentlichte ihn. 0.1.37/0.1.38 haben das mit einer starren 3-s-Sperre überdeckt (`REMOTE_APPLY_GRACE`).
3. **Browser ohne verlässliche Rückmeldung:** Die Bestätigung der Realtime-Sendung sagt nichts darüber, ob der Desktop den Befehl übernommen hat.

## Architektur

- **Der Desktop-Host ist der einzige Sequencer** für Browserbefehle. Er kündigt das im Status an (`commands: 1`, nur der Fork ab 0.1.39).
- **Browser vergeben keine `seq` mehr.** Sie senden ein `command`-Event:
  - `command_id` (UUID)
  - `member_id`
  - `paused`
  - `position_ms`
  - `base_seq` (die zuletzt gesehene Revision)
  - `media_key`
  - `host_member_id`

  Das Payload enthält keine Tokens, Zugangsdaten oder Stream-URLs.
- **Epoche** = (`host_member_id`, `media_key`). Nach einem Host- oder Medienwechsel werden alte Befehle abgelehnt (`stale_epoch`). Der Browser verwirft dann alle offenen Befehle.
- **Entscheidung im Host** (`PartyCommands.decide`, Verlauf in `PartyCommandLedger`):
  - Abgelehnt werden: Host-only (`host_only`), Nicht-Mitglied laut letztem Server-Snapshot (`not_member`), falsche Epoche und ungültige ID.
  - Angenommen wird ein Befehl nur, wenn seit `base_seq` ausschließlich Revisionen dieses Gastes (schnelles Umschalten) oder Koordinator-Wartezustände entstanden sind. Sonst gilt `superseded`: Der zuerst beim Host eingetroffene Befehl gewinnt. *Nach dem Live-Test entfernt: Die Regel lehnte Befehle mit veralteter `base_seq` ab und verursachte die P0-Regression. Jetzt gilt die Ankunftsreihenfolge, siehe `WATCHPARTY_P0_AFTER_0.1.39.md`.*
- **Annahme:** Der Host veröffentlicht eine normale `state`-Revision mit seiner eigenen `seq` sowie `origin_member_id` und `command_id`. Danach sendet er `ack` mit `accepted`, `rejected` oder später `applied`.
- **Doppelte Command-ID:** Der Host antwortet mit dem gespeicherten Ergebnis und führt den Befehl nie zweimal aus (64 IDs).
- **Speicherung:** Der Host speichert wie bisher über sein eigenes, autorisiertes `watch_party_update`. Die Command-Felder sind nur Wire-Felder und werden vor dem Speichern entfernt; das Schema der Datenbankzeile bleibt also unverändert.
- **Kompatibilität:**
  - Ein Host ohne Ankündigung (offizielle App, ältere Forks) nutzt den bisherigen Weg: Desktop-Parität bzw. `confirmed`.
  - Ältere Clients ignorieren die neuen Felder (`ignoreUnknownKeys`).
  - Desktop-Gäste veröffentlichen unverändert direkt.

## Zustände im Browser

| Zustand | Bedeutung |
|---|---|
| PENDING | gesendet, lokale Vorschau aktiv |
| ACCEPTED | `ack` vom Host oder die Host-Revision mit dieser `command_id` (`member_id` = `host_member_id`) |
| APPLIED | Der Host-Player hat den Zustand erreicht. Nur Anzeige, ändert nie die Wiedergabe. |
| REJECTED | vom Host abgelehnt (Grund als feste Bezeichnung) oder lokal wegen eines Epochenwechsels |
| UNKNOWN | keine Antwort nach 4 s und einer Wiederholung mit derselben ID. Danach folgt der Server-Snapshot (`watch_party_heartbeat`), keine weiteren Wiederholungen. |

**Wichtige Grenze:** Supabase-Realtime prüft die Identitäten im Payload nicht serverseitig. ACKs werden deshalb nur vom aktuellen Host und nur für eigene Befehle angenommen und steuern ausschließlich die Anzeige. Die Wiedergabe folgt immer der geordneten Party-Revision. Gegen gefälschte Nachrichten eines Party-Mitglieds schützt das nicht vollständig. Das war mit Desktop-Gästen schon vorher so; der Stand ist nicht schlechter geworden.

## Alte Zustände

- Jede Revision läuft durch `isNewer`. Verspätete RPC-Antworten, doppelte oder ältere Broadcasts sowie Snapshots können nichts zurückdrehen.
- Die lokale Vorschau endet, sobald eine neuere Revision eines anderen Mitglieds eintrifft. Eigene frühere Befehle beenden sie nicht, damit es beim schnellen Umschalten nicht flackert.
- Nach einer Annahme ohne eintreffende Revision wird der Zustand nachgefordert. Die Vorschau endet nach 4 s.
- Nach einem Reconnect gelten `state_request` und der Heartbeat-Snapshot.

## Desktop: 3-s-Sperre entfernt

- `REMOTE_APPLY_GRACE` ist entfernt. Neu ist `awaitingApply`: Die zuletzt empfangene fremde Revision (auch eine, die der Host aus einem Gastbefehl sequenziert hat, erkannt über `actorId`) gilt als „wird umgesetzt“. Das endet ereignisbasiert durch eines dieser Ereignisse:
  - **Applied:** Wiedergabezustand erreicht, Position innerhalb von 1,5 s. Dann folgt `ack applied`.
  - **Superseded:** Eine echte lokale Aktion hat `shouldPlay` geändert. Sie wurde ohnehin direkt veröffentlicht. Dadurch wird „Desktop Play direkt nach Browser Pause“ nie zurückgedreht.
  - **Neue Revision.**
- Solange ein Befehl noch nicht erreicht ist, wird der alte Player-Zustand nie veröffentlicht. Die programmatische Umsetzung wird höchstens dreimal im Abstand von 1,2 s wiederholt. Das ist Recovery und keine Sperre: Lokale Bedienelemente veröffentlichen jederzeit sofort. Erst ein Player, der nie ankommt (z. B. ein fehlgeschlagener Start), wird danach wie jede andere Abweichung behandelt.
- Puffern (`isLoading`) zählt nie als Abweichung.

## Backend

Für eine **echte serverseitige** Serialisierung und Autorisierung wäre eine Backend-Erweiterung nötig. Sie ist nur dokumentiert, nicht umgesetzt:
- eine RPC (z. B. `watch_party_command`) mit `auth.uid()`-Mitgliedsprüfung, Host-only-Prüfung, atomarer `seq`-Vergabe (`SELECT … FOR UPDATE`) und Idempotenz über `command_id`
- Realtime-Broadcast aus der Datenbank (`realtime.send`)
- Realtime-Policies, die Clients das Senden von `state` untersagen

Ohne diese Erweiterung ist der Host-Client die zentrale Instanz.

## Dateien

- Desktop:
  - `party/PartyCommands.kt` (neu)
  - `PartyModels.kt` (`origin_member_id`, `command_id`, `actorId`, Presence `commands`)
  - `PartyRepository.kt` (`onCommand`, `ack`, `reportApplied`, Verlauf, Speichern ohne Wire-Felder, Ankündigung)
  - `PartyChannel.kt` (`command`)
  - `PartySync.kt` (`pendingApply`)
  - `PlayerScreenRuntimeParty.kt` (`awaitingApply`)
- Browser:
  - `src/session.js` (Protokoll, Zustände, Timeouts)
  - `src/main.js` (Vorschau, Senden, Texte, Debug)
- Tests:
  - `commonTest/.../PartyCommandsTest.kt` (neu)
  - `tests/session.test.js`
  - `tests/personal-hls-integration.test.js`
- Wartung:
  - `check-fork-invariants.sh`
  - `verify-msi.ps1` (prüft `PartyCommandLedger`/`PartyCommand` im JAR, Manifest `guestCommandSequencer`)
  - Doku

## Tests (lokal ausführen)

```powershell
Set-Location 'C:\Users\Alanp\Desktop\Chatgpt\Codex\Nuvio-Watch\NuvioDesktop\browser-site'
npm.cmd test
Set-Location ..
.\gradlew.bat :composeApp:desktopTest --tests '*Party*Test' --tests '*Fork*UpdateTest' --tests '*AppUpdate*Test' --tests '*UpdateChannelTest' --tests '*ReleaseSelector*' --tests '*VersionUtils*' --no-configuration-cache --console=plain
bash fork-maintenance/check-fork-invariants.sh
```

**Ergebnis vom 03.11.2026:**
- Browser: `npm test` → 145 von 145 bestanden.
  - Behoben wurde ein schon vorher bestehender Timing-Fehler im Test für Desktop-Parität: Die Test-RPC antwortete sofort, sodass der Zwischenstand `broadcast` nie zu sehen war. Er schlug auch auf `d3b76d2c` fehl; der App-Code ist unverändert.
- Desktop: CI-Auswahl → 102 von 102 bestanden, darunter `PartyCommandsTest` (13). Log: `fork-maintenance/local/desktop-party-tests-0.1.39.log`.
  - Behoben: ein Typfehler im neuen Test und ein ungültiger Testname (`;`) in `ForkUpdateTest.kt` aus 0.1.38.
  - Gefunden: Die bisherige CI-Auswahl `*Update*Test` traf auch das upstream-eigene `LinuxUpdateInstallTest`. Das läuft auf Windows nicht (3 Fehler wegen Pfadtrennern, Datei unverändert gegenüber Dev). Die Fork-Workflows hätten auf `windows-2022` deshalb immer rot gemeldet. Die Auswahl ist jetzt eingegrenzt.
- Fork-Invarianten: OK.

Abgedeckt:
- Browser Pause, Play und Seek
- Desktop Play direkt nach Browser Pause, in beiden Reihenfolgen
- schnelles Umschalten
- gleichzeitige Browserbefehle
- doppelte Command-ID
- verspätete und doppelte ACKs
- gefälschte ACKs und States
- Out-of-order-Revisionen
- Timeout mit Wiederholung derselben ID, danach UNKNOWN; Ausführung trotz Timeout
- angenommen ohne eintreffenden State
- Reconnect
- Medienwechsel und Hostwechsel
- Host-only
- HLS-Puffern und Seek-Duplikate (Ziehen nur als Vorschau)
- mehrere Browser-Gäste
- Fallback für Hosts ohne Ankündigung
- `pendingApply` (Superseded, Waiting, Seeking, Applied)
- Kompatibilität der JSON-Felder

Nicht automatisch abgedeckt: die Coroutine-Schleife im Desktop-Player selbst (nur die reine Entscheidungsfunktion ist getestet).
