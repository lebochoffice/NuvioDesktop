# Windows-MSI 0.1.36 – Buildnachweis

Lokaler Branch `feature/torbox-hls-mvp`, vorhandene uncommittete Änderungen enthalten. Versionsdatei weiterhin `0.1.33-alpha` / 33; für diesen Build wurden die vorgesehenen Gradle-Overrides `nuvio.desktop.versionName=0.1.36-torbox-party-hls` und `nuvio.desktop.versionCode=36` verwendet. Die bisherigen Installer reichten bis 0.1.35. Keine Tests erneut gestartet; grüne manuelle Tests wurden vom Nutzer gemeldet.

- Datei: `C:\Users\Alanp\Desktop\Chatgpt\Codex\Nuvio-Watch\NuvioDesktop\composeApp\build\compose\release-msis\Nuvio-Windows-x64-0.1.36-torbox-party-hls.msi`
- App-Version: `0.1.36-torbox-party-hls`, Code 36.
- Aus MSI gelesene Produktversion: `1.1.36` gemäß bestehender jpackage-Versionsabbildung.
- Größe: **193310908 Bytes**.
- SHA-256: `2629e0a2cc7983e8443ce0b9725d82c43009ca17cf4051895acc6db5b3f2cbe1`.
- Signaturstatus: `NotSigned`.
- Gradle: `:composeApp:packageReleaseMsi`, `BUILD SUCCESSFUL in 2m 56s`, 9 Tasks ausgeführt, 15 aktuell. JDK 21 und vorhandenes WebView2-SDK verwendet; CI-Schutzskript unverändert.

## Verifikation

`fork-maintenance/verify-msi.ps1` mit explizitem MSI-Pfad erfolgreich. Produktmetadaten, öffentlicher Nuvio-Backend-Stand, Bridge, Java-/WebView2-/Player-Runtime geprüft. Das zugehörige `*-verification.json` liegt neben dem Installer.

Zusätzlich wurde das Anwendungs-JAR über seine MSI-File-ID mit dem vorhandenen 7-Zip direkt aus dem MSI ausgelesen, ohne Windows Installer auszuführen. Sein SHA-256 entspricht exakt dem Staging-JAR. Darin sind `PartyBrowserHls`, `PartyStream.forDesktop`, das optionale `browser_hls` und die TorBox-Vorbereitung enthalten. `player-ui/party.js` stimmt bytegenau mit dem aktuellen Quellstand überein. Somit sind Originalstream für Desktop, optionale Browser-HLS-Metadaten und die neue Copy-only-Einladungslogik im gebauten Stand enthalten. Der vorhandene gemeinsame Playback-State und die aktuellen Desktop-Synchronisierungskorrekturen wurden mit kompiliert; dies ist kein neuer Live-Wiedergabetest.

Die SHA-256-Werte sämtlicher älterer veröffentlichter lokaler MSI-Dateien wurden vor und nach dem Build verglichen: unverändert. Keine Installation, App-Ausführung, Tests, Commits, Pushes, Merges, Releases oder Deployments.

## Zusätzlich auf Cloudflare Pages benötigt

Der MSI aktualisiert die Website nicht. Pages muss aus dem **aktuellen gesamten `browser-site/`** neu gebaut werden. Insbesondere müssen `index.html`, `src/main.js`, `src/protocol.js`, `src/session.js`, `src/personal-hls.js`, das vorhandene `src/style.css`, `package.json`/Lockdatei und `public/_redirects` sowie `public/_headers` einbezogen werden. Buildbefehl: `npm run build`, Ausgabeverzeichnis: `dist` relativ zum Browserprojekt. Bei direktem Upload das vollständig erzeugte `dist/` veröffentlichen, nicht rohe Quelldateien. Öffentliche Backendwerte beim Build wie bisher konfigurieren; keine TorBox-Account-Keys eintragen.

Der Browser-Build und das Pages-Deployment wurden hier nicht gestartet. Besonders die Auswahl von `browser_hls` und die Browser-Realtime-/HLS-Korrekturen benötigen diesen separat aktualisierten Browserstand.
