#!/usr/bin/env bash
# Fails when an upstream merge removed or reverted a fork feature. Static checks
# only (grep/test); nothing fetched is executed.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

failures=0
need_file() { [[ -f "$1" ]] || { echo "::error::Fork file missing: $1"; failures=$((failures + 1)); }; }
need_text() { grep -qF -- "$2" "$1" 2>/dev/null || { echo "::error::Fork marker missing in $1: $2"; failures=$((failures + 1)); }; }

# Browser watch party (Cloudflare Pages) and its tests.
need_file browser-site/package.json
need_file browser-site/src/main.js
need_file browser-site/src/sync-policy.js
need_file browser-site/tests/personal-hls-integration.test.js
# Desktop bridge, invitation link and browser control smoothing.
need_text composeApp/src/desktopMain/resources/player-ui/party.js 'NUVIO_BROWSER_PARTY_BRIDGE_V1'
need_text composeApp/src/desktopMain/resources/player-ui/party.js 'nuvio-browser-party-host-v2'
need_text composeApp/src/commonMain/kotlin/com/nuvio/app/features/party/PartyRepository.kt 'WATCH_PARTY_BROWSER_ORIGIN = "https://nuvio-watch-friends.pages.dev"'
# Host-sequenced guest commands (command ID, ack) and event-based remote apply.
need_file composeApp/src/commonMain/kotlin/com/nuvio/app/features/party/PartyCommands.kt
need_text composeApp/src/commonMain/kotlin/com/nuvio/app/features/party/PartyChannel.kt '"chat", "command"'
need_text composeApp/src/commonMain/kotlin/com/nuvio/app/features/party/PartyRepository.kt 'private suspend fun onCommand('
need_text composeApp/src/commonMain/kotlin/com/nuvio/app/features/player/PlayerScreenRuntimeParty.kt 'var awaitingApply: PartyPlayback?'
# Frame-accurate paused party seek (native bridge + party loop) and the stale-bridge guard.
need_text composeApp/src/desktopMain/native/windows/player_bridge.cpp 'exact ? "absolute+exact" : "absolute+keyframes"'
need_text composeApp/src/desktopMain/native/windows/player_bridge.cpp 'NativePlayerBridge_seekToExact'
need_text composeApp/src/commonMain/kotlin/com/nuvio/app/features/player/PlayerScreenRuntimeParty.kt 'controller.seekToExact('
need_text composeApp/build.gradle.kts 'windowsPlayerBridgeSource.asFile.lastModified() > output.lastModified()'
# Invitation origin: production by default, the preview only via the checked build property.
need_text composeApp/build.gradle.kts 'nuvio.party.browserOrigin must be'
need_text fork-maintenance/verify-msi.ps1 'AllowPreviewOrigin'
need_text browser-site/src/session.js 'export const COMMAND_PROTOCOL = 1;'
# TorBox HLS for browser guests.
need_file composeApp/src/commonMain/kotlin/com/nuvio/app/features/debrid/TorboxPartyHls.kt
need_text composeApp/src/commonMain/kotlin/com/nuvio/app/features/party/PartyModels.kt '@SerialName("browser_hls")'
# Shared separate video (YouTube/MP4/WebM, links protocol 1).
need_file composeApp/src/commonMain/kotlin/com/nuvio/app/features/party/PartyLinks.kt
need_text browser-site/src/shared-source.js 'export const LINK_PROTOCOL = 1;'
need_text composeApp/src/commonMain/kotlin/com/nuvio/app/features/party/PartyChannel.kt '"shared_source"'
# ... played in the Desktop player view (WebView2 virtual HTTPS host for link-player.html).
need_file composeApp/src/desktopMain/resources/player-ui/link-player.html
need_text composeApp/src/desktopMain/native/windows/player_bridge.cpp 'NUVIO_LINK_HOST = L"nuvio-link.example"'
# Intro-skip configuration guard.
need_text composeApp/build.gradle.kts 'INTRODB_API_URL missing or not https'
# WebView2 loader guard: SDK path relative to the root, staged runtime checked.
need_text composeApp/build.gradle.kts '?.let { rootProject.file(it) }'
need_text composeApp/build.gradle.kts 'WebView2Loader.dll missing from the staged player runtime'
# Fork updater: only this fork's releases, checksum required.
need_text composeApp/src/desktopMain/kotlin/com/nuvio/app/features/updater/AppUpdaterPlatform.desktop.kt 'forkReleaseOwner = "lebochoffice"'
need_text composeApp/src/desktopMain/kotlin/com/nuvio/app/features/updater/AppUpdaterPlatform.desktop.kt 'actual val requiresUpdateChecksum: Boolean = true'
# Fork-only automation.
for f in .github/workflows/fork-windows-msi.yml .github/workflows/fork-upstream-review.yml .github/workflows/fork-release.yml fork-maintenance/verify-msi.ps1 fork-maintenance/build-ci.ps1; do need_file "$f"; done

if (( failures > 0 )); then
  echo "Fork invariants failed ($failures). The upstream update must not be merged as is." >&2
  exit 1
fi
echo 'Fork invariants OK.'
