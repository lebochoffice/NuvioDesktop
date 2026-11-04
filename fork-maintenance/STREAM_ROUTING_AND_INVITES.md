# Originalstream für Desktop, Browser-HLS und Invite-Korrektur

Änderungen ausschließlich im vorhandenen Branch `feature/torbox-hls-mvp` und Worktree. Bestehende lokale Änderungen wurden erhalten. Keine Tests, Builds, Commits, Pushes, Merges oder Deployments ausgeführt. Dieser Stand benötigt einen **neuen MSI**; `0.1.35-torbox-party-hls` enthält die folgenden Änderungen noch nicht.

## Arbeitspaket 1: endgültige Quellenaufteilung

`currentPartyStream()` erzeugt wieder den Originalstream aus `activeSourceUrl`, Original-Headern, Antwortheadern, Dateiname, Dateigröße, Streamtyp, Beschreibung und Badges. Die Desktop-Quelle selbst wird nicht verändert. Für eine bekannte TorBox-Datei kommt ausschließlich die optionale Erweiterung `browser_hls` hinzu:

```json
{
  "media_key": "movie|tt1||",
  "url": "https://desktop.example.test/original.mkv",
  "headers": {"Referer": "https://provider.example.test"},
  "filename": "original.mkv",
  "browser_hls": {"url": "https://stream.example.test/browser.m3u8", "headers": {}}
}
```

Alle Beispielwerte sind synthetisch. Es gibt weiterhin nur den bestehenden `stream`-Broadcast, den bisherigen Sharing-Schalter und einen gemeinsamen Party-Playback-State. Keine zweite Party, kein neuer Transcodingpfad für Desktop und keine Änderung an Nuvios Desktop-Playerquelle.

- Desktop empfängt die Originalfelder. `toStreamItem()` übernimmt ausschließlich diese. Neue Desktop-Gäste entfernen das Browser-Zusatzfeld beim Empfang mit `forDesktop()`, damit eine reine HLS-Erneuerung nicht den Desktop-Stream neu lädt.
- Der bisherige Desktop-Decoder verwendet `ignoreUnknownKeys=true`. Alte Modelle mit diesem geprüften Decoder ignorieren `browser_hls` und verwenden weiter Original-URL/-Header. Regressionen prüfen diese Projektion sowie unveränderte Qualität-/Metadaten. Ein Live-Nachweis für jede unbekannte veröffentlichte Desktop-Version ist damit nicht gegeben.
- Der Browser wählt mit `browserPartyStream()` ausdrücklich den Browserteil. Original-Dateiendung, Original-Header und Original-Qualitätsangaben werden nicht auf HLS übertragen. Die Medienkennung stammt weiterhin aus dem übergeordneten `PartyStream`; ein abweichendes verschachteltes `media_key` wird nicht übernommen. Die vorhandene Session und deren Playback-State bleiben unverändert.
- Ein vorhandenes `browser_hls` ohne gültige URL bedeutet: Browserquelle noch nicht verfügbar. Der Browser stoppt die alte Quelle und wartet bzw. bietet persönlichen HLS-Fallback an. Er wechselt dabei nicht auf das Desktop-Original. Nachrichten alter Hosts **ohne** dieses Feld behalten den bisherigen Browser-Verarbeitungspfad.
- HLS-Vorbereitung erfolgt wie bisher beim Party-Start. Nur nach explizitem Sharing wird das Gesamtobjekt veröffentlicht. Vorher wird auch die Browserquelle nicht verteilt.
- Während HLS-Erneuerung oder bei deren Fehler bleibt das Desktop-Original freigegeben; nur der Browserteil wird leer. Die vorherigen pauschalen `shareStream(null)`-Aufrufe aus der HLS-Erneuerung wurden deshalb entfernt. Explizites Sharing-Aus sendet weiterhin das bestehende Null-Stream-Ereignis und widerruft beide Quellen.
- Bei Datei-/Quellwechsel werden Original und Browserteil gemeinsam aktualisiert; bei neuem TorBox-Dateibezug wird zunächst die Browserbereitschaft zurückgesetzt. Autoritativer Filmwechsel beendet die alte Vorbereitung. Der persönliche HLS-Modus behält seine bewusste Unabhängigkeit von Streammeldungen.

Der vollständige bekannte TorBox-Account-Key wird zusätzlich im gesamten ausgehenden Objekt auf rohe und einfach URL-codierte Vorkommen geprüft, einschließlich beider Headerbereiche. Eine Quelle mit solchem Key wird nicht freigegeben; Header werden nicht stillschweigend entfernt, um eine unbrauchbare Originalquelle vorzutäuschen. Bestehende Prüfung der vorbereiteten HLS-URL bleibt erhalten. Provider-/Mehr-IP-/Tarif- und CORS-Grenzen gelten unverändert; kopierte Provider-Links können durch eine Stream-Nullnachricht nicht beim CDN widerrufen werden.

## Arbeitspaket 2: Root Cause der beiden Invite-Fehler

**Fehler 1, Expected 0 Events / Actual 1:** Der Test beschrieb den früheren kombinierten Ablauf „Bestätigen, Sharing aktivieren und Link kopieren“. Seit der gewünschten Trennung sendet der Klick sofort genau `partyBrowserInvite:<base64url-kodierter HTTPS-Link>` mit numerischem Wert **0**. Im Kotlin-Handler bedeutete 0 bereits nur Clipboard-Kopie. Ein solches Event war somit kein Nachweis einer Streamfreigabe. Die Erwartung wurde auf den neuen ausdrücklich gewünschten Copy-only-Vertrag geändert; Bestätigung und Freigabe des vorhandenen Schalters werden separat geprüft.

**Fehler 2, ungültige HTTP-Adresse erzeugt ein Event:** Das Test-Harness verwendete `section.children[2]` als Eingabe. Durch den zusätzlichen Hinweistext befand sich dort kein Input mehr. Die Tests schrieben also auf das falsche Element. Das wirkliche Input behielt die neue gültige Standardadresse `https://nuvio-watch-friends.pages.dev` und erzeugte damit erwartungsgemäß einen Link. Das war kein Akzeptieren des HTTP-Werts durch die echte Eingabevalidierung. Das Harness findet und prüft nun das tatsächliche `input.party-browser-host` anhand von Tag und Klasse.

Zusätzlich bestand im Kotlin-Handler noch der Legacy-Nebenpfad: ein Invite-Event mit Wert >= 0,5 aktivierte Sharing. Dieser Pfad ist entfernt. **Auch ein altes Overlay, das Wert 1 sendet, darf jetzt nur einen gültigen Link kopieren.** Sharing wird weiterhin ausschließlich über `partySharing` geändert. Im Overlay erfordert dessen Einschalten die vorhandene Bestätigung; Ausschalten benötigt keine zusätzliche Einwilligung.

Die editierbare Adresse bleibt erlaubt und wird als reiner HTTPS-Ursprung geprüft. Die Prüfung vor URL-Normalisierung weist zusätzlich leere `?`/`#`, Dot-Segment-Pfade, Backslashes, Steuerzeichen und leere Userinfo-Marker zurück. HTTP, Zugangsdaten, andere Pfade, Querys und Fragmente bleiben unzulässig. Die feste gültige Pages-Vorgabe ist zulässig. Party-Code und nativer URL-Abgleich gegen die aktive Party bleiben erhalten. Die Invite-Korrektur verändert keine TorBox-Aufrufe oder Streaming-Auswahl; diese wurde ausschließlich in Arbeitspaket 1 gemäß der Produktentscheidung angepasst.

## Geänderte Dateien

- `composeApp/src/commonMain/kotlin/com/nuvio/app/features/party/PartyModels.kt`: optionales Browserfeld, Desktop-Projektion, Schutz vor Account-Key-Übertragung.
- `composeApp/src/commonMain/kotlin/com/nuvio/app/features/party/PartyRepository.kt`: Browsermetadaten auf Desktop-Empfängern ignorieren.
- `composeApp/src/commonMain/kotlin/com/nuvio/app/features/player/PlayerScreenRuntimeParty.kt`: Originalstream beibehalten, HLS als Zusatzfeld, Browser-Erneuerung getrennt zurücknehmen.
- `composeApp/src/commonMain/kotlin/com/nuvio/app/features/player/PlayerScreenRuntimePartyControls.kt`: Invite-Events ändern Sharing nicht mehr; Meldung bei nicht freigabefähiger Quelle.
- `composeApp/src/desktopMain/resources/player-ui/party.js`: eindeutig Copy-only-Event und strengere Ursprungsprüfung.
- `browser-site/src/protocol.js`, `browser-site/src/main.js`: ausdrückliche Browserprojektion und Warten auf Browserbereitschaft.
- `browser-site/tests/desktop-invite.test.js`: tatsächliches Input, neuer Copy-only-Vertrag, Sharing-Consent separat, ungültige Adressen/Codes und nativer Nebenpfad.
- `browser-site/tests/protocol.test.js`, `browser-site/tests/personal-hls-integration.test.js`: Browserquelle, unveränderter Originalstream, gleicher Playback-State, leere/erneuerte Browserquelle und Widerruf.
- `composeApp/src/commonTest/kotlin/com/nuvio/app/features/party/PartyStreamTest.kt`: Desktop-Qualität/Metadaten, Wire-Kompatibilität und Key-Schutz.

## Manuelle Befehle – hier nicht ausgeführt

```powershell
Set-Location 'C:\Users\Alanp\Desktop\Chatgpt\Codex\Nuvio-Watch\NuvioDesktop\browser-site'
node --test tests/desktop-invite.test.js tests/protocol.test.js tests/personal-hls-integration.test.js tests/session.test.js
npm.cmd test
Set-Location ..
.\gradlew.bat :composeApp:desktopTest --tests '*PartyStreamTest' --tests '*Party*Test' --no-configuration-cache --console=plain
```

Danach manuell prüfen: Ein Desktop-Gast erhält exakt Original-URL, Header, Dateiname und Qualität; ein Browser-Gast lädt HLS. Host-Play/Pause/Seek steuert beide über denselben Zustand. HLS-Erneuerung darf Desktop weder umschalten noch neu laden. Film-/Dateiwechsel und Sharing-Aus müssen korrekt wirken. Ein normaler Link-Klick darf bei Sharing aus nur kopieren; erst ausdrückliches Einschalten des Schalters verteilt Streams. Eingabefeld jeweils wirklich editieren und ungültige Fälle prüfen. Kein echter Streamlink/Token in Logs oder Screenshots.

Ein neuer Windows-MSI ist erforderlich, weil Kotlin-Modelle, Empfängerlogik und Desktop-Overlay geändert wurden. Er wurde ausdrücklich **nicht gebaut**. Zusätzlich muss der Browserstand nach Prüfung separat bereitgestellt werden; der vorhandene MSI und die öffentliche Website enthalten diese Änderungen noch nicht.
