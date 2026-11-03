# 0.1.42: UI-Fix, HLS-Automatik, Teilnehmer-Abweichung, Host-Austritt

Branch `feature/party-premium-ui`, Basis `a1eb62e0`; „Allein schauen“ war dort schon enthalten. Lokal, nicht committet. Kein Build. Command-ID/ACK, Abgleichsregeln (`applySync`), Realtime-Reconnect, IntroDB, TorBox-API-Sicherheit und Updater sind unverändert.

## Phase 1: Layout

**Ursache:**
- Die globale Regel `input, select { width: 100%; padding: 14px 15px }` traf auch die Checkbox. `.check-row input { flex: none }` hielt sie dann auf voller Breite, und der lange Text wurde zusammengedrückt.

**Behebung:**
- `.setting-row`: Titel und Kurzbeschreibung links, rechts ein 44 px breiter Schalter (`.switch`, `role="switch"`, mit Fokusring).
- Der Hinweis zur IP-Weitergabe steht in einer eigenen Zeile (`#autoHostNote`).
- Statisch im Browser-Pane geprüft (375 px, aus und ein): kein horizontaler Überlauf (`scrollWidth = clientWidth`), Schalter 44 px.

## Phase 2: Automatik standardmäßig an

- Beim ersten Besuch ist der Modus an. Ein manuelles „aus“ wird gespeichert (`nuvio-party-auto-host-stream = '0'`). Gespeichert wird nur dieser Wert.
- Die IP-Weitergabe steht dauerhaft neben dem Schalter und noch einmal beim automatischen Laden in der Statusmeldung.
- Der Ablauf (Laden, Metadaten, Party-Zeit, Start, stummer Fallback, blockiert) ist aus `a1eb62e0` übernommen. Identische Quellen werden nicht neu geladen.

## Phase 3: Ursache der HLS-Probleme

1. **„[TB+] LeLibrary 4K · HDR“ ist ein Addon-Stream.**
   - `torboxPartyFile` wird nur von der integrierten TorBox-Debrid-Auflösung gesetzt (`DirectDebridResolver`, `DebridProviderApis`, Cloud-Bibliothek). Ein Addon-Name mit „TB+“ setzt es nicht.
   - Ohne die Kennung bereitet der Host nichts vor (`prepareTorboxPartyHls` startet nicht) und schickt kein `browser_hls`. Der Browser bekommt die Originalquelle (MKV) und meldet zu Recht „kann nicht abspielen“.
   - Ohne neue, autorisierte Auflösung lässt sich das nicht in HLS umwandeln. Datei-IDs zu raten wäre unsicher und ist nicht umgesetzt.
2. **Bei einer neuen Folge** passiert dasselbe, wenn sie wieder über das Addon läuft.
3. **Bei echten TorBox-Dateien** wird bei einem Medienwechsel **keine** inkompatible Originalquelle vorab verteilt. `currentPartyStream()` gibt bis zum Wechsel des Party-Films `null` zurück und danach `browser_hls.url = null` (wird vorbereitet), bis die neue Folge bereit ist. Das wurde so bestätigt, es war keine Änderung nötig. Ein dauerhaftes „noch nicht verfügbar“ bei einem Fehlschlag war bisher aber nicht von einer laufenden Vorbereitung zu unterscheiden.

**Behebung:**
- `PartyBrowserHls.state` (optional): `preparing` (auch nach Ablauf und Erneuerung), `denied` oder `failed`. Der Desktop setzt es aus `torboxPartyPhase`. Ältere Browser ignorieren es.
- Der Browser zeigt getrennte Texte:
  - wird vorbereitet (startet danach automatisch)
  - Zugriff verweigert
  - fehlgeschlagen (Hinweis auf „HLS erstellen / aktualisieren“)
  - eine Originalquelle ohne `browser_hls`: „nur Quellen aus der integrierten TorBox-Auflösung; ‚TB+‘ reicht dafür nicht“
- Desktop-Panel: Bei aktiver Freigabe einer Nicht-TorBox-Quelle zeigt es „Browser-HLS: Nicht verfügbar: … Addon-Stream …“. Der Button erscheint dann nicht.

## Phase 4: Teilnehmer-Abweichung

- Desktop und Browser melden etwa alle 10 s im vorhandenen `status`-Event optional `position_ms`, `position_at` (Serverzeit) und `playing`. Das ist rein informativ: Es wird nie als Steuerbefehl behandelt (Test: Party-`seq` unverändert) und gilt nur für denselben Film. Ältere Clients ignorieren die Felder (`ignoreUnknownKeys`).
- Die Regel ist auf beiden Seiten gleich (`PartySync.memberSync` und `protocol.memberSync`):

  | Zustand | Bedingung |
  |---|---|
  | Synchron | Abweichung höchstens 1 s |
  | Holt auf | höchstens 15 s |
  | Puffert | `loading`/`buffering` |
  | Unsynchron | mehr als 15 s, oder `behind` (z. B. „Allein schauen“) |
  | Status veraltet | Meldung älter als 30 s |

  Ein Wert wie „(+0,3 s)“ zeigt den geschätzten Abstand.
- **Anzeige am Desktop:** in der Statuszeile jedes Mitglieds im Party-Panel, nur in einer aktiven Party; die eigene Zeile nimmt die Live-Position.
- **Anzeige im Browser:** in der Mitgliederliste im Drawer.
- Bei einem Medienwechsel werden die Meldungen verworfen.
- Die Befehlsreihenfolge (Command-ID) ist unverändert.

## Phase 5: Unsync und Host-Austritt

- **Unsync** war bereits als „Allein schauen“ in `a1eb62e0` vorhanden (keine eigenen Befehle, keine Fremdeingriffe, „Zur Party“).
- **Party-Ende und Austritt des Hosts:** Eine geladene Quelle (eigene oder geteilte) läuft lokal weiter. Die Seite schaltet auf „Allein“, die Verbindung zeigt „Nicht verbunden“, und die Meldung sagt ausdrücklich, dass es keine gemeinsame Party mehr gibt. „Zur Party“ erklärt dann, dass die Party beendet ist.
- **Hostwechsel** (`stream(null, 'host_changed')`): Die bisherige Quelle läuft lokal weiter; „Zur Party“ übernimmt die Zeit des neuen Hosts.
- **Gestoppt wird weiterhin:**
  - ausdrücklicher Widerruf („Share my stream“ aus, `stream(null)` ohne Grund)
  - Entfernung aus der Party (`removed`)
  - eigenes Verlassen und neuer Beitritt
  - Filmwechsel
- Eine automatische Hostübergabe ist nicht umgesetzt.
- Läuft der TorBox-Link ohne Host ab, meldet der Player einen normalen Wiedergabefehler.

## Geänderte Dateien

- **Browser:** `index.html`, `src/style.css`, `src/main.js`, `src/session.js`, `src/protocol.js`
- **Browser-Tests:** `tests/personal-hls-integration.test.js` (Harness mit `localStorage`; bestehende Tests nutzen „aus“), `tests/protocol.test.js`, `tests/session.test.js`
- **Desktop:** `PartyModels.kt`, `PartyRepository.kt`, `PartySync.kt`, `PlayerScreenRuntimeParty.kt`, `PlayerScreenRuntimePartyControls.kt`, `player-ui/party.js`
- **Desktop-Test:** `commonTest/.../party/MemberSyncTest.kt` (neu)

## Tests (lokal ausführen)

```powershell
Set-Location 'C:\Users\Alanp\Desktop\Chatgpt\Codex\Nuvio-Watch\NuvioDesktop\browser-site'; npm.cmd test
Set-Location 'C:\Users\Alanp\Desktop\Chatgpt\Codex\Nuvio-Watch\NuvioDesktop'; $env:JAVA_HOME='C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot'; .\gradlew.bat :composeApp:desktopTest --tests '*Party*Test' --tests '*MemberSync*' --tests '*Torbox*Test' --tests '*Fork*UpdateTest' --tests '*AppUpdate*Test' --tests '*UpdateChannelTest' --tests '*ReleaseSelector*' --tests '*VersionUtils*' --no-configuration-cache --console=plain
bash fork-maintenance/check-fork-invariants.sh
```

## Offene Einschränkungen

- Addon-Streams, auch solche mit „TB+“ im Namen, erhalten kein Browser-HLS. Dafür müsste der Host die Quelle über die integrierte TorBox-Auflösung wählen. Ein automatischer Weg vom Addon zu TorBox wäre eine eigene, autorisierte Auflösung und ist nicht Teil dieses Patches.
- Die Abweichung ist eine Schätzung: Meldungen kommen etwa alle 10 s, dazwischen wird extrapoliert, mit Rate 1 und ohne Messung der Netzwerklatenz.
- Ein Hostwechsel lässt den alten Host-Link weiterlaufen, bis er abläuft. Das ist kein Widerruf, aber auch keine dauerhafte Freigabe.
- Für den Desktop-Teil (Positionsmeldung, Panel-Texte, HLS-Status) ist ein neuer MSI nötig (Vorschlag `0.1.42-watchparty`). Für den Browser-Teil braucht es ein neues Preview-Deployment.
- Nichts davon ist live getestet.

## Testergebnis (03.11.2026, lokal)

- Browser `npm test`: 179/179 bestanden.
  - Beim ersten Lauf schlugen 7 bestehende Tests fehl. Sie zählten alle Kanal-Nachrichten und damit auch die neue Positionsmeldung. Der Test-Helfer `controllable` erfasst `status`-Meldungen jetzt getrennt (`statuses`); der App-Code ist dafür unverändert.
  - Neu ist ein Test für Inhalt und Häufigkeit der Meldung (höchstens alle 10 s).
- Desktop (Auswahl inklusive `*MemberSync*` und `*Torbox*Test`): 119/119 bestanden, `MemberSyncTest` 5/5. Der Desktop-Code kompiliert. Log: `fork-maintenance/local/desktop-tests-0.1.42.log`.
- Fork-Invarianten: OK.
- Nicht live getestet.
