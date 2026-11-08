# Realtime und Host-Refresh: gezielte P0-Korrektur

## Ausgangsstand und Grenzen

Branch `restore/watchparty-0.1.49`, HEAD bei Arbeitsbeginn `3a10b2e9`.
Der bereits gestagte Revert stellt `7423b45d` wieder her und bleibt unverändert
im Index. Die hier beschriebenen Korrekturen liegen zusätzlich im Arbeitsbaum.
Keine weiteren Reverts, Tests, Builds oder Backend-Aufrufe wurden ausgeführt.

## Durch Code belegte Befunde

- `main.js` setzt `connectionLost` anhand der Subscribe-Callbacks. Ein
  `member_joined` oder `state_request` setzt diesen Zustand nicht. Ein dritter
  Gast löst Status-/Quellenantworten aus, aber keinen absichtlichen Kanalwechsel.
  CHANNEL_ERROR/CLOSED sind Kanalzustände, kein Beweis für einen geschlossenen
  WebSocket. Der Socket kann weiter offen sein, während der Server einen Kanal
  ablehnt. Ohne Live-Ereignisse ist die Ursache des Flackerns weiterhin offen.
- `session.js/reconnect()` plante nach einem Fehler einen Retry, obwohl
  `this.reconnecting` noch gesetzt war. `scheduleReconnect()` unterdrückte ihn.
  Die Sperre wird jetzt vor dem Retry freigegeben. Ein abgelaufenes Login wird
  weiterhin als solches gemeldet und nicht endlos erneut versucht. Alte
  Kanal-Callbacks bleiben über Generation/Kanal-Identität ausgeschlossen.
- `refresh()` verwendet eine Sperre pro Raum. War der Heartbeat eines entfernten
  Kanals noch aktiv, übersprang SUBSCRIBED des neuen Kanals seine Rollenprüfung.
  `hostOfferDeferred` konnte bis zum nächsten 45-Sekunden-Heartbeat gesetzt bleiben.
  Alte Kanalantworten/-fehler werden jetzt verworfen; nach Freigabe dieser Sperre
  erhält der bereits abonnierte Ersatzkanal sofort seine eigene Prüfung.
  Keine Subscription-Epochen und keine Refresh-Warteschlangen wurden eingeführt.
- Die Recovery verlangt alle übrigen Mitglieder aus dem serverseitigen Snapshot,
  gleiche Revision und gleiche bestätigte Quelle innerhalb von 3500 ms.
  Ein Offline-Mitglied oder eine verlorene Antwort verhindert sie. Eine verlorene
  `stream_commit`-Nachricht kann einen Gast mit spielendem Video, aber ohne
  bestätigte Recovery-Kopie zurücklassen. Sichtbare Wiedergabe beweist keinen Commit.
- Die Anfrage wird einmal nach 1750 ms mit derselben Request-ID wiederholt.
  Duplikate zählen nicht als weiteres Mitglied. Die Frist bleibt 3500 ms;
  ein Teilquorum wird niemals angenommen. Timer werden bei Abschluss, Abbruch
  und Kanalwechsel entfernt. Nach tatsächlichem Kanalverlust bleibt der
  Recovery-Auftrag für die erneute Rollenprüfung erhalten, alte Antworten nicht.
- Ein Replay mit gleicher Revision bestätigte bisher auch abweichenden Inhalt.
  Jetzt bestätigt nur identischer Inhalt. Ein erkannter Konflikt bleibt für diese
  Revision gesperrt, auch wenn später ein Commit eintrifft. Eine neue Revision
  kann wieder regulär verarbeitet werden. Identische Replays laden den Player
  weiterhin nicht neu.

## Accounts, Tabs und Tokens

`nuvio-party-device` bleibt in sessionStorage, damit ein Refresh dieselbe
Mitgliedschaft wieder betreten kann. Ein duplizierter Tab kann diese Kennung
kopieren. Unterschiedliche Browserprofile besitzen getrennte Speicher; das
gleiche Nuvio-Konto allein beweist keine identische Gerätekennung.
Ob gleiche Account-/Device-Kombinationen serverseitig eine Mitgliedschaft oder
Verbindung verdrängen, ist ohne Backenddefinition/Live-Diagnose nicht belegt.
Die Kennungsvergabe wird deshalb hier nicht spekulativ geändert.

Der lokal installierte SupabaseClient aktualisiert Realtime-Tokens bei
TOKEN_REFRESHED/SIGNED_IN/INITIAL_SESSION selbst (`_handleTokenChanged`).
Der App-Callback behandelt SIGNED_OUT. Es wird kein zweiter Token-Refresh-Loop
hinzugefügt. Realtime-Limits, Gateway-Abweisungen und Auth-Konfiguration wurden
nicht live geprüft. Niemals JWTs, WebSocket-URLs oder HAR-Dateien ungefiltert teilen.

## Sichere Recovery-Grenze

Bei `timeout`, `unconfirmed` oder `conflict` muss der Host den Link ausdrücklich
erneut freigeben. Offline-Mitglieder werden nicht anhand unzuverlässiger Presence
aus der erforderlichen Bestätigung entfernt. Unterschiedliche Revisionen werden
nicht einfach auf die höchste reduziert. Ein neuer Host-Link kann einen fehlenden
Commit reparieren; Gäste erfinden keine Commit-Bestätigung.

Die private Beta vertraut weiterhin Mitgliedsangaben in Realtime-Nachrichten.
Das bekannte Absenderrisiko ist nicht behoben. Selbst einstimmige Gastkopien sind
kein dauerhaftes Backend-Protokoll: Haben alle Gäste einen Widerruf verpasst,
können ihre Kopien veraltet sein. Eine garantierte aktuelle Quellenrevision nach
Host-Reload lässt sich ohne autoritativ gespeicherte Revision nicht beweisen.
Diese Änderung behauptet keine solche Garantie und speichert keine Medien-URLs.

## Manueller Test und Diagnose

PowerShell im Repository:

```powershell
Set-Location 'C:\Users\Alanp\Desktop\Chatgpt\Codex\Nuvio-Watch\NuvioDesktop'
node --test browser-site/tests/session.test.js browser-site/tests/personal-hls-integration.test.js
npm.cmd --prefix browser-site test
```

Die ergänzten Tests verwenden synthetische Quellen und gesteuerte Timer. Sie
decken getrennte Browserclients mit gleichen/verschiedenen Accounts, gleiche
Device-Werte, dritten Beitritt, isolierten Gast-Reconnect, Wiederholungen nach
Kanalfehlern, alte Heartbeats, verlorene Antworten, Offline-Mitglieder, fehlenden
Commit, widersprüchliche Replays und den Erhalt einer geladenen HLS-Instanz ab.
Die Account-/Device-Tests prüfen Clientverhalten unter gemocktem Backend, nicht
die reale Autorisierung oder Mehrfachsitzungsregel des Nuvio-Servers.

Für den Live-Test die bestehende Schaltfläche zur lokalen Sync-Diagnose benutzen
oder in jedem Test-Tab lokal aktivieren, dann neu laden:

```javascript
sessionStorage.setItem('nuvio-party-debug', '1')
```

1. A/B spielen synchron. C tritt in einem separaten Browserprofil bei.
   A/B dürfen nicht pausieren oder die HLS-Instanz neu laden.
2. Nur C reconnecten; danach Host A refreshen, während B/C verbunden bleiben.
3. Wiederholen mit einem offline geschalteten Gast: klare Timeout-Meldung statt
   unbestätigter Übernahme. Danach bewusste erneute Freigabe.
4. Separat gleiche Accounts und duplizierte Tabs prüfen. Nur lokal vergleichen,
   ob `sessionStorage.getItem('nuvio-party-device')` identisch ist. Im Bericht
   ausschließlich „gleich/verschieden“ nennen, keine IDs oder Accountdaten.
5. Zu gleichen Zeitpunkten in A/B/C erfassen: `realtimeLog`, `socketConnected`,
   `registeredChannels`, `joinedChannels`, `realtimeReconnects`, `rolePending`,
   `lastHeartbeatAt`, `recoveryExpected`, `recoveryReplies`, `recoveryResult`,
   `syncActive`, `lastAcceptedAt`, `lastEventSource`, `playbackSeq`.

Normal: ein registrierter/abonnierter Kanal pro Client. Die Anzahl ist
SDK-lokal, keine globale Serverzählung. `socketConnected=true` bei CHANNEL_ERROR
deutet auf ein Kanalproblem, beweist aber keine bestimmte Backend-Ursache.
Ein CLOSED ohne Fehlergrund kann vom SDK keine detaillierte Ursache liefern.
Bei wiederkehrenden echten Abbrüchen benötigt die nächste Untersuchung die
obigen Daten und gegebenenfalls bereinigte serverseitige Ablehnungsgründe.

Kein Live-Erfolg, kein erfolgreiches Testresultat und keine Behebung eines
serverseitigen Limits werden aus dieser statischen Untersuchung abgeleitet.

## Follow-up: abwechselnde Kanalabbrüche, Gaststeuerung, abruptes Verlassen

Der Nutzer meldet SUBSCRIBED, 32 Reconnects, einen registrierten/abonnierten
Kanal, offenen Socket, aber `rolePending=true` und Recovery `idle` mit 0/0
Antworten. Das belegt wiederkehrende Kanal-Lifecycle-Ereignisse. Es beweist
weder einen Socket-Abbruch noch ein bestimmtes Account-/IP-Limit.
Die installierten SDKs entsprechen dem Lockfile und `7423b45d`:
Supabase/Realtime 2.118.0, Phoenix 0.4.5. Keine Dependency wurde geändert.

### A: Herkunft des ersten CLOSED ermitteln

Zusätzlich wird jeder lokale subscribe/removeChannel-Aufruf mit lokaler
fortlaufender Kanalnummer und Zeit erfasst (`lifecycle`). Alte Callback-Closings
werden als `stale` markiert; sie lösen keinen Reconnect der neuen Session aus.

Die optionale `realtime-trace.js` verwendet die öffentliche SDK-Logger-Option.
Sie übernimmt nur feste Kategorien aus dem Loggerformat der installierten SDKs:
`server_channel_close` (eingehendes phx_close), `client_channel_leave`
(ausgehendes phx_leave), `duplicate_topic`, `socket_close`, `socket_error`.
Nur bei Socket-Close wird zusätzlich ein numerischer Close-Code aufgenommen.
Keine rohen SDK-Strings, Topics, Payloads, Gründe, Kennungen oder URLs werden
gespeichert oder an die Konsole ausgegeben. Die Listen sind auf 20 Einträge begrenzt.
Keine globalen WebSocket-Patches, kein weiterer Socket und kein Server-logLevel.

**Aktivieren vor dem Neuladen** (pro Tab, nur localhost bzw. Test-Preview):

```javascript
sessionStorage.setItem('nuvio-party-debug', '1')
location.reload()
```

Danach im vorhandenen Diagnosebereich prüfen: `transportTraceEnabled=true`.
Der Diagnosebutton allein aktiviert den SDK-Logger nicht nachträglich; dann
ist ein Reload mit der obigen lokalen Einstellung notwendig. Ausschalten mit
`sessionStorage.removeItem('nuvio-party-debug')` und Reload.

Interpretation der **ersten** Ereignisse, bevor die automatische Erholung startet:

| Beobachtung | Belegt / als Nächstes prüfen |
| --- | --- |
| remove_start vor CLOSED / phx_leave | Eigener Client startet Entfernung; reason unterscheidet leave, cleanup, reconnect. |
| Eingehendes phx_close ohne vorausgehendes lokales leave/remove | Remote-seitige Kanalschließung; Gateway-/Realtime-Logs und Autorisierung prüfen. Kein Beweis für ein bestimmtes Limit. |
| duplicate_topic | SDK hat lokal ein bereits offenes Topic gefunden; Lifecycle-Nummern und weitere App-Clients prüfen. |
| socket_close vor Kanalfehler | Tatsächliches Transport-Close, Code erfassen. Code 1006 allein erklärt die Ursache nicht. |
| CLOSED bei offenem Socket ohne aussagekräftigen Trace | Keine gesicherte Ursache; SDK-Format oder fehlenden Start der Diagnose prüfen. |

Ein phx_close **nach** lokalem phx_leave ist kein Beweis, dass der Server den
ursprünglichen Ausfall verursacht hat. Das anschließende Entfernen eines bereits
geschlossenen Kanals ist erwartete Erholung und muss zeitlich getrennt werden.

Zuerst ohne Video: A/B im Warteraum, C beitreten lassen. Dann dieselbe Matrix
mit Video. Jeweils neue, nicht duplizierte Tabs in drei Profilen verwenden;
gleiche Accounts und drei verschiedene Accounts getrennt prüfen. Duplizierte
Tabs als eigenen Fall testen. Eine gemeinsame öffentliche IP bleibt bei diesem
lokalen Test bestehen. Ob ein Gateway IP-, Account-, Session- oder Device-Limits
erzwingt, können gemockte Tests nicht beweisen. Für Backend-Untersuchung benötigt
der Betreiber zeitlich passende Close-/Join-/Auth-Ablehnungsgründe, Membership-
Schlüssel/Uniqueness-Regeln und die geltenden Verbindungslimits. Keine rohe ID,
JWTs, HAR-Dateien oder WebSocket-Frames in den Bericht übernehmen.

### B: Recovery wartet womöglich noch vor ihrer Anfrage

`recoveryExpected=0`, `recoveryReplies=0`, `recoveryResult=idle` ist kein Nachweis
einer fehlenden Medienquelle: Die Anfrage kann noch gar nicht begonnen haben.
Neue Diagnosefelder: `isHost`, `recoveryArmed`, `heartbeatStartedAt`,
`heartbeatResult` (idle/pending/ok/stale/failed), `heartbeatFailure` sowie
`waitingForHostState`. `rolePending` bleibt eine echte Sperre für neue Freigaben.
Der reguläre Rejoin-Arming-Pfad und die einstimmige Quellenprüfung bleiben erhalten.

Bei `recoveryArmed=true` und `rolePending=true` zuerst den Heartbeat bzw. den
fortlaufenden Kanalwechsel untersuchen. Bei `isHost=false` ist der Browser laut
aktuellem Snapshot Gast; genau dann zeigt der Room „Warte auf Video vom Host“.
Nicht aus einer früheren Hostrolle künstlich Hostrechte wiederherstellen.
Falls der Server die Rolle während Reload bereits weitergegeben hat, braucht
es ein Angebot des serverbestätigten neuen Hosts. Keine Quelle aus einem anderen
Host-/Medienkontext erzwingen. Die bekannte Freigabeoption für den bestätigten
Host und die konkreten Recovery-Fehlermeldungen bleiben verfügbar.

### C: Keine unbeabsichtigte lokale Wiedergabe während Rollenprüfung

Nachweisbarer Codepfad: `hostOfferDeferred`/`waitingForHostState` sperrt
`canControl()`. Bisher konnte die eigene Play-Schaltfläche trotzdem `play()`
auslösen; der anschließende Play-Handler fand keinen erlaubten Party-Befehl und
setzte `syncEnabled=false`. Gleiches Risiko bestand bei Seek/Pause.

Die vorhandene Eingabesperre greift jetzt auch bei ausstehender Steuerfreigabe,
bevor die eigenen Controls den Player verändern. Ein Hinweis erklärt die
ausstehende Bestätigung. Bei spät eintreffenden nativen Gesten bleibt Sync aktiv
und der bestehende Sync-Pfad übernimmt wieder den Party-Zustand. Host-only
bleibt gesperrt, bewusstes Solo bleibt lokal bedienbar. Nach Backend-Bestätigung
nutzen Play/Pause/Seek unverändert den bestehenden Command-/RPC-Pfad. Der neue
Host kann `host_only` weiterhin über den vorhandenen autorisierten Schalter
ändern; kein Client überschreibt einen serverseitigen Wert.

### D: Austritt und verwaiste Mitglieder

Beim regulären Verlassen beginnen Kanalbereinigung und `watch_party_leave`
jetzt parallel. Ein langsames unsubscribe hält den autorisierten Austritt
nicht auf. Der gemeinsame Close-Promise wartet weiterhin auf beide Vorgänge,
bevor dieselbe Session eine neue Mitgliedschaft öffnen kann.

Presence-leave ist nur ein Hinweis. Mehrere Hinweise werden für 1500 ms
zusammengefasst; bleibt noch Presence für dasselbe Mitglied, passiert nichts.
Bei weiterhin verbundenem Kanal wird ein Heartbeat angefordert. Das ändert
von sich aus weder Hostrolle noch Quelle oder Playback. Der normale
45-Sekunden-Heartbeat bleibt Fallback. Achtung beim Live-Test: Der neue Presence-
Listener aktiviert im SDK auch Presence-Empfang; dessen Berechtigung muss der
private Kanal erlauben. Eine Ablehnung wird nicht umgangen.

Kein Beacon/unload-Austritt wurde hinzugefügt: Ein Reload darf nicht als
ausdrückliches Verlassen behandelt werden. Crash, Internetverlust und ein
eingefrorener Browser können weder eine API-Anfrage noch sofortiges Presence-leave
garantieren. Timeout und Nachfolgewahl sind Backend-Aufgaben. Die genaue TTL,
Auswahlregel und eventuelle Verzögerung sind aus den vorhandenen RPC-Aufrufen
nicht belegbar. Wenn Heartbeats nach abgelaufener Mitgliedschaft keinen Nachfolger
liefern, muss der Betreiber Expiry-/Heartbeat-/Host-Nachfolge-Logik prüfen;
es wurde keine Migration ausgeführt.

### Ergänzte Tests und manuelle Befehle

Zusätzlich: SDK-Close-Kategorien und Secret-Filter, CLOSED bei offenem Socket,
lokale/stale Entfernung, Recovery vor Rollenbestätigung, Host-/Gast-Presence-
Verlust ohne lokale Wahl, regulärer Austritt bei hängender Kanalbereinigung,
Gast-Play/Pause/Seek nach Hostwechsel und erneuter Rollenbestätigung,
Host-only und explizites Solo. Zwei alte Verträge für native manuelle Gesten
wurden an die bestehende Host-only-Sperre bzw. explizit lokalen Modus angepasst.

```powershell
Set-Location 'C:\Users\Alanp\Desktop\Chatgpt\Codex\Nuvio-Watch\NuvioDesktop'
node --test browser-site/tests/realtime-trace.test.js browser-site/tests/session.test.js browser-site/tests/personal-hls-integration.test.js
npm.cmd --prefix browser-site test
```

Keine Tests, Builds, automatischen Analyseprogramme oder Live-Anfragen durch
Codex ausgeführt. Das Realtime-Tennisball-Problem ist bis zum neuen Live-Trace
ausdrücklich **nicht als behoben bestätigt**.

## Follow-up vom 7. November: Presence und serverseitige Kanalschließung

Der neue Live-Test mit drei verschiedenen Konten zeigt in zwei Browsern
wiederholt `server_channel_close` vor `client_channel_leave`, bei offenem
Socket und erfolgreichem Backend-Heartbeat. Der nachfolgende lokale Leave
ist Teil der Wiederverbindung. Der genaue Grund für das eingehende Close
ist aus diesen Daten weiterhin nicht bestimmbar.

Der bisherige Code konnte pro Subscription, pro fremdem `state_request`,
pro geändertem Playerstatus und pro relevantem Medien-/Hostwechsel jeweils
`track()` aufrufen. Join und Rejoin starteten jeweils eine Subscription.
Reine Positionsberichte und unveränderte Heartbeats verwendeten keinen
Track. Schon ein Track zur Subscription, vier fremde Zustandsanfragen und
eine Playerstatusänderung ergeben sechs Tracks ohne garantierten Abstand.
Das überschreitet die dokumentierte Grenze von fünf Presence-Aufrufen pro
Client in 30 Sekunden. Siehe [Realtime Limits](https://supabase.com/docs/guides/realtime/limits).

Zustandsanfragen erhalten weiter den aktuellen Status und ggf. das bestehende
Hostangebot. Buffering, Behind, Ready, Position und Host-Fähigkeiten werden
weiter per Status-Broadcast übermittelt. Presence erhält einen initialen
Track bei freiem Zeitfenster und zusammengefasste Folgeupdates. Eine
monotone Uhr erzwingt 6250 ms Abstand zwischen Track-Versuchen pro Browser-
Session, auch über Reconnect und Wechsel der Party hinweg. Es gibt höchstens
einen Timer für den jeweils neuesten Status. Positions- und reine
Driftänderungen lösen keinen eigenen Presence-Track mehr aus.

Ein Fehler der System-Erweiterung wird pro Kanal direkt ausgewertet. Die
optionale SDK-Diagnose kategorisiert auch Fehler in `phx_error` und
`phx_reply`. Presence-Antworten ohne konkrete Ursache erscheinen nur als
`presenceResult=error` oder `timeout`. Die Diagnose speichert ausschließlich
Kategorien und Zeitpunkte. Bei dokumentierten Rate-Limit-Fehlern wartet
die App mindestens 31 Sekunden (Client-Presence oder Join-Limit) bzw.
61 Sekunden (projektweite Presence- oder Ereignislimits). Auch manuelles
Synchronisieren überspringt diese Frist nicht. Quellen-Recovery und
Playback-Sync verwenden ihre bisherigen Pfade. Die Gaststeuerung bleibt
bis zum erfolgreichen Rollen-Heartbeat gesperrt und hängt danach weiter
vom bestätigten `host_only` und Hostzustand ab.

Nach erfolgreichem lokalen Test erneut mit drei Browserprofilen prüfen.
Pro Profil zuerst das lokale Debug-Flag setzen und neu laden, wie oben
beschrieben. Danach Beitritt, Wiedergabe, Host-Refresh und einen Hostwechsel
prüfen. Bei einem Close die ersten passenden Ereignisse aus
`transportTrace` und `lifecycle` mit Uhrzeit und Zeitzone erfassen.
Dazu `realtimeServerError`, `presenceTracks`, `lastPresenceTrackAt`,
`presenceResult`, `realtimeReconnectCooldownMs`, `rolePending`,
`heartbeatResult` und `controlBlockedReason` notieren. Ein eingehendes
`system` mit `client_presence_limit` unmittelbar vor `server_channel_close`
bestätigt den konkreten Client-Presence-Grenzfall. Bei bloßem Close oder
`other` sind die zeitgleichen Realtime-/Gateway-Logs des Betreibers nötig.
Dort nach dem kanalbezogenen Systemfehler und den effektiven Client- und
Projektgrenzen suchen. Siehe [Realtime Protocol](https://supabase.com/docs/guides/realtime/protocol)
und [Realtime Settings](https://supabase.com/docs/guides/realtime/settings).
