# Persönlicher Nuvio-Watch-Party-Fork

Der Fork wird in lebochoffice/NuvioDesktop gepflegt. Der produktive Branch ist Dev.
Der wöchentliche Codex-Check meldet veröffentlichte Original-Nuvio-Releases.
Eine Übernahme beginnt erst nach Freigabe in einem separaten Branch.
Desktop-Updates werden manuell installiert.

## Windows-MSI lokal erstellen

In einem sauberen Checkout des freigegebenen Commits arbeiten. Commit, App-Version
und MSI-Produktversion vor dem Build festhalten. JDK 21, MSVC/Windows SDK, WiX,
WebView2 SDK und die vorgesehenen Git-LFS-Runtimes bereitstellen.
Die autorisierte lokale Watch-Party- und IntroDB-Konfiguration aus dem privaten
Backup verwenden. Zugangsdaten und Windows-Signierschlüssel bleiben lokal.

Beispiel in Windows PowerShell. Die Versionsnummern vor jedem Build mit den
bisherigen Family-Versionen abgleichen und bei Bedarf höher wählen.

~~~powershell
.\gradlew.bat :composeApp:packageReleaseMsi '-Pnuvio.desktop.versionName=0.1.73-watchparty' '-Pnuvio.desktop.versionCode=173' '-Pnuvio.party.browserOrigin=production'
if ($LASTEXITCODE -ne 0) { throw 'MSI-Build fehlgeschlagen.' }
.\fork-maintenance\verify-msi.ps1 -MsiPath '.\composeApp\build\compose\release-msis\Nuvio-Windows-x64-0.1.73-watchparty.msi' -ExpectedProductVersion '1.1.73'
~~~

Die Prüfung kontrolliert Produkt und Upgrade-Regeln, Protokollregistrierung,
Browser-Einladungsziel und den gepackten Desktop-Build. Die MSI und den
Verifikationsbericht mit SHA-256 im vereinbarten lokalen Release-Ordner sichern.
Falls die MSI lokal signiert wird, den SHA-256 der endgültigen Datei festhalten.

Der Installer trägt die Produktidentität Nuvio Family. Die getrennten UpgradeCodes
und Installations- und Profilpfade erlauben den Parallelbetrieb mit Nuvio 1.1.58.
Vor dem Öffnen der MSI Produkt, Version, UpgradeCode und SHA-256 mit dem
Verifikationsbericht vergleichen. Eine höhere Family-Version kann eine ältere
Family-Installation aktualisieren. Die eigene nuvio://-Registrierung von Family
beansprucht nicht automatisch den Windows-Standardhandler.

Der manuell startbare Workflow Fork - Windows MSI kann separat ein
Build-Artefakt erstellen. Er veröffentlicht keine Releases.

## Lokale Arbeit

Die Browser-App liegt in browser-site/, der Party-Share-Worker in party-share-worker/.
Cloudflare, Family-Beta-Passwortschutz und Supabase behalten ihre produktive
Konfiguration. Für neue Änderungen einen eigenen Branch von Dev und einen
Draft-PR im persönlichen Fork verwenden.
