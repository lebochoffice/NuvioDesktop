# Automatische Freigabe (P2) und Preview-Login 30 Tage (P1); P3 gestrichen

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

## Sicherheitsgrenze (dauerhaft, weil P3 gestrichen ist)

- Ohne Proxy (P3, am 05.11.2026 gestrichen) liefert der Freigabedienst die **Original-TorBox-Adresse mit Account-Key** an die Browser der Mitglieder.
- Mit P2 sind das **alle** Mitglieder, auch jedes Konto, das per Party-Code beitritt, solange „Share my stream“ an ist.
- Ein einmal übertragener Key bleibt beim Empfänger nutzbar, bis du ihn bei TorBox neu erzeugst.
- Die Vorgabe „vollständige Keys nie an Browsergäste“ ist damit bewusst nicht erfüllt; nur ein HLS-Proxy könnte das leisten.
- Deshalb: den Party-Code nur der Familie geben, Gäste ohne Zulassung entfernen und „Share my stream“ nur bei Bedarf einschalten.

## Geänderte Dateien

- **Browser:** `functions/_middleware.js`, `index.html`, `src/main.js`; Test `tests/preview-gate.test.js` (30 Tage, Ablauf, Passwortwechsel)
- **Desktop:** `PlayerScreenRuntimeParty.kt`, `PlayerScreenRuntimePartyControls.kt`, `PlayerScreenRuntimeState.kt`, `PlayerControlParty.kt`, `party.js`

## Testergebnis (05.11.2026, lokal)

- Browser `npm test`: 221/221 bestanden, darunter der neue 30-Tage-Test. Log: `fork-maintenance/local/browser-tests-p1p2.log`.
- Desktop: 127/127 bestanden, der Kotlin-Code kompiliert ohne die entfernte Einzel-Freigabe. Log: `fork-maintenance/local/desktop-tests-p1p2.log`.
- Fork-Invarianten: OK.

## Nachtrag 05.11.2026: Link mit API-Key direkt an die Gäste (Entscheidung des Nutzers)

- Bei aktivem „Share my stream“ steht der fertige **TorBox-HLS-Link mit Account-Key** direkt im Party-Stand (`stream`-Ereignis, `browser_hls.url`).
  - Browser laden ihn automatisch, übernehmen die Party-Zeit und versuchen Play.
  - Desktop-Gäste können ihn ebenfalls abspielen.
  - Neue Gäste und Reconnects erhalten ihn über `state_request`.
  - Der Freigabedienst (Worker) wird dafür **nicht mehr benötigt**; eine vorhandene Freigabe dort wird widerrufen.
- Ein manuell geteilter TorBox-Link mit Key geht ebenso an alle.
- Braucht die Variante dasselbe Token, kennzeichnet der Host das (`propagate_token`). Der Browser hängt es dann nur an TorBox-HTTPS-Anfragen an.
- **Prüfungen:** Die TorBox-Erzeugung nutzt jetzt immer die Original-Adresse (die Variante ohne Key scheitert mit 422). Die Key-Sperre gilt weiterhin für die Originalquelle und alle anderen Adressen.
- **Sicherheit:**
  - Den Link lesen alle Teilnehmer des Realtime-Kanals.
  - Ob das Backend dort ausschließlich aktuelle Mitglieder zulässt, ist nicht verifizierbar. Gekickte Mitglieder können bis zum Ablauf ihres JWT mithören.
  - Ein Widerruf („Share my stream“ aus, Party-Ende) stoppt weitere Verteilung und laufende Browser-Wiedergaben, macht einen übertragenen Key aber nicht ungültig; das geht nur durch Neuerzeugen bei TorBox.
- Tests (nicht ausgeführt): Browser lädt den Link mit Token direkt und gibt das Token nur an TorBox-Varianten weiter; `propagate_token` wird nur bei `true` übernommen.
