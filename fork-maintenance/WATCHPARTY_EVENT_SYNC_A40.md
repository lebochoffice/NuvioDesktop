# A40: Ereignis-Sync, Leertaste im Pause-Overlay, mobile HLS-Pufferanalyse

Stand: lokaler Worktree (nicht committet, nicht gebaut, nicht deployt).

## A – Leertaste bei „Du schaust gerade“ (Desktop)

**Befund (reproduziert):** Die Desktop-Controls (`player-ui/controls.js`) verarbeiten
Space auch bei sichtbarem Pause-Overlay korrekt: Im lokal geladenen Controls-HTML
mit simulierter Bridge sendet ein echter Tastendruck genau ein
`setPlaybackStateQuiet:1` (bzw. `:0` bei sichtbarer Steuerung). Der Fehler entsteht
also nicht in der Tastenlogik, sondern wenn der Tastaturfokus nicht mehr beim
Controls-WebView liegt: Dann landet Space beim AWT/Compose-Fenster, für das es
keine Player-Belegung gab.

**Auslöser:** Nach ca. 5 s Pause plus Ausblenden der Steuerung schaltete Kotlin
zusätzlich das Compose-`PauseMetadataOverlay` über die native SwingPanel-Fläche ein
(auf Desktop ein Duplikat – das WebView zeichnet dasselbe Overlay). Das war die
einzige Kotlin-seitige Änderung im Moment des Ausfalls. Der genaue
Fokuswechsel-Mechanismus von Compose/AWT/WebView2 ist ohne laufende App nicht
mitgeschnitten; er ist **wahrscheinlich, nicht bewiesen**.

**Fix (zwei Ebenen, Overlay bleibt erhalten):**
1. Desktop rendert das redundante Compose-Overlay nicht mehr (`!isDesktop`); das
   WebView-Overlay „Du schaust gerade“ bleibt unverändert.
2. `DesktopPlayerSpaceFallback` (KeyEventDispatcher am Player-Fenster): Space, das
   AWT erreicht (also nicht vom WebView verarbeitet wurde), löst genau einen
   `keyboardToggle` über den bestehenden, party-fähigen Pfad aus und gibt den
   Fokus an das WebView zurück. Auto-Repeat ⇒ eine Aktion beim Loslassen;
   Strg/Alt/Meta, andere Fenster (Dialoge) und andere Tasten werden ignoriert.
   Kann nie doppelt auslösen: Hat das WebView den Fokus, sieht AWT die Taste nicht.

## B – Ereignis-Sync

**Übertragung:** Der Host kündigt den Modus in seinem bestehenden Status/Presence
an – optionales Feld `sync: "event"` (fehlt = Live-Sync), wie das vorhandene
`commands`-Feld. Kein neues Playback-Event, keine neue Revision, kein Backend-/
Supabase-Schema. Bei Reconnect wird der Status ohnehin neu gesendet (track +
status + state_request-Antwort) ⇒ Modus wird wiederhergestellt. Nur der Status
des aktuellen Hosts zählt; Gäste können den Modus nicht setzen; nach Host-Wechsel
gilt Live bis zur Ankündigung des neuen Hosts.

**Verhalten im Ereignis-Sync (Desktop und Browser identisch):**
- Play/Pause: an der eigenen Position, kein Seek (`eventNeedsPosition` /
  `eventSyncSeekReason`: Play-Zustand geändert ⇒ keine Position).
- Vor-/Zurückspulen: bestehender autorisierter Host-/Command-Pfad; ein Sprung der
  Party-Zeitachse bei unverändertem Play-Zustand ⇒ genau ein Seek.
- Re-Anchors, Tempoänderungen, Duplikate, veraltete/fremde Revisionen ⇒ kein Seek
  (Sequenz- und Host-only-Prüfung unverändert).
- Kein periodischer Drift-Seek, kein Tempo-Nudging, kein Paused-Position-Re-Anchor
  des Hosts.
- Keine globale Wartepause: Der Koordinator pausiert nicht für puffernde Mitglieder;
  eine beim Umschalten laufende Wartepause wird sofort beendet.
- Beitritt: einmalige Ausrichtung beim ersten Zustand; „Jetzt synchronisieren“:
  einmalige Ausrichtung (Host-Pause wird beachtet). Browser-Reconnect richtet wie
  ein Wiedereintritt einmal aus (der Browser pausiert während eines
  Verbindungsverlusts lokal). Desktop-App-Resume aus dem Hintergrund richtet nicht
  automatisch aus.
- Puffern: nur der Gast wartet, Status „Puffert“, danach weiter an eigener Position.
- „Alle synchronisieren“ ist im Ereignis-Sync ausgeblendet (würde nur re-ankern).

**Moduswahl:** Desktop-Partymenü (Karte „Synchronisierung“, Host wählt, Gäste sehen
den Modus); Browser-Drawer (Browser-Host wählt, Gäste sehen den Modus). Wechsel ohne
Quellenneustart und ohne Repositionierung.

**Kompatibilität / Einschränkungen:**
- Offizielle Nuvio-TV-App und ältere Desktop-/Browser-Builds ignorieren das Feld und
  korrigieren weiter automatisch (Live-Verhalten). Ereignis-Sync gilt dort **nicht**.
- Ein Host ohne neues Build kündigt nichts an ⇒ alle bleiben im Live-Sync.
- Ist der Host offline, gilt für einen Gast-Koordinator wieder Live.

## C – Mobile HLS-Pufferung

**Nicht nachgewiesen** ist eine konkrete Ursache am betroffenen Smartphone – dafür
fehlen Messdaten der Live-Sitzung. Aus dem Code belegt sind diese Mechanismen, die
das beobachtete Muster (langer Start, wenige Sekunden Wiedergabe, erneut „Videopuffer
leer“) erzeugen können:
1. Standard „Beste Qualität“ fixiert bei mehreren Varianten die höchste Stufe
   (`loadLevel`), ABR ist dann aus. Liefert die Mobilverbindung weniger als deren
   Bitrate, laden Segmente langsamer als Echtzeit ⇒ Puffern ist unvermeidlich.
2. Live-Sync springt bei anhaltender Drift in ungepufferte Bereiche (mit Vorlauf);
   jeder solche Seek verwirft den nutzbaren Vorwärtspuffer ⇒ Aufhol-Schleife.
   Ereignis-Sync vermeidet das vollständig.
3. HEVC/4K: hls.js prüft Codecs (`useMediaCapabilities`); nicht unterstützte Formate
   enden mit „Videoformat nicht unterstützt“, nicht in endlosem Puffern.

**Änderungen (nur Diagnose + Hinweis, kein stilles Umschalten):** Opt-in-Diagnose um
fehlende Messwerte ergänzt: Qualitätsmodus, ABR aktiv, Höhe/Bitrate/Codec-Familie
der aktiven Variante, Segment-Bytes und -Durchsatz, Bitrate der Segment-Variante,
Anzahl Segmente langsamer als Echtzeit, Serie, Fragment-Retries, CDN-Hostwechsel
(nur Zähler, keine Hostnamen/Tokens), Quellen-Ladevorgänge. Lädt eine fixierte
Qualität drei Segmente in Folge langsamer als Echtzeit, zeigt die Qualitätsnotiz
einen Hinweis auf „Automatisch (adaptiv)“. Keine Pufferlängen, keine
Qualitätsstufen, kein Transcoding geändert; beste Qualität bleibt Standard.

## Auslieferung
- **Neue Desktop-MSI nötig:** A (Compose-Overlay, Space-Fallback), B Desktop
  (Kotlin-Sync, Koordinator, Partymenü `party.js`, Controls-State).
- **Nur Family-Beta-Deployment:** B Browser (`session.js`, `main.js`, `sync-policy.js`,
  `index.html`, `style.css`), C (Diagnose + Hinweis).
- Ereignis-Sync wirkt erst, wenn der Host (Desktop-MSI oder Browser-Host) das neue
  Build nutzt; Browser-Gäste brauchen das neue Family-Beta-Bundle.
