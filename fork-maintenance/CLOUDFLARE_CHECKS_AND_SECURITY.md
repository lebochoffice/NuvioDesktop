# Cloudflare: fehlgeschlagener Workers-Check und Sicherheitsprüfung (03.11.2026)

Nur lesend geprüft. Keine Änderung an Cloudflare, GitHub oder dem Pages-Projekt.

## Check „Workers Builds: nuvio-watch-friends“

- Er schlägt bei jedem Commit fehl (zuletzt `7f7ddea0`). Die Meldung der GitHub-App `cloudflare-workers-and-pages` lautet: „Preview creation failed: This Worker does not exist on your account.“
- Der Check „Cloudflare Pages“ ist beim selben Commit erfolgreich, und die Preview liefert den aktuellen Stand aus.
- Vermutete Ursache laut Hinweis des Nutzers: Die Workers-Builds-Verknüpfung zu einem gelöschten Worker ist an der GitHub-App hängen geblieben, siehe cloudflare/workers-sdk#15900. Vom Fork aus ist das nicht überprüft.
- Auswirkung: keine auf Pages oder die Apps. In GitHub erscheint nur ein roter Check.
- Falls `Dev` Pflicht-Checks bekommt: nur `browser`, `windows` und `PR Template Check` als Pflicht setzen, **nicht** „Workers Builds“.
- Bewusst nicht gemacht: keinen neuen Worker angelegt, die GitHub-App nicht entfernt, das Pages-Projekt nicht geändert. Eine Bereinigung (alte Workers-Builds-Verknüpfung im Cloudflare-Dashboard entfernen) wäre eine Änderung am Konto und braucht deine Entscheidung.

## Sicherheitsprüfung Browser-Build und Pages

- **Repository:** Getrackt ist nur `browser-site/.env.example` (ohne Werte). `.env`, `.env.*` und `.env.local` sind per `.gitignore` ausgeschlossen. Die lokale `.env.local` enthält nur `VITE_SUPABASE_URL` (`api.nuvio.tv`) und einen `sb_publishable_`-Key.
- **`dist` und die Live-Bundles (Production und Preview):**
  - genau ein öffentlicher `sb_publishable_`-Key
  - kein JWT, kein `sb_secret_`, keine privaten Schlüssel, AWS- oder GitHub-Tokens
  - keine Source Maps und kein `sourceMappingURL`; es gibt keine `vite.config`, und Vite erzeugt standardmäßig keine Maps
- **Unbekannte Pfade:** `/.env`, `/.env.local`, `/.env.production`, `/phpinfo.php`, `/.git/config`, `/wp-login.php` und `/assets/*.js.map` liefern bei beiden Domains **die `index.html` mit Status 200**. Das ist das SPA-Verhalten von Pages ohne `404.html`. Es wird keine Datei ausgeliefert, es entsteht kein Leck. Scanner sehen aber 200 statt 404.
  - Optional, nicht umgesetzt: eine `404.html` in `public/` sorgt für echte 404-Antworten. `/party/*` bleibt dann über `_redirects` erreichbar.
- **Header (`_headers`):** strenge CSP (`script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`), `nosniff`, `X-Frame-Options DENY`, `Referrer-Policy no-referrer`.
- **Ergebnis:** kein Sicherheitsproblem im Browser-Build gefunden.
