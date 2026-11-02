# Eigene HLS-URL (Beta): MVP und manuelle Prüfung

Aktuelle Realtime-Diagnose und manuelle Prüfschritte: [REALTIME_SYNC_DIAGNOSIS.md](REALTIME_SYNC_DIAGNOSIS.md). Der Nutzer hat inzwischen echte TorBox-Wiedergabe mit Bild und Ton gemeldet; die Synchronisierung dieser Nachbesserung wurde hier nicht ausgeführt oder bestätigt.

## Nachbesserung der drei gemeldeten Testfehler

Nutzerbefund vor dieser Korrektur: 46 Tests, 43 bestanden, drei fehlgeschlagen. Die folgende Änderung wurde ausschließlich lesend geprüft; es wurde kein Test oder Build ausgeführt. Die ursprünglichen Erwartungen bleiben erhalten. Ein vollständig erfolgreicher Testlauf ist noch nicht bestätigt.

1. **AbortError, erwartete zwei Play-Aufrufe:** Der VM-Testkontext und die Player-Doubles verwenden unterschiedliche Promise-Konstruktoren. `Promise.resolve(player.play())` im VM-Kontext assimiliert das Promise des Doubles asynchron. Ein einzelnes `await Promise.resolve()` im Test erreicht die anschließende Fehlerbehandlung noch nicht zuverlässig. Der nächste Host-Play wurde deshalb geprüft, während der vorherige Start im Test noch als offen galt. Der Test wartet jetzt mit `setImmediate` aus `node:timers/promises` einen vollständigen Ereignisschleifen-Durchlauf ab. Der Play-Double setzt außerdem wie ein Browser beim Start `paused=false`, damit der Host-Pause-Zweig tatsächlich geprüft wird. Zusätzlich verwirft die Implementierung einen überholten Start bereits bei einer Host-Pause; ein neuer Host-Start muss nicht erst auf dessen Ablehnung warten. Ein AbortError des weiterhin aktuellen Starts lässt die Synchronisierung aktiv und gibt den nächsten Versuch frei.
2. **NotAllowedError / NotSupportedError, Synchronisierung unerwartet aktiv:** Dieselbe unvollständige Promise-Verarbeitung führte zur Prüfung vor dem Fehlerzweig. Nach vollständiger Verarbeitung muss `syncEnabled=false` bleiben: Bei `NotAllowedError` ist die Quelle noch geladen und die Schaltfläche für einen ausdrücklichen erneuten Start verfügbar; bei `NotSupportedError` wird die Quelle gestoppt und die Schaltfläche gesperrt. Diese Erwartungen wurden nicht abgeschwächt. Zusätzlich kontrollieren Erfolgs- und Fehler-Callbacks die Identität des aktuellen Startversuchs, bevor sie Zustand ändern. Eine Pause, ein Reset oder ein ausdrücklicher erneuter Klick macht frühere Versuche ungültig. Die Regressionstests prüfen auch verspätete Erfüllung und Ablehnung bei derselben Quelle.
3. **Party-Ende, doppeltes closed:** `join()` ruft vor dem Beitritt `close()` auf. Bisher wurde selbst für eine vollständig leere Sitzung `closed` ausgelöst; beim echten Party-Ende folgte ein zweites `closed`. Das war ein Lifecycle-Fehler der Implementierung. `close()` meldet jetzt nur beim Übergang einer bestehenden Raum-/Kanalverbindung nach geschlossen ein Ereignis. Raum, Kanal, Playback und Timer werden weiterhin synchron ungültig, bevor asynchron aufgeräumt wird. Parallele Close-Aufrufe erhalten dasselbe Cleanup-Promise und entfernen Kanal/Mitgliedschaft nur einmal. Auch ein leerer Close erhöht weiterhin die Generation, damit ein wartender Join abgebrochen werden kann. `finish()` meldet `ended` nur für eine noch aktuelle Generation; doppelte Finish-Aufrufe und veraltete Meldungen nach einem neuen Join sind abgesichert.

Die Änderungen betreffen nur Play-Promise-Verarbeitung, Close-/Ended-Lifecycle, zugehörige Tests und diese Dokumentation. Die HLS-Quelle, Synchronisierungszeitberechnung, Backend-Sicherheitsregeln und URL-Verarbeitung bleiben erhalten. Tests verwenden ausschließlich synthetische Adressen.

Zusätzliche Regressionen: aktueller AbortError mit Wiederanlauf; Host-Pause/Play vor Auflösung des alten Starts; veraltete Erfüllung/Fehler nach ausdrücklichem Neustart; leere und wiederholte Close-Aufrufe; paralleles Cleanup; parallele Finish-Aufrufe; Join während altem Cleanup; Abbruch eines noch auf Anmeldung wartenden Joins.

**Manuell auszuführende Befehle (hier nicht ausgeführt):**

```powershell
Set-Location 'C:\Users\Alanp\Desktop\Chatgpt\Codex\Nuvio-Watch\NuvioDesktop\browser-site'
node --test tests/personal-hls-integration.test.js tests/session.test.js
npm test
```

Danach wie unten beschrieben die echte TorBox-Wiedergabe prüfen. Keine Freigabe oder Veröffentlichung wurde ausgelöst.

Stand: Implementierung auf `feature/torbox-hls-mvp`, Basis Fork-`Dev` / `28f593dd`. **Durch den Agenten wurden keine Tests, Builds, Deployments, Merges oder Releases ausgeführt.** Der Nutzer meldet Bild und Ton im echten TorBox-Test; eine erfolgreiche Realtime-Synchronisierung ist noch nicht bestätigt.

Die angegebene Website ist `https://nuvio-watch-friends.pages.dev`. Ihre veröffentlichte Version wurde hier nicht geändert. Die folgenden Schritte gelten erst für einen separat bereitgestellten Stand mit dieser Änderung; es wurde weder ein lokaler Testserver noch ein anderer Player gestartet.

## Verwendung

1. Der Host öffnet den gewünschten Film ganz normal in Nuvio Desktop und startet eine Party. Für die persönliche HLS-Quelle ist „Share my stream“ nicht erforderlich.
2. Der Gast meldet sich mit seinem eigenen bestehenden Konto an und tritt dieser Party bei. Unter dem Video **Eigene HLS-URL (Beta)** ausklappen.
3. Eine eigene zulässige HTTPS-HLS-Playlist für **dieselbe vollständige Filmfassung** eintragen und **Eigene HLS-Quelle laden** anklicken. Die Adresse muss nicht auf `.m3u8` enden. Keine echte URL in Chat, Screenshots, Testdateien oder Fehlermeldungen übernehmen.
4. Die Oberfläche prüft die von hls.js geladene **Media-Playlist**, nicht nur den HTTP-Status oder eine Master-Playlist. Eine endgültige VOD-Playlist (`ENDLIST`, endliche Dauer, Segmente) und endliche Videometadaten müssen vorliegen. Der aktuelle Party-Zeitpunkt muss im von `video.seekable` gemeldeten Bereich liegen.
5. Erst dann **Wiedergabe synchronisieren** anklicken. Der Gast verwendet dasselbe `applySync`, den Playback-State und die Serverzeit aus `PartySession`. Eine Meldung über Playlist/Metadaten ist noch kein Nachweis, dass Bild und Ton tatsächlich funktionieren.
6. Mit **Zur Desktop-Freigabe zurück** die persönliche Quelle ausdrücklich verlassen. Dabei wird sie gelöscht und eine aktuelle Host-Freigabe angefragt. Es wird nicht unbemerkt auf eine alte gespeicherte Desktop-Quelle zurückgeschaltet.

## Gezielte manuelle Fälle

| Fall | Erwartung, noch manuell zu prüfen |
| --- | --- |
| Vollständiges TorBox-VOD mit relativen `.ts`-Segmenten | hls.js lädt die relative Variante/Segmente gegen die jeweilige Playlist-Basis. Eigene Query-Tokens werden nicht künstlich an andere Adressen angehängt. HTTP 206 wird vom vorhandenen hls.js-Loader unterstützt. |
| Erste Wiedergabe | Tatsächliches Bild und Ton am Gast prüfen. Anschließend Host-Play, Pause und mehrere Sprünge nach vorn/hinten vergleichen. Auch lange Sprünge in noch ungepufferte Bereiche prüfen. |
| Abweichende Fassung/Dauer | Liegt die Party-Zeit außerhalb der Quelle, darf der Gast nicht fälschlich am Filmende „synchronisiert“ weiterlaufen. Fehlermeldung statt stiller Begrenzung. Gleiche Dauer beweist allerdings noch nicht dieselbe Fassung. |
| Noch kein Suchbereich / Lücken im Suchbereich | Vor dem Start bleibt die Schaltfläche gesperrt. Eine bereits aktivierte Synchronisierung wartet pausiert und versucht die aktuelle Host-Zeit erneut, sobald sie suchbar ist. Keine Zusage, dass alle noch nicht angeforderten Segmente erreichbar sind. |
| Native Seek-Ausnahme | Synchronisierung endet mit einer festen Fehlermeldung; kein URL-/Token-Text aus der Ausnahme wird angezeigt. |
| Host sendet MKV, andere MP4 oder beendet seine Streamfreigabe | Die persönliche Quelle wird weder ersetzt noch gestoppt. Auch ein Fehler der eigenen Quelle hebt diesen Schutz nicht auf. |
| Tatsächlicher Film-/Episodenwechsel | `PartySession` erkennt die neue Medienkennung im autoritativen Snapshot. Persönlicher Player, HLS-Instanz und URL-Eingabe werden zurückgesetzt; neue persönliche URL erforderlich. |
| Party verlassen/beendet, Mitglied entfernt, Logout | Der vorhandene Session-Close-/Mitgliedschaftspfad räumt die persönliche Quelle ebenfalls auf. Ein vorübergehender Kanalabbruch pausiert wie bisher und erfordert erneutes Synchronisieren. |
| Live oder laufende Event-Playlist ohne ENDLIST | Eigene Live-Meldung, Laden gestoppt, keine Synchronisierung mit der Desktop-Filmzeit. Kein automatischer Wechsel zur Live-Kante. Für den MVP eine abgeschlossene VOD-Playlist verwenden. |
| HTTP 401/403/404/410 für Manifest/Segment/Schlüssel | Feste Meldung über verweigerten/nicht mehr verfügbaren Zugriff, ggf. abgelaufenen Link. Neue eigene URL laden. Kein endloser Auth-Retry. |
| Codec-/Manifestfehler, CORS, Netzverlust | Verständliche feste Fehlertexte. CORS und abgelaufene Links sind ohne lesbaren Status nicht immer unterscheidbar; keine erfundene genaue Ursache anzeigen. |
| Nicht angemeldet / kein aktives Mitglied | Eigene Quelle kann über den Handler nicht geladen werden. Normale Auth-/private Kanalregeln bleiben erhalten. |

## Datenschutz und Grenzen

- Die URL wird ausschließlich an den vom Gast gewählten Medienanbieter bzw. die von seiner Playlist referenzierten Medienziele übergeben. Sie steht nicht im Party-Playback-State, Presence, Chat, RPC, Invite oder Supabase-Storage.
- Nur die HLS-Instanz hält die laufende Adresse im Arbeitsspeicher. Die Eingabe wird geleert; keine persönliche URL in localStorage, sessionStorage, Seiten-URL oder Analytics. Bei Reset wird die Instanz zerstört. Bestehende Login-/Geräte-Speicherung bleibt unverändert.
- hls.js läuft mit `debug: false`; rohe Fehlerobjekte, URLs, Header und Provider-Antworten werden weder geloggt noch in Meldungen eingebaut. Die Browser-Netzwerkansicht und Server des Medienanbieters sehen zwangsläufig die angeforderten URLs. Deshalb keine HAR-/Netzwerkprotokolle oder URL-haltigen Screenshots weitergeben. Diese Browserfunktion lässt sich durch die Anwendung nicht als „unsichtbar“ garantieren.
- Kein Proxy, FFmpeg, VLC, zusätzlicher Streamingserver oder eigene Remux-Bridge. Der Modus nutzt den vorhandenen HTML-Player und hls.js mit Media Source Extensions. Ein Browser ohne hls.js-/MSE-Unterstützung bekommt eine Fehlermeldung; ein unprüfbarer nativer HLS-Fallback wird für diesen Beta-Modus nicht angenommen.
- Eigene Quellen benötigen HTTPS und passende CORS-/Codec-Unterstützung auch für Unter-Playlists, Segmente und Schlüssel. Keine eigenen Auth-/Referer-/User-Agent-Header oder Cross-Origin-Cookies werden gesetzt. Jeder Zuschauer benötigt seinen eigenen zulässigen Zugang.
- Die vorab vom Nutzer gemeldeten HTTP-200-/206-, MPEG-TS- und CORS-Befunde wurden nicht erneut abgefragt. Sie beweisen weder decodierbare Codecs noch VOD/Seek oder echte Wiedergabe.

## Geschriebene, nicht ausgeführte Tests

- `tests/personal-hls.test.js`: URL-Prüfung, VOD/Live, endliche Metadaten und Suchbereiche, feste Fehlermeldungen, Transport-Konfiguration, Cleanup und veraltete HLS-Callbacks.
- `tests/personal-hls-integration.test.js`: tatsächliche Event-Verdrahtung aus `main.js` mit lokalen Doubles; Schutz vor Desktop-Ereignissen, Host-Play/Pause/Seek, Zurücksetzen, Mitgliedschafts-Gate und Fehlerfälle ohne Token-Weitergabe.
- Erweiterter `checks/browser-smoke.mjs`: Entwurf für eine echte hls.js-Anfrage eines relativen Segments an eine synthetische 410-Testantwort, URL-Privatsphäre und Schutz vor Desktop-Überschreiben. Das ist ausdrücklich kein TorBox-Wiedergabetest.

Vor einer späteren Freigabe diese Tests sowie die obigen manuellen Fälle prüfen. In diesem Auftrag ist das bewusst nicht geschehen.

## Hardening M1–M3 / L1–L5

- `AbortError` eines unterbrochenen Wiedergabestarts lässt die Synchronisierung aktiv. Der nächste Durchlauf verwendet den neuesten Host-Zustand. Ein noch offener Play-Aufruf wird nicht wiederholt. `NotAllowedError` verlangt einen erneuten Klick; `NotSupportedError` stoppt die Quelle mit einem Format-/Codec-Hinweis. Andere Ausnahmen erhalten einen festen Text ohne Originalmeldung.
- Native `seeking`, ein erwarteter eigener Seek und Buffering verhindern weitere Seek-Aufträge. `seeked` gibt den nächsten Abgleich frei. Falls dieses Ereignis ausbleibt, darf nach fünf Sekunden erneut korrigiert werden, sobald weder natives Seeking noch Buffering läuft. Es wird immer der neueste Host-Zustand verwendet.
- hls.js-Meldungen `bufferSeekOverHole` und `bufferNudgeOnStall` markieren ausschließlich den tatsächlich eingestellten numerischen Zeitpunkt. Passende Seeking-Ereignisse deaktivieren die Synchronisierung nicht. Abweichende manuelle Sprünge deaktivieren sie auch innerhalb des bisherigen Pausen-Unterdrückungsfensters. Diese Erkennung ist bewusst kein pauschales Ignorieren aller Sprünge während Buffering.
- Leere/fehlende Filmkennungen werden vor dem Quellenwechsel abgewiesen. Rückgabefehler und Ausnahmen von `open()` sowie Fehler bei der Unterstützungserkennung räumen den Player mit festen Fehlermeldungen auf.
- VOD-/Metadatenmeldungen versprechen keine nachgewiesene Wiedergabe. Presence meldet erst nach einer Sekunde tatsächlichem Buffering/Warten auf Suchbarkeit `buffering`. Ein offener Start-/Seek-Auftrag allein blockiert die Party nicht. Beim Laden ohne gestartete Synchronisierung wird `browsing` gemeldet. Medien-/Party-Resettexte benennen den jeweiligen Anlass.
- Beim Host-Wechsel wird die Playback-Sequenz neu begonnen. Die persönliche Quelle bleibt bei unverändertem Film erhalten; nach Party-Ende kann ein verspätetes Play-Ergebnis sie nicht wieder aktivieren.

### Zusätzliche manuelle Freigabefälle

1. Während des Starts sofort am Host pausieren und erneut starten: `AbortError` darf die Synchronisierung nicht abschalten. Autoplay-Sperre separat prüfen und per Klick aufheben. Eine echte inkompatible Quelle muss einen Formatfehler zeigen.
2. Host mehrfach schnell springen lassen, auch in ungepufferte Bereiche. Im Gast darf kein endloses Zurücksetzen des Seek-Vorgangs entstehen; nach Ende des Ladens muss die neueste Host-Zeit erreicht werden. Den Fall eines ausbleibenden `seeked` mit dem Regressionstest prüfen.
3. An einer echten HLS-Pufferlücke/Discontinuity weiterlaufen lassen: interne Gap-/Nudge-Korrekturen müssen die Verbindung zum Party-Takt erhalten. Insbesondere als GAP markierte Segmente und Audio-/Videolücken prüfen: hls.js meldet nicht jeden internen Sprung zwingend über dieselben ErrorDetails. Der persönliche Player unterscheidet deshalb zusätzlich echte Maus-/Touch-/Tastatur-Bediengesten von automatischen Sprüngen. Native Zeitleiste und Tastatursteuerung in jedem Zielbrowser manuell prüfen.
4. Während und direkt nach Buffering manuell per nativer Zeitleiste und Tastatur spulen: Synchronisierung muss deaktiviert werden. Danach ausdrücklich neu synchronisieren.
5. Host wechseln, ohne den Film zu wechseln, auch mit neuer Sequenznummer 0. Danach echten Filmwechsel, Party-Ende, Entfernen des Mitglieds und Logout prüfen: Quelle muss passend erhalten bleiben bzw. vollständig entfernt werden.
6. Reale TorBox-Quelle mindestens mit Bild, Ton, Play/Pause, kurzen und langen Sprüngen sowie längerem Verlauf prüfen. Nur diese Prüfung kann die tatsächliche Wiedergabe bestätigen.

## L8: Redirects – statische Bewertung

Der bestehende hls.js-XHR-Loader folgt HTTP-Redirects im Browser automatisch. `xhrSetup` prüft die angeforderte Adresse einschließlich aufgelöster relativer Segmente, kann aber das Redirectziel nicht vor dessen Anforderung prüfen. `safeStreamUrl` ist außerdem eine URL-Prüfung, keine DNS-Prüfung. Eine Garantie, dass sämtliche Redirect-/DNS-Ziele öffentliche Hosts sind, besteht deshalb nicht.

Es gibt hier keinen Server-Proxy und damit keinen serverseitigen SSRF-Zugriff. Ein bösartiger oder kompromittierter Medienanbieter könnte jedoch Anfragen des Gast-Browsers auf andere HTTPS-Ziele lenken, einschließlich lokaler Netzziele, soweit der Browser dies zulässt. CORS verhindert nicht grundsätzlich das Absenden einer Anfrage. Mixed-Content-/Local-Network-Schutz ist browserabhängig und ersetzt keine Zielprüfung. `withCredentials=false` verhindert Cross-Origin-Cookies für den XHR, verhindert aber keine ausdrücklich in einer Redirect-URL enthaltenen Tokens. Der Anbieter kennt die ihm eingegebene persönliche URL ohnehin bereits; Query-Tokens werden vom Anwendungscode nicht an andere Ziele kopiert und gelangen nicht an Supabase oder die Party.

Für diesen MVP wurde der Loader nicht ausgetauscht und es wird keine Redirect-Sperre behauptet. Nur vertrauenswürdige eigene Medienanbieter verwenden. Normale CDN-Redirects sowie ein künstliches Redirectziel dürfen später ausschließlich mit tokenfreien lokalen Fixtures geprüft werden; es wurden hier keine echten privaten URLs abgefragt. Vollständiges Sperren von Redirects würde eine gesonderte Loader-Änderung und Kompatibilitätsprüfung erfordern.

## Manuelle Befehle (hier nicht ausgeführt)

In PowerShell ausführen, wenn die Tests ausdrücklich gewünscht sind; Node.js und vorhandene Projektabhängigkeiten werden vorausgesetzt:

```powershell
Set-Location 'C:\Users\Alanp\Desktop\Chatgpt\Codex\Nuvio-Watch\NuvioDesktop\browser-site'
node --test tests/personal-hls.test.js tests/personal-hls-integration.test.js tests/session.test.js
npm test
```

Optionaler synthetischer Browsertest, sofern Playwright und dessen Chromium bereits verfügbar sind (startet selbst einen lokalen Vite-Server):

```powershell
node checks/browser-smoke.mjs
```

Für die anschließende echte manuelle TorBox-Prüfung kann später `npm run dev` verwendet werden. Keine echte URL in Befehle oder Testdateien schreiben; nur in das Feld des angemeldeten Players eingeben. Keine dieser Anweisungen wurde im Hardening-Auftrag ausgeführt. Es wurde auch kein Build, Commit, Push, Deployment oder Merge ausgelöst. **Freigabestatus bleibt unbestätigt**, bis Regressionstests und reale Wiedergabe-/Recovery-Prüfung erfolgreich sind.
