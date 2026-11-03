# 0.1.45: TorBox-CDN und Freigabe ohne Account-Key (nach `343d5e6d`)

Lokal, nicht committet. Kein MSI. Nicht live getestet; eine tatsächliche Browserwiedergabe ist **nicht** bestätigt.

**Unverändert:** Command-ID/ACK, exakter Seek, Play/Pause-Synchronisierung, Drift-Korrektur, Desktop-zu-Desktop, Einladungsbuttons, Fork-Updater.

## 1. Warum das TorBox-CDN bisher blockiert wurde

- `torboxHlsCandidate` akzeptierte nur `torbox.app` und `*.torbox.app`. TorBox liefert `hls_url` aber auch auf seinem CDN aus, live z. B. `flux-007.wnam.tb-cdn.io`. Daher kam „HLS-Adresse auf nicht freigegebenem Host“.
- Beim „Video-Link für alle teilen“ enthielt der eingefügte TorBox-Link den Account-Key im Parameter `token`. Die Key-Sperre hat ihn deshalb (richtig) abgelehnt; eine Variante ohne Key gab es auf diesem Weg nicht.

## 2. Unterstützte Hostnamen

- Unterstützt werden `torbox.app` und die CDN-Domains, die TorBox dokumentiert ([NextDNS-Artikel](https://support.torbox.app/en/articles/13181686-accessing-torbox-with-nextdns)):
  - `tb-cdn.cx`, `tb-cdn.io`, `tb-cdn.pw`, `tb-cdn.sh`, `tb-cdn.st`, `tb-cdn.to`, `tb-cdn.earth`
  - jeweils der exakte Name oder eine echte Subdomain
- Die Prüfung (`isTorboxStreamHost`):
  - ignoriert Groß- und Kleinschreibung
  - erlaubt pro Label nur `a-z0-9-`, ohne Bindestrich am Anfang oder Ende
  - lehnt einen Punkt am Ende ab
  - lehnt Nachahmungen ab: `evil-tb-cdn.io`, `tb-cdn.io.evil.example`, `xtorbox.app`, `tb-cdn.com`
  - akzeptiert keine IP-Adressen
- `isTorboxStreamUrl` verlangt zusätzlich HTTPS und keine Zugangsdaten in der URL.
- **Weiterleitungen und Varianten:**
  - Die Startadresse, die Zieladresse nach Weiterleitungen und die erste Variante samt ihrer Zieladresse müssen auf diesen Hosts liegen.
  - Sonst meldet die Prüfung `497` („Host außerhalb der TorBox-CDNs“): Bei der ersten Vorbereitung wird nichts geteilt, und eine schon laufende Freigabe stoppt bei der Erneuerung.
  - Eine fremde Startadresse wird gar nicht erst abgerufen.
- **SSRF:** Für TorBox-Pfade gibt es nur diese festen Namen, keine beliebigen Hosts. DNS-Rebinding bei diesen Namen würde voraussetzen, dass die DNS-Zonen von TorBox kompromittiert sind.

## 3. Absicherung der Freigabe mit eingebettetem Account-Key

Die drei Wege in der vorgegebenen Reihenfolge:

- **A, Adresse ohne vollständigen Key (umgesetzt):**
  - Steht der Key **nur** im Parameter `token` einer TorBox- oder CDN-Adresse, verwendet die App dieselbe Adresse ohne `token`.
  - Voraussetzung: TorBox liefert die Playlist und ihre erste Variante ohne Key aus, ohne Key im Inhalt und ohne fremde Hosts.
  - Die Adresse mit Key wird dabei nie abgerufen und nie geteilt. Der übrige Teil, z. B. das `presigned_token` im Pfad, ist eine Stream-Session und kein Account-Key.
  - Das gilt jetzt für **alle drei Wege**: Nuvio-Cloud-HLS, LeLibrary mit verknüpfter TorBox-Datei und „Video-Link für alle teilen“.
  - **Ob TorBox ohne Key ausliefert, ist nicht belegt.** Lehnt TorBox ab (401/403), meldet die App: „TorBox liefert die Playlist ohne Account-Key nicht“.
  - Eine offizielle Freigabe mit eingeschränkten Rechten (z. B. ein reines Stream-Token) gibt es laut TorBox-OpenAPI nicht. `getstreamdata` verlangt ebenfalls den API-Key.
- **B, eigener kleiner Dienst (nicht umgesetzt):**
  - Ein Dienst hält den Key, prüft Sitzung und Teilnehmer und liefert die Playlist oder signierte Weiterleitungen aus. Das wäre die saubere Lösung.
  - Er widerspricht aber deiner bestehenden Regel „kein eigener Watchparty-Server“. Außerdem müsste er die Segmente proxen oder neu signieren, denn sonst landet der Key wieder beim Gast.
  - Er braucht deine ausdrückliche Freigabe für Betrieb und Hosting (z. B. Cloudflare Worker mit Secret und Prüfung der Mitgliedschaft per Supabase-RPC).
  - Beim Desktop-Host selbst ist so ein Dienst nicht möglich: Browsergäste erreichen den PC nicht (NAT), und ein Tunnel wäre wieder ein Dienst.
- **C, direkte Freigabe (nicht aktiviert):**
  - Ein Nachweis fehlt weiterhin (siehe `WATCHPARTY_FAMILY_SHARE_SECURITY.md`). Die Realtime-Policies sind nicht einsehbar, und jedes Konto mit dem Party-Code kann beitreten.
  - Entfernte Mitglieder empfangen laut Supabase-Dokumentation weiter, bis ihr JWT abläuft.
  - Die Sperre für den vollständigen Key bleibt deshalb aktiv: `ContainsAccountKey`, Prüfung auf `498` und `containsAccountKey` beim Broadcast.

## 4. Verbleibende Sicherheitsgrenzen

- Auch eine Adresse **ohne** Key (Variante A) ist ein Zugang, solange die TorBox-Session gilt. Wer sie über die Party erhält (siehe die Grenzen oben), kann den Stream bis zu ihrem Ablauf abrufen.
- „Share my stream“ aus bzw. „Video-Link-Freigabe beenden“ stoppt **weitere** Broadcasts und laufende Browser-Wiedergaben. Eine schon übertragene Adresse macht nur TorBox ungültig, wenn die Session abläuft.
- Ob die Segmente einer Variante ohne Key funktionieren, prüft die App nicht, sondern nur die Playlists. Schlägt das fehl, meldet der Browser „HLS-Zugriff verweigert“.
- Beim „Video-Link für alle teilen“ mit Nicht-TorBox-Links gilt weiter nur die Prüfung von IP-Literalen (keine Auflösung des Namens). Das ist eine bewusste Aktion des Hosts und unverändert gegenüber 0.1.44.

## 5. Bereits implementiert

- CDN-Allowlist mit Prüfung der Domain-Grenzen.
- Prüfung von Weiterleitungen und der ersten Variante gegen die TorBox-Hosts. Neu ist dafür der Code `497`.
- Variante A für alle drei Wege. Im Panel steht dann „TorBox-Link ohne Account-Key geprüft“.
- Für Browsergäste der bestehende Ablauf, unverändert: automatisch laden, Party-Zeit übernehmen, Play versuchen, Reload und Reconnect über `state_request`, Folgenwechsel, Widerruf bei „Share my stream“ aus.

## 6. Geänderte Dateien

- `debrid/TorboxPartyHls.kt`: `TORBOX_STREAM_DOMAINS`, `isTorboxStreamHost`, `isTorboxStreamUrl`, `torboxKeyFreeUrl`, `TORBOX_PROBE_UNSAFE_HOST`; `probeTorboxPartyHls` mit einstellbarem Abruf und Hostprüfung
- `party/PartyHostHls.kt`: Variante A und TorBox-Hostprüfung beim Host-Link, `Ok.keyRemoved`
- `player/PlayerScreenRuntimeParty.kt`: Bei der Erneuerung stoppt `497` die Freigabe
- `player/PlayerScreenRuntimePartyControls.kt`: Statustext
- **Tests:**
  - `TorboxPartyHlsTest.kt`: Hosts, Nachahmungen, CDN-Candidate, Weiterleitung, Master und Variante, Key in der Playlist
  - `TorboxPartyHlsPrepareTest.kt`: CDN, Variante A über das CDN, unsichere Weiterleitung
  - `PartyHostHlsTest.kt`: TorBox-Link mit Key im Parameter `token`
  - `personal-hls-integration.test.js`: CDN-Quelle, Reconnect, nur der Host widerruft

## 7. Lokale Testbefehle

```powershell
Set-Location 'C:\Users\Alanp\Desktop\Chatgpt\Codex\Nuvio-Watch\NuvioDesktop\browser-site'; npm.cmd test
Set-Location 'C:\Users\Alanp\Desktop\Chatgpt\Codex\Nuvio-Watch\NuvioDesktop'; $env:JAVA_HOME='C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot'; .\gradlew.bat :composeApp:desktopTest --tests '*Party*Test' --tests '*MemberSync*' --tests '*PausedPosition*' --tests '*NativePlayerExactSeek*' --tests '*Torbox*Test' --tests '*TorboxPartyHlsPrepare*' --tests '*PartyHostHls*' --tests '*Fork*UpdateTest' --tests '*AppUpdate*Test' --tests '*UpdateChannelTest' --tests '*ReleaseSelector*' --tests '*VersionUtils*' --no-configuration-cache --console=plain
bash fork-maintenance/check-fork-invariants.sh
```

## 8. Empfehlung für 0.1.45

- Zuerst beide Testläufe, dann ein Test-MSI 0.1.45 mit `-Pnuvio.party.browserOrigin=preview` und `verify-msi.ps1 -AllowPreviewOrigin`.
- **Live-Test, in dieser Reihenfolge:**
  1. Nuvio-Cloud, „HLS erstellen / aktualisieren“: Erscheint statt „nicht freigegebener Host“ jetzt „verarbeitet“ bzw. „An Teilnehmer gesendet“, oder „ohne Account-Key nicht“?
  2. LeLibrary, Datei verknüpfen, danach dasselbe.
  3. Den TorBox-Link per „Video-Link für alle teilen“ eintragen.
  4. Im Browser prüfen: automatisch laden, Party-Zeit übernehmen, Reload, Folgenwechsel, „Share my stream“ aus.
- Liefert TorBox **ohne** Key nicht aus, bleibt für die Familienfreigabe nur Weg B (eigener Dienst). Den nur nach deiner ausdrücklichen Freigabe beginnen, weil er die Regel „kein eigener Server“ ändert.

## Testergebnis (03.11.2026, lokal)

- Browser `npm test`: 201/201 bestanden. Log: `fork-maintenance/local/browser-tests-0.1.45.log`.
- Desktop: 149/149 bestanden. Darunter `TorboxPartyHlsTest` 13/13, `TorboxPartyHlsPrepareTest` 6/6 und `PartyHostHlsTest` 6/6. Die Bridge wurde nicht neu gebaut (`SKIPPED`). Log: `fork-maintenance/local/desktop-tests-0.1.45.log`.
- Fork-Invarianten: OK.
- Nicht live getestet.
