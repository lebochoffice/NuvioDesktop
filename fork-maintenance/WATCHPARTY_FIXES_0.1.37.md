# Nuvio Desktop 0.1.37-watchparty-fixes

Branch `feature/party-premium-ui`. Keine Commits, Pushes oder Deployments. Tests geschrieben, nicht ausgeführt.

## A. Intro überspringen

**Ursache (bestätigt):**
- `IntroDbConfig.URL` wird beim Build aus `INTRODB_API_URL` in `local.properties` erzeugt. Der Schlüssel fehlte, daher ist die URL im installierten MSI 0.1.36 leer. Das wurde read-only geprüft: Die Klasse `IntroDbConfig` im gepackten JAR enthält keine URL, und die generierte Datei `IntroDbConfig.kt` enthält `URL = ""`.
- `SkipIntroApi` bricht bei leerer URL ab. IntroDB ist für normale Filme und Serien die einzige Quelle (AniSkip/Anime-Skip nur für Anime-IDs). Deshalb gibt es keine `skipIntervals`, kein `activeSkipInterval` und kein `skipPromptVisible`.
- Die restliche Kette ist intakt und unverändert: `PlayerScreenRuntimeEffects` → `nativeSkipInterval` → `skipPromptVisible` → `controls.js`.
- `playerControlsLocked` ist die Bildschirmsperre, keine Party-Sperre; die Party-Steuerungssperre blendet das Popup nicht aus.

**Korrekte Adresse (verifiziert, nicht erfunden):** `https://api.introdb.app`. Belege: Die offizielle Doku auf `introdb.app/docs` nennt `api.introdb.app/segments?imdb_id=…&season=…&episode=…`. Ein Live-Aufruf am 03.11.2026 lieferte HTTP 200 mit `intro`/`recap`/`outro` und `start_sec`/`start_ms`, exakt wie `IntroDbSegmentsResponse`.

**Behebung:**
- `INTRODB_API_URL=https://api.introdb.app` in der ignorierten, lokalen `local.properties`; sie wird nicht committet.
- Fail-fast in `composeApp/build.gradle.kts`: `packageReleaseMsi` bricht ab, wenn die URL fehlt oder nicht `https://` ist. Nur für Diagnosezwecke gibt es `-Pnuvio.allowMissingIntroDb=true`.
- Fail-fast in `fork-maintenance/build_on_windows.ps1`.
- `fork-maintenance/verify-msi.ps1` prüft die URL im gepackten JAR.

**Hinweis:** Ein Original-/Upstream-MSI zum Vergleich lag lokal nicht vor; es wurde nichts heruntergeladen. Für den Upstream-Release setzt die CI `local.properties` aus Secrets (`NUVIO_DESKTOP_LOCAL_PROPERTIES_BASE64`).

## B. Browsersteuerung

**Ursachen:**
1. **Desktop-Pingpong (Ursache im Code):** Nach einem fremden Befehl (z. B. Browser „Play“) prüft der Desktop-Host nach 1,2 s, ob der Player-Zustand dem Party-Zustand entspricht. Braucht der Player länger (Seek, Puffer, Netzwerk), veröffentlichte der Host (`canControl`) seinen **alten** Zustand als neuen Befehl. Dadurch sprang die Party zurück, es ruckelte, und es entstand Pingpong.
2. **Browser wartete auf RPC:** `publishLikeDesktop` hielt `pendingCommand` bis zur Antwort von `watch_party_update`. Schnelle Folgebefehle wurden deshalb verzögert (Warteschlange).
3. **Seek wartete auf `seeked`:** Eigene ±10-s- und Zeitleisten-Sprünge wurden erst nach dem nativen `seeked` gesendet; bei HLS kann das Sekunden dauern.

**Änderungen:**
- Desktop `PlayerScreenRuntimeParty.kt`: Nach einem angewendeten fremden Befehl wird das Rücksenden des lokalen Zustands 3 s lang unterdrückt (`REMOTE_APPLY_GRACE`). *Ab 0.1.39 ersetzt durch ereignisbasiertes Abwarten (`awaitingApply`), siehe `WATCHPARTY_COMMANDS_0.1.39.md`.* Eigene Bedienungen und alle übrigen Regeln (Host-only, Puffer-Koordinator, Korrekturen) bleiben unverändert.
- Browser `session.js`: Der Befehl gilt nach dem Broadcast als erledigt; die Speicherung (`watch_party_update`) läuft im Hintergrund. Späte oder veraltete Antworten werden geordnet (`isNewer`) angewendet und können nichts zurückdrehen.
- Browser `main.js`: Eigene Sprünge senden den Zielzeitpunkt sofort. Das zugehörige native `seeking` wird als eigenes erkannt (`ownSeek`) und nicht doppelt gesendet.

**Nicht abschließend gelöst (Sicherheit):** Realtime-Absender sind weiterhin nicht serverseitig authentifiziert. Es gilt dasselbe Vertrauensmodell wie bei Desktop-Gästen. Abhilfe schafft nur die dokumentierte Backend-Erweiterung (serverseitiger Broadcast, Policies).

## C. Einladungslink

- `partyInviteLink()` erzeugt im offiziellen Backend-Modus `https://nuvio-watch-friends.pages.dev/party/<CODE>`, bei Custom-Backends weiterhin `nuvio://party/<CODE>`. Betrifft „Einladen/Teilen“ in `PartyDetails` und im Player-Overlay.
- `party.js` („Watch in Browser“): neuer Speicherschlüssel `nuvio-browser-party-host-v2`, sodass alte gespeicherte Hosts ignoriert werden. Cloudflare-Preview-Hosts (`<hash>.<projekt>.pages.dev`) werden weder geladen noch akzeptiert. Der Standard ist die Cloudflare-Adresse. Das Kopieren gibt keinen Stream frei.
- Die Cloudflare-Seite bleibt ein eigenes Deployment.

## Tests (lokal ausführen)

```powershell
Set-Location 'C:\Users\Alanp\Desktop\Chatgpt\Codex\Nuvio-Watch\NuvioDesktop\browser-site'
npm.cmd test
Set-Location ..
.\gradlew.bat :composeApp:desktopTest --tests '*Party*Test' --no-configuration-cache --console=plain
```

Neu bzw. geändert:
- Browser: schnelle Pause/Play-Folge trotz hängender RPC; wiederholtes ±10 s bzw. Seek während HLS-Puffer genau einmal; Reconnect und Host-only; Host-Befehl während laufendem Browserbefehl; späte, doppelte oder veraltete Zustände (`session.test.js`); alte und Preview-Hosts in `desktop-invite.test.js`.
- Kotlin: `PartyInviteLinkTest`.

## MSI-Build 0.1.37 – Ergebnis (NICHT verwendbar)

- Gradle `:composeApp:packageReleaseMsi` mit `-Pnuvio.desktop.versionName=0.1.37-watchparty-fixes -Pnuvio.desktop.versionCode=37`: `BUILD SUCCESSFUL in 3m 17s`. Log: `fork-maintenance/local/msi-0.1.37-build.log`.
- Datei: `composeApp/build/compose/release-msis/Nuvio-Windows-x64-0.1.37-watchparty-fixes.msi`, 193233084 Bytes, SHA-256 `f1a41d6e3af2b4d3af4ead4758a9ee3086279b208cda84c74b0a39562c137a4f`, unsigniert.
- **Verifikation fehlgeschlagen:** `native/windows/WebView2Loader.dll` fehlt im Anwendungs-JAR. Ursache: Auf dem Rechner ist kein WebView2-SDK mehr vorhanden; `prepareWindowsPlayerRuntime` lässt die Datei dann stillschweigend weg. Ohne sie kann der Windows-Player nicht starten. Dieser MSI darf nicht installiert werden.
- Korrekt im JAR: IntroDB-URL, Cloudflare-Einladungsorigin, `party.js` v2, Player-Bridge, libmpv, nuvio_engine.
- Neu: `packageReleaseMsi` bricht künftig ab, wenn `WebView2Loader.dll` fehlt. Der Verifier läuft jetzt auch unter Windows PowerShell 5.1.
- Für einen neuen Build: Microsoft.Web.WebView2 (NuGet, z. B. 1.0.4078.44 wie in der CI) installieren oder `-Pnuvio.webview2.dir=<sdk>` übergeben. Der Build braucht deine erneute Freigabe; nach dem Updater-Umbau sinnvollerweise als `0.1.38-watchparty`.
