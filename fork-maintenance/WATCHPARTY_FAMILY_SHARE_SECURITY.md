# Familienfreigabe von TorBox-Links mit Account-Key: Sicherheitsbefund (nach `d4460c82`)

Stand 03.11.2026. Nur gelesen, nichts gegen das Live-Backend ausgeführt. Keine echten Keys verwendet.

**Ergebnis: Die Zugriffskontrolle ist NICHT VERIFIZIERT und nachweislich nicht ausreichend. Die Familienfreigabe wurde deshalb NICHT aktiviert.** Die bestehenden Sperren (`ContainsAccountKey`, Prüfung auf `498`, `containsAccountKey`) sind unverändert.

## 1. Sind HLS-Links nur für aktuelle Party-Mitglieder abrufbar?

**Nicht belegbar, und für ehemalige Mitglieder nachweislich nicht garantiert.**

- **Server-Regeln nicht einsehbar:**
  - Der Fork enthält keine SQL zu `watch_party_*` und keine Policy auf `realtime.messages`. Das steht schon in `GUEST_CONTROL_PREVIEW_AND_BACKEND.md`.
  - Das öffentliche Upstream-Repository `NuvioMedia/self-host` (`database/migrations/*`, `volumes/db/realtime.sql`) enthält ebenfalls nichts zu `watch_party` oder `realtime.messages`.
  - Die Regeln liegen nur im Nuvio-Backend (`api.nuvio.tv`). `private: true` im Client (`PartyChannel.kt`, `session.js`) beweist nichts.
- **Mitgliedschaft wird nicht pro Nachricht geprüft:** Laut Supabase-Dokumentation wird die Berechtigung für private Kanäle beim Beitritt geprüft und für die Dauer der Verbindung zwischengespeichert. Neu geprüft wird erst bei einem neuen Subscribe oder einem neuen JWT; beim Ablauf des JWT wird getrennt.
  - Ein entferntes Mitglied, dessen Client nicht freiwillig trennt (z. B. ein veränderter Client), kann also **bis zum Ablauf seines JWT** weiter Broadcasts empfangen, also auch erneuerte Stream-Links. Wie lange das JWT bei Nuvio gilt, ist nicht bekannt.
  - Quellen: [Realtime Authorization](https://supabase.com/docs/guides/realtime/authorization), [Broadcast and Presence Authorization](https://supabase.com/blog/supabase-realtime-broadcast-and-presence-authorization), [Realtime Reports](https://supabase.com/docs/guides/realtime/reports).
- **Erneuerte HLS-Quelle:** Der Host sendet sie als neuen Broadcast. Es gibt keinen Abruf, bei dem die Mitgliedschaft erneut geprüft würde.

## 2. Geprüfte Angriffswege für Außenstehende

| Weg | Befund |
|---|---|
| Kanal abonnieren ohne Mitgliedschaft | Hängt allein von der nicht einsehbaren Policy ab. Das Topic enthält die Party-UUID. Laut Client-Modell liefert `watch_party_preview` sie nicht, die Server-Antwort ist aber nicht vollständig bekannt (`ignoreUnknownKeys`). **Nicht verifiziert.** |
| Party-Code bekannt + eigenes Nuvio-Konto | Der Code ist die Zugangsberechtigung: `watch_party_join` macht jedes angemeldete Konto zum Mitglied, bis die Party voll ist. Danach schickt der Host auf `state_request` sofort die aktuelle Quelle. Der Host sieht den neuen Teilnehmer zwar, aber erst, nachdem der Link schon übertragen ist. |
| Nach Kick, Leave oder Party-Ende | Ehrliche Clients verlassen den Kanal (`finish`, `close`). Ein nicht kooperierender Client kann wegen des Berechtigungs-Caches bis zum Ablauf des JWT weiter mithören (siehe oben). |
| Gefälschte Absender | `member_id` im Payload prüft der Server nicht (`PartyRepository.kt`, Kommentar bei `onCommand`). Jedes Mitglied kann `state_request` senden und löst damit beim Host einen erneuten `stream`-Broadcast aus. |
| RPCs und Snapshots | Stream-URLs werden **nicht** gespeichert. `sendStream` sendet nur per Broadcast, kein RPC enthält einen Stream (`PartyApi.kt`). |
| Presence und Status | Nur Status, `media_key` und Position, keine URL (`encodePresence`, `sendPresence`). |
| Einladungslinks | Nur der Party-Code (`/party/<CODE>`, `nuvio.tv/party/<CODE>`). |
| Logs und Diagnosen | Keine URL im Desktop-Log (`runRemote` loggt nur Fehler). Die Browser-Diagnose zeigt nur freigegebene Felder; Tests sichern das ab. Die Fehlertexte enthalten keine URLs. |
| Cloudflare und öffentliche Browser-Dateien | Das Bundle enthält nur den öffentlichen `sb_publishable_`-Key. Stream-Links entstehen erst zur Laufzeit im Speicher; `localStorage` und `sessionStorage` speichern nur den Auto-Schalter, die Geräte-ID und den Party-Code. |
| Empfänger selbst | Jeder Empfänger sieht den Key in der Medienadresse (DevTools, Netzwerk, Verlauf, Erweiterungen). Das lässt sich technisch nicht verhindern. |

## 3. Nicht verifizierbare Zugriffsbeschränkungen

- Die RLS- bzw. Realtime-Policy auf `realtime.messages` für `watch-party:<id>`: wer lesen und wer senden darf, und ob entfernte Mitglieder ausgeschlossen sind
- ob `watch_party_preview` bzw. `join` die Party-ID an Nicht-Mitglieder ausliefert
- die Gültigkeitsdauer der Nuvio-JWTs und damit, wie lange ein entfernter Client mithören kann
- ob das Backend beim Entfernen eines Mitglieds dessen Realtime-Verbindung aktiv trennt
- die Server-Logs von Supabase und Cloudflare, also ob Broadcast-Payloads protokolliert werden

## 4. Kann die Familienfreigabe sicher aktiviert werden?

**Nein, nicht mit dem heutigen Broadcast-Weg.** Dein Vertrauen in die Familie deckt die Empfänger ab. Die Bedingung „Unbefugte können den Key über die Infrastruktur nicht lesen“ ist aber nicht erfüllt:

- (a) Die Server-Policy ist nicht verifiziert.
- (b) Jedes Konto mit dem Party-Code wird sofort Mitglied und erhält den Link, bevor der Host reagieren kann.
- (c) Ein gekicktes Mitglied kann bis zum Ablauf seines JWT weiter empfangen.

**Bleibende Grenze auch bei perfekter Zugriffskontrolle:** Ein einmal an ein Familienmitglied übermittelter vollständiger Account-Key lässt sich unabhängig von der Party weiter nutzen. Er erlaubt den vollen TorBox-Zugriff, laut OpenAPI bis zu `DELETE /v1/api/user/deleteme`. Ungültig wird er nur, wenn du ihn bei TorBox neu erzeugst.

**Was eine sichere Aktivierung bräuchte** (Backend, nicht in diesem Fork):
1. Den Key-Link nicht per Broadcast senden, sondern in einer Tabelle speichern, die nur über ein RPC lesbar ist. Das RPC prüft bei **jedem** Abruf die aktuelle Mitgliedschaft (`removed`, `ended`). Der Broadcast meldet dann nur „neue Quelle“ ohne URL.
2. Die Policy auf `realtime.messages` vom Betreiber belegen lassen und sie mit zwei Testkonten prüfen (Nicht-Mitglied, gekicktes Mitglied).
3. Optional: Beitritt nur mit Bestätigung durch den Host oder per Positivliste von Konten, damit der Code allein nicht reicht.
4. Kurze JWT-Laufzeit, oder aktives Trennen beim Entfernen.

## 5. Dateien, die bei einer späteren Aktivierung zu ändern wären

- **Desktop:**
  - `debrid/TorboxPartyHls.kt`: `ContainsAccountKey` als eigenes Ergebnis „nur Familie“ statt Fehler; HTTPS- und Hostprüfung bleiben
  - `player/PlayerScreenRuntimeParty.kt`: `currentPartyStream`, also die Abzweigung für den Key-Link nur bei „Share my stream“ und nur über den neuen RPC-Weg
  - `party/PartyApi.kt` und `party/PartyRepository.kt`: Speichern und Abrufen über das RPC, Broadcast ohne URL
- **Browser:** `browser-site/src/session.js` und `main.js`, die den Link per RPC statt aus dem Broadcast abrufen
- **Backend (Betreiber):** Tabelle und RPC mit Mitgliedschaftsprüfung, Realtime-Policy
- **Tests:** die Key-Sperre in `TorboxPartyHlsTest`, `TorboxPartyHlsPrepareTest` und `personal-hls-integration.test.js`, gezielt nur für den Host-Pfad

## 6. Zwei Einladungsbuttons (umgesetzt, nicht getestet)

- **„Watch in Nuvio – Copy link“** kopiert den Upstream-Link `https://nuvio.tv/party/<CODE>`, bei eigenem Backend `nuvio://party/<CODE>`. Das ist wieder der Code aus `NuvioMedia/NuvioDesktop` (`upstream/Dev`, Commit `dfe1bba6`).
  - `partyInviteLink` zeigt also nicht mehr auf die Browser-Seite. Das betrifft auch das Kopiersymbol neben dem Code und die Einladung außerhalb des Players (`PartyDetails`).
- **„Watch in Browser – Copy link“** bleibt wie bisher: konfigurierte Cloudflare-Adresse (Production oder die geprüfte Preview im Test-Build), gleicher Party-Code, Prüfung in Kotlin unverändert. Der Button bleibt der letzte im Abschnitt.
- **Geänderte Dateien:** `PartyRepository.kt`, `PlayerScreenRuntimePartyControls.kt` (Aktion `partyCopyNuvioLink`), `PlayerScreenRuntimeState.kt`, `player-ui/party.js`, `PartyInviteLinkTest.kt`, `browser-site/tests/desktop-invite.test.js`.
- Synchronisierung, Command-ID/ACK, exakter Seek und Player-Bridge sind unverändert.

## Testergebnis (03.11.2026, lokal)

- Browser `npm test`: 200/200 bestanden, darunter der neue Test für „Watch in Nuvio“. Log: `fork-maintenance/local/browser-tests-invite.log`.
- Desktop (Auswahl wie bei 0.1.44): 144/144 bestanden, darunter `PartyInviteLinkTest` 3/3. Log: `fork-maintenance/local/desktop-tests-invite.log`.
- Fork-Invarianten: OK.
- Nicht live getestet. Ob der kopierte Link `https://nuvio.tv/party/<CODE>` die Nuvio-App öffnet, hängt von der Installation ab.
