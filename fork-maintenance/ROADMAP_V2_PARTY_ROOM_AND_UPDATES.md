> Historischer Plan. Der automatische Updater und die darin beschriebenen GitHub-Workflows wurden eingestellt. Für aktuelle Builds gilt die [manuelle MSI-Anleitung](README.md).

# Roadmap V2: Party-Room und Upstream-Update-Audit

Stand 04.11.2026:
- Branch `feature/party-premium-ui` auf `ea2d6eb9` (Test-MSI 0.1.48).
- Upstream `NuvioMedia/NuvioDesktop` Dev auf `dfbfdcf0` (03.11.2026, Version `0.1.34-alpha`).
- Nur Analyse: nichts implementiert, getestet, gebaut, committet oder gepusht.
- `fork-maintenance/NUVIO_MASTER_ROADMAP.md` **existiert nicht**. Abschnitt 4 übernimmt den Abgleich und kann die Grundlage dieser Datei werden.

---

## 1. Party-Room

### 1.1 Ist-Stand: Was es schon gibt

Die Watch Party ist eine **offizielle Nuvio-Funktion** mit Backend und Supabase Realtime. Der Fork erweitert sie nur. Die vier fork-eigenen Dateien sind `PartyCommands.kt`, `PartyCountdown.kt`, `PartyFamilyShare.kt` und `PartyHostHls.kt`. In acht Upstream-Dateien kommen rund 725 Zeilen dazu.

| Anforderung | Vorhanden | Wo |
|---|---|---|
| Party erstellen, beitreten | ja | `watch_party_create`, `watch_party_join`, `watch_party_preview` (`PartyApi.kt`), `PartyScreen.kt` (`PartyHome`, `JoinContent`, `PreviewCard`) |
| Party **benennen** | **nein** | Das Backend hat kein Namensfeld; `PartyInfo`/`PartyPreview` haben keins |
| Lobby mit Teilnehmern | ja | `PartyRoom` → `PartyContent` → `PartyOverview` (`PartyDetails.kt`: `MembersSection`, `MemberRow`, `SeatDots`, `OpenSeatRow`) |
| Bereitschaft | **teilweise** | `PartyMemberStatus` (`browsing`/`loading`/`buffering`/`ready`/`behind`) beschreibt nur den **Player**. Ein manuelles „Ich bin bereit“ in der Lobby fehlt |
| Einladungslink, Party-Code | ja | `CodeSection`, `PartyCode.kt`, Browser-Einladung (Preview-Origin), Original-Einladungslink |
| Filmkarte | ja | `MediaHeader`, `MediaTitle`, `PreviewCard` |
| Stream-Status, automatische HLS-Freigabe | ja | `stream`-Ereignis, `browser_hls`, TorBox-Vorbereitung, direkte Freigabe mit Key (`ea2d6eb9`) |
| Chat | ja | `PartyChat.kt`, `PartyChatContent.kt`, `watch_party_send_message`/`list_messages`, Realtime `chat`, Tabs mit Ungelesen-Zähler |
| Teilnehmerstatus | ja | Realtime `status` (`PartyPresence`: Status, Rückstand, Position, `solo`) |
| Universal Sync | ja | Phase A: „Sync me“, „Sync all“, Allein-Status; `PartySync`, Command-ID/ACK |
| Gemeinsamer Countdown | ja | Phase B, `PartyCountdown.kt`, in Server-Zeit |
| Host-/Gastberechtigungen | ja | `host_only` (`watch_party_set_host_only`), `watch_party_remove_member`, Host-Sequencer für Gastbefehle |
| Leave, End for everyone | ja | `watch_party_leave` bzw. `watch_party_end` mit Bestätigung |
| Reconnect, Wiederbeitritt | **teilweise** | Realtime-Reconnect und `rejoinOrFinish()` im Repository. Nach einem App-Neustart gibt es **kein** automatisches Zurück in die Party; nur der Einladungslink führt zurück |
| Host-Failover | **teilweise** | Das Backend wechselt den Host beim Leave. H0 und H1 sind geplant (`WATCHPARTY_HOST_INDEPENDENT_PLAN.md`) |

**Fazit:** Rund 80 % sind vorhanden. Der Party-Room ist vor allem eine **Neuordnung der vorhandenen Oberfläche** plus drei kleine fehlende Funktionen: Name, Lobby-Bereitschaft und Wiederbeitritt nach Neustart. Neue Backend-Logik ist nicht nötig.

### 1.2 Neue Bausteine (minimal-invasiv)

Keine neuen Backend-Tabellen und keine neuen RPCs; das offizielle Backend ist nicht unseres. Alle Erweiterungen sind **optionale Felder** in bestehenden Realtime-Ereignissen. Ältere Clients und offizielle Nuvio-Apps ignorieren sie, wie schon bei `solo` und `commands`.

1. **Party-Name**
   - Erste Wahl: ein optionales Feld `room_name` in `PartyMedia` (geht als `p_media` an `watch_party_create`).
     - Speichert das Backend `p_media` als JSON unverändert, bleibt der Name ohne Host erhalten und erscheint auch in `watch_party_preview`.
     - **Das muss vorab gemessen werden** (Schritt R0).
   - Ersatz, falls das Backend das Feld verwirft: Der Host sendet den Namen im `stream`- bzw. `state`-Antwortpaket auf `state_request` mit. Ohne Host fehlt er dann, und der Code wird angezeigt.
   - Begrenzung: höchstens 40 Zeichen; nur als Text darstellen, nie als HTML (Browser: `textContent`).
2. **Lobby-Bereitschaft:** optionales Feld `lobby_ready: Boolean?` in `PartyPresence` über das bestehende `status`-Ereignis.
   - Der Host sieht „2/3 bereit“ und kann den bestehenden Countdown starten.
   - Ein Auto-Start, sobald alle bereit sind, bleibt eine Option, die standardmäßig aus ist.
3. **Wiederbeitritt nach Neustart:**
   - Gespeichert werden lokal nur Party-Code und Party-ID, keine Tokens, mit einer Gültigkeit von höchstens 12 h.
   - Beim Start: `watch_party_preview` aufrufen. Ist die Party aktiv und man ist Mitglied, erscheint der Hinweis „Party … fortsetzen?“ mit Klick zum Beitreten über den vorhandenen `join`.
   - Nach „Leave“, „End“ oder „Removed“ werden Code und ID gelöscht.
   - Browser: dasselbe in `sessionStorage` (`session.js` hat das teilweise schon).
4. **Room-Oberfläche (Desktop):** `PartyRoom` wird dreiteilig:
   - **Kopf:** Name, Code, Einladen
   - **Hauptbereich:** Filmkarte, Stream-Status, Bereit-Liste, Start bzw. Countdown
   - **Seitenleiste:** Chat, ab einer Breite von 900 dp; schmaler bleiben die Tabs
   - Die vorhandenen Composables werden wiederverwendet und nur neu angeordnet.
5. **Browser-Lobby:** Vor „Film starten“ zeigt `main.js` dieselbe Bereit-Liste und denselben Namen; die Daten kommen aus denselben Realtime-Ereignissen.
6. **Host-Failover:** **keine** Room-Arbeit. Es bleibt H1 (Sync-Failover) bzw. H3 (Stream-Autorität im Worker). Der Room zeigt den Host nur an, wo das heute schon geschieht.

### 1.3 Dateiplan

| Datei | Änderung |
|---|---|
| `features/party/PartyModels.kt` | `PartyMedia.roomName?`, `PartyPresence.lobbyReady?`; optional, Standard `null` |
| `features/party/PartyRepository.kt` | Bereitschaft setzen (über die bestehende `status`-Sendung), Name beim Erstellen übergeben, Wiederbeitritts-Speicher |
| `features/party/PartyApi.kt` | keine neue RPC; höchstens `roomName` in `p_media` |
| `features/party/PartyScreen.kt`, `PartyDetails.kt` | Room-Layout, Namensfeld beim Erstellen, Bereit-Liste, Fortsetzen-Hinweis |
| `features/party/PartyRejoin.kt` (neu, fork-eigen) | kleiner lokaler Speicher (Code, ID, Zeit) ohne Tokens |
| `composeResources/values/strings.xml` | neue Texte, **am Dateiende** gesammelt, weil Upstream diese Datei oft ändert |
| `browser-site/src/protocol.js`, `main.js`, `session.js`, `style.css` | Name und Bereitschaft anzeigen bzw. senden, Lobby-Ansicht |
| `browser-site/tests/*` | Protokoll- und Lobby-Tests |
| `commonTest/.../PartyRoomTest.kt` (neu) | Serialisierung der optionalen Felder, Rückwärtskompatibilität, Bereitschaftszählung, Gültigkeit des Wiederbeitritts |
| `check-fork-invariants.sh` | Marker für Room und Wiederbeitritt ergänzen |

**Nicht** angefasst werden `PartySync.kt` (Synchronisation), `PartyCommands.kt` (Command-ID/ACK), die Player-Bridge, `party.js`/`controls.html` (Player-Overlay) und der Worker.

### 1.4 Abhängigkeiten und Risiken

- **Backend nicht einsehbar:** Ob `p_media` zusätzliche Felder behält, wird in R0 gemessen. Die maximale Teilnehmerzahl (`max_members`, Standard 3) legt das Backend fest; der Room kann sie nur anzeigen.
- **Upstream-Konflikte:** `PartyScreen.kt` und `PartyDetails.kt` sind Upstream-Dateien. Je mehr dort umgebaut wird, desto mehr Konflikte gibt es später. Deshalb kommen neue Teile in fork-eigene Dateien (`PartyRoomLayout.kt`); in den Upstream-Dateien bleibt nur ein Aufruf.
- **Realtime-Absender werden nicht vom Server geprüft:** Name und Bereitschaft vom Host werden nur angenommen, wenn der Absender `host_member_id` ist (wie beim Countdown).
- **TorBox-Key:** Der Room zeigt Stream-Status nur als Text („TorBox HLS bereit“), nie die Adresse.

### 1.5 Reihenfolge

| Schritt | Inhalt | Abnahme |
|---|---|---|
| **R0** | Messen: Behält `watch_party_create` ein Zusatzfeld in `p_media`, und liefert `watch_party_preview` es zurück? (1 Testparty) | Ja/Nein notiert |
| **R1** | Modelle, Wiederbeitritt, Bereitschaft (Logik und Tests, ohne UI) | Tests grün; ältere Payloads werden unverändert gelesen |
| **R2** | Desktop-Room-Layout, Namensfeld, Bereit-Liste, Fortsetzen-Hinweis | Live: Erstellen mit Name, Beitritt, Bereit, Countdown, Leave, End |
| **R3** | Browser-Lobby | Browsergast sieht Name und Bereitschaft und meldet sich bereit |
| **R4** | H0 messen, dann H1 Sync-Failover (eigener Plan) | siehe `WATCHPARTY_HOST_INDEPENDENT_PLAN.md` |

---

## 2. Audit: Übernahme offizieller Updates

### 2.1 Befund

| Prüfpunkt | Ergebnis |
|---|---|
| **Workflow aktiv?** | Ja: `Fork - Review upstream updates`, täglich 07:23 UTC und manuell. Läufe: #1 (02.11., manuell) erfolgreich; **#2 (02.11.) und #3 (03.11.) fehlgeschlagen**, jeweils nach etwa 27 s. |
| **Draft-PR vorhanden?** | **Nein.** Offen ist nur PR #2 (`feature/torbox-hls-mvp`), geschlossen ist #1. Ein Branch `updates/*` existiert auf `origin` nicht. Es wird also aktuell **kein** Update vorgeschlagen. |
| **Upstream-Stand** | Dev fehlen **130 offizielle Commits**, zuletzt `dfbfdcf0` vom 03.11.2026. |
| **Richtiger Branch?** | Ja: Der Job läuft nur auf `refs/heads/Dev` im Repository `lebochoffice/NuvioDesktop`. Aber auf **Dev liegt noch die alte Skriptfassung**: Sie schiebt nur den Upstream-Tip nach `updates/nuvio-dev` und öffnet einen Draft-PR, ohne Integrationsmerge und ohne Invariantenprüfung. Die neue Fassung (ab 0.1.38) liegt nur auf `feature/party-premium-ui`. |
| **Fehlerursache #2/#3** | Ohne Anmeldung auf GitHub nicht einsehbar (Logs erfordern Login, `gh` ist lokal nicht installiert). Da kein Branch `updates/nuvio-dev` existiert, scheitert sehr wahrscheinlich schon `git push origin <tip>:refs/heads/updates/nuvio-dev`. Mögliche Gründe: Der Token im Secret `FORK_SYNC_TOKEN` fehlt, ist abgelaufen oder hat keine Schreibrechte, oder die Actions-Einstellung lässt nur Lesezugriff zu. Das muss im Log von Lauf #3 bestätigt werden. |
| **Merge-Konflikte?** | Probe-Merge (`git merge-tree`, ohne Änderung am Arbeitsbaum): `Dev + upstream` **konfliktfrei**, `feature/party-premium-ui + upstream` ebenfalls **konfliktfrei**. Neun Dateien ändern beide Seiten, unter anderem `player_bridge.cpp`, `NativePlayerBridge.kt`, `controls.html`, `PlayerEngine.kt`, `build.gradle.kts`, `strings.xml` und `MainAppContent.kt`. Textuell passen sie zusammen; die Funktion muss getestet werden. |
| **Fehler im neuen Skript** | `fork-maintenance/upstream-pr.sh` Zeile 29 auf `feature/party-premium-ui` enthält ein wörtliches `\n` statt eines Zeilenumbruchs. `git show` bekommt dadurch das Zusatzargument `n` und scheitert immer. Das Skript bricht mit „check-fork-invariants.sh is not on Dev yet“ ab, sobald diese Fassung auf Dev liegt. **Muss vor dem Übertragen auf Dev behoben werden.** |
| **Weitere Actions-Fehler** | `PR Template Check` #5–#7 am 02.11. fehlgeschlagen, danach grün; das ist erledigt. `Fork - Windows MSI` ist auf PR #2 grün. |
| **CI für den Hauptbranch** | Pushes auf `feature/party-premium-ui` lösen **keine** CI aus, weil es keinen PR gibt. Getestet wird nur lokal. |
| **Release-Workflow** | `fork-release.yml` liegt **nicht** auf Dev und ist in Actions deshalb nicht sichtbar. Releases über den In-App-Updater sind daher derzeit **nicht möglich**. |
| **Watch Party geschützt?** | Ja, mit der neuen Skriptfassung: Invarianten aus dem Fork-Dev, Draft-PR bei Konflikt oder fehlender Fork-Funktion, Auto-Merge nur mit `FORK_AUTO_MERGE=true`. **Diese Variable nicht setzen**, Entscheidung: nur Draft-PRs. Mit der alten Fassung auf Dev gibt es nur einen Draft-PR des reinen Upstream-Tips; ein Merge würde die Fork-Funktionen nicht entfernen, ist aber ungeprüft. |

### 2.2 Fork-Releases über den In-App-Updater

So ist es schon gebaut (`FORK_UPDATER.md`, `AppUpdaterPlatform.desktop.kt`):
- Der Desktop-Updater fragt `lebochoffice/NuvioDesktop`-Releases ab.
- Er nimmt nur `.msi`-Assets mit `WatchParty` und `windows` im Namen.
- Download nur von GitHub, mit SHA-256-Pflicht über den Asset-`digest`.
- Installation interaktiv mit `msiexec`, Rollback durch Windows Installer.

Damit das genutzt werden kann:
1. Den Fork-Stand über einen **Draft-PR** `feature/party-premium-ui → Dev` auf Dev bringen. Das ist eine Änderung an Production und erfordert eine gesonderte Freigabe. Danach existieren `fork-release.yml` und die neue `upstream-pr.sh` auf Dev.
2. Einmalig einrichten: Umgebung `fork-release` mit dir als „Required reviewer“, Branch-Schutz für Dev und ein gültiges Secret `FORK_SYNC_TOKEN`.
3. Release `v0.1.49-watchparty` manuell starten. Ab dann bekommen installierte Builds ab 0.1.38 Updates in der App.
4. Für die spätere breitere Verteilung: Code-Signing. Der MSI ist unsigniert, deshalb warnt SmartScreen.

### 2.3 Offizielle MSIs dürfen den Fork nicht überschreiben

- **Ist:** Fork und offizielle App nutzen **dieselbe `UpgradeCode`** (`395990ee-…`) und denselben Produktnamen „Nuvio“. Windows behandelt sie als ein Produkt. Es gewinnt die höhere `ProductVersion`.
  - Heute: Fork `1.1.48`, offiziell `0.1.34-alpha` → `1.1.34`. Ein offizieller MSI würde also **nicht** installiert („neuere Version vorhanden“).
- **Risiko:** Sobald die offizielle Version über den Fork-Kern steigt (ab `0.1.49`), ersetzt ein offizieller MSI den Fork vollständig. Der In-App-Updater des Forks bietet offizielle Assets nie an. Gefahr droht nur, wenn jemand einen offiziellen MSI manuell installiert. Builds bis 0.1.37 fragen außerdem noch NuvioMedia ab.
- **Empfehlung (einfach, ohne Migration):** Den Fork-Versionskern dauerhaft über den offiziellen legen, zum Beispiel ab dem nächsten Release `2.0.49-watchparty` → `ProductVersion 2.0.49`.
  - Ein offizieller MSI `1.x` wird dann von Windows abgelehnt.
  - Der Fork-Updater vergleicht nur mit Fork-Releases, die neue Zählung ist also unproblematisch.
  - Der Version-Code muss weiter monoton steigen (`20049`).
- **Alternative (gründlicher):** eigene `UpgradeCode` und eigener Produktname „Nuvio Watch Party“ mit eigenem Installationsordner. Damit laufen beide Apps nebeneinander. Bestehende Fork-Installationen müssen aber einmal manuell deinstalliert werden, und Einstellungen und Daten liegen dann doppelt. Erst sinnvoll, wenn beide Apps parallel gebraucht werden.

### 2.4 Reihenfolge für den Update-Workflow

| Schritt | Inhalt | Abnahme |
|---|---|---|
| **U1** | Log von Lauf #3 lesen (GitHub-Anmeldung im Browser-Bereich), Ursache bestätigen, Secret bzw. Actions-Rechte von dir korrigieren lassen | Manueller Lauf erzeugt den Branch `updates/nuvio-dev` und einen Draft-PR |
| **U2** | `upstream-pr.sh` Zeile 29 reparieren (`\n` → echter Zeilenumbruch) und das Skript mit `bash -n` und einem lokalen Trockenlauf testen | Skript bricht nicht mehr fälschlich ab |

**U1 Ursache bestätigt (Log Lauf #3, 04.11.2026):**
- Der Push wird abgelehnt:

  ```
  ! [remote rejected] 2436858a… -> updates/nuvio-dev (refusing to allow a GitHub App
    to create or update workflow `.github/workflows/update-store-source.yml` without `workflows` permission)
  ```
- **Hintergrund:**
  - Der Lauf nutzt den eingebauten `GITHUB_TOKEN`. „GitHub App“ bedeutet, dass das Secret `FORK_SYNC_TOKEN` fehlt oder nicht greift.
  - Der Fork hat `update-store-source.yml` geändert (`d9976388`: Schutz `if: github.repository == 'NuvioMedia/NuvioDesktop'`, dazu Zeilenenden).
  - Der reine Upstream-Tip enthält die offizielle Fassung dieser Datei. Für GitHub ist sein Push daher eine Änderung an einem Workflow, und die ist mit `GITHUB_TOKEN` nie erlaubt.
  - Kein Upstream-Commit selbst ändert Workflows. Der Fehler tritt also **bei jedem Lauf** auf, nicht nur bei diesem Update.
- **Behebung (nur durch dich):**
  - Fein-granularen Personal Access Token anlegen:
    - nur für das Repository `lebochoffice/NuvioDesktop`
    - Berechtigungen: **Contents: Read and write**, **Pull requests: Read and write**, **Workflows: Read and write**
    - Ablauf höchstens 90 Tage
  - Ihn als Repository-Secret `FORK_SYNC_TOKEN` speichern.
  - Der Workflow nutzt das Secret bereits (`secrets.FORK_SYNC_TOKEN || github.token`). Mit dem PAT starten auch die CI-Prüfungen auf dem Draft-PR.
  - Den Token nirgends sonst speichern oder einfügen.
- **Danach:** `Fork - Review upstream updates` manuell starten („Run workflow“ auf Dev).
  - Erwartet: Branch `updates/nuvio-dev` und Draft-PR „Review Nuvio Desktop Dev updates“ (alte Dev-Fassung des Skripts).
  - Kein Merge.
  - `FORK_AUTO_MERGE` nicht setzen.

**U1 erledigt (04.11.2026):**
- Lauf #4 scheiterte noch, weil das Secret fehlte; das Repository hatte zu dem Zeitpunkt kein Secret.
- Nach dem Anlegen von `FORK_SYNC_TOKEN` war Lauf #5 erfolgreich.
- Ergebnis:
  - Branch `updates/nuvio-dev` steht auf dem offiziellen Tip `dfbfdcf0`.
  - Draft-PR #3 „Review Nuvio Desktop Dev updates“ (`updates/nuvio-dev` → `Dev`) ist angelegt.
  - Auf PR #3 laufen die CI-Prüfungen: `PR Template Check` grün, `Fork - Windows MSI` lief zum Zeitpunkt der Prüfung noch.
  - Dev ist unverändert (`28f593dd`). Es wurde nichts gemergt.

**U2 umgesetzt (04.11.2026, uncommittet):**
- Zeile 29 endet jetzt mit `\` + Zeilenumbruch, `|| { … }` steht auf Zeile 30.
- Der Index speichert die Datei mit LF, auf dem Runner kommt also LF an. Lokal liegt sie mit CRLF vor.
- Weitere wörtliche `\n` in den Fork-Skripten und Fork-Workflows: keine.
- **Zweiter Befund:**
  - Die neue Fassung liest den Prüfer `check-fork-invariants.sh` aus Dev. Dort fehlt er.
  - Bis der Fork-Stand auf Dev liegt (U3), bricht diese Fassung also absichtlich mit „not on Dev yet“ ab.
  - Auf Dev läuft bis dahin weiter die alte Fassung. U2 wirkt erst mit U3.
- **Trockenlauf (04.11.2026):**
  - Aufbau: Wegwerf-Bare-Repository als `origin`, echter Fetch des offiziellen Dev-Tips `dfbfdcf0`, ein Stub statt `gh`, Dummy-Token. Nichts ging an GitHub.

  | Fall | Dev im Test | Skript | Ergebnis |
  |---|---|---|---|
  | A | Fork-Stand `ea2d6eb9` | repariert | exit 0: Prüfer aus Dev gelesen; Merge mit dem offiziellen Tip **konfliktfrei**; „Fork invariants OK.“; `updates/nuvio-dev` und `updates/nuvio-integration` gepusht; `gh pr create --draft` „Integrate Nuvio Desktop Dev updates (checked)“; kein Merge, kein Auto-Merge |
  | B | Fork-Stand `ea2d6eb9` | alt (Zeile 29 mit `\n`) | exit 1: „check-fork-invariants.sh is not on Dev yet“, **obwohl der Prüfer vorhanden ist**. Der Fehler ist damit bestätigt. |
  | C | heutiges Dev `28f593dd` | repariert | exit 1: „not on Dev yet“, wie erwartet (Prüfer fehlt auf Dev) |

  - Nebenbefund: Der Fork-Stand mit allen 130 offiziellen Commits besteht die Fork-Invarianten. Für U3 ist das eine gute Ausgangslage; Desktop- und Browser-Tests auf dem gemergten Stand stehen noch aus.
| **U3** | Draft-PR `feature/party-premium-ui → Dev` (nur nach Freigabe, Production) | CI `Fork - Windows MSI` grün; Merge nur durch dich |
| **U4** | Versionsschema `2.0.x-watchparty` festlegen (eigener Commit) | MSI zeigt `ProductVersion 2.0.x`; ein offizieller MSI wird abgelehnt |
| **U5** | Erste Fork-Release über `fork-release.yml` | Installierte 0.1.48 bietet das Update in der App an |

---

## 3. Entscheidungen, die gelten

- **Kein HLS-Proxy** (H2/P3 gestrichen).
- **Direkte TorBox-Freigabe mit Account-Key** nur im vertrauenswürdigen Kreis.
  - Das Risiko bleibt offen: Jedes Party-Mitglied kann den Key lesen, und ein Widerruf holt einen übertragenen Key nicht zurück.
  - Ein Party-Room mit Einladungslink macht das Weitergeben leichter. Deshalb sollte vor dem ersten Teilen ein Hinweis „Nur mit vertrauenswürdigen Personen teilen“ erscheinen (Teil von R2).
- **Preview-Passwort 90 Tage:**
  - Heute `SESSION_S = 30*24*3600` in `browser-site/functions/_middleware.js`.
  - Änderung auf `90*24*3600`; gemessen in Sekunden liegt das unter der Grenze des Cookie-`Max-Age`.
  - Tests in `browser-site/tests` anpassen, als eigener kleiner Schritt **P90** vor R1.
  - Wirkt erst nach dem Pages-Deployment der Preview und nur für neue Anmeldungen.
- **Host-unabhängige Party** bleibt Ziel: H0 → H1 → H3, getrennt vom Room.
- **Production `Dev` unverändert**, bis du U3 ausdrücklich freigibst.

## 4. Abgleich Gesamt-Roadmap

| Bereich | Status |
|---|---|
| Sync (Command-ID/ACK, exakter Seek, Drift, Reconnect) | fertig, unverändert lassen |
| Universal Sync (Phase A), UI-Pass 2, Countdown (B), Intelligente Wiedergabe (C) | fertig |
| TorBox HLS automatisch, direkte Freigabe mit Key | fertig (`ea2d6eb9`), **Live-Test mit 0.1.48 offen** |
| Preview-Passwort | fertig mit 30 Tagen → **P90** offen |
| Party-Room | **R0–R3** offen |
| Host-unabhängig | **H0** (Messplan fertig, Messung offen) → H1 → H3 → H4 |
| Upstream-Updates | **kaputt** (U1, U2), 130 Commits ausstehend |
| Fork-Releases per App | **blockiert**, bis der Fork auf Dev liegt (U3–U5) |
| Schutz vor offiziellem MSI | heute sicher, ab offiziell 0.1.49 nicht mehr → **U4** |

**Empfohlene Gesamtreihenfolge:**
1. Live-Test 0.1.48
2. U1 und U2 (Updates wieder funktionsfähig, kleiner Eingriff)
3. P90
4. R0 → R1 → R2 → R3
5. U3 bis U5 (Fork auf Dev, Versionsschema, erste App-Release), vor dem offiziellen 0.1.49
6. H0 → H1

Jeder Schritt wird einzeln umgesetzt, getestet und freigegeben.
