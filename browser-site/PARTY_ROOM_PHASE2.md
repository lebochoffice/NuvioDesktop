# Browser-Party-Room Phase 2: Videofreigabe durch den Browser-Host

Branch `restore/watchparty-0.1.49`. Die Implementierung ist in `f595fa818` enthalten; die Härtung unten ist **nicht getestet und nicht committet**.

## Sicherheitsstatus (Härtung nach dem Review): GESPERRT, durch das Backend blockiert

**Ergebnis der Prüfung:** Mit dem vorhandenen Backend kann kein Client erkennen, ob eine Realtime-Nachricht wirklich vom Host stammt.

- **Realtime-Absender:** `member_id` in `stream`, `state`, `stream_suggest`, `stream_suggest_result` und der Presence-Schlüssel setzt der sendende Client selbst. Der private Kanal prüft nur, ob jemand dem Thema beitreten darf, nicht wer eine Nachricht verfasst hat. Jedes Mitglied kann also „als Host“ senden.
- **Quellen:** Für Streamangebote gibt es keine serverseitige Speicherung, Revision oder Bestätigung.
  - `PartyMedia.source` (`PartySource`) kennt nur Addon- und Torrent-Merkmale, keine URL. Ihn umzuwidmen wäre eine Vertragsverletzung und würde Tokens in die Datenbank schreiben.
  - Ob das Backend `p_media`-Änderungen auf den Host beschränkt, ist nicht einsehbar.
- **Party-Zeit:** `watch_party_update` speichert serverseitig. Ob das Backend `member_id` aus der Anmeldung setzt oder den Client-Wert übernimmt, ist nicht einsehbar. Bei `host_only = false` dürfen ohnehin auch Gäste schreiben. Ein gespeicherter Stand ist damit kein Herkunftsnachweis für Realtime-Stände.
- **Vorschläge:** Es gibt keinen privaten Weg zum Host. Jeder Vorschlag ist für alle Mitglieder des Kanals lesbar, Tokens in Links also auch.
- **Atomarer Quellenwechsel:** Streamangebot (Realtime) und Startstand (Realtime + RPC) sind zwei ungekoppelte Vorgänge. Eine echte Atomarität ist ohne serverseitige Quellenrevision nicht erreichbar.

**Konsequenz (fail-closed):**
- **Videofreigabe durch den Browser-Host:** gesperrt. Die Videofreigabe im Room ist deaktiviert und zeigt den Grund. Der Host sendet kein Streamangebot und beantwortet `state_request` nur, wenn er tatsächlich eine Quelle teilt; das kommt bei gesperrter Freigabe nicht vor.
- **Vorschläge:** Die Vorschlagsliste des Browser-Hosts und das neue Vorschlagsformular für Browser-Mitglieder sind gesperrt. Das neue „Video vorschlagen“ im Desktop-Party-Menü ist entfernt (Desktop hat keinen Build-Schalter).
- **Interner Schalter:** Nur für geschlossene, interne Tests lässt sich die Sperre per Build-Variable `VITE_PARTY_BROWSER_HOST_SHARE=1` aufheben. Sie ist **nicht für eine öffentliche Preview** gedacht.
- **Weiter aktiv**, weil serverseitig autorisiert:
  - Room-Redesign, Einladungslink, Teilnehmerzahl, Chat
  - Host-Reiter (Nur Host darf steuern, Mitglieder entfernen, Party beenden)
  - Erstellen über die Cinemeta-Suche
- **Unverändert:**
  - Desktop-Host-Freigaben („Share my stream“, Browser-HLS)
  - das bisherige HLS-„Video laden & vorschlagen“ an einen Desktop-Host
  - Host-only, Solo-Modus und Countdown
  - Diese bestehenden Wege haben dieselbe ungeprüfte Absenderidentität. Das ist bekannt und hier nicht verschlimmert.

### Fehlender Backend-Vertrag (Vorschlag, keine Migration ohne Freigabe)

1. **Serverbestätigte Quelle:**
   - RPC `watch_party_set_source(p_party_id, p_device_id, p_source jsonb, p_expected_rev int)`, nur für den Host.
   - Sie speichert `{kind, url}` mit einer vom Server vergebenen `source_rev` und lehnt eine veraltete `p_expected_rev` ab.
   - `null` bedeutet Widerruf und erhöht die Revision ebenfalls.
   - Join, Heartbeat und Preview geben `source` und `source_rev` zurück.
2. **Server als Absender:**
   - Eine Quellenänderung wird vom Server selbst verteilt, per `realtime.send` aus der RPC oder `postgres_changes` auf die Party-Zeile.
   - Clients akzeptieren Quellen nur aus diesem serverseitigen Kanal bzw. aus dem Snapshot und vergleichen `source_rev`. Damit sind Widerruf, Late Join und Reconnect gedeckt.
3. **Party-Zeit mit Quellenbezug:** `watch_party_update` setzt `member_id` aus der Anmeldung, nimmt `source_rev` entgegen und weist Stände für eine ältere Revision zurück.
4. **Private Vorschläge:**
   - RPC `watch_party_propose(p_party_id, p_device_id, p_url)`: Der Absender ergibt sich aus der Anmeldung, nur aktuelle Mitglieder dürfen vorschlagen.
   - Lesen darf nur der Host (`watch_party_list_proposals`). Die Entscheidung läuft über `watch_party_decide_proposal` und prüft vor der Annahme Mitgliedschaft und Medienidentität.
   - Kein Vorschlag geht über den gemeinsamen Kanal.

Erst wenn 1 und 2 vorhanden sind, darf die Browser-Freigabe öffentlich aktiviert werden. Für Vorschläge mit Tokens ist zusätzlich 4 nötig.

### Einordnung der Review-Befunde

| Befund | Status |
|---|---|
| Host-Imitation bei Streamangebot, Widerruf und Party-Zeit des Browser-Hosts | **DURCH BACKEND BLOCKIERT**; die Funktion ist fail-closed gesperrt. |
| Host-Imitation bei Vorschlagsentscheidungen | **DURCH BACKEND BLOCKIERT**; die Vorschläge sind gesperrt. |
| Token-Leaks über Freigabe und Vorschläge (Realtime, für alle lesbar) | **ABGESICHERT, ABER EINGESCHRÄNKT**: Die neuen Wege sind gesperrt. Das bestehende HLS-Vorschlagen an Desktop-Hosts warnt weiterhin, dass Mitglieder den Link samt Tokens sehen. Eine URL-Prüfung kann unbekannte Secrets nicht erkennen. |
| Atomarer Quellenwechsel, verspätete Angebote nach Widerruf | **DURCH BACKEND BLOCKIERT**: Ohne serverseitige Revision ist keine Garantie möglich. Durch die Sperre entstehen keine widersprüchlichen Browser-Host-Quellen. |
| Vorschläge nach Kick oder Medienwechsel | **ABGESICHERT, ABER EINGESCHRÄNKT**: Mit der Sperre wird nichts angenommen. Für den internen Schalter prüft die Annahme den Snapshot nur beim Eingang. |
| Desktop-Gäste erhalten ein neues Angebot, mpv wechselt nicht automatisch | **ABGESICHERT, ABER EINGESCHRÄNKT**: Mit der Sperre kommt kein Browser-Host-Angebot an. Für Desktop-Host-Angebote bleibt die bestehende manuelle Quellenauswahl. Automatische Desktop-Wiedergabe ist nicht implementiert. |
| Desktop-Vorschlag gilt als „gesendet“ ohne bestätigten Versand | **BEHOBEN** durch Entfernen der neuen Desktop-Vorschlagsfunktion. |
| HLS-Untermanifeste, Segmente, Schlüssel, Redirects | **ABGESICHERT, ABER EINGESCHRÄNKT**: Geprüft wird nur die eingegebene Adresse. Untermanifeste, Segmente, Schlüssel und Redirects lädt der Browser bzw. hls.js selbst; ohne Proxy gibt es dafür keine vollständige Zielprüfung und **keine SSRF-Schutzgarantie**. Mit der Sperre entfällt der neue Weg. |
| Alle Punkte | **NOCH UNGETESTET** gegen das Live-Backend. |

**Hinweis:** Der folgende Abschnitt beschreibt den Funktionsumfang, wenn der interne Schalter gesetzt ist. Öffentlich gilt die Sperre oben.

## Phase 2.1: Private Familien-Beta

**Nur für einen geschlossenen Kreis**, mit dem internen Build-Schalter `VITE_PARTY_BROWSER_HOST_SHARE=1`. Er ist standardmäßig aus, eine öffentliche Preview bleibt gesperrt. Das Risiko oben gilt unverändert und wurde für die Beta bewusst akzeptiert: Jedes Mitglied kann Realtime-Nachrichten „als Host“ senden, und Vorschläge sind für alle Mitglieder lesbar.

- **Warteraum:**
  - Der Host bleibt im Room bis zur ersten Freigabe, Mitglieder bleiben dort, solange keine Quelle angeboten oder geladen ist. Ein Videolink ist für das Erstellen und Beitreten nicht nötig.
  - Gezeigt werden Poster, Titel, Party-Code, Einladungslink, Teilnehmer, „Teilnehmer & Chat“ und „Warte auf Video vom Host …“.
  - Mitglieder sehen keine Host-Steuerelemente. Ohne Quelle erscheint keine Fehlermeldung.
  - Aus dem Player ist der Room über „Party-Room anzeigen“ (Reiter Party) bzw. „Party-Room öffnen“ (Reiter Host) erreichbar.
  - Die Texte nennen nicht mehr ausdrücklich einen „Desktop-Host“.
- **Freigabe (bestmöglich, keine Transaktion):**
  - Es läuft immer nur eine Freigabe-Aktion.
  - Die lokale Quelle ändert sich erst nach bestätigtem Versand. Ein gescheitertes Angebot hinterlässt keinen Zustand und wird bei `state_request` oder Reconnect nie nachgesendet.
  - Scheitert danach der Startstand, kündigt der Host die vorherige Quelle (oder „keine“) wieder an. Der Host-Player behält seine bisherige Quelle, und die Meldung sagt, ob die Wiederherstellung gelang.
  - Ein Widerruf gilt erst nach bestätigtem Versand; sonst bleibt alles wie es war.
- **Mitglieder:** Neue Quelle → Wechsel vom Warteraum in den Player und automatisches Laden. Quellenwechsel → nur die neue Quelle. Widerruf → zurück in den Warteraum.
- **Autoplay:** Blockiert der Browser den Start, auch stumm, erscheint ein einziger Knopf „Wiedergabe starten“; das Tippen startet bei der Party-Zeit.
- **Vorschläge** (nur mit Schalter):
  - Sie verfallen, wenn das Mitglied nicht mehr in der Party ist, der Titel wechselt oder die Party endet.
  - Vor der Annahme werden Mitgliedschaft und Titel erneut gegen den letzten Server-Stand geprüft.
  - Keine Account-Tokens, API-Keys oder Passwörter in Links teilen.
- **Desktop:**
  - Desktop-Gäste können vor der Freigabe beitreten.
  - Das Angebot des Browser-Hosts erscheint bei ihnen als vom Host geteilte Quelle im Stream-Bildschirm und muss **manuell** gewählt werden. Ein automatischer Wechsel einer laufenden mpv-Wiedergabe ist **nicht** implementiert.
  - Die Desktop-zu-Desktop-Party ist unverändert.

## Ablauf

1. Party über die Cinemeta-Suche erstellen (Phase 1, unverändert).
2. **Party-Room:**
   - Poster, Titel (bei Serien Staffel/Episode), Party-Code
   - Teilnehmerzahl (`n / max`), Verbindungsstatus
   - großes Feld für den Videolink mit „Video für alle freigeben“
   - Einladungslink, „Teilnehmer & Chat“, „Host-Einstellungen“
   - Der Phase-1-Hinweis ist entfernt.
3. **Freigabe:**
   - Prüfung (`host-share.js`): öffentliche HTTPS-Adresse, direkte `.m3u8`, `.mp4` oder `.webm`, kein `#`, keine Zugangsdaten, keine lokalen Ziele.
   - Der Host sendet das normale `stream`-Angebot für den Party-Titel (gleiche Form wie beim Desktop-Host, ohne Header) und einen Startstand „pausiert bei 0“.
   - Wird derselbe Link erneut freigegeben, bleibt die aktuelle Party-Zeit erhalten.
4. **Player:**
   - Die Room-Startansicht schließt, der vorhandene Browser-Player lädt die Quelle.
   - Play, Pause und Seek des Hosts werden zum Party-Stand: zuerst Broadcast, dann `watch_party_update`.
   - Mit `host_only = false` folgt der Host auch den Ständen der Mitglieder.
5. **Mitglieder:**
   - Browser-Gäste übernehmen das Angebot über den bestehenden Pfad.
   - Desktop-Gäste sehen es als „vom Host geteilte“ Quelle im Stream-Bildschirm.
6. **Vorschläge:**
   - Browser-Mitglieder nutzen „Video vorschlagen“ im Stream-Reiter, Desktop-Mitglieder „Video vorschlagen“ im Party-Menü.
   - Der Host sieht im Room Name, Format und Hostname. „Link prüfen“ zeigt die vollständige Adresse nur ihm.
   - „Annehmen“ gibt das Video wie unter 3 frei, „Ablehnen“ verwirft es. Der Vorschlagende sieht die Entscheidung.
7. **Host-Reiter** in den Einstellungen, nur für den serverseitig bestätigten Host (`session.isHost()`):
   - Nur Host darf steuern
   - Mitglieder verwalten (entfernen)
   - Party-Room öffnen, Videofreigabe beenden, Party beenden

## Autorisierung (geprüft)

- **Party-Zeit:**
  - `watch_party_update` ist dieselbe RPC, mit der Desktop-Host und Gäste den Stand speichern.
  - Der Server entscheidet, ob der Aufrufer schreiben darf (Host immer, Gäste nur bei `host_only = false`).
  - Der Browser-Host nutzt dafür die Reihenfolge des Desktops: zuerst Broadcast, dann speichern.
  - Ein abgelehnter Speicheraufruf nimmt den bereits gesendeten Stand nicht zurück, genauso wie beim Desktop.
- **Streamangebot:**
  - Es läuft nur über den privaten Realtime-Kanal, wie beim Desktop-Host.
  - Empfänger übernehmen es nur, wenn `member_id == host_member_id` aus dem letzten **Server-Snapshot** ist.
  - Realtime-Absender werden vom Server nicht geprüft. Das ist das bestehende Vertrauensmodell und wird hier nicht als sicher dargestellt.
- **Vorschläge:**
  - Die Absender-ID ist behauptet, nicht nachgewiesen.
  - Angenommen wird nur von IDs, die im letzten Server-Snapshot Mitglied sind (nicht der Host), für den aktuellen Titel und mit gültigem Link.
  - Der Name dient nur der Anzeige. Freigegeben wird erst durch die ausdrückliche Annahme des Hosts.
- **Keine Gastbefehls-Sequenzierung:** Der Browser-Host meldet kein `commands: 1`. Gäste mit Steuerrecht nutzen deshalb den bestehenden Pfad (Broadcast, dann `watch_party_update`), und der Server erzwingt Host-only.

## Durch das Backend bzw. die Architektur begrenzt

- **Reload des Hosts:**
  - Das Streamangebot liegt nur im Speicher (bewusst keine URLs im Browser-Speicher). Nach einem Neuladen der Host-Seite muss der Link erneut freigegeben werden; Gäste spielen bis dahin weiter.
  - Eine dauerhafte Quelle bräuchte eine serverseitige Quellen- und Revisionsbindung (siehe Phase 1, „Offener Backend-Vertrag“). Es gibt keine Migration ohne Freigabe.
- **Fehlende Koordinatorfunktionen** des Desktop-Hosts im Browser-Host:
  - Warten auf puffernde Mitglieder
  - gemeinsamer Countdown
  - Gastbefehls-Sequenzierung
  - Chat, Solo-Modus, Host-only und Reconnect funktionieren.
- **Serie ohne Episode: nicht umgesetzt.**
  - Der Backend-Vertrag ist nicht einsehbar, ein Live-Aufruf war nicht freigegeben.
  - Clientseitig ist eine Episode nötig: Der Wiedergabeschlüssel enthält Staffel und Episode, und Desktop-Gäste öffnen eine Party ohne Episode mit `videoId = metaId` (`MainAppContent.openPartyMedia`). Das liefert für Serien keine passenden Streams.
  - Die bestehende Episodenauswahl bleibt erhalten, es gibt keine Dummy-Daten.
- **Desktop-Host und Vorschläge:** Ein Desktop-Host prüft Vorschläge wie bisher als HLS. MP4/WebM-Vorschläge kann nur ein Browser-Host annehmen.

## Autoplay

- **Host:** Er startet selbst mit ▶; das ist eine Nutzergeste, also kein Autoplay-Problem.
- **Gäste:** Blockiert der Browser den automatischen Start, gilt der bestehende Ablauf:
  - erst ein stummer Start, mit dem Hinweis auf den Ton-Knopf
  - sonst „Party-Zeit aktualisieren“ bzw. „Mich synchronisieren“ als Startknopf

## Geänderte Dateien (Phase 2)

- `browser-site/src/host-share.js` (neu)
- `browser-site/src/session.js`
- `browser-site/src/main.js`
- `browser-site/index.html`
- `browser-site/src/style.css`
- `browser-site/tests/host-share.test.js` (neu)
- `browser-site/tests/session.test.js`
- `browser-site/tests/personal-hls-integration.test.js`
- `composeApp/.../party/PartyRepository.kt` (`suggestLink`)
- `composeApp/.../player/PlayerScreenRuntimePartyControls.kt` (`partySuggestLink:`)
- `composeApp/src/desktopMain/resources/player-ui/party.js` (Vorschlagsfeld für Mitglieder)

## Lokale Testbefehle

```powershell
node --test browser-site/tests/host-share.test.js browser-site/tests/session.test.js browser-site/tests/personal-hls-integration.test.js
npm.cmd --prefix browser-site test
.\gradlew.bat :composeApp:desktopTest --tests '*Party*Test' --no-configuration-cache --console=plain
```

## Noch nicht live getestet

- Erstellen im Browser und Freigabe gegen das offizielle Backend: Lässt `watch_party_update` den Browser-Host schreiben?
- Gäste im Browser und am Desktop übernehmen Quelle und Party-Zeit, auch bei spätem Beitritt und nach einem Reconnect.
- Vorschläge von Browser- und Desktop-Mitgliedern, Annahme und Ablehnung.
- Host-only, Solo-Modus, Chat und das Beenden der Party mit einem Browser-Host.
