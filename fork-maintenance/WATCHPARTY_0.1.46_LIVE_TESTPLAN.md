# Live-Testplan: Berechtigungen der Familienfreigabe (0.1.46)

Ziel: vor der echten Nutzung mit eigenen Konten belegen, dass nur zugelassene, aktuelle Mitglieder die TorBox-Adresse erhalten. Geprüft werden **nur HTTP-Statuscodes und Fehlercodes**, nie Adressen oder Tokens.

## Grundregeln für sichere Protokolle

- **Keine echten TorBox-Keys, Stream-Adressen, JWTs oder Grants** in Notizen, Screenshots, Chats oder Tickets. Notiert werden nur Statuscode und `error`.
- Keine HAR-Dateien oder Netzwerk-Exporte speichern. DevTools-Netzwerklogs nach dem Test leeren.
- Nach Möglichkeit einen **eigenen Test-Torrent** verwenden. Nach dem Test empfiehlt sich: TorBox-API-Key neu erzeugen und in Nuvio neu eintragen. Der Test selbst überträgt den Key an zugelassene Testbrowser.
- Tokens nur in Umgebungsvariablen der Shell halten, nie per `echo` ausgeben. Die Befehle unten geben nur Statuscode und Fehlercode aus.
- Sitzungen nach dem Test abmelden (Browser) und die Freigabe beenden („Share my stream“ aus).

## Aufbau

| Rolle | Konto | Gerät | Zweck |
|---|---|---|---|
| H | Konto 1 (Host, TorBox) | Desktop 0.1.46 mit `-Pnuvio.party.shareWorker` | Host |
| A | Konto 2 | Browser (Preview mit `VITE_PARTY_SHARE_WORKER`) | zugelassenes Mitglied |
| B | Konto 3 | zweiter Browser oder privates Fenster | Mitglied, **nicht** zugelassen |
| X | Konto 4 | dritter Browser | Fremder, kein Mitglied |
| D | Konto 5 (optional) | zweiter Desktop | für den Host-Wechsel |

**Werte für die Shell-Befehle** (in PowerShell, ohne Ausgabe):
- **`$W`:** Worker-Adresse, z. B. `https://nuvio-party-share.<konto>.workers.dev`
- **`$P`:** Party-ID. Sie steht nicht im Einladungslink. In der Browser-Konsole von A abrufbar (nur lokal ansehen), z. B. aus der Antwort von `watch_party_heartbeat` im Netzwerk-Tab, Feld `party.id`.
- **`$JA`, `$JB`, `$JX`:** Zugriffstokens (JWT) der Browser A, B und X. In den DevTools unter Application → Local Storage → `sb-…-auth-token` → `access_token`. Nur in die Variable kopieren.
- **`$DA`:** Geräte-ID von A: Session Storage → `nuvio-party-device`.

Hilfsfunktion (gibt nur Status und Fehlercode aus):

```powershell
function Probe($action, $jwt, $body) {
  $headers = @{ 'Content-Type' = 'application/json' }
  if ($jwt) { $headers['Authorization'] = "Bearer $jwt" }
  try { $r = Invoke-WebRequest -Method Post -Uri "$W/v1/$action" -Headers $headers -Body ($body | ConvertTo-Json -Compress) -UseBasicParsing
        "$action -> $($r.StatusCode)" }
  catch { $code = $_.Exception.Response.StatusCode.value__
          $err = try { (($_.ErrorDetails.Message | ConvertFrom-Json).error) } catch { '?' }
          "$action -> $code ($err)" }
}
```

Hinweis: Eine **erfolgreiche** Antwort auf `grant` bzw. `stream` enthält die Adresse. `Probe` zeigt sie nicht an, verwirft aber auch nichts. Nur das Ergebnis der Funktion notieren, nie `$r.Content` ausgeben.

## Testfälle

| Nr. | Fall | Vorgehen | Erwartet |
|---|---|---|---|
| T1 | Gültiger Host darf freigeben | H startet die Party, wählt eine Nuvio-Cloud-Quelle und drückt „HLS erstellen / aktualisieren“. Danach „Share my stream“ an und A unter „Familienfreigabe“ einschalten. | Panel: „Familienfreigabe aktiv für 1 Mitglied.“ |
| T2 | Zugelassenes Mitglied darf abrufen | A tritt im Browser bei (Auto-Modus an). | Video lädt, springt zur Party-Zeit und startet (ggf. stumm). Quelle „TorBox (Familie)“. Optional: `Probe grant $JA @{party_id=$P; device_id=$DA}` ergibt `200`. |
| T3 | Fremdes Konto ohne Mitgliedschaft | X ist angemeldet, aber **nicht** beigetreten: `Probe grant $JX @{party_id=$P; device_id='x-test-device'}` | `403 (not_member)` |
| T4 | Fremde `device_id` übernimmt keine Mitgliedschaft | `Probe grant $JX @{party_id=$P; device_id=$DA}`, also Konto X mit der Geräte-ID von A | `403 (not_member)`. **Danach:** A lädt neu und bekommt die Quelle weiterhin (T2 erneut `200`), A ist also nicht verdrängt worden. |
| T5 | Nicht zugelassenes Mitglied | B tritt bei (nicht eingeschaltet). `Probe grant $JB @{party_id=$P; device_id=<Geräte-ID von B>}` | Browser B: „nicht zugelassen“, kein Video; `Probe` ergibt `403 (not_admitted)`. |
| T6 | Fremder ohne Session und ohne Grant | `Probe stream $null @{party_id=$P; grant=('A'*43)}` | `401 (grant)` |
| T7 | Entferntes Mitglied erhält keine neue Freigabe | H entfernt A aus der Party. Danach `Probe grant $JA @{party_id=$P; device_id=$DA}` | `403 (not_member)`. Browser A: Party beendet bzw. entfernt. Wer schon lief, darf lokal weiterspielen; das ist die bekannte Grenze. |
| T8 | Zulassung entziehen | A erneut beitreten lassen (neues Mitglied), zulassen, laden. Dann H schaltet A aus. | Browser A stoppt die Quelle sofort: „nicht zugelassen“. |
| T9 | Widerruf über „Share my stream“ | H schaltet „Share my stream“ aus. | Alle Browser stoppen; `Probe grant $JA …` ergibt `404 (no_share)`. |
| T10 | Hostwechsel: alte Grants nicht erneuerbar | Mit D als zweitem Desktop-Mitglied: A ist zugelassen und lädt. Dann wird H **hart beendet** (Task-Manager, kein Widerruf). Warten, bis das Backend D zum Host macht (in D sichtbar). Danach `Probe grant $JA …` | `403 (host_changed)`. Spätestens 5 min nach dem letzten Grant ergibt auch ein Reconnect von A nichts mehr (`stream` → `401`). Ernennt das Backend keinen neuen Host, endet die Party: `403 (not_member)`. |
| T11 | Ablauf ohne Host | wie T10, aber ohne D | Nach höchstens 30 min (keine Verlängerung): `Probe grant $JA …` ergibt `404`, oder schon früher `403`, wenn die Party endet. |
| T12 | Rate-Limit greift, Reconnect bleibt frei | Von einem Rechner aus 35-mal `Probe grant $JX …` in einer Minute | Ab etwa dem 31. Aufruf `429 (rate_limited)`, mit `Retry-After`. Gleichzeitig lädt A über einen Reload weiter: Ein Reconnect nutzt `stream` mit eigenem Budget. |
| T13 | CORS ist keine Sperre | T3 per PowerShell (ohne Origin) | Auch ohne Browser gibt es keine Daten: `403`. Die Sicherheit hängt nicht an CORS. |

## Auswertung

- **Bestanden**, wenn T3 bis T13 die erwarteten Codes liefern und T1 und T2 funktionieren. Notiert werden nur Nummer, Statuscode und Fehlercode.
- **Sofort abbrechen und die Freigabe beenden**, falls T3, T4, T5, T7 oder T10 `200` ergeben. Dann den TorBox-Key neu erzeugen und mir nur die Nummer des Falls und den Statuscode nennen.
- **Nach dem Test:** „Share my stream“ aus, Party beenden, Browser abmelden, DevTools-Logs leeren. Optional den TorBox-Key neu erzeugen.
