# Premium-Oberfläche und passwortloser Gastzugang

Branch `feature/party-premium-ui`, abgezweigt von `feature/party-mobile-sync-control` (`ca5a2c24`). Nur `browser-site/` geändert. Nicht ausgeführt: Tests, Build, Deployment, Commit. Status: **implementiert, nicht lokal getestet, nicht live getestet**.

## Final-Master-Stand (nach Commit `31650756`, uncommittet)

**Einladung:** Der Hinweisbalken und die Überschrift „Du bist zu einer Watch Party eingeladen.“ sind entfernt. Es gibt nur noch die Filmkarte mit „[Host] lädt dich ein“, Titel bzw. Logo, Episode, Beschreibung, Host und Plätze, darunter **Name + „Jetzt ansehen“**. Der Play-Button im Bild löst denselben Ablauf aus. Der Party-Code kommt ausschließlich aus `/party/<CODE>` (`partyCodeFromPath`/`normalizeCode`/`validCode`). Das Code-Feld erscheint nur, wenn der Link keinen gültigen Code enthält, zusammen mit einem Hinweis. Die Kontoanmeldung öffnet sich erst nach „Jetzt ansehen“ ohne nutzbare Sitzung, kompakt in der Karte und mit „Zurück“; danach geht es automatisch weiter. Statusmeldungen erscheinen als kurze Toasts unten (4,5 s, Fehler 9 s) statt als Dauerbanner.

**Kino-Player:** einspaltig und horizontal zentriert (`justify-items: center`, symmetrische Ränder). Die Breite ist `min(96vw, 1720px, (100svh − 16px) · 16/9)` bei `aspect-ratio: 16/9` und `object-fit: contain`. Die Markenleiste wird im Player ausgeblendet.

| Fenster (Innenmaß ca.) | Player-Breite (berechnet, nicht gemessen) |
| --- | --- |
| 1920 × 955 (1080p-Monitor, Browser maximiert) | ≈ 1669 px |
| 1440 × 815 (900p-Monitor) | ≈ 1382 px (Begrenzung durch 96vw) |
| 1366 × 680 (768p-Monitor) | ≈ 1180 px |
| Smartphone hochkant | 100vw |

Die Teilnehmerleiste liegt unter dem Player und verkleinert ihn nicht. Bei voller Höhe sitzt sie knapp unterhalb des sichtbaren Bereichs (vertikal scrollbar, keine horizontale Scrollbar).

**Controls nach Referenz (eigene SVG-Icons):** oben Zurück (zur Einladung, ohne die Party zu verlassen; „Zurück zur Party“ synchronisiert wieder) und Info. Darunter eine breite Zeitleiste mit Restzeit. Links Play/Pause, −10 s, +10 s, Ton (Lautstärkeregler bei Hover). In der Mitte der Titel. Rechts **„Synchron“-Badge** (Synchron / Puffert … / Nicht synchron / Verbindung unterbrochen, aus dem echten Zustand) und **„Party-Zeit aktualisieren“** (bestehendes `resync`), dazu Qualität (nur bei echten Varianten), Chat und Vollbild (iOS: nativer Vollbildplayer). Die Controls blenden sich mit der Maus ein und bei Inaktivität aus; bei Pause bleiben sie sichtbar. Auf Touch-Geräten blendet ein Tipp sie ein bzw. aus. Tastatur: Leertaste/K, ←/→, F, M, Esc.

**Info-Drawer** (rechts, auf Smartphones als Bottom Sheet) mit Host, Party-Code, Qualität, Teilnehmern, Chat (aufklappbar), „Technik“ (Streaminfo, eigene HLS-URL) und „Party verlassen“. Die Teilnehmerleiste unter dem Player zeigt bis zu 5 Avatare und „Teilnehmer · 2/8“ und öffnet den Drawer.

**Lokale Bedienung repariert:** Play zeigte bei pausierter Party und Host-only bisher scheinbar keine Wirkung, weil der Player sofort wieder pausierte. Jetzt spielt Play lokal weiter und markiert das ehrlich als „Nicht synchron“ mit Hinweis; „Party-Zeit aktualisieren“ holt zurück. Ein vom Browser blockierter Start (`NotAllowedError`) erzeugt eine Meldung. Ohne Stream erklärt Play, dass der Host freigeben muss. Gemeinsame Steuerung über dieselben Controls nur mit `VITE_PARTY_GUEST_CONTROL=1`.

## One-Screen-Cleanup und Untertitel (nach `bcbc6382`, uncommittet)

- **Scrollfrei:** `.watch` hat genau die Viewport-Höhe mit `overflow: hidden`. Unter dem Player gibt es nichts mehr (Teilnehmerleiste und Steuerungstext entfernt). Der Player misst `min(98vw, 1920px, (100svh − 8px) · 16/9)`, berechnet ca. 1683 px bei 1920 × 955 und durch 96–98vw begrenzt bei 1440 px.
- **Entfernt aus dem Player:** Info-Icon oben rechts, „PARTY <CODE>“, die Leiste unter dem Player. Der Steuerungsmodus steht jetzt im Drawer; der Rechtshinweis gibt es nur noch auf der Einladung.
- **Teilnehmer:** kompakte Badge oben rechts im Player („2/8 Teilnehmer“ mit Avataren); sie öffnet den Drawer und verkleinert den Player nicht.
- **Titel:** „Serie · S2 E10 · Folgentitel“ bzw. Filmtitel; fehlende Teile werden weggelassen.
- **Untertitel:**
  - (A) hls.js-Untertitel-Renditions (`EXT-X-MEDIA TYPE=SUBTITLES`) bzw. native Text-Tracks (Safari) sind auswählbar, sofern die Quelle sie liefert. Ob TorBox-HLS solche Tracks enthält, ist **nicht bestätigt**. Ohne Tracks zeigt das Menü „Diese Quelle liefert keine Untertitel.“
  - (B) Lokale `.vtt`/`.srt`-Datei (max. 2 MB). SRT wird im Browser zu WebVTT konvertiert und als `blob:`-Track eingebunden (CSP `media-src blob:`). Sie gilt nur lokal und wird bei Filmwechsel entfernt.
  - Externe Untertitel-URLs sind bewusst nicht eingebaut: CORS-abhängig und ein weiterer Fremdabruf.
- **Gemeinsame Steuerung:** Die Kette (Geste → `pause`/`play`/`seeking` → `sendControl` → `prepareControl`/`commitControl` → `watch_party_update` → nur bestätigt `state`-Broadcast → Desktop `accept`) ist im Frontend vollständig verdrahtet, hat Loop-Schutz und ist getestet. In Production ist sie **bewusst aus** (`VITE_PARTY_GUEST_CONTROL` nicht gesetzt); deshalb wirkt Browser-Pause dort nur lokal. Der Blocker ist der nicht verifizierte Backend-Vertrag (siehe oben), kein Frontend-Fehler.
- **Desktop-Parität (umgesetzt, Entscheidung des Inhabers, Standard):** Wie Nuvio Desktop-Gäste (`PartyRepository.publish`): Wenn der Host Gaststeuerung erlaubt (`host_only=false` im DB-Snapshot), sendet der Browser bei Play, Pause oder Spulen sofort den `state`-Broadcast (`seq + 1`, eigene `member_id`, `media_key`, `waiting=false`) und speichert danach per `watch_party_update`. Der Desktop übernimmt ihn über `accept()` (Host-only, Medienkennung, `isNewer`).
  - Ein Speicherfehler macht den verteilten Zustand nicht rückgängig, genau wie am Desktop.
  - Ein fehlgeschlagener Broadcast wendet nichts an.
  - Meldet die Speicherantwort `host_only=true`, endet die Steuerung sofort.
  - Vertrauensbasis wie bei Desktop-Gästen: Die Absender-ID in Realtime-Nachrichten ist fälschbar, und der Server prüft den Befehl nicht nachweislich. Für einen echten Schutz bleibt die Backend-Erweiterung (serverseitiger Broadcast, Policies) nötig.
  - `VITE_PARTY_GUEST_CONTROL`: leer/`desktop` = Parität, `confirmed`/`1` = nur nach Server-Bestätigung, `off` = nur lokal.
  - Voraussetzung im Betrieb: Am Desktop muss „Host only“ ausgeschaltet sein.

## Final Cleanup (Refresh-Icon, Footer, Gastzugang)

- `#resync` ist jetzt ein runder Refresh-Icon-Button (`aria-label`/`title` „Party-Zeit aktualisieren“, sichtbar deaktiviert). Handler unverändert; Code überschreibt das Icon nicht mehr mit Text.
- Der Footer `#legal` und sein CSS sind entfernt.
- Die Einladung passt auf eine Desktop-Bildschirmhöhe: Cover-Höhe `min(Breite · 9/16, 42vh)`, kompaktere Abstände bei Höhe ≤ 820 px. Smartphones dürfen weiter scrollen (Tastatur); es gibt kein globales `overflow: hidden`.
- **Name-only: weiterhin nicht möglich.** Unverändert gilt:
  - Kein Beleg, dass das offizielle Backend anonyme Supabase-Nutzer für Party-RPCs, Realtime und RLS zulässt.
  - Nuvio Desktop selbst verlangt ein echtes Konto.
  - Kein Zugriff auf SQL, Policies oder Projekteinstellungen.
  - Der Login bleibt als funktionierender Fallback, nur bei Bedarf.
- **Eigene kontrollierte Erweiterung, Plan (nicht umgesetzt):** Ein Gast kann nur Mitglied einer Party werden, die die offizielle Datenbank führt. Ohne Mitwirkung des Backend-Betreibers gibt es deshalb keinen sicheren Weg. Möglich wäre:
  1. Im **offiziellen** Supabase-Projekt Anonymous Sign-In aktivieren, mit CAPTCHA (Turnstile) und Rate-Limit.
  2. `watch_party_join` akzeptiert `is_anonymous` nur mit gültigem, laufendem Code und freier Kapazität; Mitgliedschaft an `auth.uid()` gebunden; Name begrenzt; anonym nie Host.
  3. Heartbeat, Leave, Chat und Update sowie die Realtime-Policies auf `watch-party:<id>` prüfen dieselbe Mitgliedschaft.
  4. Danach im Browser `VITE_PARTY_GUEST_JOIN=1` setzen (Code bereits vorhanden). Das ist dann nur ein Cloudflare-Update.

  Ein separater eigener Server oder ein eigenes Supabase-Projekt kann keine Mitgliedschaft in Nuvio-Parties erteilen und würde Realtime nicht autorisieren; diese Variante ist nicht tragfähig.
- **Status:** UI vorbereitet; echter passwortloser Beitritt funktioniert **nicht**.

## Sicherheitsbefund: Streamfreigabe

- **Bestätigt (Code):** Der Desktop sendet ein einziges `stream`-Broadcast an **alle** Kanalmitglieder: Original-URL, Original-Header, Dateiname und zusätzlich `browser_hls`. Browser-Gäste erhalten damit auch die Desktop-Originalquelle (z. B. Debrid-/CDN-Link mit Token) und deren Header, obwohl sie nur HLS nutzen. Der vollständige TorBox-Account-Key wird ausgeschlossen (`containsAccountKey`), zeitlich begrenzte Stream-Tokens aber nicht.
- **Nicht verifizierbar:** wer `watch-party:<id>` abonnieren darf (Realtime-Policies), und wie lange die Links gültig sind (anbieterabhängig).
- Der Browser loggt keine URLs; die Diagnose enthält nur Zahlen und feste Labels.
- **Lösung (nicht umgesetzt, Desktop-Änderung → neuer MSI):** Desktop-Hosts senden den Originalstream nur in einem Ereignis, das Browser-Gäste nicht erhalten, z. B. ein serverseitig verteilter Kanal nur für Desktop-Mitglieder. Alternativ ein getrenntes `browser_stream`-Ereignis ohne Originalfelder, das Browser ausschließlich abonnieren; das schützt aber nur, wenn die Realtime-Policies Browser-Mitglieder vom Desktop-Ereignis ausschließen, also wieder eine Backend-Anforderung. Ohne Backend-Unterstützung ist eine echte Trennung nicht möglich, weil Realtime-Broadcasts an alle Kanalmitglieder gehen.

## Neue Nutzerführung

1. Der Link `/party/<CODE>` öffnet die **Einladung**: „[Host] lädt dich zu [Titel] ein.“, Backdrop bzw. Poster (sonst eleganter Verlauf), Logo oder Titel, Staffel/Episode, Beschreibung, Host-Avatar und Plätze.
2. **Name eingeben → „Jetzt ansehen“** (oder der große Play-Button im Bild).
   - Bestehende Nuvio-Sitzung im Browser: sofortiger Beitritt.
   - Keine Sitzung: Es erscheint einmalig die Kontoanmeldung in derselben Karte; danach geht es automatisch weiter. Weitere Besuche brauchen nur noch Name und Play, solange die Sitzung im Browser gespeichert bleibt.
3. **Player:** großer Play-Button sobald der Host den Stream teilt → Stream lädt → der Player folgt automatisch der Party-Zeit. Blockiert der Browser Autoplay, reicht ein Tippen auf Play.
4. Eigene Controls: Play/Pause, Zeitleiste, Zeit, Ton/Lautstärke, Sync-Status („Synchron“, „Puffert …“, „Nicht synchron“) mit „Wiedergabe synchronisieren“, Qualität (nur echte Varianten), Party-Bereich, Vollbild (iOS: nativer Vollbildplayer). Die Controls blenden sich bei Inaktivität aus. Tastatur: Leertaste/K, F, M.
5. Party-Bereich rechts (Desktop) bzw. unter dem Player (Tablet/Smartphone): Host, Steuerungsmodus, Teilnehmer, Chat (eingeklappt), eigene HLS-URL (Beta), Verlassen.

Design: eigenständig, dunkel und kinoartig. Streamingdienste dienten als Inspiration, es wurden keine Logos, Marken oder Assets kopiert. Systemschriften (die CSP erlaubt keine externen Fonts), Akzent Koralle, `prefers-reduced-motion`, Safe Areas, sichtbare Focus-Styles.

## Auth-Modell und Backend-Blocker (Name-only)

- `PartySession.join()` lehnt anonyme Supabase-Nutzer weiterhin ab, außer der Build setzt `VITE_PARTY_GUEST_JOIN=1`. Dann wird `supabase.auth.signInAnonymously()` genutzt, und `join(..., {allowAnonymous: true})` überlässt die Entscheidung dem Server.
- **Befund:** Nuvio Desktop verlangt für Parties selbst ein echtes Konto (`PartyRepository`: `signedIn && !isAnonymous`). Seine „anonyme“ Anmeldung ist nur eine lokale UUID ohne Supabase-Sitzung. Es gibt also **keinen Beleg**, dass das Backend anonyme Supabase-Nutzer für `watch_party_join`/Realtime autorisiert oder dass Anonymous Sign-In im Projekt aktiviert ist. Die SQL-/RLS-Definitionen liegen nicht im Repository.
- **Daher:** Name-only ist implementiert, aber **standardmäßig aus**. Der sichere Login bleibt als Fallback, wird aber nur noch einmal pro Browser gebraucht.
- **Minimale Backend-Anforderung** für die Freigabe:
  1. Anonymous Sign-In im Supabase-Projekt aktivieren, mit CAPTCHA/Rate-Limit.
  2. `watch_party_join` akzeptiert `auth.jwt()->>'is_anonymous' = 'true'` nur mit gültigem, nicht beendetem Code und freier Kapazität; begrenzter Anzeigename; die Mitgliedschaft wird an `auth.uid()` gebunden.
  3. Heartbeat/Leave/Chat/Realtime-Policies prüfen dieselbe Mitgliedschaft; anonyme Mitglieder dürfen kein Host werden.
  4. Host kann entfernen; ein Rate-Limit pro IP/Party gegen Massenbeitritte.
  5. Danach Preview mit `VITE_PARTY_GUEST_JOIN=1` testen, dann Production.

## Gemeinsame Steuerung

Die separaten Buttons „Party pausieren/fortsetzen“ sind entfernt. Play, Pause und Zeitleiste im Player markieren eine Nutzergeste. Die bestehende Logik entscheidet dann:

- Mit `VITE_PARTY_GUEST_CONTROL=1` und `host_only=false`: gemeinsamer, serverbestätigter Befehl.
- Sonst (Production-Standard): nur lokal. Der Sync-Status zeigt „Nicht synchron“, ein Tippen auf Play bzw. „Wiedergabe synchronisieren“ verbindet wieder.

Die Freigabe bleibt an `GUEST_CONTROL_PREVIEW_AND_BACKEND.md` gebunden.

## Unverändert

HLS-/TorBox-Logik, `browser_hls`, Desktop-Originalstream, Sync-Policy (Hysterese, Wartebudget, Seek-Vorlauf), Realtime, Chat-Protokoll, Host-only, Kotlin/Desktop. Auch die explizite Ladeaktion vor dem ersten Medienabruf (IP-Offenlegung) bleibt erhalten; sie ist jetzt der große Play-Button.

## Geänderte Dateien

- `browser-site/index.html`: neue Struktur, alle bisherigen Element-IDs erhalten.
- `browser-site/src/style.css`: neues Design.
- `browser-site/src/main.js`: Einladung (`renderInvite`), Teilnehmerliste, Player-Controls, Beitrittsablauf mit Login-Fallback, Gast-Flag, automatischer Start nach Laden.
- `browser-site/src/session.js`: `join(..., {allowAnonymous})`.
- `browser-site/public/_headers`: `img-src` erlaubt zusätzlich `https:` (Poster/Backdrops aus Party-Metadaten; nur `https:` wird im Code akzeptiert).
- `browser-site/tests/personal-hls-integration.test.js`, `tests/session.test.js`: Tests angepasst und ergänzt.

## Tests (manuell ausführen)

```powershell
Set-Location 'C:\Users\Alanp\Desktop\Chatgpt\Codex\Nuvio-Watch\NuvioDesktop\browser-site'
npm.cmd test
npm.cmd run build
node checks/browser-smoke.mjs
```

Danach optisch prüfen: `npm.cmd run dev`, dann `http://127.0.0.1:5173/party/<CODE>` in Desktop-Breite, mit 390 px (DevTools) sowie auf einem echten iPhone und Android-Gerät.

## Cloudflare

- Production: keine neuen Variablen. `VITE_PARTY_GUEST_JOIN` und `VITE_PARTY_GUEST_CONTROL` **nicht** setzen.
- Preview optional: beide Flags nur nach den jeweiligen Backend-Freigaben.
- Reihenfolge: PR #2 → Dev, dann Mobile-Sync-PR, dann dieser UI-Branch als eigener PR. Jeweils zuerst die Preview prüfen; bei Problemen das Pages-Rollback auf das vorherige Production-Deployment nutzen.
- **Kein neuer MSI nötig.**
