# Desktop-Anmeldung bei Trakt, Simkl und MDBList

## Lokale Konfiguration

Die drei eigenen registrierten App-IDs gehören in die ignorierte
`NuvioDesktop/local.properties`. Folgende Eigenschaftsnamen werden verwendet.

```properties
TRAKT_CLIENT_ID=
TRAKT_REDIRECT_URI=
SIMKL_CLIENT_ID=
MDBLIST_CLIENT_ID=
```

Leere Client-IDs halten die Anmeldeschaltflächen deaktiviert. Der Desktop
benötigt kein TRAKT_CLIENT_SECRET. Für Trakt-Refresh muss die Redirect-URI exakt
zum Eintrag der registrierten Trakt-App passen. Für neue Registrierungen empfiehlt
Trakt eine eigene HTTPS-URI. Der Gerätecode-Anmeldung dient diese URI nicht als
Callback. Der bestehende Default bleibt für ältere App-Konfigurationen erhalten.
Keine fremde Client-ID oder erfundene URI einsetzen.

## Trakt

Der Desktop verwendet weiter Gerätecode, Verifikationsseite und Polling mit
dem vorgegebenen Intervall. Der aktuelle offizielle Vertrag macht client_secret
auch für Device-Token, Refresh und Revoke optional.
[API-Vertrag](https://github.com/trakt/trakt-api/pull/974/files)
[Authentifizierung](https://developer.trakt.tv/docs/authentication-oauth)
[PKCE](https://developer.trakt.tv/docs/pkce)

Der gemeinsame generierte TraktConfig enthält keine Secret-Konstante mehr.
Die generierten gemeinsamen Quellen liegen unter runtime-config/kotlin/common.
Der Desktop liefert für den Legacy-Secret-Zugriff immer null. Die bisherigen
mobilen Authorization-Code-Aufrufe behalten ihren separaten Legacy-Wert unter
runtime-config/kotlin/mobile. Nur Android/iOS binden diesen Ordner ein.
Das ist eine Kompatibilitätsmaßnahme für den bestehenden mobilen Code.
Die Modernisierung des mobilen Authorization-Code-Flows gehört in einen
separaten Auftrag.

Desktop-OAuth-Requests lassen client_secret vollständig weg, auch bei
encodeDefaults=true. Gespeicherte Sitzungsfelder bleiben kompatibel.
Refresh bleibt durch den vorhandenen Mutex serialisiert und speichert das
rotierte Tokenpaar. Trakt weist darauf hin, dass Tokens vor der Auth-Migration
gegebenenfalls einmal neu autorisiert werden müssen. Revoke bleibt best effort.
Ein lokales Trennen ist keine Bestätigung eines erfolgreichen serverseitigen
Widerrufs.

Gerätecode-Ablehnung und Ablauf verwenden vorhandene lokalisierte Meldungen.
Unbekannte OAuth-Fehler zeigen eine allgemeine Anmeldefehlermeldung.
Providerantworten und Transportfehlermeldungen werden dabei nicht als
Diagnosedetails ausgegeben. Nach einer Polling-Verzögerung wird der Kontext
erneut geprüft.

## Simkl und MDBList

Simkl verwendet am Desktop weiter seinen PIN-Flow und prüft SIMKL_CLIENT_ID.
Der vorhandene Simkl-Pfad besitzt keinen mit Trakt vergleichbaren Refresh-Token-
Austausch. Die vorhandenen Token-/Profil-Aktualisierungen und die Trennung
werden beibehalten.

MDBList verwendet weiter Device Authorization sowie seinen vorhandenen
Refresh-/Revoke-Pfad und prüft MDBLIST_CLIENT_ID. Alle drei Karten benutzen
dieselbe Connect-Bedingung aus konfigurierten Credentials und ruhendem Login.
Die vorhandenen Hinweise auf fehlende IDs bleiben erreichbar.

## Manuelle Verifikation

Codex hat keine Tests, Builds oder echten Anmeldungen ausgeführt.
Der Nutzer hat die gezielten Desktop-Tests anschließend mit BUILD SUCCESSFUL
in 3m 12s bestätigt, einschließlich der korrigierten iOS-SourceSet-Konfiguration.
Die neuen Tests prüfen den öffentlichen Trakt-Client, secretfreie Payloads
für Device-Token/Refresh/Revoke, Gerätecode-Erfolg/Fehler/Ablauf sowie die
gemeinsame Button-Bedingung. Der Desktop-Test prüft den fehlenden Legacy-Secret-
Wert. Vorhandene Simkl-PIN- und MDBList-Auth-/Store-Tests decken deren Flows ab.

```powershell
Set-Location 'C:\Users\Alanp\Desktop\Chatgpt\Codex\Nuvio-Watch\NuvioDesktop'
.\gradlew.bat :composeApp:desktopTest '--tests=*Trakt*Test' '--tests=*SimklPinAuthorizationTest' '--tests=*MdbListAuth*Test' '--tests=*TrackingConnectPolicyTest' '--project-prop=nuvio.webview2.dir=fork-maintenance/local/webview2-sdk/1.0.4078.44' --no-configuration-cache --console=plain
```

Nach erfolgreicher Testprüfung und Eintragen der eigenen Client-IDs kann lokal
eine neue MSI gebaut werden. Version 0.1.52 liegt bereits im Ausgabeordner.
Der folgende Vorschlag verwendet 0.1.53-auth-test.

Vor dem Build die Readiness-Prüfung ausführen. Sie liest ausschließlich die
vorgesehene lokale root/local.properties und gibt keine Werte aus.
Trakt gilt hier erst mit Client-ID und expliziter gültiger HTTPS-Redirect-URI
als konfiguriert. Das ist strenger als die reine Freigabe des Loginbuttons.
Die Prüfung bestätigt die Form der Konfiguration. Registrierung, Freigabe,
Übereinstimmung der Redirect-URI und Gültigkeit bestätigt der Anbieter.
Ein neues PowerShell-Fenster startet im Beispiel im oben angegebenen Repository.

```powershell
$ErrorActionPreference = 'Stop'
.\fork-maintenance\check-tracking-readiness.ps1
.\fork-maintenance\check-tracking-readiness.ps1 -RequireConfigured
if (Test-Path '.\composeApp\build\compose\release-msis\Nuvio-Windows-x64-0.1.53-auth-test.msi') { throw 'Ziel-MSI existiert bereits. Eine neue Version waehlen.' }
```

Der Schalter -RequireConfigured beendet die Prüfung bei fehlenden Werten
mit einem terminierenden Fehler. In einem Build-Skript zusätzlich am Anfang
`$ErrorActionPreference = 'Stop'` setzen und direkt danach die Gradle-Zeile
ausführen. Keine ExecutionPolicy global ändern.

```powershell
.\gradlew.bat :composeApp:packageReleaseMsi '--project-prop=nuvio.desktop.versionName=0.1.53-auth-test' '--project-prop=nuvio.desktop.versionCode=153' '--project-prop=nuvio.party.browserOrigin=https://family-beta.nuvio-watch-friends.pages.dev' '--project-prop=nuvio.webview2.dir=fork-maintenance/local/webview2-sdk/1.0.4078.44' --no-configuration-cache --console=plain
.\fork-maintenance\verify-msi.ps1 -MsiPath '.\composeApp\build\compose\release-msis\Nuvio-Windows-x64-0.1.53-auth-test.msi' -AllowPreviewOrigin
```

Auf Windows zusätzlich jeden Anbieter mit fehlender und vorhandener ID prüfen,
Anmeldung bestätigen bzw. ablehnen und ablaufen lassen, App neu starten,
Sitzung aktualisieren und trennen. Bei Trakt außerdem ein Token aus einer
älteren Installation prüfen. Anbieterfreigabe, registrierte Redirect-URI und
Live-Tokenaustausch können nur mit eigenen gültigen Konfigurationswerten
bestätigt werden.

## Einmalige Entwicklerregistrierung für den Fork

1. Trakt unter [My Apps](https://app.trakt.tv/settings/apps) mit dem eigenen
   Betreiberkonto öffnen. Für eine neue API-App ist die GitHub-Verifikation
   vorgeschrieben. Eine eigene Fork-App mit passender Beschreibung, Website
   und kontrollierter HTTPS-Redirect-URI registrieren. Client-ID und exakt diese
   URI lokal in TRAKT_CLIENT_ID und TRAKT_REDIRECT_URI übernehmen. Eine bereits
   eigene App nur mit ausdrücklicher Nutzungsberechtigung für diesen Fork
   verwenden. Die Desktop-Gerätecode-Anmeldung braucht keinen Callbackserver.
   [Registrierungsvertrag](https://developer.trakt.tv/docs/create-an-app)
2. Simkl im eigenen Konto unter [Developer](https://simkl.com/settings/developer/)
   eine Anwendung für den Desktop-Fork registrieren bzw. eine eigene autorisierte
   Anwendung auswählen. PIN-/Gerätezugang für die Anwendung bestätigen und die
   Client-ID in SIMKL_CLIENT_ID setzen. Falls PIN-Zugang für die App erst durch
   Simkl freigeschaltet werden muss, diese Freigabe vor dem Verteilen einholen.
   Keine ID aus einem fremden Installer verwenden.
3. MDBList unter [Developer](https://mdblist.com/developer/) eine eigene OAuth-App
   registrieren. Öffentlichen Desktop-/Device-Client für den vorhandenen
   Device-Authorization-Flow und den benötigten write-Zugriff freigeben lassen.
   MDBLIST_CLIENT_ID lokal übernehmen. Falls das Portal nur einen vertraulichen
   Web-Client anbietet, beim Betreiber die öffentliche Device-Nutzung anfragen.
   Ein Web-Client-Secret gehört nicht in die Desktop-App.
   [OAuth-Dokumentation](https://mdblist.docs.apiary.io/)

Nach einmaligem Eintragen und anschließendem MSI-Build sind die öffentlichen
Client-IDs im Programm enthalten. Endnutzer autorisieren ihr eigenes Konto
über Verbinden und die jeweilige Verifikationsseite. Die Registrierung durch
den Entwickler ersetzt diese individuelle Einwilligung nicht.

## Lokal geprüfte MSI-Voraussetzungen

Die Release-Task lautet :composeApp:packageReleaseMsi. Die eingecheckte
Desktop-Standardversion ist 0.1.33-alpha, Code 33. Für den neuen Installer
Version und Code wie oben ausdrücklich übergeben. Der Family-Beta-Origin
ist als Standard und als gültiger expliziter Wert konfiguriert.

JDK 21, Visual-C++-Build-Tools mit vcvars64.bat, WebView2-SDK 1.0.4078.44
(Header, Importbibliothek und Loader), libmpv-2.dll sowie Nuvio-Engine-DLL/JAR
sind lokal vorhanden. Die Prüfung ist eine Bestandsaufnahme und ersetzt den
späteren Paketbuild und dessen Verifikation nicht.

Öffentliche Backend-Konfiguration und INTRODB_API_URL sind lokal vorhanden.
TMDB_API_KEY fehlt in den vorgesehenen lokalen/Environment-Buildquellen.
TMDB verwendet einen optionalen individuellen UI-Wert mit Build-Key-Fallback.
Für vorab konfigurierte TMDB-Funktionen ist deshalb zusätzlich ein eigener
autorisierter Entwickler-Key nötig. Nutzerbezogene App-Einstellungen wurden
hier nicht gelesen. Weitere optionale Anbieter können eigene Zugangsdaten
benötigen.

Die optionale Property nuvio.party.shareWorker bleibt im obigen Buildbefehl
leer. Ein aktiver Worker ist keine Voraussetzung für die Tracking-Anmeldungen
oder den Family-Browser-Einladungslink. Soll der bestehende Worker-Pfad
gebündelt werden, zusätzlich die vollständig quotierte Property
`'--project-prop=nuvio.party.shareWorker=https://nuvio-party-share.leboch-office.workers.dev'`
übergeben, nachdem dessen Funktionen und Zugriffsregeln live bestätigt wurden.
