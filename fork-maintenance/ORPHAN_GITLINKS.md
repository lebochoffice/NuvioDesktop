# Checkout-Metadaten im persönlichen Fork

Die erste echte GitHub-CI scheiterte im Auth-Cleanup von actions/checkout mit `No url found for submodule path ... in .gitmodules`. Zwei vom Upstream geerbte Gitlinks hatten keine URL-Zuordnung und waren daher nicht initialisierbar:

| Pfad | Ursprüngliches Gitobjekt |
| --- | --- |
| `libass-android` | `c10b71ab8b4d90796d4a795f775d337c29198ad0` |
| `vendor/quickjs-kt` | `57ce096200ac36bceb4e1ee5b6ec411b12357eb8` |

Die beiden leeren Gitlink-Einträge wurden ausschließlich im persönlichen Fork entfernt. Es wurde keine Quell-URL erfunden und keine lokale Datei gelöscht. Die mitgelieferten AAR-/JAR-Abhängigkeiten bleiben erhalten. Das gültige MPVKit-Submodul bleibt unverändert. Der Windows-Build benötigt diese beiden Quell-Submodule nicht.

Ein isolierter Checkout-Test bestätigte, dass Git nach der Indexbereinigung die rekursive Cleanup-Prüfung wieder erfolgreich durchläuft. `persist-credentials: false` bleibt in der Fork-PR-CI erhalten. Für eine spätere Wiederherstellung zuerst die tatsächlichen Quell-Repositories und die genannten Objekte verifizieren.
