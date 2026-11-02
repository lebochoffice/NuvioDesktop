# Premium-Oberfläche und passwortloser Gastzugang

Branch `feature/party-premium-ui`, abgezweigt von `feature/party-mobile-sync-control` (`ca5a2c24`). Nur `browser-site/` geändert. Nicht ausgeführt: Tests, Build, Deployment, Commit. Status: **implementiert, nicht lokal getestet, nicht live getestet**.

## Neue Nutzerführung

1. Der Link `/party/<CODE>` öffnet die **Einladung**: „[Host] lädt dich zu [Titel] ein.“, Backdrop bzw. Poster (sonst eleganter Verlauf), Logo oder Titel, Staffel/Episode, Beschreibung, Host-Avatar und Plätze.
2. **Name eingeben → „Jetzt ansehen“** (oder der große Play-Button im Bild).
   - Bestehende Nuvio-Sitzung im Browser: sofortiger Beitritt.
   - Keine Sitzung: Es erscheint einmalig die Kontoanmeldung in derselben Karte; danach geht es automatisch weiter. Weitere Besuche brauchen nur noch Name und Play, solange die Sitzung im Browser gespeichert bleibt.
3. **Player:** großer Play-Button sobald der Host den Stream teilt → Stream lädt → der Player folgt automatisch der Party-Zeit. Blockiert der Browser Autoplay, reicht ein Tippen auf Play.
4. Eigene Controls: Play/Pause, Zeitleiste, Zeit, Ton/Lautstärke, Sync-Status („Synchron“, „Puffert …“, „Nicht synchron“) mit „Wiedergabe synchronisieren“, Qualität (nur echte Varianten), Party-Bereich, Vollbild (iOS: nativer Vollbildplayer). Die Controls blenden sich bei Inaktivität aus. Tastatur: Leertaste/K, F, M.
5. Party-Bereich rechts (Desktop) bzw. unter dem Player (Tablet/Smartphone): Host, Steuerungsmodus, Teilnehmer, Chat (eingeklappt), eigene HLS-URL (Beta), Verlassen.

Design: eigenständig, dunkel und kinoartig. Streamingdienste dienten als Inspiration, es wurden keine Logos, Marken oder Assets kopiert. Systemschriften (die CSP erlaubt keine externen Fonts), Akzent Koralle, `prefers-reduced-motion`, Safe Areas, sichtbare Focus-Styles.

## Auth-Modell und Backend-Blocker (Name-only)

- `PartySession.join()` lehnt anonyme Supabase-Nutzer weiterhin ab, außer der Build setzt `VITE_PARTY_GUEST_JOIN=1`. Dann wird `supabase.auth.signInAnonymously()` genutzt, und `join(..., {allowAnonymous: true})` überlässt die Entscheidung dem Server.
- **Befund:** Nuvio Desktop verlangt für Parties selbst ein echtes Konto (`PartyRepository`: `signedIn && !isAnonymous`). Seine „anonyme“ Anmeldung ist nur eine lokale UUID ohne Supabase-Sitzung. Es gibt also **keinen Beleg**, dass das Backend anonyme Supabase-Nutzer für `watch_party_join`/Realtime autorisiert oder dass Anonymous Sign-In im Projekt aktiviert ist. Die SQL-/RLS-Definitionen liegen nicht im Repository.
- **Daher:** Name-only ist implementiert, aber **standardmäßig aus**. Der sichere Login bleibt als Fallback, wird aber nur noch einmal pro Browser gebraucht.
- **Minimale Backend-Anforderung** für die Freigabe:
  1. Anonymous Sign-In im Supabase-Projekt aktivieren, mit CAPTCHA/Rate-Limit.
  2. `watch_party_join` akzeptiert `auth.jwt()->>'is_anonymous' = 'true'` nur mit gültigem, nicht beendetem Code und freier Kapazität; begrenzter Anzeigename; die Mitgliedschaft wird an `auth.uid()` gebunden.
  3. Heartbeat/Leave/Chat/Realtime-Policies prüfen dieselbe Mitgliedschaft; anonyme Mitglieder dürfen kein Host werden.
  4. Host kann entfernen; ein Rate-Limit pro IP/Party gegen Massenbeitritte.
  5. Danach Preview mit `VITE_PARTY_GUEST_JOIN=1` testen, dann Production.

## Gemeinsame Steuerung

Die separaten Buttons „Party pausieren/fortsetzen“ sind entfernt. Play, Pause und Zeitleiste im Player markieren eine Nutzergeste. Die bestehende Logik entscheidet dann:

- Mit `VITE_PARTY_GUEST_CONTROL=1` und `host_only=false`: gemeinsamer, serverbestätigter Befehl.
- Sonst (Production-Standard): nur lokal. Der Sync-Status zeigt „Nicht synchron“, ein Tippen auf Play bzw. „Wiedergabe synchronisieren“ verbindet wieder.

Die Freigabe bleibt an `GUEST_CONTROL_PREVIEW_AND_BACKEND.md` gebunden.

## Unverändert

HLS-/TorBox-Logik, `browser_hls`, Desktop-Originalstream, Sync-Policy (Hysterese, Wartebudget, Seek-Vorlauf), Realtime, Chat-Protokoll, Host-only, Kotlin/Desktop. Auch die explizite Ladeaktion vor dem ersten Medienabruf (IP-Offenlegung) bleibt erhalten; sie ist jetzt der große Play-Button.

## Geänderte Dateien

- `browser-site/index.html`: neue Struktur, alle bisherigen Element-IDs erhalten.
- `browser-site/src/style.css`: neues Design.
- `browser-site/src/main.js`: Einladung (`renderInvite`), Teilnehmerliste, Player-Controls, Beitrittsablauf mit Login-Fallback, Gast-Flag, automatischer Start nach Laden.
- `browser-site/src/session.js`: `join(..., {allowAnonymous})`.
- `browser-site/public/_headers`: `img-src` erlaubt zusätzlich `https:` (Poster/Backdrops aus Party-Metadaten; nur `https:` wird im Code akzeptiert).
- `browser-site/tests/personal-hls-integration.test.js`, `tests/session.test.js`: Tests angepasst und ergänzt.

## Tests (manuell ausführen)

```powershell
Set-Location 'C:\Users\Alanp\Desktop\Chatgpt\Codex\Nuvio-Watch\NuvioDesktop\browser-site'
npm.cmd test
npm.cmd run build
node checks/browser-smoke.mjs
```

Danach optisch prüfen: `npm.cmd run dev`, dann `http://127.0.0.1:5173/party/<CODE>` in Desktop-Breite, mit 390 px (DevTools) sowie auf einem echten iPhone und Android-Gerät.

## Cloudflare

- Production: keine neuen Variablen. `VITE_PARTY_GUEST_JOIN` und `VITE_PARTY_GUEST_CONTROL` **nicht** setzen.
- Preview optional: beide Flags nur nach den jeweiligen Backend-Freigaben.
- Reihenfolge: PR #2 → Dev, dann Mobile-Sync-PR, dann dieser UI-Branch als eigener PR. Jeweils zuerst die Preview prüfen; bei Problemen das Pages-Rollback auf das vorherige Production-Deployment nutzen.
- **Kein neuer MSI nötig.**
