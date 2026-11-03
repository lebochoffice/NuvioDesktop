# Automatische HLS-Freigabe und Quellenaktualisierung

Branch `feature/party-premium-ui`, Basis `60d59f75` (0.1.40). Lokal, nicht committet. Kein Build. Die Synchronisierung ist unverändert.

## Ursache des manuellen Ablaufs

- **Browser (`main.js`):**
  - Der Stream-Handler hat jede Host-Freigabe ignoriert, solange eine eigene HLS-Quelle aktiv war (`if (personalHls.active) return;`).
  - Die eigene Quelle wird bei jedem Film- und Folgenwechsel sowie bei jedem Reload entfernt. Danach musste die URL neu eingegeben werden.
  - Eine neue oder erneuerte Host-Quelle setzte das Video zurück und verlangte jedes Mal einen neuen Klick auf ▶.
- **Desktop:**
  - Die TorBox-Vorbereitung (`prepareTorboxPartyHls`) lief zwar automatisch an, auch bei neuen Folgen (`LaunchedEffect` mit Schlüssel aus Film und Datei).
  - Es gab aber keinen Button, um sie anzustoßen oder zu erneuern, und keinen klaren Status, nur den Freitext im Hinweis zur Freigabe.
  - Sie funktioniert ausschließlich für Quellen der eingebauten TorBox-Debrid-Auflösung (`torboxPartyFile`). Addon-Streams liefern kein `browser_hls`.

## Änderungen

- **Desktop:**
  - `TorboxPartyHls.kt`: `Failed.denied` unterscheidet abgelehnte Zugriffe (403, Manifest 401/403/410/498) von vorübergehenden Fehlern. Neu sind `TorboxHlsPhase` (Nicht verfügbar, Vorbereitung, Bereit, Zugriff verweigert, Abgelaufen, Fehlgeschlagen) und `torboxHlsStatusLabel`. „An Teilnehmer gesendet“ gilt nur bei „Bereit“ und aktivem „Share my stream“.
  - `PlayerScreenRuntimeState.kt`: neue Zustände `torboxPartyPhase` und `torboxPartyRefresh`.
  - `PlayerScreenRuntimeParty.kt`:
    - Der Producer setzt die Phase.
    - `torboxPartyRefresh` ist Schlüssel des einen `LaunchedEffect`: Ein Klick bricht den laufenden Producer ab und startet genau einen neuen.
    - Die Erneuerung ist wie bisher begrenzt: Prüfung alle 60 s, neue Vorbereitung nach 401/403/404/410, höchstens 3 Erneuerungen.
  - `PlayerControlParty.kt`/`PlayerScreenRuntimePartyControls.kt`:
    - Neue Felder `hlsAvailable` (nur Host, Party-Film, TorBox-Datei), `hlsBusy` und `hlsStatus`.
    - Neues Ereignis `partyHlsRefresh`. Es wird während einer laufenden Vorbereitung ignoriert und ändert nie die Zustimmung zur Freigabe.
  - `player-ui/party.js`: Button „HLS erstellen / aktualisieren“ mit Statuszeile unter „Share my stream“. Er wird nur angezeigt, wenn `hlsAvailable` gilt, und ist während der Vorbereitung deaktiviert.
- **Browser:**
  - `index.html`/`style.css`: Checkbox „Host-Stream automatisch verwenden“ unter „Technik“, standardmäßig aus, mit Hinweis auf die IP-Übertragung.
  - `main.js`:
    - Nur der Schalter wird lokal gespeichert (`nuvio-party-auto-host-stream`). URLs und Tokens bleiben im Speicher.
    - Im Automatikmodus wird jede passende Host-Quelle sofort geladen und folgt nach den Metadaten der Party-Zeit. Das gilt auch für neue Folgen und erneuerte Links.
    - Eine eigene HLS-Quelle wird nur im Automatikmodus und nur durch eine abspielbare Host-Quelle ersetzt, nie durch einen Widerruf oder ein noch nicht fertiges HLS.
    - Dieselbe Quelle nach einem Reconnect lädt nicht neu. Quellen eines anderen Films werden ignoriert. Ein Widerruf stoppt sofort.
    - Beim Einschalten wird eine bereits angebotene Quelle übernommen.
    - Ohne Automatikmodus bleibt alles wie bisher.

## Sicherheit

- Unverändert:
  - Kein TorBox-Key wird übertragen.
  - `torboxShareableHls` lässt nur HTTPS-URLs auf `*.torbox.app` ohne Account-Key in Pfad oder Query zu. Ein Manifest, das den Key enthält, beendet die Freigabe (498).
  - Verteilt wird erst nach erfolgreicher Prüfung des Manifests.
  - Desktop-Gäste erhalten kein `browser_hls`.
- Die HLS-URL kann selbst ein kurzlebiges, sitzungsgebundenes TorBox-Token enthalten (`?token=…`). Mitglieder können sie sehen, solange die Freigabe läuft. Das ist der vorgesehene Rahmen von „Share my stream“; der Browser speichert sie nicht.
- Freigabe nur über „Share my stream“. Ausschalten widerruft sofort (`stream: null`). Weder Kopieren noch der neue Button schalten sie ein.
- Kein Umgehen von CORS, DRM oder Anbieterbeschränkungen. Erlaubt die TorBox-CDN den Browserzugriff nicht, meldet der Browser einen Wiedergabefehler.

## Einschränkungen

- Nur Quellen der eingebauten TorBox-Debrid-Auflösung. Addon-Streams erhalten weiterhin kein Browser-HLS.
- Der Wechsel bei einer Quellenaktualisierung verursacht eine kurze Unterbrechung (neue URL, neues Laden). Danach geht es zur aktuellen Party-Zeit weiter.
- Autoplay-Sperren: Ohne vorherige Geste (z. B. nach einem Reload) kann `play()` blockiert werden. Dann erscheint die bestehende Meldung mit Tippen auf Play.
- Desktop-Einladungen zeigen weiterhin auf Production. Die neue Browseroberfläche braucht dort ein eigenes Deployment.
- Nicht live getestet.

## Tests (lokal ausführen)

```powershell
Set-Location 'C:\Users\Alanp\Desktop\Chatgpt\Codex\Nuvio-Watch\NuvioDesktop\browser-site'; npm.cmd test
Set-Location 'C:\Users\Alanp\Desktop\Chatgpt\Codex\Nuvio-Watch\NuvioDesktop'; .\gradlew.bat :composeApp:desktopTest --tests '*Party*Test' --tests '*Torbox*Test' --tests '*Fork*UpdateTest' --tests '*AppUpdate*Test' --tests '*UpdateChannelTest' --tests '*ReleaseSelector*' --tests '*VersionUtils*' --no-configuration-cache --console=plain
bash fork-maintenance/check-fork-invariants.sh
```

Neu abgedeckt:
- manueller Modus ohne Überschreiben
- automatisches Laden mit Party-Zeit
- kein Neuladen bei Reconnect
- Linkerneuerung und neue Folge
- andere Filme werden ignoriert
- Ersetzen der eigenen Quelle nur durch eine spielbare Host-Quelle
- Einschalten übernimmt die angebotene Quelle
- Widerruf
- keine gespeicherten URLs
- Statuslabels (Kotlin)

Nicht automatisch getestet sind der Desktop-Button und der Producer mit echter TorBox-API.

## Testergebnis (03.11.2026, lokal)

- Browser `npm test`: 160/160 bestanden (6 neue Tests zur automatischen Host-Quelle).
- Desktop (CI-Auswahl plus `*Torbox*Test`): 114/114 bestanden, `TorboxPartyHlsTest` 4/4. Der Desktop-Code kompiliert. Log: `fork-maintenance/local/desktop-tests-autohls.log`.
- Fork-Invarianten: OK.
- Nicht live getestet.
