# A40: Integration von Upstream 0.1.37-alpha

Branch `integration/a40-upstream-0.1.37` (lokal, nicht gepusht), Worktree
`Nuvio-Watch-A40-0.1.37`. Basis: `backup/a40-before-upstream-0.1.37` (= bisheriger
Entwicklungsstand inkl. aller uncommitteten A40-Änderungen, ohne `.wrangler/`).

## Sicherung
- Branch `backup/a40-before-upstream-0.1.37`, Tag `a40-pre-0.1.37-worktree-snapshot` (`d7ac98aac`).
- Git-Bundle unter `%LOCALAPPDATA%\NuvioPrivateBuilds\source-backups\a40-pre-0.1.37-20261119.bundle` (verifiziert).
- Signierte MSI 1.2.42 und Rollback-Ordner unverändert.

## Upstream 0.1.36 → 0.1.37 (95 Commits, 107 Dateien)
Desktop-relevant: Bibliothek (Liste/Typ merken, Genre-/Jahr-/Gesehen-Filter), Rating-Chip in
der Detail-Hero, Untertitel (Konturbreite, Farben/Positionen/Top-Platzierung im Styled
Overlay, ASS unverändert auf Desktop: `sub-ass-override=no`), Stremio-Player-/Library-Tracking-
Add-ons (mit Zustimmungsdialog), Quellen-Fallback auch für die automatisch gewählte Quelle der
nächsten Episode, TorBox-Alternativ-Hash-Cache, Ladebildschirm mit Startschritten, Seekbar-
Track-Fix, Performance (keine Controls-Neuzeichnung ohne sichtbare Änderung), neue Sprachen
(pt-BR, uk, zh-CN, fr). Android/iOS: Baseline-Profile, mpv-android-lib 0.2.1, iOS-Downloads.

## Konflikte und Auflösung
| Datei | Auflösung |
|---|---|
| `.github/workflows/update-store-source.yml` | Upstream-Prerelease-Schutz **und** A40-Fork-Sperre kombiniert |
| `androidApp/build.gradle.kts` | Upstream (Baseline-Profile), A40 hatte dort nichts geändert |
| `iosApp/Configuration/Version.xcconfig`, `store.json` | Upstream (A40 liefert kein iOS) |
| `WatchProgressIdentityTest.kt` | Beide Seiten hatten denselben Testfix; Upstream-Variante |
| `SubtitleCuePresenterTest.kt` | Im Fork gelöscht, upstream geändert: Upstream-Datei behalten (Android-Hosttest) |

Automatisch zusammengeführt und inhaltlich geprüft: `PlayerScreenRuntimeEffects/State/Ui`,
`PlayerModels`, Windows-/Linux-Bridge, `composeApp/build.gradle.kts`, `libs.versions.toml`,
`MainAppContent`, `strings.xml`. `controls.js`/`controls.css` waren im Fork seit 0.1.36
unverändert und wurden vollständig übernommen; Tastatur-, Pause-Overlay- und Skip-Pfad sind
inhaltlich unverändert. Desktop-Kotlin (`desktopMain/kotlin`) ist identisch mit dem A40-Stand.

## Erhalten (Marker geprüft)
Ereignis-/Live-Sync, Host-Sequenzierung, Host-Solo, Browser-Party-Bridge, WaitGate/Sync-Trace,
Leertasten-Fallback inkl. Fokusrückgabe, kein doppeltes Compose-Pause-Overlay, IntroDB-Härtung,
Browser-Site unverändert (= deployte Family-Beta 8177c7fa), A40-MSI-UpgradeCode.

## Verifikation
- Kotlin-Desktop kompiliert (0 Fehler). 245/246 gezielte Kotlin-Tests bestanden; der eine Fehler
  (`NativePlayerControllerTeardownTest.sourceGapsDisposeSuccessfulSupersededCreatesBeforeReplacementPublication`)
  tritt identisch schon auf dem signierten 1.2.42-Quellstand `9a31d00af` auf (vorbestehend).
- Browser: 297/297 (Party, Session, Protokoll, HLS, Sync-Policy, Host-Share).
- Windows-Player-Bridge **nicht** kompiliert: WebView2-SDK fehlt auf diesem Rechner (nur eine
  Zeile geändert: `sub-ass-override`). Muss beim MSI-Build mit `-Pnuvio.webview2.dir` gebaut werden.

## Vorbestehend, nicht durch die Integration verursacht
`check-fork-invariants.sh` meldet zwei veraltete Marker (`nuvio-browser-party-host-v2`, fester
UpgradeCode-String) – identisch auf dem Entwicklungsstand vor dem Merge.
