# Automatische Freigabe (P2) und Preview-Login 30 Tage (P1); P3 zurückgestellt

Lokal, nicht committet. Kein MSI. Nicht live getestet.

## P1: Preview-Passwort einmal pro Gerät

- `browser-site/functions/_middleware.js`: Die Session gilt jetzt **30 Tage** statt 12 Stunden.
  - Immer mit Ablauf.
  - Cookie `__Host-nuvio_preview` mit `HttpOnly`, `Secure`, `SameSite=Lax`.
  - gebunden an Host und Passwort; ein Passwortwechsel beendet alle Sessions
  - Production unverändert
- **Alte Sessions:** Bestehende Cookies tragen ihren 12-Stunden-Ablauf in sich und laufen danach normal aus. Neue Logins gelten 30 Tage.
- **Drei Preview-Branches:** Das Cookie gilt pro Host. Auf jedem der drei Branch-Aliase ist also einmal pro Gerät ein Login nötig. Die anderen zwei Branches brauchen diese Änderung per Cherry-Pick, sobald sie committet ist.
- **Abmelden:** In der Browser-App unter „Technik“ gibt es „Preview abmelden“; in Production ist der Button ausgeblendet.
  - Der Logout-`POST` nutzt gezielt `referrerPolicy: same-origin`. Sonst würde die App-Seite mit `no-referrer` den Header `Origin: null` senden, und die unveränderte Origin-Prüfung würde ihn ablehnen.
- Cloudflare Access und die IP-Bypass-Regel sind unberührt.

## P2: Ein globaler Schalter „Share my stream“

- Ist „Share my stream“ an, sind **alle aktuellen Mitglieder außer dem Host** automatisch für den Freigabedienst zugelassen.
- **Änderungen der Mitglieder:**
  - Neue Mitglieder kommen automatisch dazu: Bei jeder Mitgliederänderung wird neu veröffentlicht.
  - Bei Kick oder Leave fallen sie heraus, und der Worker löscht ihre Berechtigungen sofort.
- **Widerruf:** „Share my stream“ aus, das Party-Ende oder ein Titelwechsel widerrufen die Freigabe.
- **Worker:** Laufzeiten (Freigabe 30 min mit Verlängerung, Berechtigung 5 min), Rate-Limits und serverseitige Prüfung der Mitgliedschaft per `watch_party_heartbeat` sind unverändert. Der deployte Worker braucht dafür **kein** neues Deployment.
- **UI:** Die Schild-Schalter pro Mitglied sind entfernt. Der Status der Freigabe erscheint unter „Stream freigeben“. Die Bestätigung beim Einschalten nennt die Folge ausdrücklich.
- Die HLS-Vorbereitung lief schon automatisch (Nuvio-Cloud direkt, Addon-Streams per Infohash bzw. exaktem Titel, sonst Stift und manuelle Auswahl) und bleibt so. Ein Reconnect erzeugt nichts neu.

## Sicherheitsgrenze (wichtig, weil P3 zurückgestellt ist)

- Ohne P3 liefert der Freigabedienst die **Original-TorBox-Adresse mit Account-Key** an die Browser der Mitglieder.
- Mit P2 sind das **alle** Mitglieder, auch jedes Konto, das per Party-Code beitritt, solange „Share my stream“ an ist.
- Ein einmal übertragener Key bleibt beim Empfänger nutzbar, bis du ihn bei TorBox neu erzeugst.
- Das widerspricht der Vorgabe „vollständige Keys nie an Browsergäste“. Diese Vorgabe erfüllt erst **P3** (HLS-Proxy im Worker; der Key bleibt im Worker).
- Bis dahin: den Party-Code nur der Familie geben, Gäste ohne Zulassung entfernen und „Share my stream“ nur bei Bedarf einschalten.

## Geänderte Dateien

- **Browser:** `functions/_middleware.js`, `index.html`, `src/main.js`; Test `tests/preview-gate.test.js` (30 Tage, Ablauf, Passwortwechsel)
- **Desktop:** `PlayerScreenRuntimeParty.kt`, `PlayerScreenRuntimePartyControls.kt`, `PlayerScreenRuntimeState.kt`, `PlayerControlParty.kt`, `party.js`

## Testergebnis (05.11.2026, lokal)

- Browser `npm test`: 221/221 bestanden, darunter der neue 30-Tage-Test. Log: `fork-maintenance/local/browser-tests-p1p2.log`.
- Desktop: 127/127 bestanden, der Kotlin-Code kompiliert ohne die entfernte Einzel-Freigabe. Log: `fork-maintenance/local/desktop-tests-p1p2.log`.
- Fork-Invarianten: OK.
