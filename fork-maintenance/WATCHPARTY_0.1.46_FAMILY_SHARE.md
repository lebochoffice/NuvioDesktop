# 0.1.46: TorBox-HLS mit Account-Token über einen geschützten Freigabedienst (nach `707088db`)

Lokal, nicht committet. Kein MSI. Der Worker ist **nicht** deployt. Nicht live getestet; dass HLS im Browser abspielt, ist **nicht** belegt.

**Unverändert:** Synchronisierung, Command-ID/ACK, exakter Seek, Drift-Korrektur, Desktop-zu-Desktop, Einladungsbuttons, Fork-Updater, Cloudflare-Pages-Seite und Production.

## 1. Exakte Ursache von HTTP 422

- **Manuelle Freigabe („Video-Link für alle teilen“):** Die Meldung „Playlist nicht abrufbar (HTTP 422)“ entsteht in `PartyHostHls.kt` nur aus `response.status`, also aus der Antwort von TorBox. Unser Validator erzeugt dort kein 422.
  - TorBox läuft auf FastAPI (alle Endpunkte dokumentieren `422 Validation Error`). FastAPI antwortet mit 422, wenn ein Pflicht-Parameter fehlt oder ungültig ist.
  - Unsere Variante ohne Key hat genau den Parameter `token` entfernt, den der Stream-Endpunkt verlangt. TorBox lehnt die Adresse ohne `token` also als ungültige Anfrage ab, nicht als „noch in Arbeit“.
- **Nuvio-Cloud („auch nach 20 Minuten keine Playlist“):** Die Prüfschleife hat jeden Status außer 200/401/403/410/497/498 als „wird noch verarbeitet“ behandelt. Ein dauerhaftes 422 wurde deshalb rund 10 Minuten lang wiederholt, nach „HLS erstellen / aktualisieren“ noch einmal.
  - Außerdem hat unsere eigene Prüfung bei „2xx, aber kein HLS“ ebenfalls 422 gemeldet. Das war nicht vom echten 422 von TorBox zu unterscheiden.
- **Behebung:**
  - Nur echte Verarbeitungszustände werden erneut geprüft: 0, 202, 404, 408, 425, 429, 500, 502, 503 und 504. Alles andere, darunter 422, endet sofort mit „Playlist-Anfrage abgelehnt (HTTP …)“.
  - Unsere eigene Prüfung meldet „kein HLS“ jetzt als `415` (eigener Code, Text „Antwort ist keine HLS-Playlist“).

## 2. Funktioniert die Original-HLS-Adresse mit Token?

- **Nicht live belegt.** Der Code verwendet sie jetzt unverändert, wenn der Freigabedienst eingerichtet ist (Weg unten). Der Host prüft sie selbst, das Token geht dabei nur an TorBox:
  - HTTP-Status, `#EXTM3U`, Weiterleitungen nur auf TorBox-Hosts
  - Master und erste Variante, und zwar so, wie hls.js die Variante auflöst
- **Token in Varianten:** Funktioniert eine relative Variante ohne `token` nicht (401/403/422), mit demselben Token aber schon, meldet die Prüfung `290` (`propagateToken`). Zugelassene Browser hängen das Token dann an TorBox-Anfragen ohne Token an, nur auf TorBox-HTTPS-Hosts.
  - Ob TorBox das Token auch bei Segmenten verlangt, prüft der Host nicht (Segmente werden nicht geladen). Mit `propagateToken` bekommen Segmente auf TorBox-Hosts das Token aber ebenfalls.
- **TorBox-Webplayer:** Laut dessen öffentlichem Bundle baut er `…/stream/<presigned_token>/<res>/<sub>/<audio>/<datei>?token=<user_token>` und übergibt diese Adresse samt Token an den Player. Das passt zu dem 422 ohne Token.

## 3. Freigabelösung und Zugriffsschutz

**Cloudflare Worker plus Durable Object** in `party-share-worker/`, eigenständig, nicht Teil der Pages-Seite. Gedacht als Keimzelle der geplanten Lobby. Er ist kein Video-Proxy und transkodiert nicht.

- **Host → Worker (`/v1/share`, `/v1/revoke`):**
  - Der Desktop meldet sich mit seiner eigenen Nuvio-Session an. Der Worker ruft damit das offizielle `watch_party_heartbeat` auf und verlangt `member_id == host_member_id`.
  - Erst dann speichert er Adresse, Titel (`media_key`), zugelassene Mitglieder (nur aktuelle Mitglieder, nicht der Host, höchstens 16) und die Ablaufzeit (Standard 6 h, höchstens 12 h).
  - Er nimmt nur HTTPS-Adressen auf TorBox-Hosts an.
- **Gast → Worker (`/v1/grant`):**
  - Der Browser meldet sich mit seiner eigenen Nuvio-Session an. Der Worker prüft die **aktuelle Mitgliedschaft serverseitig**, über dasselbe offizielle RPC mit dem JWT des Gastes, und dann die Zulassung durch den Host.
  - Danach gibt er eine **eigene, zufällige Berechtigung** aus (256 Bit). Sie gilt 15 min, liegt nur als SHA-256 gespeichert vor und wird zusammen mit der Adresse übergeben.
  - Der Party-Code allein reicht nicht. Ein Konto, das per Code beigetreten ist, bekommt nichts, solange der Host es nicht zulässt.
- **Reconnect (`/v1/stream`):** Mit der Berechtigung erhält der Gast die aktuelle Adresse erneut, auch ohne Session. Nach Ablauf holt er sich mit Session eine neue, wieder mit Prüfung der Mitgliedschaft.
- **Widerruf und Ablauf:**
  - „Share my stream“ aus, ein Titelwechsel oder das Verlassen der Party durch den Host entfernt die Freigabe samt allen Berechtigungen.
  - Nimmt der Host ein Mitglied heraus, werden dessen Berechtigungen gelöscht.
  - Bei Ablauf löscht ein Alarm alles.
  - Das Durable Object ist stark konsistent: Ein Widerruf gilt ab der nächsten Anfrage, anders als bei KV.
- **Gekickte Mitglieder:** Der nächste `/grant` scheitert sofort, weil das RPC sie nicht mehr kennt. Eine schon ausgegebene Berechtigung gilt höchstens noch 15 min, außer der Host nimmt das Mitglied heraus. Dann ist sie sofort weg; der Desktop entfernt entfernte Mitglieder beim nächsten Veröffentlichen.
- **Keine Logs:** Der Worker schreibt nichts mit (`observability` aus, kein `console`). Antworten tragen `Cache-Control: no-store`, CORS ist nur für die eingetragenen Browser-Origins offen. Der TorBox-Key steht nie in der Worker-Konfiguration.
- **Host verlässt die Party:** Neue Abrufe sind gesperrt. Gäste, die die Adresse schon geladen haben, schauen weiter (lokal „Allein“), solange TorBox die Adresse gelten lässt.
- **Broadcast:** Das Realtime-`stream`-Ereignis enthält in diesem Modus **keine** URL, nur `browser_hls: {state: "family", rev}`. Nicht zugelassene Mitglieder und Fremde im Kanal erfahren nur, dass es eine Familienfreigabe gibt.

**Bleibende Grenze:** Ein an einen Familienbrowser übermittelter vollständiger TorBox-Key lässt sich **unabhängig von der Party weiter nutzen** (DevTools, Netzwerk, Verlauf). Er erlaubt den vollen Account-Zugriff. Weder der Worker noch ein Widerruf ändern daran etwas; ungültig wird er nur, wenn du ihn bei TorBox neu erzeugst.

## 4. Implementiert

- **TorBox (`TorboxPartyHls.kt`):**
  - sofortiger Abbruch bei dauerhaften Fehlern, eigener Code `415` für „kein HLS“
  - Familienmodus: Originaladresse unverändert, Host-Prüfung ohne Key-Sperre auf genau diese Adresse
  - Prüfung „Variante braucht Token“ (`290`)
  - nur eine `createstream`-Session pro Vorbereitung, wie bisher
- **Desktop:**
  - `PartyFamilyShare.kt` (neu): Client für Freigabe und Widerruf mit der Host-Session; kein Logging
  - Build-Einstellung `-Pnuvio.party.shareWorker=<https-Origin>`, streng geprüft; ohne sie ist der Familienmodus aus, und Adressen mit Token werden nie verwendet
  - `PlayerScreenRuntimeParty.kt`: Familienadresse nie im Broadcast; Veröffentlichen und Widerrufen gekoppelt an „Share my stream“, Titel und Party
  - Panel „Familienfreigabe (TorBox)“ mit einem Schalter pro Mitglied, ohne Bestätigungsdialog
- **Browser (`main.js`, `protocol.js`):**
  - Bei `state: "family"` holt der Browser die Adresse beim Worker, mit `VITE_PARTY_SHARE_WORKER`.
  - Danach gilt der bestehende Ablauf: automatisch laden, Metadaten abwarten, Party-Zeit übernehmen, Play versuchen, bei einer Autoplay-Sperre stumm starten bzw. den Hinweis zeigen.
  - Reconnect über die Berechtigung; ein Entzug stoppt die Wiedergabe sofort.
  - Das Token bleibt nur im Speicher; „Allein schauen“ ist unverändert.
- **LeLibrary:** Die automatische, eindeutige Zuordnung über den Infohash hat Vorrang. „Mit TorBox-Datei verknüpfen“ erscheint nur, wenn keine eindeutige Datei gefunden wurde (oder um eine manuelle Verknüpfung zu ändern). Danach gilt derselbe Freigabeweg wie bei der Nuvio-Cloud.
- **Video-Link für alle teilen:** unverändert, also nur Links ohne Account-Key. Für TorBox-Links mit Token ist der Familienweg über „HLS erstellen“ gedacht.

## 5. Was Cloudflare-Konfiguration braucht (nicht ausgeführt)

1. Einen Worker aus `party-share-worker/` anlegen: `wrangler.toml.example` nach `wrangler.toml` kopieren und `SUPABASE_URL`, `SUPABASE_ANON_KEY` (nur `sb_publishable_…`) sowie `ALLOWED_ORIGINS` (exakte Pages-Origins) eintragen. Dann `wrangler deploy`. Die Durable-Object-Migration `v1` steht in der Vorlage.
2. Den Desktop-Test-Build mit `-Pnuvio.party.shareWorker=https://<worker>.workers.dev` bauen (zusätzlich zu `-Pnuvio.party.browserOrigin=preview`).
3. Die Preview der Browser-Seite mit `VITE_PARTY_SHARE_WORKER=https://<worker>.workers.dev` bauen, als Umgebungsvariable der Preview-Umgebung in Cloudflare Pages. Das ist eine Einstellungsänderung, die du selbst vornimmst.
4. Production und die bestehende Pages-Konfiguration bleiben unverändert, solange die Variable dort nicht gesetzt wird.

## 6. Testbefehle

```powershell
Set-Location 'C:\Users\Alanp\Desktop\Chatgpt\Codex\Nuvio-Watch\NuvioDesktop\browser-site'; npm.cmd test
Set-Location 'C:\Users\Alanp\Desktop\Chatgpt\Codex\Nuvio-Watch\NuvioDesktop\party-share-worker'; npm.cmd test
Set-Location 'C:\Users\Alanp\Desktop\Chatgpt\Codex\Nuvio-Watch\NuvioDesktop'; $env:JAVA_HOME='C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot'; .\gradlew.bat :composeApp:desktopTest --tests '*Party*Test' --tests '*MemberSync*' --tests '*PausedPosition*' --tests '*NativePlayerExactSeek*' --tests '*Torbox*Test' --tests '*TorboxPartyHlsPrepare*' --tests '*PartyHostHls*' --tests '*PartyFamilyShare*' --tests '*Fork*UpdateTest' --tests '*AppUpdate*Test' --tests '*UpdateChannelTest' --tests '*ReleaseSelector*' --tests '*VersionUtils*' --no-configuration-cache --console=plain
bash fork-maintenance/check-fork-invariants.sh
```

Neue Tests:
- **Worker (`party-share-worker/tests/worker.test.js`):**
  - Hosts
  - nur der Host darf freigeben
  - zugelassene und nicht zugelassene Gäste, Fremde mit Party-ID
  - Berechtigung pro Gast
  - Reconnect, Entzug, Kick, Ablauf, Folgenwechsel
  - CORS
- **Kotlin:** `PartyFamilyShareTest`, 422 und Abbruch, Familienmodus, Variante mit Token, `415`
- **Browser:**
  - zugelassener Gast lädt, synchronisiert und hängt das Token nur an TorBox-Hosts an
  - Reconnect ohne Neuladen; Entzug stoppt
  - nicht zugelassen, Build ohne Worker, gefälschter Absender
  - Host verlässt die Party: Gast schaut weiter
  - Hilfsfunktionen in `protocol.test.js`

## 7. Offene Risiken

- **Weitergabe des Keys an die Familie:** Siehe die Grenze in Abschnitt 3. Für Fremde gilt: Sie bekommen über unsere Infrastruktur nichts ohne Zulassung durch den Host. Diese Aussage hängt aber am offiziellen `watch_party_heartbeat`, das aktuelle Mitgliedschaft und Host-Rolle korrekt meldet. Das ist plausibel (die App selbst verlässt sich darauf), serverseitig aber nicht einsehbar.
- **Zulassung pro Party:** Mitglieds-IDs gelten nur für eine Party, deshalb wird die Zulassung nicht gespeichert. Jede neue Party braucht neue Schalter.
- **Desktop-Gäste:** In diesem Modus bekommen sie keine URL, denn das Original enthält den Key. Sie bräuchten eine eigene Nuvio-Quelle.
- **Schließen des Players:** Schließt der Host den Player, ohne die Party zu verlassen, bleibt die Freigabe bis zu ihrem Ablauf (höchstens 6 h) bestehen. Neue Abrufe setzen aber weiter eine aktuelle Mitgliedschaft und die Zulassung voraus.
- **Missbrauch:** Die Funktion ist nur so sicher wie die Zulassungsliste. Wer zugelassen ist, kann den Key extrahieren.
- **Ohne Live-Test unbekannt:**
  - ob die Originaladresse mehrere gleichzeitige Geräte zulässt
  - ob TorBox CORS für die Preview-Origin erlaubt
  - ob die Segmente das Token brauchen
  - ob `watch_party_heartbeat` aus einem Worker ohne Browser-Origin funktioniert
- **Worker-Kosten und Limits:** Durable Objects mit SQLite gibt es auch im Free-Plan. Prüfe die Limits deines Kontos.

## Testergebnis (03.11.2026, lokal)

- Worker `npm test`: 6/6 bestanden. Log: `fork-maintenance/local/worker-tests-0.1.46.log`.
  - Im ersten Lauf startete kein Test: `node --test tests/` nimmt in Node 24 kein Verzeichnis an. Das Skript ist jetzt `node --test`, wie in `browser-site`.
- Browser `npm test`: 206/206 bestanden. Log: `fork-maintenance/local/browser-tests-0.1.46.log`.
  - Im ersten Lauf schlugen die 4 neuen Familientests fehl. Ursache war ein echter Fehler in `fetchFamilyStream`: `familyGrant?.party === room.info.id` war auch ohne gespeicherte Berechtigung wahr, wenn die Party-ID fehlte, und `.expires` scheiterte dann. Jetzt gibt es eine explizite Null-Prüfung.
- Desktop: 156/156 bestanden. Darunter `TorboxPartyHlsTest` 14/14, `TorboxPartyHlsPrepareTest` 8/8, `PartyFamilyShareTest` 4/4 und `PartyHostHlsTest` 6/6. Ohne Property ist `SHARE_WORKER` leer, der Familienmodus also aus. Log: `fork-maintenance/local/desktop-tests-0.1.46.log`.
- Fork-Invarianten: OK.
- Nicht live getestet, Worker nicht deployt.
