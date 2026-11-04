# Sicherheitsprüfung des Familienfreigabe-Workers vor dem Deployment (Commit `0eaf81c8`)

Stand 04.11.2026. Nur gelesen: kein Test, kein Build, kein Deployment, keine Codeänderung. Geprüft wurden `party-share-worker/src/index.js`, die Desktop-Anbindung (`PartyFamilyShare.kt`, `PlayerScreenRuntimeParty.kt`), der Browser-Abruf (`main.js`) und die Konfiguration.

**Gesamturteil:** Ohne Zulassung durch den Host bekommen Fremde über den Worker keinen Link. Voraussetzung ist, dass das offizielle `watch_party_heartbeat` Mitgliedschaft und Host-Rolle serverseitig korrekt an die angemeldete Person bindet; das ist **nicht verifizierbar**. Vor dem Deployment sollten die Punkte **S1 bis S4** behoben werden. Keiner davon gibt Fremden direkten Zugriff, aber sie verlängern den Zugriff ehemaliger Mitglieder oder lassen ihn offen.

## Befunde

| Nr. | Schwere | Befund |
|---|---|---|
| S1 | mittel | Gekickte oder ausgetretene Mitglieder behalten bis zu 15 min Zugriff über `/v1/stream` |
| S2 | mittel | Nach einem Host-Wechsel können zugelassene Mitglieder bis zu 6 h neue Grants holen |
| S3 | mittel | `party-share-worker/wrangler.toml` ist nicht vor einem Commit geschützt |
| S4 | niedrig bis mittel | Kein Rate-Limit; jeder `/v1/grant`-Aufruf löst einen Supabase-RPC aus |
| S5 | niedrig | Ein Widerruf ist „best effort“, ohne Wiederholung oder Rückmeldung bei Fehlschlag |
| S6 | niedrig | Ein Grant ist ein Bearer-Token und nicht an Session oder Gerät gebunden |
| S7 | niedrig | `readBody` liest den Body vor der Größenprüfung vollständig |
| N1 | nicht verifizierbar | Ob `watch_party_heartbeat` die Mitgliedschaft an `auth.uid()` bindet oder nur an `device_id` |

## Prüfpunkte im Einzelnen

### 1. Host- und Mitgliedschaftsprüfung über `watch_party_heartbeat`

- Der Worker ruft das RPC mit dem **JWT des Aufrufers** und dessen `device_id` auf (`index.js:52–65`).
  - `member_id` und `host_member_id` stammen ausschließlich aus der Server-Antwort, nie aus dem Request.
  - `isHost` heißt `snapshot.member_id === snapshot.party.host_member_id` (`:98`), und die Party-ID muss zur Antwort passen (`:62`).
- Das JWT prüft Supabase, nicht der Worker. Ein ungültiges oder fremdes Token führt zu einem Fehler im RPC und damit zu 403 (`:96`).
- **N1:** Ob das RPC die Mitgliedschaft an die angemeldete Person (`auth.uid()`) bindet, ist im Repository nicht einsehbar (siehe `WATCHPARTY_FAMILY_SHARE_SECURITY.md`).

### 2. Identitätsvortäuschung über `device_id` oder `member_id`

- **`member_id`:** nicht vortäuschbar. Der Worker übernimmt keine `member_id` vom Client. Die Zulassungsliste des Hosts wird bei `/v1/share` gegen die aktuellen Mitglieder geprüft (`:111`).
- **`device_id`:** kommt vom Client und geht ans RPC.
  - **Wenn** der Server die Mitgliedschaft nur über `device_id` und nicht über `auth.uid()` findet (N1), könnte ein fremdes Konto mit der Geräte-ID eines Mitglieds dessen Identität annehmen.
  - Gemindert wird das dadurch, dass Geräte-IDs weder in Mitgliederlisten (`PartyMember`: `id`, `display_name`, Avatar) noch in Presence oder Status (`PartyPresence`) übertragen werden. Ein Angreifer müsste sie vom Gerät des Opfers holen.
- **Live-Prüfung (empfohlen, mit zwei eigenen Konten):** Konto B ruft `/v1/grant` mit der `party_id` und der `device_id` von Konto A auf. Erwartet wird 403.

### 3. `/v1/grant` mit gültigem Nuvio-Konto, aber ohne Mitgliedschaft

- Das RPC schlägt fehl, also 403 `not_member`, und es wird keine URL ausgegeben. Der Test deckt das ab („stranger“).
- Wer ein Mitglied ist, aber nicht zugelassen, erhält 403 `not_admitted`.
- Der Party-Code allein reicht nicht. Ein Konto, das per Code beitritt, ist zwar Mitglied, aber nicht zugelassen.

### 4. `/v1/stream` ohne gültigen Grant

- Format-Prüfung (43 Zeichen base64url), danach Suche über SHA-256 im Durable Object der Party. Unbekannt oder abgelaufen ergibt 401, ohne URL.
- 256 Bit Zufall sind nicht erratbar. Ein Grant gilt nur im Durable Object seiner Party.

### 5. Kick, Leave, Host-Austritt, Widerruf

- **Widerruf** („Share my stream“ aus, Titelwechsel, Host verlässt die Party über die App): `deleteAll()`. Danach liefern `/v1/grant` und `/v1/stream` sofort nichts mehr; das Durable Object ist stark konsistent.
- **S1, Kick oder Leave:** Ein neuer `/v1/grant` scheitert sofort, weil das RPC das Mitglied nicht mehr kennt. `/v1/stream` prüft aber nur die Zulassungsliste, nicht die Mitgliedschaft (`:159`).
  - Der Desktop veröffentlicht die Liste nur neu, wenn sich `familyAdmitted`, Titel, Freigabe oder Party ändern. Eine Änderung der **Mitglieder** löst das nicht aus (`PlayerScreenRuntimeParty.kt:495`).
  - Ein ehemaliges Mitglied kann deshalb mit seinem Grant bis zu dessen Ablauf (≤ 15 min) die Adresse weiter abrufen.
  - **Korrektur:** Die Mitglieder-IDs in die Schlüssel des Effekts aufnehmen und Entfernte automatisch aus `familyAdmitted` streichen (beim nächsten Veröffentlichen löscht der Worker deren Grants). Zusätzlich die Grant-Laufzeit auf 5 min senken.
- **S2, Host-Austritt ohne App-Widerruf** (Absturz, Netzwerk, Player geschlossen): Die Freigabe bleibt bis zu ihrem Ablauf (Standard 6 h).
  - Hält das Backend die Party offen und ernennt einen neuen Host, können zugelassene Mitglieder weiter neue Grants holen. Die Freigabe speichert nämlich nicht, **welcher** Host sie angelegt hat.
  - **Korrektur:**
    - `host_member_id` beim Veröffentlichen mitspeichern; `/v1/grant` lehnt ab, wenn `snapshot.party.host_member_id` davon abweicht. Dafür muss der Worker die Host-ID des RPC an das Durable Object weiterreichen.
    - Die Freigabe kurz halten (z. B. 30 min) und vom Desktop während der Freigabe regelmäßig verlängern lassen; dann endet sie nach einem Absturz von selbst.
- **Bereits geladene Links:** Gäste schauen bei einem Host-Austritt weiter, wie gewünscht. Den Account-Key, den sie schon erhalten haben, können sie unabhängig von der Party weiter nutzen. Das ist eine bewusste und dokumentierte Grenze.

### 6. Gültigkeit der Grants (15 min)

- `expires_at = min(Ablauf der Freigabe, jetzt + 15 min)` (`:152`). Bei `/v1/stream` wird ein abgelaufener Grant gelöscht und mit 401 beantwortet (`:157`). Grants werden nur gehasht gespeichert; der Alarm beim Ablauf der Freigabe löscht alles.
- Ein Grant wird nie verlängert. Nach dem Ablauf ist ein neuer `/v1/grant` mit Session und Prüfung der Mitgliedschaft nötig.
- **S6:** Ein Grant ist ein Bearer-Token. Wer ihn bekommt, z. B. von einem zugelassenen Mitglied, kann die Adresse bis zum Ablauf abrufen. Das ist nicht schlimmer, als die Adresse selbst weiterzugeben. Kürzere Laufzeit siehe S1.

### 7. CORS oder echte serverseitige Autorisierung

- CORS (`:42–48`) steuert nur, ob **Browser** Antworten lesen dürfen. Für andere Clients ist es keine Sperre; auch POSTs von nicht erlaubten Origins werden verarbeitet.
- Die eigentliche Autorisierung ist unabhängig davon serverseitig: JWT und RPC bei `share`, `revoke` und `grant`, Grant bei `stream`.
- Es gibt kein CSRF-Risiko, weil keine Cookies verwendet werden, nur ein `Authorization`-Header oder der Grant im Body.

### 8. Keine Keys in URLs, Logs oder Fehlermeldungen

- **Worker:**
  - Die Adresse steht nur im POST-Body und im Speicher des Durable Objects, nie in einer Request-URL.
  - Antworten mit Adresse gehen nur an `/v1/grant` und `/v1/stream` nach erfolgreicher Prüfung; `/v1/share` gibt sie nicht zurück.
  - Fehler sind feste Codes; es gibt kein `console`, und `observability` ist aus.
  - Cloudflare speichert die Adresse verschlüsselt im Durable Object. Wer Zugriff auf dein Cloudflare-Konto hat, könnte Code deployen, der sie ausliest. Das Konto also schützen (2FA).
- **Desktop (`PartyFamilyShare.kt`):** kein Logging, Exceptions werden ohne Text verworfen. Sentry ist mit `isSendDefaultPii = false` konfiguriert und hat keine HTTP-Breadcrumbs für `httpRequestRaw`.
- **Browser:** Adresse und Grant liegen nur im Speicher, `credentials: 'omit'`, keine Speicherung im Browser. Die Diagnose zeigt nur freigegebene Felder, der Text in der Oberfläche nur „TorBox (Familie)“.
- **Restlecks:** Die Adresse ist im Netzwerkprotokoll des Browsers des zugelassenen Gastes sichtbar; das ist der autorisierte Medienabruf. TorBox und das CDN sehen den Referer `…/party/<CODE>`, also nur den Party-Code. Als Härtung möglich: `referrerpolicy` bzw. eine Referrer-Policy `no-referrer` auf der Pages-Seite.

### 9. `wrangler.toml` und Git (S3)

- `party-share-worker/wrangler.toml` existiert inzwischen als **unversionierte** Datei. Sie steht in **keiner** `.gitignore`; ein `git add -A` würde sie mitnehmen.
- Aktueller Inhalt (ohne Werte geprüft): nur öffentliche Angaben. `SUPABASE_ANON_KEY` ist noch der Platzhalter `sb_publishable_REPLACE_ME`, also kein Geheimnis, aber auch noch nicht konfiguriert.
- **Korrektur:** `party-share-worker/.gitignore` mit `wrangler.toml`, `.dev.vars*` und `.wrangler/` anlegen. Echte Geheimnisse, falls je nötig, nur per `wrangler secret put`, nie in `wrangler.toml`.

### Weitere

- **S4:** Kein Rate-Limit. Ein Angreifer mit beliebigem Token kann viele `/v1/grant`-Aufrufe erzeugen, die jeweils das Supabase-RPC treffen.
  - Lesen kann er dabei nichts, aber er verursacht Last und Kosten.
  - **Korrektur:** Cloudflare-Rate-Limiting (WAF-Regel oder Binding `ratelimit`) pro IP und Party, z. B. 20 Anfragen pro Minute auf `/v1/*`.
- **S5:** Ein Widerruf ist „best effort“ (`PartyFamilyShare.revoke`). Schlägt er wegen des Netzwerks fehl, bleibt die Freigabe bis zu ihrem Ablauf aktiv, und der Host sieht es nicht.
  - **Korrektur:** Bei Fehlschlag einen Hinweis im Panel zeigen und nach 30 s erneut versuchen; dazu die kurze Laufzeit mit Verlängerung aus S2.
- **S7:** `request.text()` liest den Body vor der 16-KB-Prüfung vollständig. Das ist nur ein Speicherproblem, keine Datenoffenlegung.
  - **Korrektur:** Zuerst `Content-Length` prüfen, bei einem fehlenden oder zu großen Wert abbrechen.

## Notwendige Korrekturen vor dem Deployment

1. **S3:** `.gitignore` für `wrangler.toml`, `.dev.vars*` und `.wrangler/`.
2. **S1:** Desktop veröffentlicht neu, wenn sich die Mitglieder ändern, und entfernt ehemalige Mitglieder automatisch. Grant-Laufzeit 5 min.
3. **S2:** Freigabe an `host_member_id` binden, Laufzeit 30 min mit Verlängerung durch den Desktop.
4. **S4:** Rate-Limit in Cloudflare.
5. **N1:** Live mit zwei eigenen Konten prüfen: Nicht-Mitglied, fremde `device_id`, gekicktes Mitglied. Alle müssen 403 bzw. 401 bekommen.

Optional: S5, S7, Referrer-Policy.

## Umsetzung S1 bis S3 (04.11.2026, nicht committet)

- **S3 behoben:** `party-share-worker/.gitignore` schließt `wrangler.toml`, `.dev.vars*` und `.wrangler/` aus. `git check-ignore` bestätigt das für die vorhandene `wrangler.toml`.
- **S2 behoben:**
  - Der Worker speichert `host_member_id` der Person, die veröffentlicht hat. `/v1/grant` lehnt mit `403 host_changed` ab, wenn das RPC einen anderen Host meldet. Ein neuer Host, der selbst veröffentlicht, beendet alle Grants des alten.
  - Die Freigabe gilt standardmäßig 30 min (höchstens 2 h). Der Desktop verlängert sie alle 10 min (`FAMILY_SHARE_TTL_S`, `FAMILY_SHARE_RENEW_MS`).
  - Bleibt eine Verlängerung aus (Absturz, Player geschlossen), endet die Freigabe von selbst. Eine Verlängerung ohne inhaltliche Änderung behält `rev`, damit Browser nicht unnötig neu abrufen.
- **S1 behoben:**
  - Der Desktop veröffentlicht neu, sobald sich die Mitglieder ändern, und streicht Ausgeschiedene automatisch aus `familyAdmitted`. Ein erneuter Beitritt ist ein neues Mitglied und muss neu zugelassen werden.
  - Der Worker löscht beim Veröffentlichen die Grants nicht mehr zugelassener Mitglieder. Grants gelten nur noch 5 min.
- **Tests angepasst bzw. neu:**
  - `worker.test.js`: Bindung an den Host, Verlängerung behält `rev`, Begrenzung der Laufzeit, Ablauf ohne Verlängerung
  - `PartyFamilyShareTest`: `ttl_s` wird gesendet; die Verlängerung erfolgt vor dem Ablauf
- **Offen:** S4 (Rate-Limit in Cloudflare konfigurieren), S5 bis S7 (optional) und die Live-Prüfung N1 mit zwei Konten.

### Testergebnis (04.11.2026, lokal)

- Worker: 8/8. Browser: 206/206. Desktop: 156/156, darunter `PartyFamilyShareTest` 4/4.
- Logs: `fork-maintenance/local/worker-tests-0.1.46-fix.log`, `browser-tests-0.1.46-fix.log`, `desktop-tests-0.1.46-fix.log`.
- Fork-Invarianten: OK.
- Nicht live getestet, Worker nicht deployt.
