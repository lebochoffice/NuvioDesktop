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
# Event sync: host-announced mode, menu choice, no drift correction, no party-wide waits.
need_text composeApp/src/desktopMain/resources/player-ui/party.js 'const buildPartySyncMode'
need_text composeApp/src/commonMain/kotlin/com/nuvio/app/features/party/PartyModels.kt 'enum class PartySyncMode'
need_text composeApp/src/commonMain/kotlin/com/nuvio/app/features/party/PartyRepository.kt 'fun setSyncMode(mode: PartySyncMode)'
need_text composeApp/src/commonMain/kotlin/com/nuvio/app/features/player/PlayerScreenRuntimeParty.kt 'PartySync.eventNeedsPosition('
need_text browser-site/src/session.js 'export const syncModeOf'
# Desktop space bar after the pause overlay (AWT fallback, focus return, no Compose duplicate).
need_file composeApp/src/desktopMain/kotlin/com/nuvio/app/features/player/desktop/DesktopPlayerSpaceFallback.kt
need_text composeApp/src/desktopMain/kotlin/com/nuvio/app/features/player/desktop/NativePlayerController.kt 'DesktopPlayerSpaceFallback()'
need_text composeApp/src/commonMain/kotlin/com/nuvio/app/features/player/PlayerScreenRuntimeUi.kt 'visible = !isDesktop && playerSettingsUiState.pauseOverlayEnabled'
# Skip-intro resilience: parallel providers, no cached transient failures, bounded retries.
need_file composeApp/src/commonMain/kotlin/com/nuvio/app/features/player/skip/SkipLookupResilience.kt
need_text composeApp/src/commonMain/kotlin/com/nuvio/app/features/player/PlayerScreenRuntimeEffects.kt 'resolveSkipIntervalsWithRetry('
need_text composeApp/src/commonMain/kotlin/com/nuvio/app/features/party/PartyRepository.kt 'WATCH_PARTY_BROWSER_ORIGIN = "https://family-beta.nuvio-watch-friends.pages.dev"'
need_text composeApp/src/commonMain/kotlin/com/nuvio/app/features/party/PartyRepository.kt 'WATCH_PARTY_BROWSER_PRODUCTION_ORIGIN = "https://nuvio-watch-friends.pages.dev"'
need_text composeApp/src/commonMain/kotlin/com/nuvio/app/features/party/PartyRepository.kt 'PartyBrowserConfig.ORIGIN.takeIf { it == WATCH_PARTY_BROWSER_PRODUCTION_ORIGIN } ?: WATCH_PARTY_BROWSER_ORIGIN'
# Host-sequenced guest commands (command ID, ack) and event-based remote apply.
need_file composeApp/src/commonMain/kotlin/com/nuvio/app/features/party/PartyCommands.kt
need_text composeApp/src/commonMain/kotlin/com/nuvio/app/features/party/PartyChannel.kt '"command")'
need_text composeApp/src/commonMain/kotlin/com/nuvio/app/features/party/PartyRepository.kt 'private suspend fun onCommand('
need_text composeApp/src/commonMain/kotlin/com/nuvio/app/features/player/PlayerScreenRuntimeParty.kt 'var awaitingApply: PartyPlayback?'
# Frame-accurate paused party seek (native bridge + party loop) and the stale-bridge guard.
need_text composeApp/src/desktopMain/native/windows/player_bridge.cpp 'exact ? "absolute+exact" : "absolute+keyframes"'
need_text composeApp/src/desktopMain/native/windows/player_bridge.cpp 'NativePlayerBridge_seekToExact'
need_text composeApp/src/commonMain/kotlin/com/nuvio/app/features/player/PlayerScreenRuntimeParty.kt 'controller.seekToExact('
need_text composeApp/build.gradle.kts 'windowsPlayerBridgeSource.asFile.lastModified() > output.lastModified()'
# Hosted MSI builds explicitly select production. Local builds may use the validated preview fallback.
need_text composeApp/build.gradle.kts 'nuvio.party.browserOrigin must be'
need_text composeApp/build.gradle.kts '"production", partyBrowserProductionOrigin -> partyBrowserProductionOrigin'
need_text fork-maintenance/build-ci.ps1 '-Pnuvio.party.browserOrigin=production'
need_text fork-maintenance/verify-msi.ps1 'AllowPreviewOrigin'
need_text browser-site/src/session.js 'export const COMMAND_PROTOCOL = 1;'
# TorBox HLS for browser guests.
need_file composeApp/src/commonMain/kotlin/com/nuvio/app/features/debrid/TorboxPartyHls.kt
need_text composeApp/src/commonMain/kotlin/com/nuvio/app/features/party/PartyModels.kt '@SerialName("browser_hls")'
# Intro-skip configuration guard.
need_text composeApp/build.gradle.kts 'INTRODB_API_URL missing or not https'
# WebView2 loader guard: SDK path relative to the root, staged runtime checked.
need_text composeApp/build.gradle.kts '?.let { rootProject.file(it) }'
need_text composeApp/build.gradle.kts 'WebView2Loader.dll missing from the staged player runtime'
# Local packaging must preserve the isolated Family identity and leave desktop updates manual.
need_text composeApp/build.gradle.kts 'windowsA40Fork -> "e3bc93a6-7e5c-4a95-a902-bdc61b8324e3"'
need_text composeApp/build.gradle.kts 'else -> "dfe71c5b-c265-42ce-a025-396193575a13"'
need_text composeApp/src/desktopMain/kotlin/com/nuvio/app/core/build/AppFeaturePolicy.desktop.kt 'inAppUpdaterEnabled: Boolean = false'
need_text composeApp/src/desktopMain/kotlin/com/nuvio/app/features/updater/AppUpdaterPlatform.desktop.kt 'canInstallDownloadedUpdate(): Boolean = false'
for f in .github/workflows/fork-windows-msi.yml fork-maintenance/verify-msi.ps1 fork-maintenance/build-ci.ps1; do need_file "$f"; done

if (( failures > 0 )); then
  echo "Fork invariants failed ($failures). The upstream update must not be merged as is." >&2
  exit 1
fi
echo 'Fork invariants OK.'
