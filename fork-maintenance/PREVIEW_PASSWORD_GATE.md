# Passwortschutz für Cloudflare-Pages-Previews (nach `18a94645`)

Lokal, nicht committet. Kein Build, kein Deployment. Production bleibt unverändert.

## 1. Analyse

- **Pages-Projekt `nuvio-watch-friends`:**
  - Git-Anbindung, Root-Verzeichnis `browser-site`, Build `npm run build`, Ausgabe `dist` (laut `CLOUDFLARE_RELEASE_0.1.36.md`; die Dashboard-Werte selbst kann ich nicht einsehen).
  - Statische Regeln in `browser-site/public/_headers` (CSP usw.) und `_redirects` (`/party/* → /index.html 200`).
  - **Bisher keine Pages Functions**, kein `_routes.json`, kein `_worker.js`.
- **Access ist aktiv** (nur lesend per HTTP geprüft, ohne Anmeldung):
  - `https://feature-party-premium-ui.nuvio-watch-friends.pages.dev/` und `/party/…` antworten mit `302` auf `nuvio-watch-friends-pages.cloudflareaccess.com` (`Www-Authenticate: Cloudflare-Access`).
  - **Production** `https://nuvio-watch-friends.pages.dev/` antwortet ohne Access mit `200`.
  - Access sitzt **vor** Pages. Neuer Anwendungscode kann Access weder umgehen noch ersetzen; er greift erst, wenn Access ausgeschaltet ist.
- **Trennung Preview und Production:** Pages trennt die Variablen und Secrets nach den Umgebungen „Production“ und „Preview“. Previews sind über den Branch-Alias (`<branch>.nuvio-watch-friends.pages.dev`) und über Hash-URLs pro Deployment (`<hash>.nuvio-watch-friends.pages.dev`) erreichbar.
- **Middleware:** Liegt `browser-site/functions/_middleware.js` vor und gibt es keine `_routes.json`, leitet Pages **alle** Anfragen durch die Functions, also auch HTML und Assets. Bestehende Routen bleiben erhalten: Nach erfolgreicher Prüfung reicht `next()` an die normale Auslieferung weiter, einschließlich `_redirects`.
- **Nicht betroffen:** Supabase-Login und Realtime gehen direkt an `api.nuvio.tv`, und der Party-Share-Worker hat eine eigene Domain. Beides läuft nicht über Pages und wird nicht berührt.
- **Rate-Limit-Binding:** Die Pages-Dokumentation listet für Pages Functions KV, Durable Objects, R2, D1 usw., aber **kein** Rate-Limiting-Binding ([Pages Bindings](https://developers.cloudflare.com/pages/functions/bindings/), [Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)).
  - Darauf verlasse ich mich deshalb nicht. Eine WAF-Rate-Limit-Regel geht auf `pages.dev` ebenfalls nicht, denn das ist keine eigene Zone.

## 2. Lösung

**Neue Datei `browser-site/functions/_middleware.js`:**
- **Production-Host** `nuvio-watch-friends.pages.dev` (plus optional `PRODUCTION_HOSTS`): sofort `next()`, ohne weitere Prüfung. Production wird **nie** gesperrt, auch nicht bei fehlender oder fehlerhafter Konfiguration.
- **Jeder andere Host** (Branch-Aliase, Hash-URLs, lokal) gilt als Preview:
  - **Ohne gültige Secrets:** `503 „Preview-Schutz nicht eingerichtet“`. Die Preview bleibt gesperrt, nie offen.
  - **Ohne Session:** Für `GET` oder `HEAD` kommt eine Login-Seite mit Status `401` (für HTML, Assets, `/party/…` und jeden anderen Pfad). Andere Methoden bekommen `401` als Text. Es wird **nichts** ausgeliefert.
  - **Login** per `POST /__preview/login`:
    - Vergleich über SHA-256 in konstanter Zeit.
    - Bei Erfolg kommt `303` auf den ursprünglichen Pfad. `next` ist nur ein Pfad derselben Seite: keine fremde Domain, kein `//`, kein `\`, nicht `/__preview/…`. Offene Redirects sind damit ausgeschlossen.
  - **Session-Cookie** `__Host-nuvio_preview`:
    - `Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=43200` (12 h).
    - Inhalt: Ablaufzeit plus HMAC-SHA-256 über Host, Ablaufzeit und den Fingerabdruck des Passworts.
    - Folgen: Ein Cookie gilt nur für genau diesen Preview-Host. Ein Passwortwechsel beendet alle Sessions. Ein gefälschtes oder abgelaufenes Cookie wird abgelehnt.
    - `SameSite=Lax`, damit Einladungslinks aus Chat oder Mail ohne erneuten Login öffnen.
  - **Logout:** `POST /__preview/logout` löscht das Cookie.
  - Bei Login und Logout wird Cross-Site-`POST` abgewiesen (Prüfung des `Origin`-Headers).
- **Sicherheitsheader:**
  - Die Login-Seite hat eine eigene CSP (`default-src 'none'`, kein JavaScript), `X-Frame-Options DENY`, `no-store` und `noindex`.
  - Alle Preview-Antworten erhalten `Cache-Control: private, no-store`, `Vary: Cookie` und `X-Robots-Tag: noindex`. So landet nichts in geteilten Caches.
  - Eingaben werden nie zurückgegeben (HTML-Escaping). Es gibt keine Logs.
- **Bremse für Login-Versuche:**
  - Nach 8 Fehlversuchen pro Client-IP innerhalb von 15 min antwortet die Seite mit `429` und `Retry-After`.
  - Mit dem optionalen KV-Binding `PREVIEW_LOGIN_KV` zählt das über alle Instanzen; die IP wird dabei nur als SHA-256 gespeichert. Ohne Binding zählt es nur pro Instanz.
  - Jeder Fehlversuch wird um 750 ms verzögert.
  - Der Hauptschutz ist die Mindestlänge des Passworts von **16 Zeichen**; ein zufälliges Passwort ist so per Brute-Force nicht zu knacken.
- **Unverändert:** Wiedergabe-Synchronisierung, Seek, Player-Bridge, HLS, Party-Share-Berechtigungen und alle bestehenden Dateien der Browser-App.

**Geänderte Dateien:**
- `browser-site/functions/_middleware.js` (neu)
- `browser-site/tests/preview-gate.test.js` (neu)
- `browser-site/.gitignore`: neu sind `.dev.vars*` und `.wrangler/`, für lokale Testwerte
- `fork-maintenance/PREVIEW_PASSWORD_GATE.md` (diese Datei)

## 3. Secrets und Dashboard-Einstellungen

Unter Cloudflare Dashboard → Workers & Pages → `nuvio-watch-friends` → Settings → **Variables and Secrets**, Umgebung **Preview**:

| Name | Typ | Wert |
|---|---|---|
| `PREVIEW_PASSWORD` | **Secret** (verschlüsselt) | mindestens 16 Zeichen, zufällig |
| `PREVIEW_COOKIE_SECRET` | **Secret** | mindestens 32 Zeichen, zufällig, **anders** als das Passwort |
| `PRODUCTION_HOSTS` | Text (optional) | nur bei einer eigenen Production-Domain, z. B. `watch.example.com`, kommagetrennt, exakte Hostnamen. **Nie** einen Preview-Host eintragen. |

Optional unter Settings → **Bindings** → KV namespace, Umgebung Preview: Variablenname `PREVIEW_LOGIN_KV`, ein neu angelegter, leerer KV-Namespace (z. B. `nuvio-preview-login`). Im Free-Plan sind 1000 Schreibvorgänge pro Tag frei; geschrieben wird nur bei Fehlversuchen.

In **Production** wird nichts gesetzt. Dort ist die Middleware ohnehin durchlässig.

**Passwort sicher erzeugen, ohne Chat und ohne Git** (PowerShell, lokal):

```powershell
$b = New-Object byte[] 24; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b) | Set-Clipboard
```

- Danach sofort im Passwortmanager speichern und im Dashboard als Secret `PREVIEW_PASSWORD` einfügen.
- Für `PREVIEW_COOKIE_SECRET` denselben Befehl mit `byte[] 48` ausführen und nur ins Dashboard einfügen; den Wert musst du dir nicht merken.
- Weder in eine Datei noch in Chat, Ticket oder Commit kopieren.
- Für lokale Tests eigene Testwerte in `browser-site/.dev.vars` (ist ignoriert), nie die echten.

## 4. Sichere Reihenfolge

1. **Secrets setzen** (Preview, siehe oben). Access bleibt **an**.
2. **Commit und Push** nach deiner Freigabe. Pages baut das Preview-Deployment mit der Middleware.
3. **Hinter Access prüfen:** Preview im Browser öffnen, bei Access anmelden. Danach muss **zusätzlich** die neue Login-Seite erscheinen. Mit dem Passwort einloggen; die Watch-Party funktioniert normal. Mit der Hash-URL dieses Deployments wiederholen. In den DevTools prüfen, ob die CSP aus `_headers` auf HTML-Antworten weiter vorhanden ist (siehe Risiken).
4. **Alte Deployments entschärfen, bevor Access ausgeht:**
   - Alle **älteren** Preview-Deployments und **andere Branch-Aliase** (z. B. `feature/torbox-hls-mvp`) wurden **ohne** Middleware gebaut. Ohne Access wären sie öffentlich.
   - Im Dashboard unter Deployments die alten Preview-Deployments **löschen** oder deren Branches neu bauen lassen.
   - Prüfen, dass keine Hash-URL eines alten Deployments mehr antwortet, außer mit dem neuen Login. Wo das nicht möglich ist: Access **nicht** abschalten.
5. **Access für Previews abschalten:** Settings → General → Access policy, bzw. die Access-Application in Zero Trust.
6. **Ohne Anmeldung testen** (Testplan unten), auch mit Hash-URLs und anderen Branch-Aliasen.
7. **Production kontrollieren:** `https://nuvio-watch-friends.pages.dev/` und `/party/<Code>` liefern ohne Login wie bisher `200`.

Bei einem Problem: Access sofort wieder einschalten. Der Code-Schutz kann nichts öffnen, was Access sperrt.

## 5. Lokale Tests und Testplan

**Lokal (nicht ausgeführt):**

```powershell
Set-Location 'C:\Users\Alanp\Desktop\Chatgpt\Codex\Nuvio-Watch\NuvioDesktop\browser-site'; npm.cmd test
```

Neu ist `tests/preview-gate.test.js`. Abgedeckt sind:
- Production ist nie gesperrt
- fehlende Secrets ergeben 503
- HTML, Assets und Routen sind ohne Login gesperrt
- Cookie-Attribute
- Bremse pro IP, KV-Zähler
- keine offenen Redirects
- Bindung an Host, Passwort und Ablauf
- Cross-Site-`POST` und XSS in `next`

Optional mit dem echten Pages-Laufzeitsystem, nach einem lokalen Build mit Testwerten in `.dev.vars`:

```powershell
npm.cmd run build; npx wrangler pages dev dist --compatibility-date=2026-10-01
```

Lokal gilt `127.0.0.1` als Preview-Host, also mit Login.

**Live, ohne Anmeldung** (privates Fenster, nach Schritt 5):

| Aufruf | Erwartet |
|---|---|
| Preview-Alias `/`, `/party/ABC234`, `/assets/<Datei>.js` | Login-Seite, Status 401, kein App-Inhalt |
| Hash-URL des neuen Deployments | Login-Seite |
| Hash-URL eines alten Deployments | gelöscht (404) oder ebenfalls Login, **nie** die App |
| Anderer Branch-Alias | Login oder nicht erreichbar |
| 9-mal ein falsches Passwort | ab dem 9. Versuch `429` |
| `/__preview/login?next=https://evil.example` und Login | Weiterleitung auf `/`, nie auf eine fremde Domain |
| Production `/` und `/party/<Code>` | `200`, keine Login-Seite |

**Live, angemeldet:**

| Prüfung | Erwartet |
|---|---|
| Login, dann Einladungslink `/party/<Code>` | direkt in der Party, Supabase-Login wie bisher |
| Reload, neuer Tab | weiter angemeldet (Cookie bis 12 h) |
| Wiedergabe, Sync, Familienfreigabe | unverändert |
| Cookie in den DevTools | `__Host-nuvio_preview`, `HttpOnly`, `Secure`, `SameSite=Lax`; keine Klartextwerte |
| Passwort im Dashboard ändern und neues Deployment | alte Sessions abgelaufen, erneuter Login nötig |

## 6. Blocker und Risiken

- **Alte Deployments (wichtigster Punkt):** Hash-URLs vor diesem Commit und andere Branch-Aliase haben keinen Code-Schutz. Erst löschen oder neu bauen, dann Access abschalten (Schritt 4).
- **Kosten in Production:**
  - Pages Functions laufen für **jede** Anfrage, auch in Production (sofortiges `next()`). Diese Aufrufe zählen zum Workers-Kontingent (Free: 100 000 pro Tag).
  - Ein `_routes.json` lässt sich nicht pro Umgebung unterscheiden.
  - Für eine Familien-Party ist das unkritisch. Bei viel Traffic die Nutzung im Dashboard beobachten, denn über dem Kontingent schlagen Function-Aufrufe fehl.
- **`_headers` und Functions:** Laut Cloudflare gelten `_headers` nicht für Antworten, die Functions **selbst** erzeugen (das betrifft die Login-Seite; sie hat eigene Header). Ob die CSP bei durchgereichten Asset-Antworten erhalten bleibt, bitte in Schritt 3 prüfen. Fehlt sie, ergänze ich sie in der Middleware.
- **Bremse für Login-Versuche:** Ohne `PREVIEW_LOGIN_KV` zählt sie nur pro Instanz. Ein Rate-Limit-Binding für Pages ist nicht dokumentiert, eine WAF-Regel auf `pages.dev` nicht möglich. Deshalb ist ein langes Zufallspasswort Pflicht (erzwungen: mindestens 16 Zeichen).
- **Party-Share-Worker:** Erlaubt nur den Preview-Alias als Origin. Über Hash-URLs funktioniert die Familienfreigabe nicht; das ist beabsichtigt und unverändert.

## Testergebnis (04.11.2026, lokal)

- Browser `npm test`: 216/216 bestanden, darunter die 9 neuen Tests in `preview-gate.test.js`. Log: `fork-maintenance/local/browser-tests-preview-gate.log`.
- Im ersten Lauf schlug ein Test fehl, und zwar wegen eines Fehlers im **Test**: Die Login-Seite enthält zu Recht den angefragten Pfad (`/assets/…`) als `next`, und der Test suchte nach dem Wort „asset“. Er prüft jetzt eine eindeutige Markierung im Inhalt des Fake-Assets. An der Middleware hat sich nichts geändert.
- Desktop-Tests waren nicht nötig (keine Desktop-Änderung). Kein Build, kein `wrangler pages dev`, nicht live getestet.
