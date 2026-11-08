# Host-unabhängige Watch Party: Analyse und Etappenplan

Stand `bc30f009` (05.11.2026). Nur Analyse, keine Codeänderung. **Entscheidung 05.11.2026: Kein HLS-Proxy (H2/P3 gestrichen).** Die Aussagen zum offiziellen Nuvio-Backend (`watch_party_*`, Realtime-Policies) sind aus dem Client-Code abgeleitet und **nicht einsehbar**.

## 1. Was heute schon erfüllt ist

| Anforderung | Stand |
|---|---|
| Leave ≠ End | **Erfüllt.** „Leave“ ruft `watch_party_leave` auf, „End for everyone“ `watch_party_end` (mit Bestätigung). |
| Party lebt über den Host hinaus | **Teilweise.** Das Backend ernennt bei einem Leave des Hosts offenbar ein anderes Mitglied (`host_member_id` ändert sich; Desktop und Browser behandeln das ausdrücklich). Bei Absturz, PC aus oder Netzverlust gibt es keinen Leave-Aufruf: Der Host bleibt im Backend Host, bis eine Zeitgrenze greift, die nicht einsehbar ist. |
| Wiedergabe läuft ohne Host weiter | **Teilweise.** Der Party-Stand ist „Position + Startzeit + Tempo“; alle Clients rechnen ihn über die Server-Uhr selbst fort. Ein spielender Film läuft bei Desktop- und Browsergästen weiter, auch wenn der Host verschwindet. |
| Stream nicht über den Host | **Erfüllt.** Browser laden HLS direkt bei TorBox (bzw. die Adresse vom Freigabedienst), Desktop-Gäste ihre eigene oder die geteilte Original-Quelle direkt beim Anbieter. Der Host-PC liegt nie im Medienpfad. |
| Keine zweite Autorität | **Teilweise.** `PartySync.coordinatorId` wählt deterministisch: den Host, wenn online, sonst das erste Online-Mitglied, aber **nur ohne Host-only**. Sequenznummer und Member-ID (`isNewer`) lösen gleichzeitige Stände eindeutig auf. |

## 2. Was noch vom ursprünglichen Host abhängt

1. **Koordinator bei Host-only:** Mit „Only I can control playback“ bleibt der Host Koordinator, auch offline (`coordinatorId` gibt dann den Host zurück). Niemand übernimmt das Warten auf Puffernde, Pause und Fortsetzen.
2. **Browser kann nie Koordinator sein:** Wird ein Browser-Gast vom Backend zum Host ernannt, beendet er seine Sitzung („Der Desktop-Host hat die Party verlassen“, `host_left`). Bei einem Host-Wechsel schaltet der Browser auf „lokal weiter“ (Allein) und verlässt damit den Sync.
3. **Stream-Freigabe:** Nur der Host beantwortet `state_request` mit dem `stream`-Ereignis. Neue Teilnehmer bekommen ohne Host keine Quelle.
4. **TorBox-HLS-Erneuerung:** Nur der Host-Desktop prüft die HLS-Adresse alle 60 s und erzeugt sie bei Ablauf neu (er braucht dafür den TorBox-Key).
5. **Familienfreigabe:** Der Host verlängert sie alle 10 min (Laufzeit 30 min). Der Worker bindet sie an `host_member_id`, nach einem Host-Wechsel gibt es also bewusst **keine** neuen Berechtigungen (Härtung S2). Nach höchstens 30 min ohne Host ist sie weg.
6. **Medienwechsel und Countdown:** nur durch den Host (bzw. Koordinator).

## 3. Wie Freigaben und HLS heute erneuert werden

- **TorBox `createstream`:** vom Host-Desktop mit seinem Account-Key, eine Session pro Datei, Prüfung alle 60 s, Neuerzeugung bei 401/403/404/410 (höchstens 3-mal).
- **Familienfreigabe:** Der Host veröffentlicht beim Worker (Durable Object pro Party). Gäste holen sich per Session plus Mitgliedschaftsprüfung (`watch_party_heartbeat`) eine Berechtigung (5 min) und erhalten die TorBox-Adresse **mit Key**.
- Eine **bereits geladene** TorBox-Adresse funktioniert beim Gast weiter, solange TorBox die Session gelten lässt. Wie lange das ist, ist nicht dokumentiert. Danach steht der Gast ohne Host still.

## 4. Minimal-invasive, zuverlässige Lösung

Die vorhandenen Bausteine reichen. Der Kern ist: **Der Party-Share-Worker wird zur Stream-Autorität**, und die Sync-Autorität wechselt deterministisch über die bestehenden Regeln.

1. **Stream-Autorität im Worker (ohne Proxy):**
   - Der Host hinterlegt beim Einschalten von „Share my stream“ **mit ausdrücklicher Zustimmung** seinen TorBox-Key sowie Torrent- und Datei-IDs im Durable Object der Party.
   - Speicherung: zusätzlich mit einem Worker-Secret verschlüsselt, Lebensdauer an die Party gebunden (höchstens 12 h), gelöscht bei „End for everyone“, „Share my stream“ aus oder Widerruf.
   - Der Worker ruft selbst `createstream` auf, erneuert die Adresse bei Ablauf und gibt sie über die bestehende Berechtigung an jedes aktuelle Mitglied (Prüfung per `watch_party_heartbeat`). Der Host muss nicht online bleiben.
   - **Ohne Proxy** erhalten die Browser dabei die TorBox-Adresse **mit Account-Key**, wie heute schon mit P2. Anforderung 11 („keine vollständigen Keys an Gäste“) ist damit **nicht erfüllt**. Die Medien laden die Browser weiter direkt bei TorBox.
2. **Sync-Autorität:**
   - `coordinatorId` gilt auch bei Host-only, sobald der Host länger als eine Schwelle (z. B. 20 s) ohne Presence ist. Das erste Online-**Desktop**-Mitglied in Backend-Reihenfolge übernimmt.
   - Alle Clients rechnen dieselbe Regel auf derselben Mitgliederliste; dazu kommt der bestehende Gleichstand-Entscheid über Sequenz und Member-ID.
   - Kehrt der Host zurück, übernimmt er wieder, ohne dass der Stand springt (er übernimmt die laufende Sequenz).
3. **Browser bleiben im Sync:** Ein Host-Wechsel schaltet Browser nicht mehr auf „Allein“. Sie folgen dem neuen Koordinator. Eine Ernennung des Browsers durch das Backend beendet die Sitzung nicht mehr, solange ein Desktop koordiniert.
4. **Neue Teilnehmer ohne Host:** Der Worker beantwortet die Quelle (TorBox-Adresse) direkt. `state_request` beantwortet auch der aktuelle Koordinator mit dem Party-Stand. Die Quelle kommt vom Worker, nicht vom Host.
5. **Browser als Koordinator** (nur wenn kein Desktop mehr online ist): Er wäre möglich, weil der Browser schon Stände veröffentlichen kann (Gast-Steuerung). Das ist aber eine eigene, spätere Etappe.

## 5. Sicherheits-, Kosten- und TorBox-Grenzen

- **Key beim Worker:** Das ist eine serverseitige Speicherung eines Account-Keys mit vollem Zugriff. Sie braucht Zustimmung, Verschlüsselung, Laufzeit, Widerruf und Rate-Limits; du hast das in Punkt 11 bereits so gefordert. Wer dein Cloudflare-Konto kontrolliert, könnte den Key auslesen; deshalb 2FA aktivieren.
- **Cloudflare:**
  - Ohne Proxy laufen keine Videodaten über Cloudflare; nur Freigabe- und Erneuerungsanfragen (wenige pro Gast und Stunde).
  - Der Key liegt im Worker **und** in den Adressen bei den Gästen; ein Widerruf beendet nur weitere Abrufe, nicht die Nutzbarkeit eines schon übertragenen Keys.
- **TorBox:**
  - Alle Abrufe kommen dann von Cloudflare-IPs.
  - Gleichzeitige Streams pro Account, Fair Use und Rate-Limits für `createstream` gelten.
  - Die Lebensdauer einer Stream-Session ist nicht dokumentiert.
  - Eine Session für alle Teilnehmer (nicht eine pro Gast) schont das Kontingent.
- **Backend nicht einsehbar:**
  - Zeitgrenze bis zum Host-Wechsel nach einem Verbindungsabbruch
  - ob Nicht-Hosts bei Host-only Stände persistieren dürfen (`watch_party_update`)
  - ob die Party beim Leave des Hosts manchmal endet statt zu wechseln
  - Das muss live gemessen werden.
- **Bestehende Grenzen bleiben:** Realtime-Absender werden nicht vom Server geprüft. Der Party-Code bleibt die Beitrittsberechtigung.

## 6. Etappen mit Abnahmekriterien

| Etappe | Inhalt | Abnahme |
|---|---|---|
| **H0 Messung** | Live mit 2 Desktops und 1 Browser messen: Host-Leave, NUVIO schließen, PC aus, Netz trennen. Notieren: Zeit bis `host_member_id` wechselt, Verhalten des Party-Stands, ob die Party endet. | Protokoll mit Zeiten und Backend-Verhalten; keine Codeänderung. |
| **H1 Sync-Failover** | `coordinatorId` mit Presence-Schwelle auch bei Host-only; der Koordinator beantwortet `state_request`; Browser bleiben bei Host-Wechsel im Sync; Rückkehr des Hosts ohne Sprung. | Bei allen vier Ausfallarten laufen die verbleibenden Player ohne Neustart und Positionsverlust weiter (Drift < 1 s nach 30 s). Nie zwei Koordinatoren gleichzeitig (Test mit gleichzeitigem Ausfall und Rückkehr). „End for everyone“ beendet weiterhin alles. |
| ~~H2 HLS-Proxy (P3)~~ | **Gestrichen** (Entscheidung 05.11.2026). Folge: Gäste erhalten die TorBox-Adresse mit Account-Key. | – |
| **H3 Stream-Autorität im Worker** | Zustimmung des Hosts; verschlüsselter Key im Durable Object; `createstream` und Erneuerung im Worker; Ausgabe der erneuerten TorBox-Adresse an aktuelle Mitglieder; Laufzeit, Widerruf, Rate-Limits. | Host-PC aus: Bestehende und neue Browserteilnehmer bekommen weiter eine Quelle, auch nach Ablauf der TorBox-Adresse. „End for everyone“ und „Share my stream“ aus löschen den Key nachweislich. |
| **H4 Browser-Koordinator** | Nur wenn kein Desktop online ist: Der Browser übernimmt die Koordination über die bestehende Gast-Steuerung. | Party nur aus Browsern läuft weiter; keine widersprüchlichen Stände. |

Desktop-Streamingqualität, Command-ID/ACK, exakter Seek und Player-Bridge bleiben in allen Etappen unverändert. Jede Etappe wird einzeln umgesetzt, getestet und freigegeben.
