# Watch in Browser im persönlichen NuvioDesktop-Fork

Der Desktop-Player besitzt einen zusätzlichen **Watch in Browser · Copy link**-Button im Host-Panel. Dort den eigenen HTTPS-Website-Ursprung eingeben. Die Streamfreigabe wird nur nach ausdrücklicher Bestätigung aktiviert. Der normale Nuvio-Link bleibt erhalten.

Der Browser-Client liegt in [browser-site/](browser-site/README.md). Dort stehen Konfiguration, kostenloses Cloudflare-Pages-Hosting und die Grenzen von Formaten, Headern und CORS. Er benötigt dieselben autorisierten öffentlichen Backend-Werte wie der Desktop. Diese stehen lokal in ignorierten Konfigurationsdateien und werden nicht im Quellcode hinterlegt.

Ein wichtiger Unterschied zum ursprünglichen Prototyp: Nuvios Gateway benötigt den zusätzlichen WebSocket-Parameter `nuvio_realtime=1`, entsprechend `SupabaseEndpointConfig.realtimeUrl`. Ein erfolgreicher RPC-Beitritt allein genügt nicht. Ohne den Parameter schlug der echte WebSocket-Test fehl; mit ihm funktionierten Verbindungsaufbau, authentifizierter Party-Beitritt und Empfang der vom normalen Desktop freigegebenen Quelle.

Eine modifizierte Desktop-App ist für den Empfang des bestehenden Protokolls nicht erforderlich. Die Desktop-Anpassung ergänzt Linkerzeugung, Bestätigung und Kopieren. Wenn eine Quelle MKV/AVI/Torrent/DASH oder besondere Header benötigt, zeigt der Browser eine ausdrückliche Fehlermeldung. Er wandelt die Quelle nicht um und überträgt keinen Bildschirm. Ein kompatibler Container garantiert noch keinen unterstützten Audio-/Video-Codec.

Die Regeln für Update-PRs, manuelle Windows-CI-Builds und GitHub-Einstellungen stehen in [fork-maintenance/README.md](fork-maintenance/README.md). Änderungen werden zur menschlichen Prüfung als PR bereitgestellt; es gibt kein automatisches Merge, Deployment oder Release.

Den aktuellen Stand und die Grenzen der Prüfungen dokumentiert [INTEGRATION_STATUS.md](INTEGRATION_STATUS.md). NuvioDesktop und die abgeleiteten Anpassungen unterliegen GPL-3.0; Lizenz und entsprechenden Quellcode bei Weitergabe mitliefern.
