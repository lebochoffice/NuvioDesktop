# Pause-Parität, Reload-Rejoin, Video-Link (nach `26319aca`)

Lokal, nicht committet. Kein MSI, kein Deployment.

## A. Browser-Seek, dann Pause: Der Desktop bleibt stehen

**Ursache (im Code belegt):**
- Der Windows-Player springt mit `seek <ziel> absolute+keyframes`, und `hr-seek` ist auf `no` gesetzt (`player_bridge.cpp:1123`, `:1771`). mpv landet also auf dem nächstgelegenen Keyframe statt auf der Zielsekunde. Bei 4K/HEVC-Streams liegen Keyframes oft mehrere Sekunden auseinander. Liegt das Ziel im selben Keyframe-Abschnitt wie die bisherige Position, „bleibt“ der Desktop sichtbar stehen.
- **Pause am Desktop:** Der Host landet auf dem Keyframe K, veröffentlicht aber das gewünschte Ziel T. Die Browser springen exakt auf T. Der Unterschied fällt kaum auf, weil der Host sein eigenes Bild sieht.
- **Pause im Browser:** Die Browser stehen auf T, der Desktop auf K. Die bisherige Korrekturschleife hat alle 2,5 s erneut auf T gesprungen, ist wieder auf K gelandet, und das endlos.
- APPLIED galt bei einer Pause schon ab 1,5 s Abstand (Schwelle für laufende Wiedergabe), obwohl die Pause-Toleranz 0,5 s beträgt.

**Unterscheidung:** Empfangen ist der Befehl, wenn er beim Host ankommt (`onCommand`). Angenommen ist er mit dem Host-ACK „accepted“ beziehungsweise der neuen Revision. Die Pause ist umgesetzt, wenn `PendingApply` nicht mehr `Waiting` meldet. Die Zielposition ist erreicht, wenn die Abweichung höchstens 0,5 s beträgt (neu für Pausen); dann folgt „applied“.

**Korrektur (klein, ohne Protokollumbau):**
- `PartySync.kt:107`: Bei einer pausierten Revision gilt APPLIED erst innerhalb der Pause-Toleranz von 0,5 s. Bei laufender Wiedergabe bleibt es bei 1,5 s.
- `PartySync.kt:172` `shouldConfirmPausedPosition` und `PlayerScreenRuntimeParty.kt:454` bzw. `:623–635`: Nur der Host bestätigt einmal pro Revision seine tatsächliche Pause-Position als neue Revision. Das passiert, wenn er pausiert ist, nicht puffert, seit 2,5 s nicht mehr gesprungen ist, die Position über zwei Durchläufe stabil ist (±50 ms) und mehr als 0,5 s vom Ziel abweicht. Es gilt nicht für Koordinator-Wartezustände.
- Damit stehen alle auf demselben Bild. Browser springen exakt, Desktop-Gäste treffen bei derselben Datei genau diesen Keyframe.
- Begrenzt: höchstens einmal pro Revision. Die neue Revision liegt innerhalb der Toleranz, die Korrekturschleife springt also nicht mehr endlos. Ein Pingpong gibt es nicht, weil Browser programmatische Sprünge nie veröffentlichen.
- Erfundene Serverbestätigungen gibt es nicht. Die Bestätigung ist eine normale, vom Host sequenzierte Revision und rückwärtskompatibel.
- **Nebenwirkung:** Springt der Host selbst während einer Pause, korrigiert er seine Revision nach rund 2,5 s ebenfalls auf den Keyframe. Die Browser springen dann um höchstens einen Keyframe-Abstand.
- **Bessere, aber größere Alternative (nicht umgesetzt):** ein exakter Sprung für Party-Pausen (`absolute+exact` oder `hr-seek`) in `player_bridge.cpp`. Dafür muss `player_bridge.dll` neu gebaut werden (MSVC).

**Gedankliche Fälle:**
- **Browser springt, dann sofort Pause:** Zwei Revisionen. Der Desktop pausiert und springt beim Identitätswechsel auf T. Nach 2,5 s ohne weiteren Sprung und bei stabiler Position bestätigt er K.
- **Langsames Puffern:** Solange `isLoading` gilt, wird nichts bestätigt.
- **Schnelle Befehlsfolge:** Jede neue Revision setzt den Sprung-Zeitpunkt zurück, bestätigt wird erst nach Ruhe und höchstens einmal.

## B. Wiederbeitritt nach Reload

- Pro Tab wird in `sessionStorage` (`nuvio-party-joined`, `main.js:36`) nur der Party-Code einer aktiven Mitgliedschaft gespeichert. URLs, Tokens und Keys werden nicht gespeichert, ein eigener Video-Link ebenfalls nicht. Die Geräte-ID ist wie bisher tabbezogen.
- Beim Laden (`main.js:1324`) wird automatisch wieder beigetreten, wenn drei Bedingungen gelten: Der Code in der URL stimmt mit dem gespeicherten überein, es gibt eine gültige Anmeldung, und noch keine Mitgliedschaft. Es gibt keine Passwortabfrage, und dank `joining` und `session.room` keinen doppelten Beitritt.
- Danach läuft der bestehende Ablauf weiter: Realtime-Kanal, `state_request` und Heartbeat, Host-Quelle (Automatik standardmäßig an), Autostart mit Party-Zeit. Bei blockiertem Autoplay folgt der stumme Start mit „Ton an“-Hinweis, und wenn auch der blockiert ist, der bekannte Hinweis.
- **Kein Wiederbeitritt nach:** „Party verlassen“, Abmelden, Sitzungsende (`SIGNED_OUT`), Party-Ende oder Entfernung (`main.js:184`). Bei definitiven Fehlern (`party_not_found`, `party_full`, `removed`/`not_member`, `party_ended`, `unavailable`) wird ebenfalls nicht mehr automatisch beigetreten, mit verständlicher Meldung. Bei abgelaufener Anmeldung erscheinen wieder die Anmeldefelder.

## C. Video-Link

- „Eigene HLS-URL (Beta)“ heißt jetzt „Video-Link“ und hat einen eigenen Bereich im Drawer (`index.html:124`), nicht mehr verschachtelt unter „Technik“. Er enthält: URL-Feld, „Video laden“, Statuszeile und „Zur Host-Quelle zurück“.
- Die IDs sind unverändert. Die HLS-Funktion und ihre Prüfungen bleiben vollständig erhalten.
- Die unterstützten Formate stehen ehrlich da: nur HTTPS-HLS-Playlists (.m3u8) ohne Livestream, keine Webseiten-Links (z. B. YouTube), kein DRM, keine lokalen Adressen.
- Bei 375 px statisch geprüft: kein horizontaler Überlauf.

## D. TorBox: „Datei aus meinem TorBox-Account wählen“ (nur Analyse)

- **Das gibt es schon:** die Nuvio-**Cloud-Bibliothek**.
  - Sie liest den TorBox-Account über die offizielle API (`/v1/api/torrents/mylist`, `DebridApiClients.kt:131/156`).
  - `CloudLibraryRepository.resolvePlayback` erzeugt für TorBox-**Torrents** aus den offiziellen IDs eine `TorboxPartyFile(torrentId, fileId, fingerprint)`. Geraten wird nichts.
  - Startet der Host einen Film von dort, funktionieren „HLS erstellen / aktualisieren“ und Browser-HLS über `createstream`.
- Usenet- und WebDL-Einträge der Cloud-Bibliothek bekommen keine `TorboxPartyFile`; sie haben andere APIs.
- **Addon-Streams mit „TB+“** haben keine TorBox-Dateikennung.
- **Mögliche spätere Erweiterung, autorisiert und ohne Raten:** Der Stream bringt einen Infohash mit (`activeTorrentInfoHash`). Dann den passenden Eintrag in `torrents/mylist` per Hash suchen und die Datei über `fileIdx` oder den Dateinamen zuordnen. Nur bei eindeutigem Treffer würde Browser-HLS angeboten.
- Kein Schlüssel verlässt den Host: Browser-Gäste erhalten nur die geprüfte `hls_url`.

## E. Später, nur erfasst

1. optionales intelligentes Puffern (z. B. alle warten erst ab N s)
2. einzeln abschaltbare Mini-Korrekturen (Feinanpassung der Geschwindigkeit)
3. separat abschaltbares automatisches Aufhol-Springen
4. optionaler Host-Countdown (1–10 s) vor Play

## Tests (lokal ausführen)

```powershell
Set-Location 'C:\Users\Alanp\Desktop\Chatgpt\Codex\Nuvio-Watch\NuvioDesktop\browser-site'; npm.cmd test
Set-Location 'C:\Users\Alanp\Desktop\Chatgpt\Codex\Nuvio-Watch\NuvioDesktop'; $env:JAVA_HOME='C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot'; .\gradlew.bat :composeApp:desktopTest --tests '*Party*Test' --tests '*MemberSync*' --tests '*PausedPosition*' --tests '*Torbox*Test' --tests '*Fork*UpdateTest' --tests '*AppUpdate*Test' --tests '*UpdateChannelTest' --tests '*ReleaseSelector*' --tests '*VersionUtils*' --no-configuration-cache --console=plain
bash fork-maintenance/check-fork-invariants.sh
```

Neu:
- `PausedPositionTest.kt`: einmalige Bestätigung, nicht beim Springen, Puffern oder Spielen, nicht innerhalb der Toleranz, nicht bei Wartezuständen, nur der Host; Pause-Toleranz für APPLIED.
- `personal-hls-integration.test.js`:
  - Wiederbeitritt einmal und ohne Anmeldedaten
  - nicht bei anderem Code, ohne Sitzung oder leerer Kennung
  - Verlassen, Abmelden und Party-Ende vergessen die Kennung
  - Party voll
  - Struktur des Video-Link-Bereichs

## Risiken vor MSI 0.1.42

- Die Positionsbestätigung kann Browser bei einer Pause um bis zu einen Keyframe-Abstand zurücksetzen. Gewollt, aber sichtbar; nur ein exakter Sprung in der nativen Bridge vermeidet das.
- Die Ursache ist im Code belegt, aber nicht live gemessen. Der Live-Test sollte mit derselben 4K-Quelle laufen.
- Der Wiederbeitritt hängt an `sessionStorage`. Ein neuer Tab gilt nicht als Reload, wie gewünscht.
- Der automatische Start nach einem Reload ist ohne neue Geste oft stumm (Browser-Regel).
- Nichts davon ist live getestet.

## Testergebnis (03.11.2026, lokal)

- Browser `npm test`: 184/184 bestanden.
- Desktop (Auswahl inklusive `*PausedPosition*` und `*MemberSync*`): 123/123 bestanden, `PausedPositionTest` 4/4. Log: `fork-maintenance/local/desktop-tests-pause.log`.
  - Die Meldung „Incremental compilation failed (… PartyBrowserHls)“ im Log kam vom inkrementellen Kotlin-Cache. Kotlin hat danach vollständig neu kompiliert, und der Build war erfolgreich.
- Fork-Invarianten: OK.
- Nicht live getestet.
