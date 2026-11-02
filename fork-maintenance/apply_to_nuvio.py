#!/usr/bin/env python3
"""Add a 'Watch in Browser' sharing action to Nuvio Desktop's player party panel.

This patch is intentionally surgical, refuses unknown upstream revisions, and keeps
all of Nuvio's original source files untouched until its anchors are verified.
Requires a locally cloned NuvioMedia/NuvioDesktop checkout.
"""
import argparse
from pathlib import Path
import sys

PARTY_JS = Path('composeApp/src/desktopMain/resources/player-ui/party.js')
CONTROLS = Path('composeApp/src/commonMain/kotlin/com/nuvio/app/features/player/PlayerScreenRuntimePartyControls.kt')
RUNTIME = Path('composeApp/src/commonMain/kotlin/com/nuvio/app/features/player/PlayerScreenRuntimeState.kt')
GRADLE = Path('composeApp/build.gradle.kts')
TAG = 'NUVIO_BROWSER_PARTY_BRIDGE_V1'

JS_INSERT = r'''// NUVIO_BROWSER_PARTY_BRIDGE_V1: Link to the independently hosted browser guest.
const partyBrowserHostStorage = "nuvio-browser-party-host";
const partyBrowserHost = () => {
  try { return window.localStorage.getItem(partyBrowserHostStorage) || ""; }
  catch { return ""; }
};

const buildPartyBrowserShare = party => {
  const section = partyElement("div", "party-section");
  section.appendChild(partyElement("p", "party-switch-title", "Watch in Browser"));
  section.appendChild(partyElement("p", "party-text", "Let friends watch from a browser, without installing Nuvio. Set up your own free HTTPS browser site once."));
  const address = partyElement("input", "party-browser-host");
  address.setAttribute("aria-label", "Browser player URL");
  address.setAttribute("type", "url");
  address.setAttribute("inputmode", "url");
  address.placeholder = "https://your-project.pages.dev";
  address.value = partyBrowserHost();
  address.autocomplete = "off";
  Object.assign(address.style, {
    width: "100%", boxSizing: "border-box", margin: "10px 0",
    border: "1px solid #555", borderRadius: "9px", color: "#f5f5f5",
    padding: "10px 12px", background: "#242424", fontSize: "14px"
  });
  section.appendChild(address);
  const note = partyElement("p", "party-note", "The browser viewer needs a Nuvio account. Sharing your stream may expose its underlying URL to party members. Never include a password or API key in this address.");
  section.appendChild(note);
  address.addEventListener("change", () => {
    try { window.localStorage.setItem(partyBrowserHostStorage, address.value.trim()); } catch { /* session only */ }
  });
  const inviteUrl = () => {
    const raw = address.value.trim();
    let parsed;
    try {
      parsed = new URL(raw);
      if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== "/" && parsed.pathname !== "")) throw Error("invalid address");
    } catch {
      note.textContent = "Enter the HTTPS home address of your deployed browser player (example: https://your-project.pages.dev).";
      return;
    }
    const code = String(party.code || "").trim();
    if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) {
      note.textContent = "The party code is invalid.";
      return;
    }
    const invite = `${parsed.origin}/party/${encodeURIComponent(code)}`;
    try { window.localStorage.setItem(partyBrowserHostStorage, parsed.origin); } catch { /* session only */ }
    return invite;
  };
  const onClick = () => {
    const invite = inviteUrl();
    if (!invite) return;
    const copy = confirmed => {
      send(`partyBrowserInvite:${partyEncodeText(invite)}`, confirmed ? 1 : 0);
      note.textContent = "Link requested. Check Nuvio's clipboard confirmation. Keep the host player open; stream compatibility is checked by each browser.";
    };
    if (party.sharing) return copy(false);
    showPartyConfirm({
      title: "Share the stream source?",
      message: "Browser playback needs 'Share my stream' enabled. Participants can see the stream address, which may contain credentials. Only use sources you are authorized to share.",
      confirmLabel: "Enable and copy link",
      danger: false,
      onConfirm: () => copy(true),
    });
  };
  section.appendChild(partyButtonElement("Watch in Browser · Copy link", "primary", "browserShare", onClick));
  return section;
};

'''

KOTLIN_HANDLER = '''    // NUVIO_BROWSER_PARTY_BRIDGE_V1: accept only this party's HTTPS browser invite.
    if (type.startsWith(BROWSER_INVITE_EVENT)) {
        val party = PartyRepository.state.value.party
        val url = runCatching {
            Base64.UrlSafe.withPadding(Base64.PaddingOption.ABSENT_OPTIONAL)
                .decode(type.removePrefix(BROWSER_INVITE_EVENT))
                .decodeToString()
        }.getOrNull()
        if (party?.isHost == true && url != null &&
            url.length <= 2048 &&
            Regex("^https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?/party/${Regex.escape(party.code)}$").matches(url)) {
            // A value of 1 is sent only by the explicit confirmation action.
            if (value >= 0.5) PartyRepository.setSharing(true)
            copyBrowserInvite(url)
        } else {
            showPartyMessage("Invalid browser invite")
        }
        return true
    }
'''

PATCHES = {
    GRADLE: [
        ('    localPropertiesFile.set(rootProject.layout.projectDirectory.file("local.properties"))',
         '    // NUVIO_BROWSER_PARTY_BRIDGE_V1: optional file must be unset if absent.\n'
         '    if (rootProject.file("local.properties").exists()) {\n'
         '        localPropertiesFile.set(rootProject.layout.projectDirectory.file("local.properties"))\n'
         '    }'),
    ],
    PARTY_JS: [
        ('const buildPartyHostSettings = party => {', JS_INSERT + 'const buildPartyHostSettings = party => {'),
        ('  if (party.isHost) content.appendChild(buildPartyHostSettings(party));',
         '  if (party.isHost) {\n    content.appendChild(buildPartyHostSettings(party));\n    content.appendChild(buildPartyBrowserShare(party));\n  }'),
    ],
    RUNTIME: [
        ('    var copyPartyInvite: () -> Unit = {}',
         '    var copyPartyInvite: () -> Unit = {}\n    // NUVIO_BROWSER_PARTY_BRIDGE_V1\n    var copyBrowserInvite: (String) -> Unit = {}'),
    ],
    CONTROLS: [
        ('    SideEffect {\n        copyPartyInvite = {\n',
         '    SideEffect {\n        copyBrowserInvite = { url ->\n            clipboard.setText(AnnotatedString(url))\n            showPartyMessage("Browser link copied")\n        }\n        copyPartyInvite = {\n'),
        ('    if (type.startsWith(CHAT_SEND_EVENT)) {', KOTLIN_HANDLER + '    if (type.startsWith(CHAT_SEND_EVENT)) {'),
        ('private const val REMOVE_MEMBER_EVENT = "partyRemoveMember:"',
         'private const val BROWSER_INVITE_EVENT = "partyBrowserInvite:"\nprivate const val REMOVE_MEMBER_EVENT = "partyRemoveMember:"'),
    ],
}

def apply(repo: Path, dry_run: bool) -> None:
    files = {}
    for relative, replacements in PATCHES.items():
        path = repo / relative
        if not path.is_file():
            raise ValueError(f'Missing Nuvio source file: {path}')
        original = path.read_text(encoding='utf-8')
        current = original
        if TAG in current:
            if not all(new in current for _, new in replacements):
                raise ValueError(f'Partial or older bridge patch in {relative}; inspect the diff before updating')
            print(f'Already patched and verified: {relative}')
            continue
        for old, new in replacements:
            count = current.count(old)
            if count != 1:
                raise ValueError(f'Expected one matching anchor in {relative}, found {count}: {old[:100]!r}')
            current = current.replace(old, new, 1)
        files[path] = (original, current)
    if not files:
        print('Nothing to do; patch is already installed.')
        return
    if dry_run:
        for path in files:
            print('PATCHABLE:', path.relative_to(repo))
        return
    for path, (original, current) in files.items():
        backup = path.with_suffix(path.suffix + '.pre-browser-bridge.bak')
        if not backup.exists():
            backup.write_text(original, encoding='utf-8')
        path.write_text(current, encoding='utf-8')
        print('UPDATED:', path.relative_to(repo))
    print('Patch applied. Nuvio Desktop is now ready to build. Browser site is separate.')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('repo', type=Path, help='Path to NuvioDesktop checkout')
    parser.add_argument('--check', action='store_true', help='Validate patch anchors, do not change files')
    args = parser.parse_args()
    try:
        apply(args.repo.expanduser().resolve(), args.check)
    except (ValueError, OSError) as exc:
        print('Patch stopped without further changes:', exc, file=sys.stderr)
        sys.exit(1)
