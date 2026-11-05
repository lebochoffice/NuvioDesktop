# Browser-Party-Room Phase 2: Videofreigabe durch den Browser-Host

Branch `restore/watchparty-0.1.49`, aufbauend auf den uncommitteten Phase-1-Änderungen. **Nicht getestet, nicht gebaut, nicht committet.**

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
