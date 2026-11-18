# A40: „Intro überspringen“ erscheint nicht – Analyse und Härtung

Stand: lokaler Worktree (nicht committet, nicht gebaut, nicht deployt).

## Nachgewiesene Ursache: fehlende Daten
- Die zuletzt geschaute Serie hat in IntroDB Intro-Daten für die Staffeln 1–3,
  für die Staffeln 4–5 gar keine Segmente (weder Intro noch Recap noch Outro).
  Der Wechsel fällt genau auf den Zeitpunkt, ab dem der Button fehlte.
- Ausgeschlossen anhand echter Daten: IntroDB-Konfiguration (installierte MSI
  1.2.42 enthält `https://api.introdb.app`), Episoden-IDs (alle `tt…:S:E`),
  Timeout (IntroDB 25–260 ms), Übertragung an die Desktop-Controls.
- Keine Code-Regression zwischen 1.2.41 und 1.2.42 im Skip-Pfad.
- Abhilfe für fehlende Daten: Intros über „Intro einreichen“ (IntroDB-API-Key) melden.
- Nebenbefund: Simkl lehnt den hinterlegten Client-Key mit 401 ab; damit fehlt die
  Anime-Zuordnung (AniSkip/Anime-Skip über IMDb). Betrifft nur Anime.

## Härtung (vorbeugend, ändert diesen Fall nicht)
1. **Transiente Fehler werden nicht mehr gecacht.** Netzwerk-/HTTP-Fehler, Timeouts
   und unlesbare Antworten liefern `null` statt einer leeren Liste und machen das
   Ergebnis unvollständig; nur vollständige Ergebnisse werden gecacht. Echte
   „keine Daten“-Antworten (IntroDB 200 mit `null`, AniSkip 404 `found:false`) bleiben
   leere, cachebare Antworten. Ein fehlgeschlagener Anime-Skip-Show-Lookup wird nicht
   mehr dauerhaft als „keine Show“ gemerkt.
2. **Getrennte Zeitgrenzen statt eines 4-s-Gesamt-Timeouts.** IntroDB (5 s) und die
   Anime-Kette Simkl → AniSkip/Anime-Skip (6 s) laufen parallel; ein Versuch ist auf 8 s
   begrenzt. IntroDB-Daten werden sofort angezeigt, auch wenn die Anime-Kette noch läuft
   (wichtig für Intros ab 0 s).
3. **Begrenzte Wiederholung.** Nur unvollständige Ergebnisse werden wiederholt, höchstens
   zweimal (nach 2 s und 6 s). Spät eintreffende Daten erreichen die laufende Episode;
   ein Episodenwechsel bricht die Suche ab, alte Ergebnisse erreichen nie die nächste
   Episode. Keine erfundenen Zeitfenster, keine Endlosschleife.

Nicht geändert: Auswahl des aktiven Intervalls, Desktop-Controls, Auto-Skip,
Ereignis-/Live-Sync, Leertasten-Fix.

## Offen
- ID-Fallback für Serien mit Nicht-IMDb-Video-IDs (z. B. `tmdb:…`) über die IMDb-ID
  der Metadaten ist nicht umgesetzt (für die vorhandene Bibliothek nicht relevant).
- Echtgerät: Folge mit IntroDB-Daten im Desktop-Player prüfen (Button, Sprungziel,
  Ausblenden nach dem Segment, Auto-Skip, Watch Party).
- Die Härtung benötigt eine neue Desktop-MSI; Family-Beta ist nicht betroffen.
