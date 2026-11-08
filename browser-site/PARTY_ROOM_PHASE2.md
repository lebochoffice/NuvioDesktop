# Browser-Party-Room Phase 2: Videofreigabe durch den Browser-Host

## Phase 2.3: Wiedergabe beim Hostwechsel

### Quellenwiederherstellung nach Host-Reload

Beim Neuladen gehen `hostStream`, das letzte Angebot und die lokale Player-Quelle verloren. Der Rejoin liefert Mitgliedschaft und Playback, aber keine Quelle. Der normale `state_request` wird für Quellen nur vom Host beantwortet. Deshalb konnte der neu geladene Host die bestätigte Kopie im Speicher seiner Gäste bisher nicht zurückholen.

Mit aktivierter Familien-Beta fragt nur ein automatisch wieder beigetretener, serverbestätigter Host ohne lokale Quelle den privaten Party-Kanal ab. Anfrage und Antworten sind an Party-ID, Host-Mitglieds-ID, Medienkennung und eine einmalige Anfrage-ID gebunden. Alle übrigen Mitglieder des Snapshots müssen innerhalb des Antwortfensters dieselbe bestätigte Quellenrevision melden. Ein Widerruf, widersprüchliche Revisionen, fehlende Antworten, alte Clients oder ein zwischenzeitlicher Rollen- bzw. Medienwechsel verhindern die automatische Übernahme. Beim Verlust des Kanals wird der Versuch verworfen und nach bestätigtem Reconnect mit neuer Anfrage-ID wiederholt.

Die bisherige URL bleibt einschließlich TorBox-Query unverändert. Der Host lädt sie im vorhandenen Player, folgt dem aus der Party bekannten Playback-Stand und kündigt erst nach erfolgreichem Laden und aktivem Sync dieselbe Revision erneut an. Gäste, die diese Revision bereits kennen, laden ihren Player nicht erneut. Der Ablauf speichert keine Quelle und setzt den gemeinsamen Wiedergabestand nicht auf 0. Ein abgelaufener oder nicht abspielbarer Link verlangt eine neue Freigabe.

Ohne eine verbleibende bestätigte Kopie gibt es keine automatische Wiederherstellung. Das betrifft auch einen gleichzeitigen Reload aller Browser. Antworten sind Broadcasts im bestehenden privaten Kanal und für Kanalmitglieder technisch lesbar. Die Absenderidentität ist weiterhin nicht serverseitig gebunden. Ohne serverseitigen Quellenstand lässt sich ein Widerruf, den alle antwortenden Mitglieder verpasst haben, nicht nachweisen. Der Pfad bleibt standardmäßig deaktiviert.

Ob das offizielle NUVIO-Backend die Party beim regulären Austritt des Hosts fortführt, ist weiterhin nicht live bestätigt. `close()` entfernt den lokalen Kanal und ruft beim regulären Austritt `watch_party_leave` auf. Die Antwort des Austritts wird vom Browser nicht als Wahlentscheidung verwendet. Der verbleibende Client liest den maßgeblichen Stand über `watch_party_heartbeat`. Bei abruptem Tab- oder Netzabbruch kann der Server zunächst dieselbe Mitgliedschaft und Host-ID zurückgeben. Die Dauer und eine etwaige Nachfolgeregel sind nicht durch den Clientvertrag belegt.

- **Party und bestätigter Nachfolger:** Eine bereits geladene identische Browserquelle bleibt im Player. Nach dem Rollenwechsel wartet der Gast auf das Angebot und einen gültigen Playback-Stand des neuen Hosts, bevor er wieder synchronisiert. Verspätete Snapshots des alten Hosts und Realtime-Playback eines entfernten bisherigen Hosts werden verworfen. Ein Reconnect löst keine Wahl aus. Vor der erneuten Browser-Freigabe prüft der Host-Client die Rolle per Heartbeat.
- **Party besteht ohne bestätigten Nachfolger:** Der vorhandene Player kann bei erreichbarer Quelle lokal weiterlaufen. Es gibt keinen zweiten Sender für Playback. Die Absenderidentität bleibt bei Realtime wie bisher eine Client-Angabe.
- **Party serverseitig beendet:** Die Mitgliedschaft und gemeinsame Synchronisierung enden. Der bestehende lokale Weiterlauf bleibt für dafür geeignete Quellen verfügbar. Tokenisierte Quellen der neuen Familien-Beta werden beim Ende aus dem lokalen Player entfernt. Beim eigenen Austritt oder Kick wird die Quelle ebenfalls bereinigt.

Ohne serverbestätigte Nachfolge gibt es keine verlässliche Einigung darüber, welche Browser noch aktiv sind, wer zuerst beigetreten ist und wann der bisherige Host seine Autorität verliert. Deterministisches Sortieren lokaler Listen löst unterschiedliche Sichtweisen bei Netztrennung nicht. Für einen separaten Koordinator wären ein serverseitig bestätigtes Mandat und eine geordnete Revision zur Entwertung alter Sender nötig. Ein Desktop-Host bleibt der maßgebliche Sender, solange ihn der Server führt.

**Manueller Backend-Nachweis:** In einer privaten Party mit drei autorisierten Testkonten und öffentlichem Testmedium A regulär verlassen lassen. Bei B und C prüfen, ob der Heartbeat dieselbe Party-ID und einen gültigen neuen `host_member_id` liefert oder `party_ended` bzw. keinen Party-Snapshot meldet. Den Versuch getrennt für einen kurzen Verbindungsabbruch, Tab-Schließen und späteren Reconnect wiederholen. Nur IDs und Zustandskategorien festhalten. Keine Stream-URLs, Tokens oder Authentifizierungsdaten in den Testbericht übernehmen.

## Desktop-Anfragen für einen Filmwechsel

Ein Desktop-Gast mit einem anderen, geladenen Titel kann eine Filmwechsel-Anfrage über den vorhandenen privaten Party-Kanal an die aktuelle Host-ID senden. Sie enthält Titel, Medien-ID und bei Serien die konkrete Episodenidentität. Der Desktop-Host sieht die Anfrage und kann sie in seinem Menü ablehnen. Das Ablehnen entfernt die Anfrage lokal. Eine Zustell- oder Ablehnungsbestätigung an den Absender gibt es in diesem Stand nicht. Host-only betrifft Wiedergabesteuerung und sperrt diese Anfrage nicht. Das Realtime-Ereignis ist ein Hinweis, da die Absender-ID nicht serverseitig gebunden ist.

Die Annahme mit Übernahme der Gastquelle bleibt gesperrt. Der bestehende Desktop-Code kann als Host per `watch_party_update` Medium und Playback publizieren. `watch_party_leave` hat keinen Zielparameter für einen gewünschten Nachfolger. `watch_party_heartbeat` liest unter anderem die aktuelle `host_member_id`. Keiner dieser sichtbaren Clientverträge bestätigt einen vom bisherigen Host autorisierten Transfer an ein bestimmtes Mitglied.

Der kleinste erforderliche Backend-Vertrag wäre eine atomare, autorisierte Annahme mit bisherigem Host, anfragendem Mitglied und erwartetem Party- und Medienstand. Vor dem Wechsel muss der Zielclient seine neue Quelle bereit haben. Der Server müsste Mitgliedschaft, Zustimmung und veraltete Anfragen prüfen, Hostrolle, Medienidentität und Playback-Start gemeinsam aktualisieren und beiden Clients den neuen Stand für dieselbe Party zurückgeben. Quellenfreigabe erfolgt anschließend über die vorhandenen Wege durch den neuen, serverbestätigten Host. Party-Code und Chat bleiben an derselben Party-ID. Eine abgelehnte oder gescheiterte Annahme lässt den alten Stand bestehen.

### Alternative mit unverändertem Host

Der Desktop-Host kann aus einer noch gültigen Anfrage **Eigene Quelle wählen**. Das öffnet für genau den angefragten Film oder die Episode die normale NUVIO-Stream-Auswahl. Der Wechsel des lokalen Players publiziert weder einen neuen Party-Titel noch übernimmt er die Position des alten Films. Die eigentliche Umstellung ist ein separater, bestehender Host-Schritt. Wenn die lokale Quellenauswahl scheitert oder der Host sie abbricht, bleibt der Party-Titel bestehen.

`watch_party_update` kann Medium und Playback für die vorhandene Party speichern. Das ermöglicht den bestehenden Ablauf, bei dem A eine **eigene** Quelle für den neuen Titel öffnet und danach den Titel als Host umstellt. Die Filmwechsel-Anfrage liefert nur Medienidentität und Anzeigetitel. Sie liefert weder eine Quelle, die A öffnen kann, noch die Position von B. Der bestehende Desktop-Player baut sein Angebot aus der tatsächlich aktiven lokalen Quelle des Hosts. Die Stream-Auswahl bietet empfangene Freigaben nur Gästen an. Ein Mitglied kann mit dem vorhandenen Vertrag daher keine eigene NUVIO-Quelle als das Angebot des Hosts bereitstellen.

Selbst bei getrennt beschaffter Quelle ist der bestehende Host-Wechsel des Titels kein Ersatz für eine sichere Annahme: `publishMedia` ändert den lokalen Titel und verwirft das alte Angebot bereits vor Bestätigung von `watch_party_update`. Eine fehlgeschlagene Serveraktualisierung stellt den alten Stand nicht automatisch wieder her. Andere Filme führen auf Desktop zur Party- oder Stream-Auswahl. Automatisches Öffnen ist nur für bestimmte vorhandene Episodenpfade möglich. Browser leeren beim Medienwechsel ihren Player und brauchen ein neues browserkompatibles Host-Angebot.

Der kleinste Weg ohne Hosttransfer wäre deshalb ein bewusst eingeschränkter Ablauf mit einer von A unabhängig gefundenen, vorab geprüften Quelle. Nach Zustimmung und Prüfung des noch aktuellen Antrags müsste der Client den passenden Server-Snapshot für Medium und Startposition abwarten, bevor er den Wechsel als erfolgreich anzeigt. Für zuverlässiges Akzeptieren unter konkurrierenden Änderungen wäre eine serverseitige Bedingung auf den erwarteten bisherigen Host und Medienstand nötig. **Wenn exakt die Quelle von B übernommen werden soll**, braucht es zusätzlich einen autorisierten, auf Party und neue Medienrevision beschränkten Quellenzugang für A. Der muss vor dem Wechsel geprüft werden können und darf keine privaten Addon- oder Account-Zugangsdaten weitergeben. Die bestehende Freigabe durch A kann danach unverändert genutzt werden. Ohne diesen Quellenvertrag bleibt die Annahme für den geforderten Ablauf gesperrt.

`PartyStream.toStreamItem()` übernimmt die URL sowie Request- und Response-Header in die bestehenden Player-Hinweise. Das beweist, dass der Desktop solche Angebote darstellen und mit seiner normalen Stream-Auswahl öffnen kann. Es beweist keine Abspielbarkeit auf A: Tokens, IP-Bindung, Redirects und Header können sich auf den Quellclient beziehen. Der normale Pfad hat keine isolierte Vorbereitung mit einem bestätigten mpv-Ladeergebnis, bevor der aktuelle Player und der Party-Zustand gewechselt werden. Der private Kanal ist außerdem für Kanalmitglieder lesbar und bindet die behauptete Absender-ID nicht an den Sender. In diesem Stand werden deshalb weiterhin nur Mediendaten für die Anfrage übertragen. Es gibt keine temporäre Gast-URL und keine neue Speicherung.

## Phase 2.2: Serverbestätigte Nachfolge und Player-Ansicht

Browser-Erstellung und Beitritt zeigen direkt den Player. Party-Details und Freigabeformular befinden sich im Party-Reiter des rechten Menüs. Bei bestätigter Hostrolle öffnet sich das Menü, ohne den Player anzuhalten.

Nach einem serverbestätigten Hostwechsel kann ein Browser-Host mit aktivierter interner Freigabe einen im Speicher vorhandenen, zuvor vollständig angekündigten direkten Browser-Link und dessen letzten Playback-Stand übernehmen. Automatisch erneut verteilt werden Links ohne Query sowie zuvor ausdrücklich für diese Party freigegebene TorBox-HLS-Links der Familien-Beta. Alte Desktop-Angebote, private Eingaben, HLS-Worker-Grants und sonstige signierte Links werden dafür nicht übernommen. Wenn keine geeignete Quelle vorliegt, fordert der Browser den neuen Host zum Freigeben auf. Bereits geladene identische Quellen müssen nicht neu geladen werden. Andere Quellen und abgelaufene Links brauchen eine neue Freigabe.

Die Nachfolge wird weiterhin ausschließlich vom Backend bestimmt. Die Clientverträge für `watch_party_leave` und `watch_party_heartbeat` zeigen, dass ein neuer `host_member_id` verarbeitet werden kann. Ein Transfer-RPC, eine nachgewiesene serverseitige Desktop-/Browser-Klassifikation und eine dokumentierte Wahlregel nach Beitrittszeit oder Verbindungsabbruch fehlen im Repository. Daher sind Desktop-Priorität, automatische Verdrängung beim Desktop-Beitritt und die Reihenfolge mehrerer Desktop-Mitglieder offen. Kein Client wählt sich selbst zum Host.

Manuell mit Testkonten prüfen: regulärer Browser-Host-Austritt, kurzer Reconnect, Desktop-Host-Austritt mit und ohne verbleibenden Desktop und Desktop-Beitritt zu einem Browser-Host. Im verbleibenden Client jeweils die serverbestätigte Host-ID, Party-Code, Chat und Host-only prüfen. Bei tatsächlicher Browser-Nachfolge mit einem öffentlichen Link ohne Zugangsdaten Playbackposition, Play/Pause und ausbleibendes Reload der gleichen Quelle prüfen. Beim Desktop-Host muss das Browser-Vorschlagsformular verborgen bleiben.

### Familien-Beta und Vorschläge

- `VITE_PARTY_BROWSER_HOST_SHARE` bleibt standardmäßig aus. Nur bei aktiver privater Beta und nach Bestätigung kann ein direkter HTTPS-TorBox-HLS-Link mit `token` geteilt oder vorgeschlagen werden. Ein solcher Link kann Account-Zugriff vermitteln. Die Party verteilt ihn im lesbaren Realtime-Kanal und kann empfangene Kopien nicht löschen. Das Browser-Feld verhindert ein Desktop-mpv-Angebot, aber Desktop-Kanalmitglieder können den Broadcast technisch lesen.
- Der neue HLS-Pfad lädt über hls.js mit Fetch. Unteranfragen sind auf die exakte HTTPS-Origin der Playlist beschränkt. Redirects werden abgelehnt. Quellen, die Cross-Origin-Varianten, Redirects, native HLS-Wiedergabe oder tokenisierte MP4/WebM-Links erfordern, fallen außerhalb dieses Pfads. Echte TorBox-Wiedergabe ist noch zu prüfen.
- Der Client leert bei Austritt, Kick und Party-Ende Vorschläge, Eingabefelder, Angebot und HLS-Instanz. URL und Token werden nicht im Browser-Speicher oder in Einladungen abgelegt. Ein Account-Key bleibt bis zum Ablauf oder zur Rotation nutzbar. TorBox-Hilfe und API-Bedingungen formulieren die Weitergabe unterschiedlich. Echte Account-Credentials nur mit ausdrücklicher Anbieterfreigabe verwenden.
- Das Vorschlagsformular wird erst nach einem Fähigkeitssignal der aktuellen Host-ID für dasselbe Medium angezeigt. `browser_stream_suggest` wird vom Desktop nicht verarbeitet. Das Signal ist kein serverbestätigter Gerätetyp. Das bekannte Realtime-Absenderrisiko bleibt bestehen. Die persönliche HLS-Eingabe ist ausschließlich lokal.

## Phase 2.1: Grenzen der privaten Beta

- Der Browser-Host hält den letzten abgeschlossenen Quellenstand im Speicher. Ein ausdrücklicher Widerruf hat eine eigene Revision und wird bei `state_request` und Reconnect erneut gesendet. Ältere Angebote derselben Host-/Medienkombination werden im Browser verworfen. Alte Desktop-Clients lesen weiterhin das gewöhnliche Streamangebot und bieten es zur manuellen Auswahl an.
- Angebot und Playback bleiben getrennte Broadcasts. Gäste können eine Quelle vorübergehend erhalten, bevor ein Fehler erkannt wird. Bei einem Fehler im zweiten Schritt wird der alte Stand oder ein Widerruf mit höherer Revision erneut angeboten, auch wenn die unmittelbare Rücknahme fehlschlägt. Ein Send-Ergebnis bestätigt weder die Zustellung an alle Gäste noch die spätere Speicherung des Playback-States per RPC.
- Host-Reload und Hostwechsel haben ohne serverseitig abrufbaren Quellenstand keine garantierte Wiederherstellung. Der neue Host muss seine eigene Quelle ausdrücklich freigeben. Die Revisionen dienen der Reihenfolge, nicht der Authentifizierung. Das bekannte Risiko frei behaupteter Realtime-Absender bleibt für die private Beta akzeptiert. Der Freigabeschalter ist standardmäßig aus.
- Außerhalb des ausdrücklich aktivierten TorBox-HLS-Pfads werden bekannte TorBox-Domains und typische Account-Token-Parameter abgelehnt. Eine URL-Prüfung kann beliebig eingebettete Geheimnisse nicht erkennen.

### Phase 2.2: Host-Übergabe

Desktop und Browser schließen lokal ihre Session und verwenden beim regulären Verlassen `watch_party_leave`. `watch_party_end` ist eine separate Aktion. Desktop kann eine neue Host-ID aus einem Mitgliedschaftsereignis verarbeiten. Beide Clients können einen Hostwechsel über einen `watch_party_heartbeat`-Snapshot übernehmen. Der Browser erkennt sich als Host, wenn der Snapshot die eigene Mitglieds-ID als Host nennt und das Mitglied in der Liste steht. Beim Hostwechsel werden alte Freigaben verworfen. Der Browser kann Playback aus dem neuen Snapshot übernehmen, sofern es zur aktuellen Medienidentität und Host-only-Regel passt. Das belegt Client-Unterstützung, aber keine serverseitige Wahlregel.

Bei einem Verbindungsabbruch senden die Reconnect-Pfade keinen regulären Austritt. Der Server kann die alte Mitgliedschaft noch führen. Wann sie abläuft und ob der Server dann einen Nachfolger bestimmt, ist aus den vorhandenen Verträgen nicht ableitbar.

Kleinster nächster Schritt ist ein kontrollierter Test mit zwei autorisierten Konten. Desktop- und Browser-Host jeweils regulär verlassen lassen und getrennt davon die Verbindung unterbrechen. Beim verbleibenden Konto im Heartbeat Party-ID, `host_member_id`, Mitgliedschaft und den gültigen Playback-Stand prüfen. Wenn der Server den Nachfolger bestätigt, zunächst eine explizite Neu-Freigabe durch diesen Host vorsehen und die letzte bestätigte Position verwenden. Ohne bestätigten Nachfolger keine clientseitige Wahl. Automatische Quellenübernahme separat prüfen, da sie autorisierten Quellenstand und erneute Zustimmung braucht.

Branch `restore/watchparty-0.1.49`. Die Implementierung ist in `f595fa818` enthalten; die Härtung unten ist **nicht getestet und nicht committet**.

## Sicherheitsstatus (Härtung nach dem Review): GESPERRT, durch das Backend blockiert

**Ergebnis der Prüfung:** Mit dem vorhandenen Backend kann kein Client erkennen, ob eine Realtime-Nachricht wirklich vom Host stammt.

- **Realtime-Absender:** `member_id` in `stream`, `state`, `stream_suggest`, `stream_suggest_result` und der Presence-Schlüssel setzt der sendende Client selbst. Der private Kanal prüft nur, ob jemand dem Thema beitreten darf, nicht wer eine Nachricht verfasst hat. Jedes Mitglied kann also „als Host“ senden.
- **Quellen:** Für Streamangebote gibt es keine serverseitige Speicherung, Revision oder Bestätigung.
  - `PartyMedia.source` (`PartySource`) kennt nur Addon- und Torrent-Merkmale, keine URL. Ihn umzuwidmen wäre eine Vertragsverletzung und würde Tokens in die Datenbank schreiben.
  - Ob das Backend `p_media`-Änderungen auf den Host beschränkt, ist nicht einsehbar.
- **Party-Zeit:** `watch_party_update` speichert serverseitig. Ob das Backend `member_id` aus der Anmeldung setzt oder den Client-Wert übernimmt, ist nicht einsehbar. Bei `host_only = false` dürfen ohnehin auch Gäste schreiben. Ein gespeicherter Stand ist damit kein Herkunftsnachweis für Realtime-Stände.
- **Vorschläge:** Es gibt keinen privaten Weg zum Host. Jeder Vorschlag ist für alle Mitglieder des Kanals lesbar, Tokens in Links also auch.
- **Atomarer Quellenwechsel:** Streamangebot (Realtime) und Startstand (Realtime + RPC) sind zwei ungekoppelte Vorgänge. Eine echte Atomarität ist ohne serverseitige Quellenrevision nicht erreichbar.

**Konsequenz (fail-closed):**
- **Videofreigabe durch den Browser-Host:** gesperrt. Die Videofreigabe im Room ist deaktiviert und zeigt den Grund. Der Host sendet kein Streamangebot und beantwortet `state_request` nur, wenn er tatsächlich eine Quelle teilt; das kommt bei gesperrter Freigabe nicht vor.
- **Vorschläge:** Die Vorschlagsliste des Browser-Hosts und das neue Vorschlagsformular für Browser-Mitglieder sind gesperrt. Das neue „Video vorschlagen“ im Desktop-Party-Menü ist entfernt (Desktop hat keinen Build-Schalter).
- **Interner Schalter:** Nur für geschlossene, interne Tests lässt sich die Sperre per Build-Variable `VITE_PARTY_BROWSER_HOST_SHARE=1` aufheben. Sie ist **nicht für eine öffentliche Preview** gedacht.
- **Weiter aktiv**, weil serverseitig autorisiert:
  - Room-Redesign, Einladungslink, Teilnehmerzahl, Chat
  - Host-Reiter (Nur Host darf steuern, Mitglieder entfernen, Party beenden)
  - Erstellen über die Cinemeta-Suche
- **Unverändert:**
  - Desktop-Host-Freigaben („Share my stream“, Browser-HLS)
  - Host-only, Solo-Modus und Countdown
  - Diese bestehenden Wege haben dieselbe ungeprüfte Absenderidentität. Das ist bekannt und hier nicht verschlimmert.

### Fehlender Backend-Vertrag (Vorschlag, keine Migration ohne Freigabe)

1. **Serverbestätigte Quelle:**
   - RPC `watch_party_set_source(p_party_id, p_device_id, p_source jsonb, p_expected_rev int)`, nur für den Host.
   - Sie speichert `{kind, url}` mit einer vom Server vergebenen `source_rev` und lehnt eine veraltete `p_expected_rev` ab.
   - `null` bedeutet Widerruf und erhöht die Revision ebenfalls.
   - Join, Heartbeat und Preview geben `source` und `source_rev` zurück.
2. **Server als Absender:**
   - Eine Quellenänderung wird vom Server selbst verteilt, per `realtime.send` aus der RPC oder `postgres_changes` auf die Party-Zeile.
   - Clients akzeptieren Quellen nur aus diesem serverseitigen Kanal bzw. aus dem Snapshot und vergleichen `source_rev`. Damit sind Widerruf, Late Join und Reconnect gedeckt.
3. **Party-Zeit mit Quellenbezug:** `watch_party_update` setzt `member_id` aus der Anmeldung, nimmt `source_rev` entgegen und weist Stände für eine ältere Revision zurück.
4. **Private Vorschläge:**
   - RPC `watch_party_propose(p_party_id, p_device_id, p_url)`: Der Absender ergibt sich aus der Anmeldung, nur aktuelle Mitglieder dürfen vorschlagen.
   - Lesen darf nur der Host (`watch_party_list_proposals`). Die Entscheidung läuft über `watch_party_decide_proposal` und prüft vor der Annahme Mitgliedschaft und Medienidentität.
   - Kein Vorschlag geht über den gemeinsamen Kanal.

Erst wenn 1 und 2 vorhanden sind, darf die Browser-Freigabe öffentlich aktiviert werden. Für Vorschläge mit Tokens ist zusätzlich 4 nötig.

### Einordnung der Review-Befunde

| Befund | Status |
|---|---|
| Host-Imitation bei Streamangebot, Widerruf und Party-Zeit des Browser-Hosts | **DURCH BACKEND BLOCKIERT**; die Funktion ist fail-closed gesperrt. |
| Host-Imitation bei Vorschlagsentscheidungen | **DURCH BACKEND BLOCKIERT**; die Vorschläge sind gesperrt. |
| Token-Zugriff über Realtime | Die neuen Wege sind standardmäßig gesperrt. In der ausdrücklich aktivierten Familien-Beta sind weitergegebene Links für Kanalmitglieder lesbar. Der alte Browser-Vorschlagsweg an Desktop ist entfernt. |
| Atomarer Quellenwechsel, verspätete Angebote nach Widerruf | **DURCH BACKEND BLOCKIERT**: Ohne serverseitige Revision ist keine Garantie möglich. Durch die Sperre entstehen keine widersprüchlichen Browser-Host-Quellen. |
| Vorschläge nach Kick oder Medienwechsel | **ABGESICHERT, ABER EINGESCHRÄNKT**: Mit der Sperre wird nichts angenommen. Für den internen Schalter prüft die Annahme den Snapshot nur beim Eingang. |
| Desktop-Gäste erhalten ein neues Angebot, mpv wechselt nicht automatisch | **ABGESICHERT, ABER EINGESCHRÄNKT**: Mit der Sperre kommt kein Browser-Host-Angebot an. Für Desktop-Host-Angebote bleibt die bestehende manuelle Quellenauswahl. Automatische Desktop-Wiedergabe ist nicht implementiert. |
| Desktop-Vorschlag gilt als „gesendet“ ohne bestätigten Versand | **BEHOBEN** durch Entfernen der neuen Desktop-Vorschlagsfunktion. |
| HLS-Untermanifeste, Segmente, Schlüssel, Redirects | **ABGESICHERT, ABER EINGESCHRÄNKT**: Geprüft wird nur die eingegebene Adresse. Untermanifeste, Segmente, Schlüssel und Redirects lädt der Browser bzw. hls.js selbst; ohne Proxy gibt es dafür keine vollständige Zielprüfung und **keine SSRF-Schutzgarantie**. Mit der Sperre entfällt der neue Weg. |
| Alle Punkte | **NOCH UNGETESTET** gegen das Live-Backend. |

**Hinweis:** Der folgende Abschnitt beschreibt den Funktionsumfang, wenn der interne Schalter gesetzt ist. Öffentlich gilt die Sperre oben.

## Phase 2.1: Private Familien-Beta

**Nur für einen geschlossenen Kreis**, mit dem internen Build-Schalter `VITE_PARTY_BROWSER_HOST_SHARE=1`. Er ist standardmäßig aus, eine öffentliche Preview bleibt gesperrt. Das Risiko oben gilt unverändert und wurde für die Beta bewusst akzeptiert: Jedes Mitglied kann Realtime-Nachrichten „als Host“ senden, und Vorschläge sind für alle Mitglieder lesbar.

- **Warteraum:**
  - Der Host bleibt im Room bis zur ersten Freigabe, Mitglieder bleiben dort, solange keine Quelle angeboten oder geladen ist. Ein Videolink ist für das Erstellen und Beitreten nicht nötig.
  - Gezeigt werden Poster, Titel, Party-Code, Einladungslink, Teilnehmer, „Teilnehmer & Chat“ und „Warte auf Video vom Host …“.
  - Mitglieder sehen keine Host-Steuerelemente. Ohne Quelle erscheint keine Fehlermeldung.
  - Aus dem Player ist der Room über „Party-Room anzeigen“ (Reiter Party) bzw. „Party-Room öffnen“ (Reiter Host) erreichbar.
  - Die Texte nennen nicht mehr ausdrücklich einen „Desktop-Host“.
- **Freigabe (bestmöglich, keine Transaktion):**
  - Es läuft immer nur eine Freigabe-Aktion.
  - Die lokale Quelle ändert sich erst nach bestätigtem Versand. Ein gescheitertes Angebot hinterlässt keinen Zustand und wird bei `state_request` oder Reconnect nie nachgesendet.
  - Scheitert danach der Startstand, kündigt der Host die vorherige Quelle (oder „keine“) wieder an. Der Host-Player behält seine bisherige Quelle, und die Meldung sagt, ob die Wiederherstellung gelang.
  - Ein Widerruf gilt erst nach bestätigtem Versand; sonst bleibt alles wie es war.
- **Mitglieder:** Neue Quelle → Wechsel vom Warteraum in den Player und automatisches Laden. Quellenwechsel → nur die neue Quelle. Widerruf → zurück in den Warteraum.
- **Autoplay:** Blockiert der Browser den Start, auch stumm, erscheint ein einziger Knopf „Wiedergabe starten“; das Tippen startet bei der Party-Zeit.
- **Vorschläge** (nur mit Schalter):
  - Sie verfallen, wenn das Mitglied nicht mehr in der Party ist, der Titel wechselt oder die Party endet.
  - Vor der Annahme werden Mitgliedschaft und Titel erneut gegen den letzten Server-Stand geprüft.
  - Keine Account-Tokens, API-Keys oder Passwörter in Links teilen.
- **Desktop:**
  - Desktop-Gäste können vor der Freigabe beitreten.
  - Das Angebot des Browser-Hosts erscheint bei ihnen als vom Host geteilte Quelle im Stream-Bildschirm und muss **manuell** gewählt werden. Ein automatischer Wechsel einer laufenden mpv-Wiedergabe ist **nicht** implementiert.
  - Die Desktop-zu-Desktop-Party ist unverändert.

## Ablauf

1. Party über die Cinemeta-Suche erstellen (Phase 1, unverändert).
2. **Party-Room:**
   - Poster, Titel (bei Serien Staffel/Episode), Party-Code
   - Teilnehmerzahl (`n / max`), Verbindungsstatus
   - großes Feld für den Videolink mit „Video für alle freigeben“
   - Einladungslink, „Teilnehmer & Chat“, „Host-Einstellungen“
   - Der Phase-1-Hinweis ist entfernt.
3. **Freigabe:**
   - Prüfung (`host-share.js`): öffentliche HTTPS-Adresse, direkte `.m3u8`, `.mp4` oder `.webm`, kein `#`, keine Zugangsdaten, keine lokalen Ziele.
   - Der Host sendet das normale `stream`-Angebot für den Party-Titel (gleiche Form wie beim Desktop-Host, ohne Header) und einen Startstand „pausiert bei 0“.
   - Wird derselbe Link erneut freigegeben, bleibt die aktuelle Party-Zeit erhalten.
4. **Player:**
   - Die Room-Startansicht schließt, der vorhandene Browser-Player lädt die Quelle.
   - Play, Pause und Seek des Hosts werden zum Party-Stand: zuerst Broadcast, dann `watch_party_update`.
   - Mit `host_only = false` folgt der Host auch den Ständen der Mitglieder.
5. **Mitglieder:**
   - Browser-Gäste übernehmen das Angebot über den bestehenden Pfad.
   - Desktop-Gäste sehen es als „vom Host geteilte“ Quelle im Stream-Bildschirm.
6. **Vorschläge:**
   - Browser-Mitglieder nutzen „Video vorschlagen“ im Stream-Reiter, wenn der aktuelle Browser-Host die Fähigkeit signalisiert.
   - Der Host sieht im Room Name, Format und Hostname. „Link prüfen“ zeigt die vollständige Adresse nur ihm.
   - „Annehmen“ gibt das Video wie unter 3 frei, „Ablehnen“ verwirft es. Der Vorschlagende sieht die Entscheidung.
7. **Host-Reiter** in den Einstellungen, nur für den serverseitig bestätigten Host (`session.isHost()`):
   - Nur Host darf steuern
   - Mitglieder verwalten (entfernen)
   - Party-Room öffnen, Videofreigabe beenden, Party beenden

## Autorisierung (geprüft)

- **Party-Zeit:**
  - `watch_party_update` ist dieselbe RPC, mit der Desktop-Host und Gäste den Stand speichern.
  - Der Server entscheidet, ob der Aufrufer schreiben darf (Host immer, Gäste nur bei `host_only = false`).
  - Der Browser-Host nutzt dafür die Reihenfolge des Desktops: zuerst Broadcast, dann speichern.
  - Ein abgelehnter Speicheraufruf nimmt den bereits gesendeten Stand nicht zurück, genauso wie beim Desktop.
- **Streamangebot:**
  - Es läuft nur über den privaten Realtime-Kanal, wie beim Desktop-Host.
  - Empfänger übernehmen es nur, wenn `member_id == host_member_id` aus dem letzten **Server-Snapshot** ist.
  - Realtime-Absender werden vom Server nicht geprüft. Das ist das bestehende Vertrauensmodell und wird hier nicht als sicher dargestellt.
- **Vorschläge:**
  - Die Absender-ID ist behauptet, nicht nachgewiesen.
  - Angenommen wird nur von IDs, die im letzten Server-Snapshot Mitglied sind (nicht der Host), für den aktuellen Titel und mit gültigem Link.
  - Der Name dient nur der Anzeige. Freigegeben wird erst durch die ausdrückliche Annahme des Hosts.
- **Keine Gastbefehls-Sequenzierung:** Der Browser-Host meldet kein `commands: 1`. Gäste mit Steuerrecht nutzen deshalb den bestehenden Pfad (Broadcast, dann `watch_party_update`), und der Server erzwingt Host-only.

## Durch das Backend bzw. die Architektur begrenzt

- **Reload des Hosts:**
  - Das Streamangebot liegt nur im Speicher (bewusst keine URLs im Browser-Speicher). Nach einem Neuladen der Host-Seite muss der Link erneut freigegeben werden; Gäste spielen bis dahin weiter.
  - Eine dauerhafte Quelle bräuchte eine serverseitige Quellen- und Revisionsbindung (siehe Phase 1, „Offener Backend-Vertrag“). Es gibt keine Migration ohne Freigabe.
- **Fehlende Koordinatorfunktionen** des Desktop-Hosts im Browser-Host:
  - Warten auf puffernde Mitglieder
  - gemeinsamer Countdown
  - Gastbefehls-Sequenzierung
  - Chat, Solo-Modus, Host-only und Reconnect funktionieren.
- **Serie ohne Episode: nicht umgesetzt.**
  - Der Backend-Vertrag ist nicht einsehbar, ein Live-Aufruf war nicht freigegeben.
  - Clientseitig ist eine Episode nötig: Der Wiedergabeschlüssel enthält Staffel und Episode, und Desktop-Gäste öffnen eine Party ohne Episode mit `videoId = metaId` (`MainAppContent.openPartyMedia`). Das liefert für Serien keine passenden Streams.
  - Die bestehende Episodenauswahl bleibt erhalten, es gibt keine Dummy-Daten.
- **Desktop-Host und Vorschläge:** Der Browser sendet keine Vorschläge an Desktop-Hosts. Desktop-Streaming und vorhandene HLS-Empfängerlogik bleiben unverändert.

## Autoplay

- **Host:** Er startet selbst mit ▶; das ist eine Nutzergeste, also kein Autoplay-Problem.
- **Gäste:** Blockiert der Browser den automatischen Start, gilt der bestehende Ablauf:
  - erst ein stummer Start, mit dem Hinweis auf den Ton-Knopf
  - sonst „Party-Zeit aktualisieren“ bzw. „Mich synchronisieren“ als Startknopf

## Geänderte Dateien (Phase 2)

- `browser-site/src/host-share.js` (neu)
- `browser-site/src/session.js`
- `browser-site/src/main.js`
- `browser-site/index.html`
- `browser-site/src/style.css`
- `browser-site/tests/host-share.test.js` (neu)
- `browser-site/tests/session.test.js`
- `browser-site/tests/personal-hls-integration.test.js`
- `composeApp/.../party/PartyRepository.kt` (`suggestLink`)
- `composeApp/.../player/PlayerScreenRuntimePartyControls.kt` (`partySuggestLink:`)
- `composeApp/src/desktopMain/resources/player-ui/party.js` (Vorschlagsfeld für Mitglieder)

## Lokale Testbefehle

```powershell
node --test browser-site/tests/host-share.test.js browser-site/tests/session.test.js browser-site/tests/personal-hls-integration.test.js
npm.cmd --prefix browser-site test
.\gradlew.bat :composeApp:desktopTest --tests '*Party*Test' --no-configuration-cache --console=plain
```

## Noch nicht live getestet

- Erstellen im Browser und Freigabe gegen das offizielle Backend: Lässt `watch_party_update` den Browser-Host schreiben?
- Gäste im Browser und am Desktop übernehmen Quelle und Party-Zeit, auch bei spätem Beitritt und nach einem Reconnect.
- Vorschläge von Browser- und Desktop-Mitgliedern, Annahme und Ablehnung.
- Host-only, Solo-Modus, Chat und das Beenden der Party mit einem Browser-Host.
