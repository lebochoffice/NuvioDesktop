# Cloudflare-Release-Vorbereitung für MSI 0.1.36

## Prüfergebnis und Grenzen

Geprüft wurden die lokalen geänderten Dateien, neue Quelldateien und Dokumentationen, Source-Routing, Desktop-Wire-Modell, vorhandene Pages-Assets, Vite-Paketkonfiguration, Ignore-Regeln und lokale öffentliche Backendkonfiguration. Die 37 zuvor unveröffentlichten Dateien umfassen Browser, Desktop, Tests und Dokumentation; dieser PR muss deshalb auch die Desktop-Quelländerungen enthalten, die bereits im MSI 0.1.36 gebaut wurden. Ein reiner Browser-Commit würde den Quellstand des MSI im Repository nicht abbilden.

Branch ist `feature/torbox-hls-mvp`, `origin` ist `lebochoffice/NuvioDesktop`, Upstream-Push bleibt `DISABLED`. Gegen den **lokal vorhandenen** Ref `origin/Dev` besteht noch kein Commit-Unterschied; die Arbeit liegt uncommitted vor. Remote-Refs wurden hier nicht aktualisiert. Es wurde keine PR auf GitHub erzeugt und kein Zugriff auf Cloudflare-Kontoeinstellungen durchgeführt.

`browserPartyStream()` wählt ein vorhandenes `browser_hls`, übernimmt dessen URL/Header und die übergeordnete Medienkennung. Ein vorhandenes, aber nicht bereites Browserfeld führt zum Warten, nicht zum Originalstream. Bei alten Host-Nachrichten ohne Erweiterung bleibt der vorherige Verarbeitungspfad erhalten. Persönliches HLS bleibt ein bewusster Fallback. Der MSI 0.1.36 enthält die passenden Desktop-Modelle: Originalfelder bleiben erhalten, neue Desktop-Empfänger ignorieren Browsermetadaten mit `forDesktop()`. Der Playback-State wird nicht aufgeteilt. Siehe `MSI_0.1.36_BUILD.md` und `STREAM_ROUTING_AND_INVITES.md`.

Die ignorierte lokale Browser-URL und der Publishable Key stimmen mit der ignorierten Desktop-Konfiguration überein; die URL ist der autorisierte offizielle Nuvio-Ursprung. Es wurden nur Vergleichsergebnisse ausgegeben, keine privaten Werte. Diese lokale Übereinstimmung beweist noch nicht die im Pages-Konto gesetzten Werte oder dessen Backend-Origin-Freigabe.

Keine gefundenen Literale privater Schlüssel bei der Prüfung der Kandidatendateien auf `sb_secret_`, private PEM-Schlüssel und GitHub-Tokenmuster. Dies ersetzt nicht die abschließende Prüfung des gestagten Diffs. Test-URLs/-Tokens sind synthetisch. `.env.local`, `local.properties`, `dist`, Gradle-Ausgaben, MSI und `fork-maintenance/local/` sind ignoriert und nicht Bestandteil der Stagingliste. Ein bereits im Basisrepository versioniertes JVM-Crashlog wurde nicht verändert und wird nicht gestagt. Die mitgelieferten Buildberichte enthalten Metadaten/Hashes, keine Installer-Binärdateien.

Keine Änderungen am Produktcode in diesem Auftrag. Nur Release-Anleitung, Stagingliste und PR-Text wurden hinzugefügt. Keine Tests, Builds, Git-Staging-/Commit-/Push-/Merge-Aktionen oder Deployments ausgeführt. Die grünen Tests sind vom Nutzer gemeldet, nicht hier erneut bestätigt.

## Vor jedem Push: Pages-Zustand manuell kontrollieren

Im existierenden Pages-Projekt `nuvio-watch-friends` prüfen:

| Einstellung | Sollwert |
| --- | --- |
| Repository bei Git-Anbindung | `lebochoffice/NuvioDesktop` |
| Production branch | `Dev`, ausdrücklich nicht der Feature-Branch |
| Root directory | `browser-site` |
| Build command | `npm run build` |
| Output directory | `dist` relativ zum Root directory |
| Node-Version | `NODE_VERSION=24`, passend zum vorhandenen Browser-CI |
| Preview-Branch | `feature/torbox-hls-mvp` zulassen |
| Public backend | `VITE_SUPABASE_URL=https://api.nuvio.tv` |
| Public client key | `VITE_SUPABASE_ANON_KEY`: derselbe freigegebene Publishable Key wie in der lokalen Browserkonfiguration |

Beide VITE-Werte getrennt für **Preview und Production** konfigurieren. Sie werden zur Buildzeit öffentlich in JavaScript eingebettet; niemals TorBox-Keys, `service_role`, `sb_secret_` oder persönliche Tokens eintragen. GitHub-Repository-Variables mit Namen `NUVIO_*` werden nicht automatisch zu Cloudflare-Variablen. Lokale `.env.local` wird ebenfalls nicht an Pages übertragen. Kein Wrangler-Konfigurationsfile liegt im Projekt; die tatsächlichen Dashboard-Werte müssen deshalb manuell bestätigt werden. `vercel.json` steuert Cloudflare nicht.

Vite übernimmt `public/_redirects` und `public/_headers`. Der vorhandene Rewrite `/party/* /index.html 200` ist für direkte Party-Links erforderlich. Pages muss aus dem ganzen Projekt bauen, nicht einzelne rohe JavaScript-Dateien hochladen.

**Push und PR-Erstellung können automatisch GitHub-CI-Tests/-Builds und Cloudflare-Preview-Deployments auslösen.** Auch ein Draft-PR verhindert dies nicht generell. Deshalb diese Einstellungen zuerst bewusst prüfen. Ein nachfolgender manueller Push ist dann die vom Nutzer ausgelöste Preview-Aktion. Production bleibt bis zur Freigabe unverändert.

Falls das existierende Pages-Projekt stattdessen Direct Upload verwendet, gibt es keine automatische Git-PR-Preview. Diesen Fall nicht stillschweigend als Git-Anbindung behandeln: nach eigener Build-/Deployment-Freigabe das vollständige erzeugte `dist/` über das vorhandene Upload-Verfahren veröffentlichen. Ein Git-PR kann trotzdem den Quellstand dokumentieren. Das Hosting-Verfahren wurde hier nicht geändert.

## Konkrete Git-Befehle – ausschließlich manuell

Aus dem Projektroot ausführen. Nicht als ungeprüften Gesamtblock übernehmen: an den angegebenen Prüfpunkten den Inhalt kontrollieren. `git add .` und `git add -A` sind hier absichtlich nicht vorgesehen.

```powershell
Set-Location 'C:\Users\Alanp\Desktop\Chatgpt\Codex\Nuvio-Watch\NuvioDesktop'
git branch --show-current
git status --short
git fetch origin
git log --oneline --left-right origin/Dev...HEAD
```

Erwarteter Branch: `feature/torbox-hls-mvp`. Falls der aktualisierte Dev neue Commits enthält, zuerst die Integration bewusst planen; kein automatisches Pull/Rebase auf dem schmutzigen Worktree. Bestehende Änderungen nicht zurücksetzen.

```powershell
git add --pathspec-from-file=fork-maintenance/cloudflare-release-files.txt
git diff --cached --name-only
git diff --cached --stat
git diff --cached
git status --short
```

Prüfpunkt: ausschließlich die explizite Release-Dateiliste; keine `.env`, lokalen Konfigurationen, privaten URLs, Token, Crashlogs, MSI, `build/`, `dist/`, Screenshots oder heruntergeladenen Provider-Skripte. Bei unerwarteten bereits gestagten Dateien zuerst deren Herkunft prüfen. Keine lokale Datei löschen, um eine Stagingliste zu bereinigen.

Erst nach eigener Diff-Freigabe:

```powershell
git commit -m "feat(party): align browser HLS release with desktop 0.1.36"
git push --set-upstream origin feature/torbox-hls-mvp
gh pr create --repo lebochoffice/NuvioDesktop --base Dev --head feature/torbox-hls-mvp --draft --title "Watch Party: Browser-HLS und Synchronisierung für Desktop 0.1.36" --body-file fork-maintenance/CLOUDFLARE_PR_BODY.md
```

Voraussetzung für `gh`: installiert und für den eigenen Fork angemeldet. Falls bereits ein PR für denselben Branch existiert, diesen aktualisieren statt einen zweiten anzulegen. Kein Upstream-Push, kein Force-Push und kein Merge-Befehl enthalten.

## Preview und Produktionsfreigabe

1. Nach dem bewusst ausgeführten Feature-Push/PR die von Pages tatsächlich ausgegebene Preview-URL und deren Commit-SHA notieren. Keine Preview-Adresse erraten. Production muss weiter den vorherigen freigegebenen Stand zeigen.
2. Kontrollieren, dass Preview mit dem gewünschten Commit, Root `browser-site`, Node 24 und beiden öffentlichen VITE-Werten gebaut wurde. Eine Startseite allein ist kein erfolgreicher Party-Test.
3. Preview unter `/party/<aktiver Code>` öffnen. Wegen des eigenen Preview-Ursprungs gegebenenfalls erneut mit dem bestehenden Nuvio-Konto anmelden. Derselbe Backend-/Realtime-Zugang und CORS für den Preview-Ursprung müssen tatsächlich funktionieren; keine globalen Schutzregeln abschalten.
4. Mit dem bereits verifizierten MSI 0.1.36 manuell prüfen: vor Sharing keine Quelle, nach Zustimmung Original bei Desktop-Gast und HLS bei Browser-Gast; Host-Play/Pause/Seek und Realtime-Sequenzen; Sharing-Aus, Filmwechsel, HLS-Erneuerung sowie persönlicher Fallback. Browser darf nicht auf die ursprüngliche MKV-Quelle umschalten. Mehr-IP-/Tarif- und Streamberechtigungen bleiben echte Live-Voraussetzungen. Keine HAR-Dateien oder URL-haltigen Screenshots weitergeben.
5. Erst nach dokumentierter erfolgreicher Preview und ausdrücklicher Freigabe den Draft-PR zur Prüfung freigeben und in den eigenen `Dev` übernehmen. Kein automatisches Mergen konfigurieren.
6. Als bewussten Produktionsschritt Pages-Produktion für `Dev` prüfen/freigeben. Bei aktivierter Git-Integration mit automatischen Production-Builds löst der genehmigte Merge den Build aus; dessen Commit-SHA kontrollieren. Falls automatische Produktion ausgeschaltet ist, zunächst das passende manuelle Produktionsverfahren festlegen, nicht die Preview-Branch als Production umstellen.
7. Produktions-URL `https://nuvio-watch-friends.pages.dev/party/<aktiver Code>` prüfen. Bei Problemen die zuvor erfolgreiche **Production**-Deployment-Version über die vorhandene Pages-Rollbackfunktion zurücknehmen; keine ungeprüfte Preview als Produktion deklarieren.

Offizielle Referenzen: [Buildkonfiguration](https://developers.cloudflare.com/pages/configuration/build-configuration/), [Branch-Steuerung](https://developers.cloudflare.com/pages/configuration/branch-build-controls/), [Preview-Deployments](https://developers.cloudflare.com/pages/configuration/preview-deployments/). Diese Anleitung wurde vorbereitet; keiner dieser Veröffentlichungsschritte wurde ausgeführt.
