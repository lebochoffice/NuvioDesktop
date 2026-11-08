# 0.1.44: Gemeinsamer Video-Link, Auto-Sync, TorBox ohne Key, LeLibrary (nach `7af93ce7`)

Lokal, nicht committet. Kein MSI. Nicht live getestet.

**Unverändert:** Command-ID/ACK, exakter nativer Seek, Play/Pause/Seek-Protokoll, Realtime-Reconnect, Drift-Korrektur, Desktop-zu-Desktop-Sync, Player-Bridge.

## 1. Ursache der bisherigen manuellen Linkverteilung

- Ein eigener HLS-Link existierte nur im Browser als **persönliche** Quelle (`PersonalHlsSource`). Er wurde bewusst nie gesendet, also musste jeder Gast ihn selbst eintragen.
- Der Desktop-Host konnte als Browserquelle nur TorBox-HLS (`browser_hls`) oder die Originalquelle teilen. Eine Eingabe für einen eigenen Link gab es nicht.
- Bei Nuvio-Cloud-Quellen enthielt die TorBox-HLS-Adresse den Account-Key. Sie wurde deshalb (richtig) nicht geteilt, und es blieb nichts übrig.

## 2. Automatische Verteilung (implementiert)

**Desktop-Host gibt einen Link ein** (Party-Panel, „Video-Link für alle teilen“):
- Ein Häkchen zur Zustimmung ist Pflicht. Der Text sagt, dass der Link an alle geht, enthaltene Tokens für alle sichtbar sind und „Share my stream“ eingeschaltet wird.
- Der Desktop prüft vor dem Senden (`PartyHostHls.kt`, `checkPartyHostHls`):
  - öffentliche HTTPS-Adresse ohne Zugangsdaten, kein Fragment, höchstens 4096 Zeichen
  - kein konfigurierter Debrid-Key, weder im Link noch in der Playlist
  - die Antwort beginnt mit `#EXTM3U` und ist eine abgeschlossene VOD-Playlist (`#EXT-X-ENDLIST`, Segmente). Bei einer Master-Playlist wird die erste Variante genauso geprüft.
  - auch eine Weiterleitung muss auf einen öffentlichen Host führen
  - es werden keine Header gesendet, und es gibt kein Logging der URL
- Verteilt wird über das **bestehende** `stream`-Ereignis: `browser_hls.url` ist der Link, `browser_hls.label` lautet „Video-Link des Hosts“. Ist die Originalquelle nicht teilbar, wird wie bei TorBox ein reiner HLS-Stream gesendet. Dann spielen ihn auch Desktop-Gäste.
- Browser laden ihn im Auto-Modus (Standard) sofort, übernehmen die Party-Zeit und starten, soweit der Browser es erlaubt. Sonst gilt der stumme Rückfall bzw. der ▶-Klick.
- Neue Gäste, Rejoins und Reconnects bekommen ihn über die bestehende `state_request`-Antwort. Dasselbe Angebot lädt nicht neu.
- Der Link gilt nur für **diesen Titel und diese Party**. Bei einem Film- oder Folgenwechsel endet er; für die neue Folge braucht es einen neuen Link.
- „Video-Link-Freigabe beenden“ widerruft ihn. Browser stoppen die Quelle. Der Text sagt ehrlich, dass ein schon übertragener Link nur vom Anbieter ungültig gemacht werden kann.
- Der persönliche Video-Link bleibt unverändert.

**Ein Browser schlägt einen Link vor** (bestätigungspflichtig):
- Im Browser gibt es neben „Video laden“ das Häkchen „Auch dem Host als Party-Quelle vorschlagen“, standardmäßig aus. Es gilt nur für diesen einen Link.
- Der Browser sendet ein neues, optionales Realtime-Ereignis `stream_suggest` mit `member_id`, `media_key` und `url`. Er übernimmt nichts selbst und spielt weiter seine private Quelle.
- Der Desktop-Host zeigt: „*Name* schlägt einen Video-Link vor (*Host*)“. Zu sehen sind nur der Name und der Hostname, nie die URL.
  - „Prüfen und für alle freigeben“ öffnet einen Bestätigungsdialog mit dem Token- und IP-Hinweis. Danach folgt dieselbe Prüfung wie oben.
  - „Ablehnen“ verwirft den Vorschlag.
- Der Vorschlag liegt nur im Speicher. Er fällt weg bei einem Titelwechsel, beim Verlassen des Gastes und beim Party-Ende.
- **Absender:** Realtime-Identitäten prüft der Server nicht. Der Name ist deshalb nur eine Anzeige. Sicher ist der Ablauf allein dadurch, dass der Host bestätigt und der Desktop den Link prüft.

**Unautorisierte Freigabe:** Browser übernehmen ein `stream`-Ereignis weiterhin nur, wenn `member_id` dem Host entspricht. Das schützt nur vor Versehen, nicht vor einem böswilligen Mitglied, das die `member_id` des Hosts fälscht. Das war schon vorher so (siehe Abschnitt 5).

**Spätere eigenständige Browser-Lobby (nur dokumentiert):**
- Derselbe Ablauf mit einem autorisierten Browser-Host: Der Host gibt den Link ein, stimmt ausdrücklich zu und prüft die Playlist im Browser per hls.js. Dabei gilt `#EXT-X-ENDLIST`; CORS wird direkt sichtbar.
- Verteilt wird per `stream`, Vorschläge kommen per `stream_suggest`, und die Bestätigung bleibt beim Host.
- Die Host-Rolle muss dort serverseitig feststehen (RPC bzw. RLS), nicht über `member_id` im Payload. Einen neuen Raumdienst gibt es noch nicht.

## 3. HLS-Auto-Sync: vorher und nachher

- **Vorher:** Link eingeben → Playlist lädt → „Party-Zeit aktualisieren“ muss man selbst klicken.
- **Nachher:**
  - Sobald die VOD-Playlist erkannt ist, die Metadaten da sind und die Party-Position suchbar ist, synchronisiert der Browser von selbst und versucht Play. Bei einer Autoplay-Sperre greift der bestehende stumme Rückfall.
  - Ist die Position noch nicht suchbar, prüft er jede Sekunde neu, **höchstens 30-mal**. Danach meldet er, dass der Sync-Button es erneut versucht.
  - Fehlt die Playlist noch, wartet er auf `LEVEL_LOADED`. Ist die Quelle nicht verwendbar (Live, falsche Fassung), bricht er ab.
  - **„Allein schauen“:** keine automatische Rückkehr. Auch ein neuer eigener Link im Solo-Modus bleibt solo.
  - Der Sync-Button bleibt. Am Synchronisierungsalgorithmus hat sich nichts geändert (`resyncNow`/`applySync` werden nur aufgerufen).

## 4. TorBox-Cloud und LeLibrary

**Variante A, Freigabe ohne Account-Key (implementiert, live ungeprüft):**
- TorBox baut seine Player-Adresse im Web-Player (öffentliches Bundle) als `…/stream/<presigned_token>/…?token=<user_token>`. Laut Live-Meldung ist `user_token` der Account-Key.
- Eine offizielle Freigabe ohne Key ist in der OpenAPI **nicht** dokumentiert: `getstreamdata` verlangt ebenfalls den API-Key.
- **Neu:** Steht der Key **nur** im Parameter `token` (nicht im Pfad, nicht in anderen Parametern), versucht die App dieselbe Adresse **ohne** `token`. Sie wird nur verwendet, wenn TorBox die Playlist **und deren erste Variante** ohne Key ausliefert und darin kein Key steht.
- Die Adresse mit Key wird dabei weder abgerufen noch geteilt. Antwortet TorBox mit 401/403, meldet die App: „Die HLS-Adresse enthält den Account-Key, und ohne ihn liefert TorBox die Playlist nicht …“.
- Ob das funktioniert, zeigt **erst der Live-Test**. Gut möglich, dass TorBox den Token verlangt; dann bleibt es bei der Meldung.
- Grenze: Verlangen die Segmente den Token, scheitert der Browser. Er meldet dann „HLS-Zugriff verweigert“.

**LeLibrary, „Mit TorBox-Datei verknüpfen“ (implementiert):**
- Der Button erscheint für Host-Addon-Streams ohne TorBox-Dateikennung, wenn ein TorBox-Key gespeichert ist.
- Er lädt `torrents/mylist` des Hosts. Angezeigt werden **nur Videodateien** mit ihren **echten** `torrent_id` und `file_id`, alphabetisch und höchstens 400. Im Panel lässt sich filtern; angezeigt werden 60 Treffer.
- Ein Klick fragt nach („Nur wählen, wenn es exakt dieser Film bzw. diese Folge ist“). Der Desktop akzeptiert nur ein ID-Paar aus der gerade geladenen Liste. Es wird nichts geraten und nichts automatisch gewählt.
- Die Verknüpfung gilt nur für den aktuellen Titel (`media_key`). Sie endet beim Titelwechsel, beim Party-Ende und mit „Verknüpfung lösen“.
- Danach bereitet der vorhandene TorBox-HLS-Ablauf die Datei vor, mit allen Zuständen und auch Variante A. Die Nuvio-Wiedergabe bleibt bei LeLibrary.

## 5. Sicherheitsbewertung der Familienfreigabe (Variante B, **nicht implementiert**)

**Datenfluss, falls umgesetzt:**
1. Der Host gibt die HLS-Adresse mit `?token=<Account-Key>` frei.
2. Sie geht per Supabase-Realtime-Broadcast an den privaten Kanal `watch-party:<id>`. Alle angemeldeten Party-Mitglieder (Desktop und Browser) empfangen den Payload.
3. Jeder Browser lädt die Playlist und die Segmente direkt bei TorBox, mit dem Key in der URL.

**Risiken:**
- Der TorBox-API-Key ist **kein** Stream-Token. Er erlaubt den vollen Account-Zugriff: Cloud lesen und löschen, Downloads anlegen, Einstellungen ändern und laut OpenAPI sogar `DELETE /v1/api/user/deleteme`.
- Jeder Empfänger kann den Key aus der Medienadresse ablesen (DevTools, Netzwerkprotokoll, Browser-Verlauf, Erweiterungen). Er bleibt auch nach der Party gültig.
- **Ein Widerruf macht ihn nicht ungültig.** Das geht nur durch Neuerzeugen des Keys bei TorBox. Danach muss er auch in Nuvio neu eingetragen werden.
- Realtime-Payloads tragen eine selbst erklärte `member_id`. Der Server prüft nur die Kanalmitgliedschaft (RLS des offiziellen Backends, hier nicht einsehbar), nicht den Absender. Jedes Mitglied empfängt alle Broadcasts. Eine Zugangskontrolle „nur für bestimmte Gäste“ gibt es nicht.
- Tokens landen zusätzlich in Logs von CDN und Proxy sowie in Crash-Reports der Gäste. Das liegt außerhalb unserer Kontrolle.
- Fair-Use: TorBox erlaubt das Teilen mit Familie und Freunden. Gleichzeitige Streams und Gerätegrenzen können trotzdem zu Sperren führen.

**Empfehlung:**
- Variante B nur umsetzen, wenn Variante A live scheitert, und dann:
  - ein eigener Schalter, standardmäßig aus, pro Party
  - Warnung mit genau diesen Punkten und ausdrücklicher Bestätigung
  - nur per `stream`, nie per Einladung, Chat, Log oder Speicher
  - danach den Hinweis, den Key bei TorBox neu zu erzeugen
- Die bestehenden Sperren (`ContainsAccountKey`, Prüfung auf `498`, `containsAccountKey`) bleiben unverändert.
- Besser: ein eigener TorBox-Account bzw. Unteraccount für Partys, sofern TorBox das anbietet. Das ist nicht geprüft.

## 6. Geänderte Dateien

- **Desktop:**
  - `party/PartyHostHls.kt` (neu): Prüfung und Modell für Host-Link und Vorschlag
  - `PartyRepository.kt`: `stream_suggest`, `hlsSuggestion`
  - `PartyChannel.kt`: Ereignisliste
  - `PartyModels.kt`: `PartyBrowserHls.label`
  - `TorboxPartyHls.kt`: `KeyOnlyInTokenParameter`, Prüfung der ersten Variante, `torboxCloudVideoChoices`/`listTorboxCloudChoices`
  - `PlayerScreenRuntimeParty.kt`: Host-Link im `stream`, manuelle Verknüpfung, Reset bei Titel- oder Party-Wechsel
  - `PlayerScreenRuntimePartyControls.kt`: Panel-Zustand und Aktionen
  - `PlayerScreenRuntimeState.kt`, `PlayerControlParty.kt`
  - `player-ui/party.js`: Panel für Link, Vorschlag und TorBox-Liste
- **Browser:**
  - `src/main.js`: Vorschlag, Auto-Sync, Startseite
  - `src/session.js`: `suggestStream`
  - `src/protocol.js`: Label
  - `index.html`: Häkchen
- **Tests:**
  - `PartyHostHlsTest.kt` (neu)
  - `TorboxPartyHlsTest.kt`: Variante A, Cloud-Liste; ein Erwartungswert angepasst, weil der Key im `token` jetzt `KeyOnlyInTokenParameter` ergibt
  - `TorboxPartyHlsPrepareTest.kt`: Variante A
  - `personal-hls-integration.test.js`:
    - 6 neue Tests
    - Startseiten-Test angepasst
    - Diagnose-Test: Play wird jetzt vor dem Laden der Playlist blockiert, weil die Quelle sonst schon automatisch synchronisiert
  - `protocol.test.js`: Label
- **Wartung:** diese Datei

## 7. Testbefehle für dich

```powershell
Set-Location 'C:\Users\Alanp\Desktop\Chatgpt\Codex\Nuvio-Watch\NuvioDesktop\browser-site'; npm.cmd test
Set-Location 'C:\Users\Alanp\Desktop\Chatgpt\Codex\Nuvio-Watch\NuvioDesktop'; $env:JAVA_HOME='C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot'; .\gradlew.bat :composeApp:desktopTest --tests '*Party*Test' --tests '*MemberSync*' --tests '*PausedPosition*' --tests '*NativePlayerExactSeek*' --tests '*Torbox*Test' --tests '*TorboxPartyHlsPrepare*' --tests '*PartyHostHls*' --tests '*Fork*UpdateTest' --tests '*AppUpdate*Test' --tests '*UpdateChannelTest' --tests '*ReleaseSelector*' --tests '*VersionUtils*' --no-configuration-cache --console=plain
bash fork-maintenance/check-fork-invariants.sh
```

## 8. Offene Risiken und Empfehlung für 0.1.44

- **Variante A** ist reine Hypothese, bis TorBox antwortet. Im Live-Test „HLS erstellen / aktualisieren“ drücken und die Meldung notieren.
- **CORS:** Der Desktop kann nicht prüfen, ob ein Host-Link im Browser abspielbar ist. Das zeigt erst die Wiedergabe beim Gast.
- **Fremd-Links mit Tokens:** Beim Freigeben sehen alle Mitglieder die Tokens. Das steht im Zustimmungstext.
- **Realtime-Absender** bleiben unauthentifiziert (bestehend). Die Host-Bestätigung schützt nur vor ungewollter Übernahme, nicht vor einem gefälschten `stream`-Ereignis eines böswilligen Mitglieds.
- **Mylist:** Die Liste ist auf 400 Videodateien begrenzt. Bei sehr großen Clouds muss die Datei unter den ersten 400 (alphabetisch) liegen.
- **Empfehlung:**
  - Zuerst beide Testläufe.
  - Danach ein Test-MSI 0.1.44 mit `-Pnuvio.party.browserOrigin=preview` und `verify-msi.ps1 -AllowPreviewOrigin`.
  - Die Preview erst nach einem Push, damit Browser-Häkchen und Auto-Sync dort ankommen.
  - Live prüfen: Host-Link an zwei Browser, Reload, Folgenwechsel, Widerruf, Vorschlag, LeLibrary-Verknüpfung, TorBox ohne Key.

## Testergebnis (03.11.2026, lokal)

- Browser `npm test`: 199/199 bestanden. Log: `fork-maintenance/local/browser-tests-0.1.44.log`.
  - Im ersten Lauf schlugen 3 bestehende Tests fehl (nativer Seek abgelehnt, Seek-Rennen, Stall-Erholung). Der neue Auto-Sync hatte schon gesprungen, und im Test-Gerüst kam kein `seeked`.
  - Behoben nur im Test-Gerüst: `readyGuest` lässt den automatischen Sprung mit `seeked` landen, wie im echten Browser. Am Algorithmus hat sich nichts geändert.
- Desktop (Auswahl inklusive `*PartyHostHls*`): 144/144 bestanden. Darunter `PartyHostHlsTest` 5/5, `TorboxPartyHlsTest` 10/10 und `TorboxPartyHlsPrepareTest` 5/5. Die Bridge wurde nicht neu gebaut (`SKIPPED`). Log: `fork-maintenance/local/desktop-tests-0.1.44.log`.
  - Im ersten Lauf schlug ein Test fehl: Ktor liest „not a url“ als Host `localhost`. `partyHlsDisplayHost` zeigt den Host jetzt nur bei einer öffentlichen HTTPS-Adresse.
- Fork-Invarianten: OK.
- Nicht live getestet.
