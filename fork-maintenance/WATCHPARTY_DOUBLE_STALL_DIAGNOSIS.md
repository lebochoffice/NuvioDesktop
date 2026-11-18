# A40 0.1.36: wiederkehrende Doppelhänger – Diagnose und begrenzte Korrektur

## Status / Aussagegrenze

15.11.2026, Basis `9a31d00afeab1414a3efbaeb70e26e05eca04389`, installierte MSI 1.2.42.
Der Nutzer bestätigt die **offizielle** Nuvio-Android-/TV-App; ihre installierte Versionsnummer ist noch unbekannt.
Keine MSI/APK gebaut, keine App installiert, keine Website veröffentlicht. Die früheren lokalen Browser-Sync-Änderungen bleiben erhalten.

**Kein bestätigter Live-Erfolg.** Die Pause-/Seek-Verstärkung ist im Code und kontrolliert reproduzierbar.
Ob sie die beobachteten Hänger alle ungefähr 20 Sekunden auslöst, ist ohne zeitlich korrelierte Geräteereignisse nicht nachgewiesen.
Insbesondere sind echte Puffererschöpfung, langsame HLS-Segmente, Decoder-/Audioaussetzer und Netzschwankungen damit nicht ausgeschlossen.

## Gemeinsamer Pfad

1. `PlayerScreenRuntimeParty.kt` meldete natives Loading nach 1 s als Buffering, auch nach einem korrigierenden Seek.
2. `PartyRepository.coordinatorLoop()` wertete Loading/Buffering alle 500 ms unmittelbar aus; empfangene Meldungen hatten keine eigene Mindestdauer oder lokale Altersgrenze.
3. Der Host erzeugte `paused=true, waiting=true`, sendete `state` an alle und persistierte die Revision.
4. Sobald die Wartegründe fehlten, erzeugte er `paused=false, waiting=false`. 3 s Resume-Schonzeit und 15 s Wartegrenze bestanden bereits.
5. Der native Revisionspfad konnte bei **jeder neuen Revision** schon über 500 ms lokalem Abstand seeken, vor der Loading-Abbruchprüfung. Das betraf auch Koordinator-Pausen; beim Host sogar eine eigene pausierte Revision.
6. Normale native Driftkorrektur hatte anschließend lediglich Seek-Settle (2,5 s), aber keine Mindestdauer für die Drift und keine Erholungsphase nach Buffering. Ein Seek konnte wieder Loading und eine neue Wartefolge erzeugen.

Kontrollierte Altfall-Reproduktion: bei t=20 s wird eine einzelne Buffering-Meldung zum globalen Wait. Der Gast steht 800 ms hinter dem neuen Pausenpunkt und seeked. Bei Resume eine Sekunde später liegt die simulierte Keyframe-Landung noch 600 ms zurück; der alte Revisionspfad seeked erneut. Diese Annahmen reproduzieren den Verstärker, **nicht** den realen CDN-Verlauf oder die genaue Hängerdauer.

### Offizielle TV-App getrennt betrachtet

Quellvergleich mit veröffentlichtem Tag **1.1.0** (keine Behauptung zur installierten Version):

- [TV-Player-Integration](https://github.com/NuvioMedia/NuvioTV/blob/1.1.0/app/src/main/java/com/nuvio/tv/ui/screens/player/PlayerRuntimeControllerParty.kt): `runPartySync()` besitzt ebenfalls den sofortigen Seek bei neuer Revision >500 ms, vor der Loading-Prüfung. Verwendet `seekPlaybackTo(..., SeekParameters.EXACT)` und `setPlaybackSpeedInternal`.
- [TV-Koordinator](https://github.com/NuvioMedia/NuvioTV/blob/1.1.0/app/src/main/java/com/nuvio/tv/core/party/PartyRepository.kt): 500-ms-Koordinator, 3-s-Grace, 15-s-Wait; Host hat bei vorhandener Presence Vorrang.
- [TV-Sync](https://github.com/NuvioMedia/NuvioTV/blob/1.1.0/app/src/main/java/com/nuvio/tv/core/party/PartySync.kt): 1500-ms-Seekschwelle, Tempo 250/80 ms und 5 %.

Der Android-Player **dieses Desktop-Repositories** ist nicht automatisch die separat installierte offizielle TV-App. Hier verbindet der gemeinsame Player-Pfad ExoPlayer (`seekTo`, `setPlaybackSpeed`) bzw. mpv. Windows nutzt `NativePlayerController` und mpv (`absolute+keyframes`, pausiert `absolute+exact`, Property `speed`). Diese Aufrufe laden die Quelle nicht explizit neu, können aber einen Decoder-/Pufferwechsel verursachen. Eigene gemessene ExoPlayer-/mpv-Laufzeitdaten liegen nicht vor.

## Periodische Ereignisse

| Vorgang | Intervall | Einfluss |
|---|---:|---|
| Nativer Player-Takt | 250 ms | Zustand, Revisionen, Sync |
| Koordinator | 500 ms | Kann globale Wait-Pause/Resume veröffentlichen |
| Native Driftkorrektur | 500 ms | Seek oder Tempo; hinter weiteren Gates |
| Positionsreport Desktop/Browser | 10 s | Status-/Anzeigeinformation, kein Playback-Befehl |
| Desktop/TV-Heartbeat | 120 s | Snapshot; nur neuere Playback-Revision angenommen |
| Browser-Heartbeat | 45 s | Snapshot/Session-Prüfung |
| Browser-Chat | 5 s | Nachrichtenabruf, kein Playback-Befehl |
| Browser-Clock | 60 s | Uhrkorrektur; kein eigener Playback-Publish |
| Desktop-Clock | 4 Proben im Abstand 400 ms zu Sitzungsbeginn | Kein 20-s-Timer |
| Family-Share-Erneuerung | regulär 10 min | Quellberechtigung, kein Playback-Befehl |
| HLS-Segmentgrenzen | Quelle abhängig | Ohne Live-Manifest/Segmentzeiten unbekannt |

Kein nachgewiesener genereller 20-s-Playback-Timer. Positionsreports wurden nicht als Ursache umgedeutet. `PartyClock`, `PartyChannel`, Browser-Session und Quellfreigabepfade bleiben unverändert.

## Korrektur

- Neuer hostlokaler `PartyWaitGate`: 2 s kontinuierlicher Wartegrund **ab Empfang**; keine Addition kurzer Einzelstörungen. Nach qualifiziertem Wait 1 s stabil Ready vor Resume. Fortgesetzte Statusmeldungen setzen den Beginn nicht zurück.
- Empfangsalter maximal 30 s, nur aktuelle Mitglieder/gleiches Medium, Solo ausgeschlossen. Wo `position_at` vorhanden ist, werden nachweislich ältere Meldungen innerhalb des Frischefensters verworfen. Legacy-TV ohne Timestamp funktioniert weiterhin; beliebig verspätete alte Legacy-Meldungen sind ohne Protokollerweiterung nicht eindeutig erkennbar.
- 3-s-Resume-Grace, 15-s-Wait-Limit und Ignorieren eines überlangen Wartegrunds bis zur stabilen Erholung bleiben erhalten. Explizite Aktionen bleiben außerhalb der automatischen Warteprüfung.
- Native neue Revision: unmittelbare Positionsanpassung nur für Initialabgleich, expliziten Command oder tatsächlichen Timeline-Sprung; kein automatischer Seek während Coordinator-Wait. Pause/Resume wird weiterhin sofort angewendet.
- Native automatische Drift: 2 s anhaltend, 4 s Mindestabstand zwischen Seeks, 2,5 s Erholung nach Loading/Scrubbing. Keine größere Positionsschwelle; 1500/500 ms und Tempo-Hysterese 250/80 ms bleiben erhalten.
- Kurzes Seek-Loading meldet während des vorhandenen Settle-Fensters keinen neuen Buffering-Wartegrund; anhaltendes Loading danach weiterhin.
- Smart Playback AUS/Seek AUS und Host-/Gast-Solo behalten ihre Grenzen. Kein HLS-Neustart, keine Quellwahländerung, kein zusätzlicher HLS-Prozess.

## Kontrollierte Prüfung

`PartyStabilityTest`: alte Doppel-Seek-Bedingung, Desktop-Host mit Legacy-TV-Status, Browser-Status und gemischten Gästen, zwei kurze Störungen, echte längere Störung, flappende/repetitive Presence, veraltete Meldungen, Reconnect, Mitgliedschaft/Medium/Solo, Warte-Timeout, fortlaufende Revisionen, Pause/Resume, expliziter Host-Seek, kleiner Offset, anhaltende Drift, Cooldown und Erholung.
Drei-Minuten-Modell: kurze Doppelstörungen im 20-s-Raster lösen keine globale Pause aus; eine eingebaute 6-s-Störung eines zweiten Gasts führt genau zu einer Pause und einem Resume. Das ist ein Modell der Regeln, kein echter TV-/CDN-Wiedergabetest.

Browser: echter `main.js` im vorhandenen Fake-Media-Harness, zwei HLS-Gäste, Coordinator-Wait/Resume ohne zusätzlichen Seek und ohne HLS-Instanzwechsel, expliziter Host-Seek bleibt sofort. Vorhandene Regressionen zu Buffering, Hoststeuerung, Positionsreports und lokaler Diagnose bleiben berücksichtigt.

Gezielter Gradle-Aufruf: `:composeApp:desktopTest` mit Filtern für `PartyStabilityTest`, `PartySyncTraceTest`, `PartySyncTest`, `PausedPositionTest`, `PartyCommandsTest`, `PartyHostOnlyControlTest`, `PartyStreamTest`, `PartyFamilyShareTest` (offline, kein MSI-Task). Browser: `sync-policy.test.js` sowie 18 passende Fälle aus `personal-hls-integration.test.js`, plus JS-Syntaxprüfung. Keine vollständigen Testsuites.

Torrent/Usenet, TorBox-Auswahl, deutsche Tonspur, Auflösung, Family-Token-Empfänger und Host-Zustimmung wurden nicht geändert. Bestehende Stream-/Family-Vertragstests decken die Trennung mit ab; keine echten TorBox-Anfragen oder Medienabrufe.

Abschließende Ergebnisse: **85 gezielte Desktop-Tests, 0 Fehler** (davon 21 Stabilitätsfälle und 1 Diagnose-/Datenschutztest). Kotlin-Haupt- und Testquellen erfolgreich kompiliert. **25 Browser-Tests, 0 Fehler** (7 Policy + 18 ausgewählte Integration), Syntax für main.js/session.js/sync-policy.js und `git diff --check` erfolgreich. Die bereits zuvor grünen anderen Tests wurden nicht als neue Läufe ausgegeben.

Geänderte/neue Dateien dieses Auftrags:

- `composeApp/src/commonMain/kotlin/com/nuvio/app/features/party/PartyRepository.kt`
- `composeApp/src/commonMain/kotlin/com/nuvio/app/features/party/PartySync.kt`
- `composeApp/src/commonMain/kotlin/com/nuvio/app/features/party/PartyWaitGate.kt` (neu)
- `composeApp/src/commonMain/kotlin/com/nuvio/app/features/party/PartySyncTrace.kt` (neu)
- `composeApp/src/commonMain/kotlin/com/nuvio/app/features/player/PlayerScreenRuntimeParty.kt`
- `composeApp/src/desktopMain/kotlin/com/nuvio/app/Main.kt`
- `composeApp/src/desktopMain/kotlin/com/nuvio/app/features/party/DesktopPartySyncTrace.kt` (neu)
- `composeApp/src/commonTest/kotlin/com/nuvio/app/features/party/PartyStabilityTest.kt` (neu)
- `composeApp/src/commonTest/kotlin/com/nuvio/app/features/party/PartySyncTraceTest.kt` (neu)
- `browser-site/tests/personal-hls-integration.test.js` (nur zusätzlichen Test angehängt)
- dieser Bericht.

`browser-site/src/main.js` und `browser-site/src/sync-policy.js` wurden in diesem Auftrag nicht geändert; deren bereits bestehende lokale Änderungen bleiben erhalten.

## Lokale Diagnose für einen später freigegebenen Desktop-Testbuild

Opt-in nur im Startprozess: `NUVIO_PARTY_SYNC_DIAGNOSTICS=1`. Ohne diesen Wert keine Erfassung/Datei.
A40-Ausgabe: `%LOCALAPPDATA%\Nuvio A40-Fork\Cache\party-sync-<PID>.csv`.
Maximal 240 Ereignisse, Sample alle 2 s, Datei höchstens einmal pro Sekunde im IO-Thread erneuert.
Nur feste Kategorien, Zeiten und Zahlen: Revision, Quelle (Local/Command/Realtime/Snapshot/Coordinator), Pause/Waiting, Anzahl wartender Mitglieder, lokaler/entfernter Auslöser, Loading/Buffering-Anzahl, Buffering-Ende, automatische/manuelle Seek-Kategorie, Rate, tatsächliche/erwartete Position und gemeldeter Puffer voraus.
Keine Mitglieds-/Party-/Datei-IDs, Namen, URLs, Tokens, Logger- oder Sentry-Ausgabe. Schreibfehler deaktivieren nur die Diagnose. Die begrenzte Datei bleibt lokal; kein automatischer Upload.

Browser: vorhandenes Opt-in `sessionStorage.setItem('nuvio-party-debug', '1')`, anschließend Seite neu laden. Vorhandene begrenzte `playbackEvents` enthalten Host-Revision, Pause/Waiting, Seek-Grund, Drift, Puffer, Segmentdauer und Ladezeit. Nicht die gesamte Browser-Netzwerkaufzeichnung mit authentifizierten URLs weitergeben.

Für die noch offene Live-Zuordnung braucht es 1–2 Minuten um einen Doppelhänger mit Host-CSV und Browser-Diagnose, notierten Hängerzeiten sowie genaue TV-Version/Player-Engine. Prüfen: folgt `WaitStarted` auf Buffering? Folgen Pause/Resume-Revisionen? Gibt es danach einen Seek bei leerem oder vollem Puffer? Ohne Host-Wait und Seek sind Segment-/Decoder-/Netzursachen weiter zu untersuchen.

## Auslieferung und Bestandsschutz

Der Host-Fix benötigt später eine separat freigegebene neue Desktop-MSI; 1.2.42 enthält ihn noch nicht. Ein reines Family-Beta-Deployment kann den Host-Koordinator nicht ändern. Der bereits veröffentlichte Browser-Fix bleibt unverändert, daher hier kein weiterer Browser-Deploy erforderlich.
Die offizielle TV-App erhält durch diesen Fork keine Codeänderung. Weniger unnötige Host-Wartezyklen wirkt auch für sie; bleiben eigene TV-Seeks übrig, muss deren tatsächliche Version/Engine getrennt untersucht bzw. upstream korrigiert werden. Kein pauschales TV-Update als Erfolgsgarantie.

Die bestehenden lokalen Browseränderungen und `.wrangler/` bleiben erhalten. MSI 1.2.42 bleibt unverändert (SHA-256 `1c0c932de340ec773e9a22ccd93f3802f2aa2f5582cf1e931a94b6d528d98c02`). Keine Änderungen an Family-Beta, Production, Supabase, Workern, Profilen oder Deep Links; keine Commits, Pushes oder Merges.

## Nachtrag 15.11.2026 – maßgeblich: Host flüssig, ausschließlich Gäste betroffen

Die neue Live-Beobachtung widerlegt keinen einzelnen Codepfad, schwächt aber die bisher priorisierte globale Pause erheblich. Die oben beschriebene Altfall-Reproduktion ist **kein Nachweis der realen Ursache**.

### Tatsächliche Zustandsübergänge
- publish() setzt beim Desktop zuerst _playback.value und sendet dieselbe Revision anschließend an Gäste. Der 250-ms-Player-Takt wendet applyPartyPaused vor der own-Prüfung an. own verhindert bestimmte Positionskorrekturen, nicht Pause/Resume.
- Ein normales waiting=true wird mit paused=true veröffentlicht. Ein synchronisierter, aktiver Host sollte daher ebenfalls pausieren. Host-Solo, anderer lokaler Medienkontext/noch nicht geladener Player oder eine vor dem nächsten Takt überschriebene StateFlow-Revision können die lokale Anwendung überspringen. Eine über 0,5–1 s anhaltende reguläre Pause bei unverändert flüssigem, synchronisiertem Host passt nicht zum Normalpfad.
- Neue Revisionen ohne Pause sind dagegen mit flüssigem Host und seekenden Gästen vereinbar: Im erneut gelesenen offiziellen TV-Tag 1.1.0 seeked der Revisionspfad bei >500 ms Abstand sofort, vor Loading-Prüfung und unabhängig vom regulären 2,5-s-Seek-Settle. Eigene laufende Host-Revisionen umgehen diesen Seek. Zwei Revisionen können daher zwei TV-Seeks auslösen. Ob solche Revisionen tatsächlich im 20-s-Raster eintreffen, ist unbekannt.
- Ohne neue Revision können native Driftkorrektur, Tempoänderungen oder Decoder/Buffering verantwortlich sein. Der TV-Quellstand ruft SeekParameters.EXACT und setPlaybackSpeedInternal auf. Welche konkrete installierte TV-Version/Engine betroffen ist, bleibt unbekannt. Kein Windows-Fix verändert diese App.
- Kein belegter 20-s-Timer: 10-s-Positionsreports sind Informationsmeldungen, keine Playback-Kommandos. Browser-Uhrkorrektur erfolgt alle 60 s. Segmentdauer und reale Snapshot-Verzögerungen liegen nicht vor.

### Warum die veröffentlichte Browserkorrektur nicht genügt
Sie begrenzt automatische Hard-Seeks aus applySync. Sie behebt weder echte Segment-/Decoderprobleme noch interne hls.js-Gap-Recovery, Tempoänderungen oder die TV-Implementierung. Welche dieser Ursachen im Livebetrieb wirkt, ist **nicht festgestellt**. Die Wirkungslosigkeit rechtfertigt keine pauschale Abschaltung des Syncs oder weitere Schwellenänderungen.

### Ausschließlich notwendige Diagnose ergänzt
main.js erfasst im bestehenden Opt-in-Ring (120 Ereignisse) zusätzlich rohe seeking/seeked/ratechange/pause-Ereignisse, monotone Zeit, tatsächliche Position, Player-pause/seeking, Solo-Zustand, Clock-Offset und Dauer einer waiting→playing-Phase. canplay beendet die Messung nicht vorzeitig. Das ist die vom Player gemeldete Wartephase, keine Messung physisch leerer Puffer oder unsichtbarer Decoder-Hänger. Medienwechsel setzt die Messung zurück.
Vorhandene BufferAhead-, Segmentladezeit-, Drift-, Rate-, Revisions-, ReadyState- und Host-pause/waiting-Felder bleiben erhalten. Keine URLs, Tokens oder IDs ergänzt. Rohereignisse werden auch in Solo erfasst; Diagnose bleibt standardmäßig aus. Keine Änderung der produktiven Korrekturregeln.

### Solo-Vergleich
enterSolo deaktiviert syncEnabled, setzt lokale Rate auf 1 und behält HLS-Instanz und Quelle. Eingehende normale Playback-Revisionen lösen keinen lokalen Pause/Seek aus. Zur Party übernimmt wieder die Party-Zeit. Explizite Medienwechsel, Entzug einer Freigabe oder Entfernung aus der Party sind weiterhin eigene Lebenszyklusereignisse; Solo ist kein Schutz gegen diese Aktionen.
Bei unveränderter Quelle gilt: Hänger ausschließlich synchronisiert → Korrekturen/Clock/Revision priorisieren; auch in Solo → Segment/Decoder/Netz priorisieren. Das ist ein Diagnosevergleich, kein bereits durchgeführter Live-Test.

### Prüfungen dieses Nachtrags
- 17 gezielte Integrationstests erfolgreich, einschließlich vier neuer P0-Fälle: zehn Minuten unveränderte Timeline mit neuen Revisionen; Solo/Rückkehr ohne HLS-Neuladung; getrennte 800-/700-ms-Warteepisoden und rohe Seek-/Rate-Ereignisse; kein zweiter automatischer Seek innerhalb einer Sekunde, expliziter Host-Seek weiterhin sofort.
- 7 Sync-Policy-Tests erfolgreich, einschließlich Tempo-Hysterese, Puffer-Hysterese und Seek-Lead.
- Syntaxprüfung und git diff --check erfolgreich.
- Der neue Cooldown-Test musste zunächst die bereits bestehende Initialabgleich-Sperre von vier Sekunden berücksichtigen; nur der simulierte Testzeitpunkt wurde korrigiert.
- Native/Kotlin-Quellen unverändert. Die zuvor dokumentierten 85 Desktop-Tests bleiben der letzte Prüfstand; **nicht erneut ausgeführt**. Ihre deterministischen Modelle belegen die lokalen Gates, keine reale TV-/mpv-/ExoPlayer-Wiedergabe.
- Vorheriger Koordinator-Fix bleibt als separat getestete Entprellung kurzer Statuswechsel erhalten, nicht als bewiesener P0-Fix. Native Revisions-/Cooldown-Korrekturen bleiben erhalten. Keine weiteren spekulativen Änderungen.

### Noch fehlender entscheidender Nachweis
Eine zeitgleiche Host-/Browser-Aufzeichnung über zwei Doppelhänger, synchronisiert und bei gleicher Quelle in Solo: Revision, pause/waiting, seek-Grund/rohes Media-Seek, Rate, Drift, Clock-Offset, BufferAhead und Segmentzeit mit Hängerzeitpunkten vergleichen. Browser bereits veröffentlicht: sessionStorage.setItem('nuvio-party-debug', '1'), neu laden; nur bereinigte playbackEvents verwenden, keinen HAR mit URLs/Tokens. Die neuen Diagnosefelder sind **nur lokal**, noch nicht in Family-Beta. Installierte MSI 1.2.42 enthält die neue native Diagnose ebenfalls noch nicht.
Auf der offiziellen TV-App ist diese lokale Diagnose nicht verfügbar; Versionsnummer/Player-Engine und vorhandene Geräteereignisse wären nötig. Ein separater TV-Fix ist nur erforderlich, wenn ihr eigener Korrekturpfad als Ursache bestätigt wird; ein Host-Fix kann überflüssige Revisionen reduzieren, aber keine TV-Decoder-/Sync-Implementierung reparieren.

Geändert in diesem Nachtrag: browser-site/src/main.js, browser-site/tests/personal-hls-integration.test.js, dieser Bericht. Alle vorherigen Änderungen erhalten. Keine MSI, Installation, Veröffentlichung, Commits, Pushes oder Änderungen an Family-Beta/Production/Token-Sharing.

