# Exakter Seek für Party-Pausen (Ansatz B, nach `7f7ddea0`)

Lokal, nicht committet. Kein MSI.

## Problem

- Der Windows-Player springt per `seek <ziel> absolute+keyframes`, mit `hr-seek=no`. mpv landet deshalb auf dem nächstgelegenen Keyframe K, bei 4K/HEVC oft mehrere Sekunden neben der Zielsekunde T.
- Der Fix aus `7f7ddea0` hat danach K veröffentlicht. Damit zog er bei einer Pause aus dem Browser **alle** Teilnehmer auf den Keyframe des Desktops zurück.

## Änderung

1. `player_bridge.cpp`:
   - `seekToMilliseconds(positionMs, exact = false)` sendet `absolute+exact` bei einem exakten Sprung, sonst wie bisher `absolute+keyframes`.
   - Neue JNI-Funktion `NativePlayerBridge_seekToExact`.
   - Das globale `hr-seek=no` bleibt, normales Spulen bleibt schnell.
2. `NativePlayerBridge.kt`: `external fun seekToExact`.
3. `PlayerEngine.kt`: `fun seekToExact(positionMs) = seekTo(positionMs)` als Standard. Android und iOS bleiben unverändert; der AutoSync-Wrapper reicht die Methode per `by base` weiter.
4. `NativePlayerController.kt`:
   - `seekToExact` ruft die exakte Bridge-Funktion auf.
   - Fehlt sie in einer alten DLL (`UnsatisfiedLinkError`), fällt der Controller **einmalig und dauerhaft** auf den Keyframe-Seek zurück, ohne bei jedem Sprung neu zu versuchen.
5. `PlayerScreenRuntimeParty.kt`:
   - Eine **pausierte** fremde Revision übernehmen: exakter Sprung.
   - Die pausierte Korrekturschleife: ebenfalls exakt.
   - Während der Wiedergabe bleibt der Keyframe-Seek mit gemessenem Vorlauf (`seekLead`), ohne Dekodier-Ruckler.
6. Die **Keyframe-Bestätigung** aus `7f7ddea0` ist jetzt nur noch Sicherheitsnetz (`PartySync.shouldConfirmPausedPosition(…, exactAttempted)`). Sie greift erst, wenn für dieselbe Revision schon exakt gesprungen wurde und der Player trotzdem mehr als 0,5 s daneben steht, etwa wegen einer alten DLL oder eines unpräzisen Streams. Weiterhin höchstens einmal pro Revision.
   - Dadurch springt der Host bei einem eigenen Sprung im Pausenzustand (Keyframe-Seek auf K) nach etwa 2,5 s exakt auf sein Ziel T. Die Browser bleiben auf T und werden nicht auf K gezogen.
7. **Build-Falle behoben** (`composeApp/build.gradle.kts`): `buildWindowsPlayerBridge` baut neu, wenn die DLL fehlt **oder älter als `player_bridge.cpp`** ist. Vorher galt nur „fehlt“, und eine Quelländerung wurde lokal stillschweigend nicht kompiliert.
8. `verify-msi.ps1`: Der gepackte MSI muss in `player_bridge.dll` den Export `NativePlayerBridge_seekToExact` und in der JAR `NativePlayerBridge.seekToExact` enthalten; das Manifest meldet `exactPausedSeek`. Eine veraltete DLL fällt so beim Verifizieren auf.
9. `check-fork-invariants.sh`: prüft den exakten Seek in Bridge, Party-Schleife und Build-Guard.

## Bewertung

| | Wirkung |
|---|---|
| Exaktheit | Pause bildgenau auf T, auch bei 4K/HEVC |
| Performance/CPU | mpv dekodiert von K bis T, nur bei Party-Pausen; mit Hardware-Dekodierung meist unter 1 s |
| Buffering | kaum Mehrdaten (ab K wie zuvor) |
| Kompatibilität | rein lokal, kein Protokoll betroffen; alte DLL fällt automatisch zurück |
| Schleifen | keine: Ziel erreicht, keine Korrektur; Sicherheitsnetz höchstens einmal |
| Desktop zu Desktop | Gäste und Host stehen bei Pausen auf T |

## Tests

- `composeApp/src/desktopTest/.../NativePlayerExactSeekTest.kt` (neu): exakter Aufruf, einmaliger Rückfall bei fehlendem Export, kein Sprung ohne Handle.
- `composeApp/src/commonTest/.../PausedPositionTest.kt`: keine Bestätigung ohne vorherigen exakten Seek (neu), übrige Fälle unverändert.

```powershell
Set-Location 'C:\Users\Alanp\Desktop\Chatgpt\Codex\Nuvio-Watch\NuvioDesktop'; $env:JAVA_HOME='C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot'; .\gradlew.bat :composeApp:desktopTest --tests '*Party*Test' --tests '*MemberSync*' --tests '*PausedPosition*' --tests '*NativePlayerExactSeek*' --tests '*Torbox*Test' --tests '*Fork*UpdateTest' --tests '*AppUpdate*Test' --tests '*UpdateChannelTest' --tests '*ReleaseSelector*' --tests '*VersionUtils*' --no-configuration-cache --console=plain
Set-Location 'C:\Users\Alanp\Desktop\Chatgpt\Codex\Nuvio-Watch\NuvioDesktop\browser-site'; npm.cmd test
bash fork-maintenance/check-fork-invariants.sh
```

Hinweis: Weil `player_bridge.cpp` jetzt neuer ist als die vorhandene DLL, kompiliert Gradle die Bridge beim nächsten Lauf mit MSVC neu (`C:\BuildTools\Nuvio`). Das passiert auch schon beim Desktop-Testlauf, wenn der Task Teil des Graphen ist.

## Verifikation vor dem Live-Test

1. Im Build-Log muss `buildWindowsPlayerBridge` ausgeführt worden sein, nicht SKIPPED.
2. `verify-msi.ps1` muss bestehen, einschließlich der Prüfung auf den `seekToExact`-Export.
3. Live mit derselben 4K-Quelle: Browser springt, dann Pause → der Desktop steht innerhalb von 0,5 s auf demselben Bild. Im Desktop-Log darf keine Zeile „Confirming paused keyframe position“ erscheinen; sie käme nur noch vom Sicherheitsnetz.

## Testergebnis (03.11.2026, lokal)

- Desktop: 150/150 bestanden, darunter `NativePlayerExactSeekTest` 3/3, `PausedPositionTest` 5/5 und `NativePlayerControllerTeardownTest` 23/23. Log: `fork-maintenance/local/desktop-tests-exactseek.log`.
  - Beim ersten Lauf hat Gradle `buildWindowsPlayerBridge` **tatsächlich ausgeführt**, weil die Quelle neuer war als die DLL: `player_bridge.dll` ist vom 03.11.2026, 19:46.
  - Die neue DLL enthält den Export `…NativePlayerBridge_seekToExact` sowie `absolute+exact` und `absolute+keyframes`.
  - Der zweite Lauf meldete `SKIPPED`, weil die DLL nun aktuell ist. Die neue Bedingung greift also wie gedacht.
  - Beim ersten Lauf kompilierte der neue Test nicht, weil der Reflection-Helfer in der anderen Testdatei privat ist. Er bekam eine eigene Kopie; der App-Code ist dafür unverändert.
- Browser `npm test`: 184/184 bestanden.
- Fork-Invarianten: OK.
- Nicht live getestet. Ob mpv bei 4K/HEVC mit `absolute+exact` flüssig genug springt, zeigt erst der Live-Test.
