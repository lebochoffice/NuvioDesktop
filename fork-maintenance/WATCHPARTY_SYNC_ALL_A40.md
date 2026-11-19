# A40 1.2.43+: Ereignis-Sync als Standard, „Alle synchronisieren“, Modus-Info, HLS-Messwerte

Ausgeliefert: Family-Beta `b89e7629`, signierte MSI 1.2.44 (Quellbaum `92160f3b` auf `e03c29b4`); live getestet laut Nutzer OK.

- **Standard:** Neue Desktop- und Browser-Host-Partys starten im Ereignis-Sync und kündigen
  `sync: "event"` aktiv an (`PartySyncMode.NewPartyDefault`). Fallback ohne Feld bleibt Live.
  Reconnect derselben Party behält die Wahl.
- **Alle synchronisieren (beide Modi):** gewöhnliche, sequenzierte und per Host-RPC gespeicherte
  Host-Revision mit `sync_all`-ID (nur auf der Leitung, nie gespeichert). Unterstützende Gäste
  springen genau einmal (Host-Play/Pause gilt), nur wenn die Revision vom aktuellen Host stammt;
  Duplikate/ältere Kopien greifen über `seq` nicht erneut; „Allein schauen“ bleibt unberührt;
  keine Driftkorrektur danach. Mitglieder melden Unterstützung per Presence `sync_all: 1`;
  ältere Apps/TV werden in der Host-Meldung separat gezählt, nie als synchronisiert.
- **Modus-Info:** Radio-Auswahl (Gast schreibgeschützt), „Wie funktioniert dieser Modus?“
  standardmäßig zu, `aria-expanded`, Zustand bleibt bei Refresh erhalten (Desktop + Browser).
- **HLS:** Standard bleibt „Beste Qualität“ (höchste unterstützte Variante, keine automatische
  Reduzierung); „Automatisch (adaptiv)“ ist nur manuell wählbar; explizite Wahl bleibt gespeichert,
  Einzelvariante bleibt „festgelegt“. Neue Diagnose: mittlere/maximale
  Segment-Bitrate, mittlerer Durchsatz, byte-begrenzter Vorwärtspuffer (hls.js `maxBufferSize`
  60 MB ⇒ z. B. nur ~9,6 s bei 50 Mbit/s), Chip „Verbindung langsamer als Video“.
  **Keine** Ursache am Gerät belegt – Messung im Live-Test nötig.
- **Handy vor Host:** Code zeigt keine Tempo-Abweichung (Rate wird beim Moduswechsel auf 1,0
  zurückgesetzt, Test). Wahrscheinliche Quellen eines *konstanten* Versatzes: Seek-Vorlauf
  (bis 3 s) bei der Ausrichtung, Host-Puffern (Ereignis-Sync wartet bewusst nicht), Uhrversatz.
  Neue `drift_sample`-Ereignisse alle 10 s (Diagnose) unterscheiden konstant vs. wachsend.
  Nicht belegt.
- **Auslieferung:** Desktop-Teile (Kotlin, party.js/css) ⇒ neue MSI; Browser-Teile ⇒ Family-Beta.
