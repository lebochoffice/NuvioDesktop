# 0.1.43: TorBox-HLS, Einladungslink, Doppelklick, Reload (nach `d4e6868a`)

Lokal, nicht committet. Kein MSI. **Unverändert:** Command-ID/ACK, exakter nativer Seek, Play/Pause-Synchronisierung, Drift-Korrektur, Realtime-Reconnect, Desktop-zu-Desktop und die Player-Bridge.

## 1. TorBox-HLS

**Ursachen (im Code belegt):**
- **A, Start über die Nuvio-Cloud, „This stream can't be shared“:**
  - `currentPartyStream()` gab `null` zurück, sobald die **Originalquelle** nicht teilbar war: entweder enthält der TorBox-Downloadlink den Account-Key (`containsAccountKey`), oder es ist eine lokale bzw. nicht freigabefähige URL.
  - Dadurch wurde **gar nichts** geteilt, auch kein fertig vorbereitetes, sicheres Browser-HLS.
  - Zusätzlich hat der Hinweis „can't be shared“ die eigentliche TorBox-Meldung ersetzt, sodass die Ursache von „Fehlgeschlagen“ unsichtbar blieb.
- **„Browser-HLS: Fehlgeschlagen“:** Hinter dieser einen Phase steckten mehrere unterschiedliche Fälle. Wahrscheinlich, aber ohne Live-Antwort nicht belegt:
  - Die Playlist-Prüfung folgte **keinen Weiterleitungen** (`followRedirects = false`). Ein 302 von TorBox zum CDN galt deshalb nie als „fertig“.
  - Die Wartezeit war fest auf **30 s** begrenzt (15 × 2 s). Länger dauerndes Transcoding brach deshalb ab.
  - Andere Fehler (keine `hls_url`, fremder Host, API-Fehler) wurden nicht unterschieden.
- **B, LeLibrary [TB+]:** Das ist ein Addon-Stream ohne `torboxPartyFile`. Eine Zuordnung zur eigenen TorBox-Cloud gab es bisher nicht.
- **Manueller Ablauf auf der TorBox-Webseite:** „Stream this file“, Auflösung wählen, „Start player“ und dann den HLS-Link kopieren. Dort wartet der Web-Player, bis TorBox fertig transcodiert hat. Unsere Implementierung hat nach 30 s aufgegeben und keiner Weiterleitung gefolgt.
- Welche Felder `createstream` genau zurückgibt, ist ohne echten Aufruf mit deinem Key nicht belegbar. Es wird nichts geraten: Fehlt `hls_url`, nennt die Meldung nur die **Feldnamen** der Antwort, nie die Werte.

**Behebung:**
- `TorboxPartyHls.kt`:
  - getrennte Ergebnisse (`TorboxHlsFailure`: API-Anfrage fehlgeschlagen, Zugriff verweigert, nicht unterstützt, nicht rechtzeitig fertig)
  - `torboxHlsCandidate` unterscheidet: URL vorhanden, keine `hls_url` (mit Feldnamen), unsicherer Host (Hostname wird genannt), Account-Key in der URL, ungültige Antwort
  - Playlist-Prüfung mit begrenztem Backoff: 5 × 2 s, 10 × 5 s, 36 × 15 s, insgesamt etwa 10 min. Abbrechbar durch Filmwechsel, den Button oder das Ende der Party.
  - Während der Prüfung gilt der Zustand „TorBox verarbeitet den Stream“. Es wird **keine** zweite TorBox-Session angelegt.
  - Die Prüfung folgt jetzt Weiterleitungen. Dabei werden keine Header und kein Key gesendet, und die Antwort wird weiter auf den Key geprüft.
- Neue Phasen: `Processing`, `NotReady`, `Unsupported`, dazu `torboxBrowserState` (`processing`, `unsupported` usw.). Der Browser zeigt dazu eigene Texte.
- **Freigabe nur als HLS:** Ist die Originalquelle nicht teilbar, teilt der Host nur das fertige, geprüfte HLS. Desktop-Gäste können es ebenfalls abspielen. Vorher wird nichts geteilt.
- Der Hinweis im Panel zeigt „can't be shared“ **und** die konkrete TorBox-Meldung.
- **Addon-Streams:** Liefert der Addon einen Infohash, sucht der Host in **seiner eigenen** TorBox-Cloud (offizielles `torrents/mylist`) genau einen Torrent mit diesem Hash und darin genau eine Datei mit passendem Namen (oder die einzige Videodatei) (`matchTorboxCloudFile`). Nur bei einem eindeutigen Treffer gibt es Browser-HLS; sonst nennt der Status den Grund (kein Infohash, kein eindeutiger Eintrag).

## 2. Einladungslink

- **Ursache:** `WATCH_PARTY_BROWSER_ORIGIN` und die Standardadresse in `party.js` waren fest auf Production gesetzt. Die neue Oberfläche gibt es aber nur in der Preview.
- **Behebung:**
  - Gradle-Property `-Pnuvio.party.browserOrigin=preview` erzeugt `PartyBrowserConfig.ORIGIN`. Erlaubt sind **nur** Production (Standard) und genau `https://feature-party-premium-ui.nuvio-watch-friends.pages.dev`; alles andere bricht den Build ab.
  - Beide Wege nutzen diese Adresse und enden auf `/party/<CODE>`: „Einladung kopieren“ und „Watch in Browser · Copy link“. `party.js` akzeptiert nur diese eine Preview, und nur, wenn der Build sie gewählt hat. Eine früher gespeicherte Production-Adresse gewinnt in einem Preview-Build nicht. Eine unerwartete Adresse aus der App führt zurück zu Production.
  - `verify-msi.ps1` liest die gepackte Adresse und **lehnt die Preview ohne `-AllowPreviewOrigin` ab**. Der Release-Workflow übergibt die Property nicht und baut damit immer Production.

## 3. Doppelklick und Vollbild

- **Ursache:** Jeder `click` hat sofort Play/Pause ausgelöst. Einen Handler für `dblclick` gab es nicht.
- **Behebung (`main.js`):**
  - Ein einzelner Mausklick löst Play/Pause erst nach 250 ms aus. Ein zweiter Klick (`event.detail > 1`) und `dblclick` verwerfen ihn, und nur das Vollbild wird umgeschaltet.
  - F und das Vollbild-Symbol bleiben, Escape beendet das Vollbild wie gewohnt.
  - Bei Touch blendet Tippen weiterhin die Steuerung ein oder aus.

## 4. Reload ohne erneuten Code

- **Ursache (Hypothese bestätigt):** Nach einem manuellen Beitritt über `/` blieb die URL ohne Code. Der Wiederbeitritt nach einem Reload braucht aber `/party/<CODE>`.
- **Behebung:** Nach einem erfolgreichen Beitritt setzt `history.replaceState` die URL auf `/party/<CODE>`, falls sie noch nicht so lautet. Danach greift der bestehende Wiederbeitritt: einmal, mit gültiger Sitzung, nicht nach Verlassen, Abmelden oder Entfernung. Die Host-Quelle wird automatisch geladen, die Party-Zeit übernommen und der Start versucht.
- Private HLS-URLs und Tokens werden nicht gespeichert.
- **Vorschlag, nicht umgesetzt:** einen eigenen Video-Link optional per Klick nur für diesen Tab in `sessionStorage` merken. Er würde beim Schließen des Tabs verfallen, und der Text würde vor der Sichtbarkeit von Tokens warnen.

## Geänderte Dateien

- **Desktop:** `TorboxPartyHls.kt`, `PlayerScreenRuntimeParty.kt`, `PlayerScreenRuntimeState.kt`, `PlayerScreenRuntimePartyControls.kt`, `PlayerControlParty.kt`, `PartyRepository.kt`, `player-ui/party.js`, `composeApp/build.gradle.kts`
- **Browser:** `src/main.js`
- **Wartung:** `verify-msi.ps1`, `check-fork-invariants.sh`
- **Tests:**
  - `TorboxPartyHlsTest.kt`: Candidate, Backoff, Zustände, Cloud-Zuordnung
  - `TorboxPartyHlsPrepareTest.kt` (neu): ein `createstream`, Verarbeitung, bereit, verweigert, API-Fehler, nicht unterstützt, nicht rechtzeitig fertig
  - `PartyInviteLinkTest.kt`: Production und Preview
  - `desktop-invite.test.js`: Production, Preview, gespeicherte Adresse, manipulierte Adresse
  - `personal-hls-integration.test.js`:
    - Doppelklick ohne Play/Pause, Einzelklick einmal, Touch
    - URL nach manuellem Beitritt, Wiederbeitritt lädt die Host-Quelle wieder
    - Zustände „verarbeitet“ und „nicht unterstützt“
  - Der Test-Harness sammelt jetzt Timer und erfasst `history.replaceState`.

## Noch bestehende TorBox-Beschränkungen

- Ob `createstream` bei deinem Tarif `hls_url` liefert und auf welchem Host, zeigt erst der Live-Test. Die Meldung nennt dann Feldnamen bzw. Host.
- Liegt die HLS auf einem anderen CDN als `*.torbox.app`, teilt die App sie bewusst nicht. Das ließe sich nach Prüfung des echten Hosts gezielt freigeben.
- Addon-Streams ohne Infohash lassen sich nicht zuordnen, ebenso Torrents, die nicht in deiner TorBox-Cloud liegen oder keine eindeutige Datei haben.
- Ob TorBox die Wiedergabe von der Preview-Adresse aus zulässt (CORS) und mehrere Geräte gleichzeitig erlaubt, zeigt erst der Live-Test.

## Tests (lokal ausführen)

```powershell
Set-Location 'C:\Users\Alanp\Desktop\Chatgpt\Codex\Nuvio-Watch\NuvioDesktop\browser-site'; npm.cmd test
Set-Location 'C:\Users\Alanp\Desktop\Chatgpt\Codex\Nuvio-Watch\NuvioDesktop'; $env:JAVA_HOME='C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot'; .\gradlew.bat :composeApp:desktopTest --tests '*Party*Test' --tests '*MemberSync*' --tests '*PausedPosition*' --tests '*NativePlayerExactSeek*' --tests '*Torbox*Test' --tests '*TorboxPartyHlsPrepare*' --tests '*Fork*UpdateTest' --tests '*AppUpdate*Test' --tests '*UpdateChannelTest' --tests '*ReleaseSelector*' --tests '*VersionUtils*' --no-configuration-cache --console=plain
bash fork-maintenance/check-fork-invariants.sh
```

## Empfehlung für 0.1.43-watchparty

- **Test-Build mit Preview-Einladungen:**
  ```powershell
  .\gradlew.bat :composeApp:packageReleaseMsi -Pnuvio.desktop.versionName=0.1.43-watchparty -Pnuvio.desktop.versionCode=143 -Pnuvio.party.browserOrigin=preview -Pnuvio.webview2.dir=fork-maintenance/local/webview2-sdk/1.0.4078.44 --no-configuration-cache --console=plain
  ```
  Danach `verify-msi.ps1 -AllowPreviewOrigin` ausführen.
- **Release-Build:** ohne die Property bauen, Verifier ohne Schalter.
- 0.1.42 bleibt unverändert neben dem neuen MSI liegen.
- **Live-Test mit der Nuvio-Cloud:**
  - „HLS erstellen / aktualisieren“ drücken und die Meldung genau notieren (Verarbeitung, Feldnamen, Host).
  - Danach mit einem Addon-Stream testen, dessen Datei in deiner TorBox-Cloud liegt.

## Testergebnis (03.11.2026, lokal)

- Browser `npm test`: 192/192 bestanden.
- Desktop (Auswahl inklusive `*TorboxPartyHlsPrepare*`): 136/136 bestanden. Darunter `TorboxPartyHlsPrepareTest` 4/4, `TorboxPartyHlsTest` 8/8 und `PartyInviteLinkTest` 3/3. Der Desktop-Code kompiliert, die Bridge wurde nicht neu gebaut (`SKIPPED`). Log: `fork-maintenance/local/desktop-tests-0.1.43.log`.
- Die generierte `PartyBrowserConfig.ORIGIN` ist ohne Property Production.
- Fork-Invarianten: OK.
- Nicht live getestet.
