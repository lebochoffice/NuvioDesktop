# Windows-MSI 0.1.38-watchparty – Buildnachweis

Lokaler, uncommitteter Stand von `feature/party-premium-ui` (03.11.2026). Keine Installation, kein App-Start, keine Tests.

- Gradle `:composeApp:packageReleaseMsi` mit `-Pnuvio.desktop.versionName=0.1.38-watchparty -Pnuvio.desktop.versionCode=138 -Pnuvio.webview2.dir=fork-maintenance/local/webview2-sdk/1.0.4078.44`, JDK 21.0.12: `BUILD SUCCESSFUL in 2m 39s`. Log: `fork-maintenance/local/msi-0.1.38-build.log`.
- WebView2-SDK: offizielles NuGet-Paket `Microsoft.Web.WebView2` 1.0.4078.44 (Autor Microsoft, Paketsignatur vorhanden, `.nupkg` SHA-256 `dc4d1d9168df26b830398303e50210b6e1729f6ce5a7ac69d2c766852f489962`). `WebView2Loader.dll`: Authenticode **Valid**, Microsoft Corporation, SHA-256 `239a9d6614a6cfade62b47cdb0be36e3069eedc438c3e0647a9e7b7c84ef6ea0`.

## Ergebnis

- Datei: `composeApp/build/compose/release-msis/Nuvio-Windows-x64-0.1.38-watchparty.msi`
- Größe: **193319100 Bytes**
- SHA-256: `a93a2e0771611947641d8b16b01464d705d456ac95876ccfc6e2b297d5c64d37`
- MSI-Produktversion: 1.1.38. App-Version: `0.1.38-watchparty`. Signatur: `NotSigned`.

## Verifikation (read-only)

`fork-maintenance/verify-msi.ps1` bestanden (`*-verification.json` liegt daneben):
- MSI-Header und Metadaten
- JAR-Name und -Größe stimmen mit der MSI-Dateitabelle überein
- Native Runtime vollständig, **inklusive `WebView2Loader.dll`**
- Watch-in-Browser-Marker
- Öffentliches Nuvio-Backend
- IntroDB-URL `https://api.introdb.app`
- Einladungsorigin `https://nuvio-watch-friends.pages.dev`
- Java-Runtime

Zusätzlich gegen den gepackten JAR geprüft:
- `WebView2Loader.dll` ist bytegleich mit der signierten SDK-Datei.
- `player-ui/party.js` ist bytegleich mit dem Quellstand.
- Version `0.1.38-watchparty` steht in `AppVersionConfig`.
- Updater: Quelle `lebochoffice`, kein `NuvioMedia` in den Updater-Klassen, Asset-Filter `WatchParty`.
- TorBox-HLS-Klassen (`TorboxPartyHls`, `PartyBrowserHls`) vorhanden.

Alte MSIs (0.1.33 bis 0.1.37) wurden nicht verändert. **0.1.37-watchparty-fixes ist defekt (ohne `WebView2Loader.dll`) und soll nicht installiert werden.**
