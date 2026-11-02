# Browser-Steuerung: Preview-Diagnose und Backend-Lösung

Stand: Branch `feature/party-mobile-sync-control` (`ca5a2c24`). In diesem Schritt wurden kein Produktcode, keine Tests, keine Builds und keine Deployments geändert bzw. ausgeführt. Desktop-Originalstream, TorBox-HLS und Synchronisierung bleiben unverändert.

## 1. Befund zum Autorisierungsvertrag

- Das Repository enthält **keine** SQL-Definition von `watch_party_update`, `watch_party_set_host_only` oder den Realtime-Policies. Sie liegen im Nuvio-Backend (`api.nuvio.tv`).
- Clientseitig belegt ist nur: Der Aufruf erfolgt mit dem Supabase-JWT des Nutzers und `p_device_id` und liefert einen Snapshot zurück.
- **Nicht belegt** ist, ob der Server Mitgliedschaft, `host_only`, die Übereinstimmung von `member_id` mit dem Aufrufer und die Sequenzordnung prüft. Auch ob Clients `state` frei broadcasten dürfen, ist offen.
- **Ergebnis:** Der Vertrag ist nicht verifiziert. **Keine Production-Freigabe.** `VITE_PARTY_GUEST_CONTROL` bleibt in Production ungesetzt.

## 2. Aktivierung nur in einer isolierten Preview

Cloudflare Pages kennt Variablen nur pro Umgebung (Production / Preview), nicht pro Branch. Isolation deshalb so:

1. Pages → `nuvio-watch-friends` → Settings → Builds & deployments → **Preview branch control**: „Custom branches“, nur `feature/party-mobile-sync-control` aufnehmen.
2. Settings → Environment variables → **Preview**: `VITE_PARTY_GUEST_CONTROL = 1`, dazu dieselben `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` wie Production. **Production unverändert lassen.**
3. Den nächsten Preview-Build für den Branch manuell anstoßen (Deployments → Retry), da Variablen nur beim Build eingebettet werden. Die Preview-URL `<hash>.nuvio-watch-friends.pages.dev` nicht öffentlich teilen.
4. Nach der Diagnose die Preview-Variable wieder entfernen.

Hinweis: Ob die Preview-Origin vom Backend für Auth/Realtime zugelassen ist, muss sich im Test zeigen (Login und „Verbunden“).

## 3. Diagnoseablauf (manuell, MSI 0.1.36 als Host)

1. Desktop-Host: Party starten, „Host only“ **ausschalten**, „Share my stream“ aktivieren.
2. Browser (Preview) mit eigenem Nuvio-Konto beitreten, Konsole: `sessionStorage.setItem('nuvio-party-debug','1')`, neu laden, beitreten, Stream laden, „Wiedergabe synchronisieren“.
3. Diagnosepanel „Lokale Sync-Diagnose“ ablesen:

| `controlBlockedReason` | Bedeutung | Nächster Schritt |
| --- | --- | --- |
| `disabled_in_build` | Flag nicht im Build | Schritt 2.3 wiederholen |
| `host_only` | Snapshot meldet `host_only=true` | Schalter am Desktop prüfen; 45 s Heartbeat bzw. Neuladen abwarten |
| `host_only_missing` | Backend liefert `host_only` nicht | Backend-Snapshot erweitern (Abschnitt 4) |
| `no_channel` | Realtime nicht verbunden | Login/Origin/Netzwerk |
| `allowed` | Buttons sichtbar | weiter mit 4 |

4. **Party pausieren** klicken, dann `lastCommandResult` ablesen:

| `lastCommandResult` | Bedeutung |
| --- | --- |
| `confirmed` | Server hat genau diesen Befehl gespeichert; Broadcast gesendet. Desktop muss pausieren. |
| `not_confirmed` | Server speichert Gastbefehle nicht oder liefert einen anderen Zustand. Der Browser verteilt deshalb nichts. |
| `host_only` | Server meldet Host-only. |
| `rpc_failed` | RPC-Fehler (z. B. `forbidden`, `not_member`). |
| `stored_not_broadcast` | Gespeichert, aber Realtime-Senden fehlgeschlagen. |

5. Bei `confirmed`: Folgt der Desktop-Host? Folgt ein zweiter Gast? Erst dann ist der Client-Teil funktionsfähig. **Auch dann keine Production-Freigabe**, solange Abschnitt 4 nicht bestätigt ist, denn `confirmed` beweist nicht, dass der Server Host-only oder fremde `member_id` ablehnt.

Optional, ohne Geheimnisse weiterzugeben: mit zwei Konten gegenprüfen, dass bei „Host only“ **an** ein Befehl `host_only` oder `rpc_failed` ergibt. Diese Prüfung erzwingt der Browser bereits selbst, sie sagt also nur dann etwas über den Server aus, wenn man sie direkt per RPC testet. Das ist Aufgabe des Backend-Betreibers.

## 4. Minimalinvasive sichere Lösung (Backend)

Voraussetzung ist Zugriff auf das Backend. Ohne ihn bleibt die Funktion aus. Keine neue App-Architektur, kein zusätzlicher Dienst; die Clients bleiben bis auf einen späteren Schritt unverändert.

**Schritt A – RPC härten** (Pseudo-SQL; Tabellen- und Spaltennamen an das reale Schema anpassen):

```sql
-- inside watch_party_update(p_party_id uuid, p_device_id text, p_media jsonb, p_playback jsonb)
select m.id into v_member from watch_party_members m
 where m.party_id = p_party_id and m.user_id = auth.uid() and m.device_id = p_device_id
   and m.removed_at is null;
if v_member is null then return jsonb_build_object('error','not_member'); end if;
select * into v_party from watch_parties where id = p_party_id and ended_at is null for update;
if v_party is null then return jsonb_build_object('error','party_ended'); end if;
if p_media is not null and v_member <> v_party.host_member_id then return jsonb_build_object('error','forbidden'); end if;
if p_playback is not null then
  if v_party.host_only and v_member <> v_party.host_member_id then return jsonb_build_object('error','host_only'); end if;
  if (p_playback->>'member_id') is distinct from v_member::text then return jsonb_build_object('error','forbidden'); end if;
  if (p_playback->>'media_key') is distinct from <media_key(v_party.media)> then return <snapshot>; end if;
  -- Same ordering as PartySync.isNewer: higher seq, tie -> higher member_id.
  if v_party.playback is null
     or (p_playback->>'seq')::bigint > (v_party.playback->>'seq')::bigint
     or ((p_playback->>'seq')::bigint = (v_party.playback->>'seq')::bigint
         and p_playback->>'member_id' > v_party.playback->>'member_id') then
    update watch_parties set playback = p_playback where id = p_party_id;
  end if;
end if;
return <snapshot incl. host_only>;   -- host_only always explicitly true/false
```

**Schritt B – Snapshot:** `host_only` in Join, Heartbeat und Update immer ausdrücklich liefern. Das behebt `host_only_missing`.

**Schritt C – Server-Herkunft für `state`** (schließt gefälschte Broadcasts aus):

```sql
create trigger watch_party_state_broadcast after update of playback on watch_parties
for each row when (new.playback is distinct from old.playback)
execute function watch_party_broadcast_state();   -- calls realtime.send(new.playback, 'state', 'watch-party:' || new.id, true)
```

Dazu eine Realtime-Authorization-Policy auf `realtime.messages`: Mitglieder dürfen `watch-party:<id>` lesen; Client-Inserts mit `event = 'state'` werden verweigert.

**Client-Folge** (erst nach A–C, separater Auftrag): Browser und Desktop senden `state` nicht mehr selbst und verlassen sich auf den Server-Broadcast. Der Desktop braucht dafür einen neuen MSI. Bis dahin genügen A und B für die Browser-Freigabe, wenn eine Restschwäche bewusst akzeptiert wird: Client-Broadcasts bleiben fälschbar, das gilt aber unverändert auch für Desktop-Gäste.

## 5. Freigabekriterien für Production

1. Backend-Schritte A und B vom Betreiber bestätigt (Code-Review des SQL), C empfohlen.
2. Preview: `allowed` → `confirmed`, Desktop und zweiter Gast folgen Pause, Fortsetzen und Sprung; bei Host-only an kein Effekt.
3. Erst dann `VITE_PARTY_GUEST_CONTROL=1` in Production setzen und neu bauen. Bis dahin bleibt es aus.
