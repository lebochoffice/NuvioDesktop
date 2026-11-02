# Nuvio Watch in Browser

Für den alternativen privaten HLS-Modus siehe [Eigene HLS-URL (Beta): MVP und manuelle Prüfung](HLS_BETA_MANUAL_TEST.md). Dieser MVP wurde auf Wunsch ohne Ausführung von Tests, Builds oder Deployments ergänzt; echte TorBox-Videowiedergabe ist noch nicht bestätigt.

Inoffizieller Browser-Gast für vorhandene Nuvio-Desktop-Partys. Die Website liefert keine Filme und benötigt das **gleiche autorisierte Backend** wie der Desktop-Host. Der Host muss den Player geöffnet halten und die Streamquelle ausdrücklich freigeben.

## Lokal vorbereiten

Node 22.12+ oder Node 24 LTS verwenden. In diesem Ordner:

```powershell
npm.cmd ci --ignore-scripts
Copy-Item .env.example .env.local
```

In `.env.local` die tatsächlichen öffentlichen Werte eintragen:

```dotenv
VITE_SUPABASE_URL=https://DEIN-AUTORISIERTES-BACKEND
VITE_SUPABASE_ANON_KEY=DEIN-OEFFENTLICHER-PUBLISHABLE-ODER-ANON-KEY
```

Die Beispiele sind Platzhalter. Keine Passwörter, Service-Role-Keys, `sb_secret_`-Keys, Debrid-Schlüssel oder persönlichen Tokens verwenden. Alle `VITE_*`-Werte werden öffentlich in die Website eingebaut. `.env` und `.env.*` außer `.env.example` sind ausgeschlossen. Diese Website akzeptiert Publishable-Keys und anon-JWTs; andere Schlüsselrollen werden vor Verbindungsaufbau abgelehnt.

```powershell
npm.cmd test
npm.cmd run build
npm.cmd run dev
```

Auf `http://127.0.0.1:5173/party/UXZ83H` mit eigenem Nuvio-Konto anmelden. Erst „Party beitreten“, dann „Freigegebenen Stream laden“, danach „Wiedergabe synchronisieren“ anklicken. Lokales Pausieren/Spulen löst die Synchronisierung; erneut synchronisieren stellt sie wieder her. Browser-Gäste veröffentlichen keine Playback-Steuerung. Die Wiedergabe folgt den akzeptierten Party-Ereignissen, auch wenn der Desktop die Steuerung für andere App-Mitglieder freigegeben hat.

## Kostenlos auf Cloudflare Pages veröffentlichen

Es wurde **nichts automatisch veröffentlicht**. Nur die statischen Website-Dateien gehören auf Pages; keine Videos, MSI-Dateien oder Backend-Geheimnisse hochladen. Der Cloudflare-Free-Tarif reicht für diese kleine statische Website innerhalb seiner Limits. Das vorhandene Backend und der Medienanbieter haben eigene Limits.

### Variante A: Dateien manuell hochladen

1. Die beiden Werte in `.env.local` setzen und `npm.cmd run build` ausführen.
2. Im Cloudflare-Dashboard unter **Workers & Pages** ein **Pages**-Projekt mit **Direct Upload / Upload assets** erstellen. Free-Tarif verwenden, keine kostenpflichtigen Zusatzprodukte aktivieren.
3. Den **Inhalt** von `dist/` hochladen. `index.html`, `assets/`, `_redirects` und `_headers` müssen direkt auf der Website liegen.
4. Manuell veröffentlichen. Cloudflare vergibt `https://DEIN-PROJEKT.pages.dev`.
5. Einen direkten Aufruf von `/party/UXZ83H` und danach einen Browser-Reload prüfen.

Bei Direct Upload werden keine Build-Variablen nachträglich eingebaut: Änderungen an `.env.local` erfordern einen neuen lokalen Build und Upload. Cloudflare erlaubt keinen direkten Wechsel eines Direct-Upload-Projekts auf Git-Integration; bei Bedarf ein neues Projekt anlegen.

### Variante B: Eigenes Git-Repository verbinden

1. Nur diesen Website-Ordner in ein eigenes Repository übernehmen: Quellcode, `public/`, `index.html`, `package.json`, `package-lock.json` und `.gitignore`. Keine `.env*` mit echten Werten, `node_modules/`, `.npm-cache/` oder Test-Screenshots committen.
2. Ein Pages-Projekt mit Git-Integration erstellen. Repository auswählen. Projektwurzel ist der Website-Ordner; wenn nur dessen Inhalt im Repository liegt, ist das `/`.
3. Framework Vite/None, Build-Befehl `npm run build`, Ausgabeordner `dist`, `NODE_VERSION=24` einstellen.
4. Unter Build-/Umgebungsvariablen **vor dem Build** `VITE_SUPABASE_URL` und `VITE_SUPABASE_ANON_KEY` setzen. Production verwenden; Preview nur, wenn auch Test-Deployments dieses Backend verwenden dürfen.
5. Den ersten Build selbst auslösen. Änderungen der Werte erfordern einen neuen Build.

`public/_redirects` enthält `/party/* /index.html 200`. `public/_headers` setzt unter anderem `Referrer-Policy: no-referrer`, einen Frame-Schutz und eine Content Security Policy. Medien und Backend-Verbindungen dürfen öffentliche HTTPS-/WSS-Ziele verwenden; die Medienserver müssen selbst CORS erlauben. Die Website hat keinen Proxy.

## Desktop-Link

Im modifizierten Desktop-Player eine Party starten und das Watch-Party-Panel öffnen. Unter **Watch in Browser** ausschließlich den HTTPS-Ursprung deiner tatsächlichen Website eintragen, beispielsweise `https://meine-seite.pages.dev`. **Watch in Browser · Copy link** kopiert dann `https://meine-seite.pages.dev/party/UXZ83H`.

Ist „Share my stream“ noch aus, wird vorher eine Bestätigung angezeigt. Abbrechen aktiviert nichts. Eine ungültige Seitenadresse aktiviert ebenfalls nichts. Bei schon aktivierter Freigabe wird nur kopiert. Die bestehenden normalen Nuvio-Einladungen und die Funktion `partyInviteLink` bleiben erhalten. Die Desktop-Bestätigung meldet, ob die Zwischenablage gesetzt wurde.

## Backend-Kompatibilität

Geprüft gegen NuvioDesktop `Dev`, Commit `3e876f699e59e38b66ccc738331fa8071cbf29cc`. Maßgeblich sind `PartyApi.kt`, `PartyModels.kt`, `PartyChannel.kt`, `PartyRepository.kt`, `PartySync.kt`, `PartyChat.kt` und die Serverkonfiguration.

Verwendete vorhandene RPCs: `watch_party_preview`, `watch_party_join`, `watch_party_heartbeat`, `watch_party_leave`, `watch_party_clock`, `watch_party_list_messages`, `watch_party_send_message`. Join sendet dieselben Identitätsfelder wie der Desktop. Optionaler Profilindex wird ausschließlich bei `PGRST202` ohne diesen Parameter wiederholt, entsprechend `PartyApi.callWithProfile`.

Die Anmeldung nutzt Supabase Email/Password mit einem nicht anonymen Konto. Es wird kein Konto angelegt. Die SDK-Sitzung wird lokal gespeichert und automatisch erneuert. Vor der privaten Kanal-Anmeldung wird das Session-JWT über `realtime.setAuth` gesetzt. Das SDK verwendet explizit das kompatible JSON-Protokoll `vsn=1.0.0` und den von Nuvios Gateway benötigten Parameter `nuvio_realtime=1`. Ohne diesen Parameter scheiterte der echte Verbindungsaufbau zum offiziellen Backend.

Kanal: `watch-party:<party-id>`, `private: true`, Mitglieds-ID als Presence-Key. Zustände und Streamquelle kommen über `state`/`stream`; `state_request` fragt den laufenden Desktop-Host nach der Quelle. Metadaten, Host-Wechsel und Mitgliedschaft werden über Heartbeat-Snapshots abgeglichen. Chat läuft über die vorhandenen RPCs und `chat` als Aktualisierungssignal. Die Playback-Reihenfolge verwendet Sequenznummer **und** den Desktop-Tie-Break über Mitglieds-ID; Medienwechsel setzen den vorherigen Zustand zurück.

Ohne geladenes Video meldet der Gast `browsing`. Er meldet beim Synchronisieren `ready`, bei echtem Puffern `buffering`, bei lokal entkoppelter Wiedergabe `behind`. Er blockiert die Party nicht dauerhaft mit einem fälschlichen `loading`. Austritt und ungültige Mitgliedschaft stoppen das Video und die Timer. Nach einer Kanalunterbrechung ist ein erneuter Synchronisierungsklick erforderlich. Falls das Backend den Browser nach einem Host-Austritt zum Host ernennt, verlässt er die Party: der Browser stellt keinen Desktop-Koordinator oder Stream bereit.

Die Datenbank-Funktionen und privaten Realtime-Richtlinien des tatsächlichen Servers sind nicht Bestandteil des öffentlichen Checkouts. Ein Backend-Betreiber muss Browser-Auth, Zugriff auf diese RPCs und autorisierte Party-Mitgliedschaften für den privaten Kanal erlauben. RLS oder private Kanäle nicht abschalten. Broadcast-Nutzdaten besitzen wie beim bestehenden Desktop-Protokoll keinen unabhängigen kryptographischen Absendernachweis; der Kanal setzt vertrauenswürdige autorisierte Mitglieder voraus. Am 2. November 2026 wurden ein echter authentifizierter Beitritt, der private Kanal und der Empfang einer vom normalen Desktop freigegebenen Quelle geprüft. Die dabei verwendete MKV-/H.265-/HDR-Quelle wurde ausdrücklich abgelehnt; echte Video-Synchronisierung mit dieser Quelle ist nicht bestätigt. Es wurden keine Backend-Funktionen oder Zugangsdaten erfunden.

## Wiedergabegrenzen und Fehlermeldungen

| Quelle/Anforderung | Verhalten |
| --- | --- |
| Öffentliches HTTPS-MP4/WebM | Wird nach Klick versucht. Container allein garantiert keinen unterstützten Video-/Audio-Codec. |
| HLS (`.m3u8`, HLS-Typ oder Dateiname) | Natives HLS, sonst hls.js/Media Source Extensions. Manifest, Segmente, Untermanifeste und Schlüssel müssen erreichbar sein. |
| Fehlendes CORS | Netzwerk-/Videofehler. Der Medienserver muss den Website-Ursprung erlauben; Pages-Header ändern nicht die Header des Medienservers. |
| Eigene Request-Header, Cookies oder Response-Header-Umschreiben | Nicht unterstützt. Vorhandene `headers` oder `response_headers` werden ausdrücklich abgelehnt. Requests verwenden keine Cross-Origin-Cookies. |
| HTTP, lokale Netzadressen, Benutzername/Passwort im URL-Ursprung | Abgelehnt. Kein Mixed Content und kein Zugriff auf den Rechner des Hosts. |
| MKV/AVI/Torrent/DASH | Ausdrücklich abgelehnt, auch bei erkanntem Dateinamen. |
| DRM, separate Audioquellen, nicht unterstützte Codecs | Kein DRM-/Transcoding-/Audio-Merging-Verfahren vorhanden. Andere autorisierte Quelle erforderlich. |
| Abgelaufene oder pro IP gebundene URL | Erneute Freigabe/eine andere Quelle nötig; die Host-URL ist nicht automatisch auf Gast-IP-Adressen gültig. |

Eine Anmeldung ohne Fehler beweist nicht die Medien-Kompatibilität. Browser fassen Netzwerk-, Rechte-, CORS- und Codecprobleme häufig in allgemeinen Fehlercodes zusammen; die Oberfläche behauptet daher keine präzise Ursache ohne Beleg. Extensionlose URLs werden versuchsweise geladen; HLS sollte vom Desktop als HLS-Typ oder über Dateiname/URL erkennbar sein. Die Angabe MP4/HLS ist keine Zusage für beliebige HEVC-/DTS-/Dolby-/AV1-Kombinationen.

Die URL selbst wird an Party-Mitglieder weitergegeben. Tokens in Stream-URLs sind in den Entwicklerwerkzeugen sichtbar. Nur Quellen verwenden, die du freigeben darfst und deren Zugangsdaten du dabei offenlegen darfst. Das ist keine Bildschirmübertragung: Jeder Gast lädt die Quelle selbst. Erst der Lade-Klick kontaktiert den Medienanbieter.

## Prüfungen wiederholen

`npm.cmd test` führt Protokoll-, Session- und Desktop-Linktests aus. In einem eigenständigen Website-Repository ohne Desktop-Checkout werden die zwei Desktoptests ausdrücklich übersprungen. `checks/browser-smoke.mjs` ist ein optionaler Playwright/Chrome-Test mit künstlichem RPC-/WebSocket-Backend und einem im Browser selbst erzeugten VP8/WebM-Video. Er prüft echte Wiedergabe und Synchronisierung, jedoch keinen Live-Nuvio-Server. Dafür Playwright separat bereitstellen oder `NUVIO_PLAYWRIGHT_PACKAGE` auf ein vorhandenes Paket setzen; `NUVIO_BROWSER_PATH` kann auf Chrome zeigen. Der Test startet ausschließlich eine lokale Website und einen Testbrowser.

## Quellen und Lizenz

- [Cloudflare: Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/)
- [Cloudflare: Build-Konfiguration](https://developers.cloudflare.com/pages/configuration/build-configuration/)
- [Cloudflare: Redirects](https://developers.cloudflare.com/pages/configuration/redirects/)
- [Cloudflare: Free-Limits](https://developers.cloudflare.com/pages/platform/limits/)
- [Supabase: Realtime Authorization](https://supabase.com/docs/guides/realtime/authorization)
- [Supabase: setAuth](https://supabase.com/docs/reference/javascript/setauth)
- [NuvioDesktop](https://github.com/NuvioMedia/NuvioDesktop/tree/Dev), GPL-3.0. Bei Weitergabe einer modifizierten Nuvio-Version Lizenz, Hinweise und entsprechenden Quellcode mitliefern. Diese Erweiterung ist inoffiziell und wird nicht von NuvioMedia unterstützt.
