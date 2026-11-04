const partyButton = document.getElementById("partyButton");
const partyPill = document.getElementById("partyPill");
const partyPillStack = document.getElementById("partyPillStack");
const partyPillText = document.getElementById("partyPillText");
const partyModal = document.getElementById("partyModal");
const partyPanel = partyModal.querySelector(".party-panel");
const partyPanelTitle = document.getElementById("partyPanelTitle");
const partyCloseButton = document.getElementById("partyCloseButton");
const partyBody = document.getElementById("partyBody");
const partyConfirm = document.getElementById("partyConfirm");
const partyConfirmTitle = document.getElementById("partyConfirmTitle");
const partyConfirmMessage = document.getElementById("partyConfirmMessage");
const partyConfirmCancel = document.getElementById("partyConfirmCancel");
const partyConfirmAccept = document.getElementById("partyConfirmAccept");
const partyPillBadge = document.getElementById("partyPillBadge");
const partyTabs = document.getElementById("partyTabs");
const partyTabIndicator = document.getElementById("partyTabIndicator");
const partyTabParty = document.getElementById("partyTabParty");
const partyTabChat = document.getElementById("partyTabChat");
const partyTabBadge = document.getElementById("partyTabBadge");
const partyChatBox = document.getElementById("partyChat");
const partyChatViewport = document.getElementById("partyChatViewport");
const partyChatScroll = document.getElementById("partyChatScroll");
const partyChatList = document.getElementById("partyChatList");
const partyChatEmpty = document.getElementById("partyChatEmpty");
const partyChatEmptyTitle = document.getElementById("partyChatEmptyTitle");
const partyChatEmptyMessage = document.getElementById("partyChatEmptyMessage");
const partyChatNew = document.getElementById("partyChatNew");
const partyChatNewLabel = document.getElementById("partyChatNewLabel");
const partyChatInput = document.getElementById("partyChatInput");
const partyChatSend = document.getElementById("partyChatSend");
const partyCodeLength = 6;
const partyChatAvatarSize = 28;
const partyChatMaxLength = 500;
const partyChatMaxInputHeight = 102;
const partyChatCompactHeight = 150;
const partyChatBottomSlack = 24;
const partyChatScrollMs = 300;
const partyCopiedDurationMs = 1800;
const partyMessageDurationMs = 2500;
const partySwitchSettleMs = 1500;

let partyPillKey = "";
let partyPanelKey = "";
let partyKnownMemberIds = null;
let partyCopiedUntil = 0;
let partyCopiedTimer = 0;
let partyConfirmHandler = null;
let partyTab = "party";
let partyChatSentVisible = false;
let partyChatReady = false;
let partyChatNewestKey = "";
let partyChatNewBelow = false;
let partyChatScrollFrame = 0;
let partyChatSignature = "";
let partyChatComposerFrame = 0;
const partyChatRows = new Map();

const currentParty = () => (state.party && typeof state.party === "object" ? state.party : {});

const partyLabel = (key, fallback = "") => {
  const labels = currentParty().labels;
  const value = labels && typeof labels === "object" ? labels[key] : "";
  return String(value || fallback);
};

const partyMembers = () => normalizeItems(currentParty().members);

const currentPartyChat = () => {
  const chat = currentParty().chat;
  return chat && typeof chat === "object" ? chat : {};
};

const partyUnreadCount = () => (currentParty().active ? Math.max(0, Number(currentPartyChat().unread) || 0) : 0);

const partyElement = (tag, className = "", text = null) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== null) element.textContent = text;
  return element;
};

const partyIcon = name => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#${name}`);
  svg.appendChild(use);
  return svg;
};

const partyAction = (element, focusKey, onClick) => {
  element.type = "button";
  element.dataset.partyFocus = focusKey;
  element.addEventListener("click", event => {
    event.stopPropagation();
    onClick();
  });
  return element;
};

const partyButtonElement = (label, variant, focusKey, onClick) => {
  const button = partyElement("button", variant ? `party-button ${variant}` : "party-button");
  button.appendChild(partyElement("span", "", label));
  return partyAction(button, focusKey, onClick);
};

const partyIconButton = (icon, label, className, focusKey, onClick) => {
  const button = partyElement("button", className ? `party-icon-button ${className}` : "party-icon-button");
  button.setAttribute("aria-label", label);
  button.title = label;
  button.appendChild(partyIcon(icon));
  return partyAction(button, focusKey, onClick);
};

const partyAvatarColor = value => {
  const color = String(value || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : "";
};

const buildPartyAvatar = (member, size, presence = "") => {
  const avatar = partyElement("span", "party-avatar");
  avatar.style.setProperty("--party-avatar-size", `${size}px`);
  const face = partyElement("span", "party-avatar-face", member.initial || "");
  const color = partyAvatarColor(member.color);
  if (color) face.style.background = color;
  const imageUrl = String(member.imageUrl || "").trim();
  if (imageUrl) {
    const image = document.createElement("img");
    image.alt = "";
    image.decoding = "async";
    image.addEventListener("error", () => image.classList.add("image-error"));
    image.src = imageUrl;
    face.appendChild(image);
  }
  avatar.appendChild(face);
  if (presence) avatar.appendChild(partyElement("span", `party-presence ${presence}`));
  return avatar;
};

const buildPartyOpenSeat = size => {
  const seat = partyElement("span", "party-open-seat");
  seat.style.setProperty("--party-avatar-size", `${size}px`);
  seat.appendChild(partyIcon("icon-add"));
  return seat;
};

const buildPartyStack = (container, members, size) => {
  container.textContent = "";
  const shown = members.slice(0, 3);
  const extra = members.length - shown.length;
  const slots = shown.length + (extra > 0 ? 1 : 0);
  const step = size * 0.7;
  container.style.width = `${size + step * Math.max(0, slots - 1)}px`;
  container.style.height = `${size}px`;
  const appendSlot = (index, content) => {
    const slot = partyElement("span", "party-stack-slot");
    slot.style.left = `${step * index}px`;
    slot.style.zIndex = String(slots - index);
    slot.appendChild(content);
    container.appendChild(slot);
  };
  shown.forEach((member, index) => appendSlot(index, buildPartyAvatar(member, size)));
  if (extra > 0) {
    const more = partyElement("span", "party-avatar");
    more.style.setProperty("--party-avatar-size", `${size}px`);
    more.appendChild(partyElement("span", "party-avatar-face extra", `+${extra}`));
    appendSlot(shown.length, more);
  }
};

const updatePartyBadge = (badge, count) => {
  const label = badge.querySelector(".party-unread-count");
  window.clearTimeout(badge.hideTimer);
  if (count > 0) {
    label.textContent = count > 9 ? "9+" : String(count);
    if (badge.hidden || badge.classList.contains("leaving")) {
      badge.hidden = false;
      badge.classList.remove("leaving", "entering");
      void badge.offsetWidth;
      badge.classList.add("entering");
    }
    return;
  }
  if (badge.hidden || badge.classList.contains("leaving")) return;
  badge.classList.add("leaving");
  badge.hideTimer = window.setTimeout(() => {
    badge.hidden = true;
    badge.classList.remove("leaving", "entering");
  }, 160);
};

const renderPartyChrome = () => {
  const party = currentParty();
  const title = partyLabel("title", "Watch party");
  partyButton.hidden = !party.available;
  partyButton.classList.toggle("party-active", Boolean(party.active));
  partyButton.setAttribute("aria-label", title);
  partyButton.setAttribute("title", title);

  const members = partyMembers();
  const message = String(party.pillMessage || "").trim();
  const visible = Boolean(
    party.active &&
    members.length &&
    (state.controlsVisible || party.pillPinned) &&
    !activeModal &&
    !state.isInPip,
  );
  root.classList.toggle("party-pill-visible", visible);
  partyPill.classList.toggle("visible", visible);
  partyPill.setAttribute("aria-hidden", visible ? "false" : "true");
  partyPill.tabIndex = visible ? 0 : -1;
  partyPill.setAttribute("aria-label", message || title);

  updatePartyBadge(partyPillBadge, partyUnreadCount());

  const stackKey = members.map(member => [member.id, member.initial, member.imageUrl, member.color].join(":")).join("|");
  if (stackKey !== partyPillKey) {
    partyPillKey = stackKey;
    buildPartyStack(partyPillStack, members, 28);
  }
  if (partyPillText.textContent !== message) {
    partyPillText.textContent = message;
    partyPillText.classList.remove("changed");
    if (message) {
      void partyPillText.offsetWidth;
      partyPillText.classList.add("changed");
    }
  }
};

const copyPartyInvite = () => {
  send("partyCopyInvite", 0);
  partyCopiedUntil = Date.now() + partyCopiedDurationMs;
  window.clearTimeout(partyCopiedTimer);
  partyCopiedTimer = window.setTimeout(() => {
    if (activeModal === "party") renderPartyModal();
  }, partyCopiedDurationMs + 20);
  if (activeModal === "party") renderPartyModal();
};

const showPartyConfirm = ({ title, message, confirmLabel, danger, onConfirm }) => {
  partyConfirmHandler = onConfirm;
  partyConfirmTitle.textContent = title || "";
  partyConfirmMessage.textContent = message || "";
  partyConfirmMessage.hidden = !message;
  partyConfirmCancel.textContent = partyLabel("cancel", "Cancel");
  partyConfirmAccept.textContent = confirmLabel || "";
  partyConfirmAccept.classList.toggle("danger", Boolean(danger));
  partyConfirmAccept.classList.toggle("primary", !danger);
  partyPanel.inert = true;
  partyConfirm.hidden = false;
  partyConfirmAccept.focus({ preventScroll: true });
};

const closePartyConfirm = () => {
  partyConfirmHandler = null;
  partyConfirm.hidden = true;
  partyPanel.inert = false;
};

const isPartyConfirmOpen = () => activeModal === "party" && !partyConfirm.hidden;

const buildPartyStart = party => {
  const content = partyElement("div", "party-start");
  const hero = partyElement("div", "party-seats-hero");
  const step = 56 * 0.72;
  [2, 1].forEach(index => {
    const seat = buildPartyOpenSeat(56);
    seat.style.left = `${step * index}px`;
    hero.appendChild(seat);
  });
  const profile = buildPartyAvatar(party.profile || {}, 56);
  profile.style.left = "0";
  hero.appendChild(profile);
  content.appendChild(hero);
  content.appendChild(partyElement("h2", "party-start-title", partyLabel("startTitle")));
  content.appendChild(partyElement("p", "party-text", partyLabel("startDescription")));
  const note = String(party.startNote || "").trim();
  if (note) {
    content.appendChild(partyElement("p", "party-note", note));
  } else {
    const start = partyButtonElement(partyLabel("startAction"), "primary party-start-action", "start", () => send("partyStart", 0));
    if (party.busy) {
      start.disabled = true;
      start.prepend(partyElement("span", "party-spinner"));
    }
    content.appendChild(start);
  }
  content.appendChild(partyElement("p", "party-experimental", partyLabel("experimental")));
  return content;
};

const buildPartyCode = party => {
  const section = partyElement("div", "party-code");
  const header = partyElement("div", "party-row");
  if (party.connected) {
    header.appendChild(partyElement("span", "party-label", partyLabel("codeLabel")));
  } else {
    const status = partyElement("span", "party-label accent party-row");
    status.appendChild(partyElement("span", "party-pulsing-dot"));
    status.appendChild(partyElement("span", "", partyLabel("reconnecting")));
    header.appendChild(status);
  }
  const copied = partyCopiedUntil > Date.now();
  header.appendChild(partyIconButton(
    copied ? "icon-check" : "icon-copy",
    partyLabel("copyInvite"),
    copied ? "done" : "",
    "copy",
    copyPartyInvite,
  ));
  section.appendChild(header);
  const slots = partyElement("div", "party-code-slots");
  const code = String(party.code || "");
  for (let index = 0; index < partyCodeLength; index += 1) {
    const slot = partyElement("div", "party-code-slot");
    slot.appendChild(partyElement("span", "party-code-char", code.charAt(index)));
    slot.appendChild(partyElement("span", "party-code-line"));
    slots.appendChild(slot);
  }
  section.appendChild(slots);
  return section;
};

const confirmPartyRemoval = member => showPartyConfirm({
  title: member.removeTitle,
  message: partyLabel("removeMessage"),
  confirmLabel: partyLabel("remove"),
  danger: true,
  onConfirm: () => send(`partyRemoveMember:${member.id}`, 0),
});

const buildPartyMembers = party => {
  const section = partyElement("div", "party-members");
  const members = partyMembers();
  const total = Math.max(0, Number(party.maxMembers) || 0);
  const header = partyElement("div", "party-members-header");
  header.appendChild(partyElement("span", "party-label", party.seatsLabel || ""));
  const dots = partyElement("div", "party-seat-dots");
  for (let index = 0; index < total; index += 1) {
    dots.appendChild(partyElement("span", index < members.length ? "party-seat-dot filled" : "party-seat-dot"));
  }
  header.appendChild(dots);
  section.appendChild(header);

  const known = partyKnownMemberIds;
  members.forEach(member => {
    const entering = known !== null && !known.has(member.id);
    const row = partyElement("div", entering ? "party-member-row entering" : "party-member-row");
    row.appendChild(buildPartyAvatar(member, 44, member.presence || "offline"));
    const copy = partyElement("div", "party-member-copy");
    const nameRow = partyElement("div", "party-row");
    nameRow.appendChild(partyElement("span", "party-member-name", member.name || ""));
    if (member.isHost) nameRow.appendChild(partyElement("span", "party-host-tag", partyLabel("host")));
    copy.appendChild(nameRow);
    copy.appendChild(partyElement("span", "party-member-status", member.status || ""));
    row.appendChild(copy);
    if (member.familyShare) row.appendChild(buildPartyShareToggle(member));
    if (member.canRemove) {
      row.appendChild(partyIconButton("icon-remove", partyLabel("remove"), "muted", `remove:${member.id}`, () => confirmPartyRemoval(member)));
    }
    section.appendChild(row);
  });
  partyKnownMemberIds = new Set(members.map(member => member.id));
  const familyStatus = String(party.familyStatus || "").trim();
  if (members.some(member => member.familyShare) && familyStatus) section.appendChild(partyElement("p", "party-detail", familyStatus));

  if (members.length < total) {
    const invite = partyAction(partyElement("button", "party-open-seat-row"), "invite", copyPartyInvite);
    invite.appendChild(buildPartyOpenSeat(44));
    invite.appendChild(partyElement("span", "party-open-seat-label", partyLabel("openSeat")));
    section.appendChild(invite);
  }
  return section;
};

// Stream share per member: only members switched on here receive a TorBox
// stream that carries the account token (through the family share service).
const buildPartyShareToggle = member => {
  const on = member.familyShare === "on";
  const toggle = partyAction(partyElement("button", on ? "party-share-toggle on" : "party-share-toggle"), `family:${member.id}`,
    () => send(`partyFamilyAdmit:${String(member.id)}`, on ? 0 : 1));
  toggle.setAttribute("aria-pressed", String(on));
  toggle.title = on ? "Stream freigegeben – klicken zum Entziehen" : "Stream für dieses Mitglied freigeben";
  toggle.appendChild(partyIcon(on ? "icon-check" : "icon-add"));
  toggle.appendChild(partyElement("span", "", on ? "Freigegeben" : "Freigeben"));
  return toggle;
};

const buildPartySwitch = (key, title, description, checked, eventType) => {
  const row = partyAction(partyElement("button", "party-switch-row"), key, () => {
    const next = row.getAttribute("aria-checked") !== "true";
    const apply = () => {
    row.setAttribute("aria-checked", String(next));
    send(eventType, next ? 1 : 0);
    window.setTimeout(() => {
      partyPanelKey = "";
      if (activeModal === "party") renderPartyModal();
    }, partySwitchSettleMs);
    };
    if (eventType === "partySharing" && next) {
      showPartyConfirm({
        title: "Stream mit der Party teilen?",
        message: "Mitglieder können die Quelladresse sehen. TorBox-Streams mit Account-Key erhalten nur Mitglieder, die du in der Liste freigibst.",
        confirmLabel: "Teilen", danger: false, onConfirm: apply,
      });
    } else apply();
  });
  row.setAttribute("role", "switch");
  row.setAttribute("aria-checked", String(Boolean(checked)));
  const copy = partyElement("span", "party-switch-copy");
  copy.appendChild(partyElement("span", "party-switch-title", title));
  copy.appendChild(partyElement("span", "party-switch-description", description));
  row.appendChild(copy);
  row.appendChild(partyElement("span", "party-switch"));
  return row;
};

// NUVIO_BROWSER_PARTY_BRIDGE_V1: Link to the independently hosted browser guest.
// v2 key: values stored by older builds (e.g. preview URLs) are ignored.
const partyBrowserProductionHost = "https://nuvio-watch-friends.pages.dev";
const partyBrowserAllowedPreviewHost = "https://feature-party-premium-ui.nuvio-watch-friends.pages.dev";
// The build decides the default (production, or the preview in a test build);
// any other value from the app is ignored.
let partyBrowserDefaultHost = partyBrowserProductionHost;
const setPartyBrowserDefaultHost = origin => {
  partyBrowserDefaultHost = origin === partyBrowserAllowedPreviewHost ? partyBrowserAllowedPreviewHost : partyBrowserProductionHost;
};
const partyBrowserHostStorage = "nuvio-browser-party-host-v2";
// Cloudflare preview deployments (<hash>.<project>.pages.dev) are never
// used as invitation targets, except the one preview this build
// was explicitly configured for.
const partyBrowserPreviewHost = host => /\.pages\.dev$/i.test(host) && host.split(".").length > 3 &&
  !(partyBrowserDefaultHost === partyBrowserAllowedPreviewHost && `https://${host.toLowerCase()}` === partyBrowserAllowedPreviewHost);
const partyBrowserHost = () => {
  // A preview test build always invites to its preview (a stored production
  // address from earlier must not win); production builds keep the stored host.
  if (partyBrowserDefaultHost === partyBrowserAllowedPreviewHost) return partyBrowserDefaultHost;
  try {
    const stored = window.localStorage.getItem(partyBrowserHostStorage) || "";
    const host = stored ? new URL(stored).hostname : "";
    return stored && !partyBrowserPreviewHost(host) ? stored : partyBrowserDefaultHost;
  } catch { return partyBrowserDefaultHost; }
};

// Invite block: heading, browser address, two copy buttons (Nuvio app and
// browser). The note only shows feedback or an address problem.
const buildPartyBrowserShare = party => {
  setPartyBrowserDefaultHost(String(party.browserOrigin || ""));
  const section = partyElement("div", "party-section party-card party-invite-card");
  section.appendChild(partyElement("p", "party-card-title", "Einladen"));
  const address = partyElement("input", "party-browser-host");
  address.setAttribute("aria-label", "Adresse der Browser-Seite");
  address.setAttribute("type", "url");
  address.setAttribute("inputmode", "url");
  address.placeholder = "https://your-project.pages.dev";
  address.value = partyBrowserHost();
  address.autocomplete = "off";
  address.dataset.partyFocus = "browserHost";
  address.addEventListener("click", event => event.stopPropagation());
  address.addEventListener("keydown", event => event.stopPropagation());
  section.appendChild(address);
  const note = partyElement("p", "party-detail");
  note.hidden = true;
  const showNote = text => { note.textContent = text; note.hidden = !text; };
  section.appendChild(note);
  address.addEventListener("change", () => {
    try { window.localStorage.setItem(partyBrowserHostStorage, address.value.trim()); } catch { /* session only */ }
  });
  const inviteUrl = () => {
    const raw = address.value.trim();
    let parsed;
    try {
      parsed = new URL(raw);
      if (partyBrowserPreviewHost(new URL(raw).hostname) || !/^https:\/\/[^/?#@]+\/?$/i.test(raw) || /[\u0000-\u001f\u007f\\]/.test(address.value) || parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash || /[\u0000-\u0020\u007f\\]/.test(raw) || (parsed.pathname !== "/" && parsed.pathname !== "")) throw Error("invalid address");
    } catch {
      showNote("Bitte die HTTPS-Startadresse der Browser-Seite eintragen.");
      return;
    }
    const code = String(party.code || "").trim();
    if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) {
      showNote("Der Party-Code ist ungültig.");
      return;
    }
    const invite = `${parsed.origin}/party/${encodeURIComponent(code)}`;
    try { window.localStorage.setItem(partyBrowserHostStorage, parsed.origin); } catch { /* session only */ }
    return invite;
  };
  const onClick = () => {
    const invite = inviteUrl();
    if (!invite) return;
    // Copying the link must never implicitly enable source sharing.
    send(`partyBrowserInvite:${partyEncodeText(invite)}`, 0);
    showNote("");
  };
  // Same party code: the original Nuvio invite, then the browser invite (last).
  section.appendChild(partyIconTextButton("icon-play", "Watch in Nuvio – Copy link", "", "nuvioShare", () => send("partyCopyNuvioLink", 0)));
  section.appendChild(partyIconTextButton("icon-open", "Watch in Browser – Copy link", "primary", "browserShare", onClick));
  return section;
};

// Short labels for the browser HLS status chip.
const partyHlsPhaseLabels = {
  sent: ["Gesendet", "ok"], family: ["Familie", "ok"], ready: ["Bereit", "ok"], preparing: ["Wird vorbereitet", "busy"],
  processing: ["TorBox verarbeitet", "busy"], renewing: ["Wird erneuert", "busy"], error: ["Fehler", "error"],
  idle: ["Nicht gestartet", ""], unavailable: ["Keine Cloud-Datei", ""], link: ["Eigener Link", "ok"], "family-link": ["Eigener Link · Familie", "ok"],
};

const partyIconTextButton = (icon, label, variant, focusKey, onClick) => {
  const button = partyButtonElement(label, variant, focusKey, onClick);
  button.prepend(partyIcon(icon));
  return button;
};

const partyCompactButton = (label, focusKey, onClick, variant = "") =>
  partyButtonElement(label, `compact ${variant}`.trim(), focusKey, onClick);

// One line: "Browser-HLS" + status chip + refresh. Details only on problems.
const buildPartyStreamStatus = party => {
  const phase = String(party.hlsPhase || "");
  if (!phase) return null;
  const box = partyElement("div", "party-stream-status");
  const row = partyElement("div", "party-inline-row");
  row.appendChild(partyElement("span", "party-row-label", "Browser-HLS"));
  const [label, tone] = partyHlsPhaseLabels[phase] || [phase, ""];
  const chip = partyElement("span", tone ? `party-chip ${tone}` : "party-chip", label);
  const detail = String(party.hlsStatus || "").trim();
  if (detail) chip.title = detail;
  row.appendChild(chip);
  if (party.hlsAvailable) {
    const refresh = partyIconButton("icon-sync", "HLS neu vorbereiten", "muted", "hlsRefresh", () => send("partyHlsRefresh", 0));
    if (party.hlsBusy) refresh.disabled = true;
    row.appendChild(refresh);
  }
  box.appendChild(row);
  const problem = phase === "error" || phase === "unavailable" || (party.sharing && /can't be shared|nicht geteilt/i.test(String(party.shareNote || "")));
  const note = String((phase === "error" || phase === "unavailable") ? detail : party.shareNote || "").trim();
  if (problem && note) box.appendChild(partyElement("p", "party-detail", note));
  return box;
};

const buildPartyHostSettings = party => {
  const section = partyElement("div", "party-host-settings party-card");
  section.appendChild(buildPartySwitch("hostOnly", partyLabel("hostOnlyTitle"), partyLabel("hostOnlyDescription"), party.hostOnly, "partyHostOnly"));
  section.appendChild(buildPartySwitch("sharing", partyLabel("shareTitle"), partyLabel("shareDescription"), party.sharing, "partySharing"));
  const status = buildPartyStreamStatus(party);
  if (status) section.appendChild(status);
  if (party.torboxLinkAvailable) section.appendChild(buildPartyTorboxLink(party));
  if (party.hostHlsAllowed) section.appendChild(buildPartyHostHls(party));
  return section;
};



// Drafts survive panel rebuilds; they live only in this overlay's memory.
let partyHostHlsDraft = "";
let partyHostHlsConsent = false;
let partyTorboxFilter = "";
const partyTorboxVisibleLimit = 60;

const partyInputElement = (className, label, focusKey) => {
  const input = partyElement("input", className);
  input.setAttribute("aria-label", label);
  input.autocomplete = "off";
  input.spellcheck = false;
  input.dataset.partyFocus = focusKey;
  Object.assign(input.style, {
    width: "100%", boxSizing: "border-box", margin: "8px 0",
    border: "1px solid #555", borderRadius: "9px", color: "#f5f5f5",
    padding: "10px 12px", background: "#242424", fontSize: "14px"
  });
  input.addEventListener("click", event => event.stopPropagation());
  input.addEventListener("keydown", event => event.stopPropagation());
  return input;
};

// Own HLS link for the party, folded away by default. Sent only with the
// explicit consent tick; the desktop checks it before anything is shared.
let partyHostHlsOpen = false;
const buildPartyHostHls = party => {
  const box = partyElement("div", "party-host-hls");
  const from = String(party.hlsSuggestionFrom || "").trim();
  if (from) {
    const host = String(party.hlsSuggestionHost || "").trim();
    const suggestion = partyElement("div", "party-inline-row");
    suggestion.appendChild(partyElement("span", "party-row-label", `Link-Vorschlag von ${from}`));
    suggestion.appendChild(partyCompactButton("Prüfen", "hlsSuggestionAccept", () => showPartyConfirm({
      title: "Vorgeschlagenen Link freigeben?",
      message: `Der Link von ${from} (${host}) wird geprüft und dann geteilt. Enthaltene Tokens sind für die Empfänger sichtbar.`,
      confirmLabel: "Prüfen und freigeben",
      danger: false,
      onConfirm: () => send("partyHlsSuggestionAccept", 0),
    }), "primary"));
    suggestion.appendChild(partyCompactButton("Ablehnen", "hlsSuggestionReject", () => send("partyHlsSuggestionReject", 0)));
    box.appendChild(suggestion);
  }
  const status = String(party.hostHlsStatus || "").trim();
  if (party.hostHlsActive) {
    const row = partyElement("div", "party-inline-row");
    row.appendChild(partyElement("span", "party-row-label", "Eigener Link aktiv"));
    row.appendChild(partyCompactButton("Beenden", "hostHlsClear", () => send("partyHostHlsClear", 0), "danger"));
    box.appendChild(row);
    if (status) box.appendChild(partyElement("p", "party-detail", status));
    return box;
  }
  const details = partyElement("details", "party-disclosure");
  details.open = partyHostHlsOpen || Boolean(status && status.startsWith("Nicht geteilt"));
  details.addEventListener("toggle", () => { partyHostHlsOpen = details.open; });
  const summary = partyElement("summary", "party-row-label", "Eigenen Video-Link teilen");
  summary.addEventListener("click", event => event.stopPropagation());
  details.appendChild(summary);
  const input = partyInputElement("party-host-hls-url", "HLS-Adresse", "hostHlsUrl");
  input.setAttribute("type", "url");
  input.setAttribute("inputmode", "url");
  input.placeholder = "https://…/playlist.m3u8";
  input.value = partyHostHlsDraft;
  details.appendChild(input);
  const consent = partyElement("label", "party-consent");
  const check = partyElement("input");
  check.type = "checkbox";
  check.checked = partyHostHlsConsent;
  check.dataset.partyFocus = "hostHlsConsent";
  check.addEventListener("click", event => event.stopPropagation());
  consent.appendChild(check);
  consent.appendChild(document.createTextNode(" Freigeben – Tokens im Link sind für Empfänger sichtbar"));
  consent.title = "Der Link wird geprüft und an die Party gesendet; „Share my stream“ wird eingeschaltet. TorBox-Links mit Account-Key gehen nur an freigegebene Mitglieder.";
  details.appendChild(consent);
  const share = partyButtonElement("Teilen", "primary compact", "hostHlsShare", () => {
    const url = input.value.trim();
    if (!url || !check.checked || party.hostHlsBusy) return;
    partyHostHlsDraft = ""; partyHostHlsConsent = false;
    input.value = ""; check.checked = false;
    send(`partyHostHls:${partyEncodeText(url)}`, 0);
  });
  const update = () => { share.disabled = Boolean(party.hostHlsBusy) || !check.checked || !input.value.trim(); };
  input.addEventListener("input", () => { partyHostHlsDraft = input.value; update(); });
  check.addEventListener("change", () => { partyHostHlsConsent = check.checked; update(); });
  update();
  details.appendChild(share);
  if (status) details.appendChild(partyElement("p", status.startsWith("Nicht geteilt") ? "party-detail error" : "party-detail", status));
  box.appendChild(details);
  return box;
};

// Cloud file of an addon stream: linked automatically when unique (info hash
// or exact title); the name is shown once with "change" and "remove".
const buildPartyTorboxLink = party => {
  const box = partyElement("div", "party-torbox-link");
  const linked = String(party.torboxLinkedName || "").trim();
  if (party.torboxChoicesOpen) {
    const filter = partyInputElement("party-torbox-filter", "TorBox-Dateien suchen", "torboxFilter");
    filter.placeholder = "Datei suchen …";
    filter.value = partyTorboxFilter;
    box.appendChild(filter);
    const list = partyElement("div", "party-torbox-list");
    const render = () => {
      list.textContent = "";
      const words = partyTorboxFilter.toLowerCase().split(/\s+/).filter(Boolean);
      const matches = normalizeItems(party.torboxChoices)
        .filter(choice => words.every(word => String(choice.name || "").toLowerCase().includes(word)));
      matches.slice(0, partyTorboxVisibleLimit).forEach(choice => {
        const name = String(choice.name || "");
        const item = partyButtonElement(name, "compact list", `torboxPick:${choice.id}`, () => showPartyConfirm({
          title: "Diese Datei verknüpfen?",
          message: `„${name}“ – nur wählen, wenn es genau dieser Film bzw. diese Folge ist.`,
          confirmLabel: "Verknüpfen",
          danger: false,
          onConfirm: () => send(`partyTorboxPick:${String(choice.id)}`, 0),
        }));
        if (choice.size) item.appendChild(partyElement("span", "party-list-meta", String(choice.size)));
        list.appendChild(item);
      });
      if (matches.length > partyTorboxVisibleLimit) list.appendChild(partyElement("p", "party-detail", `${matches.length - partyTorboxVisibleLimit} weitere Treffer – Suche genauer eingeben.`));
      if (!party.torboxChoicesBusy && !matches.length) list.appendChild(partyElement("p", "party-detail", "Keine passende Datei."));
    };
    filter.addEventListener("input", () => { partyTorboxFilter = filter.value; render(); });
    render();
    box.appendChild(list);
    box.appendChild(partyCompactButton("Schließen", "torboxClose", () => send("partyTorboxClose", 0)));
  } else {
    const row = partyElement("div", "party-inline-row");
    const name = partyElement("span", "party-row-label party-ellipsis", linked ? `Verknüpft: ${linked}` : "Keine Cloud-Datei verknüpft");
    name.title = linked;
    row.appendChild(name);
    if (linked && party.torboxLinkAuto) row.appendChild(partyElement("span", "party-chip", "automatisch"));
    const open = () => { partyTorboxFilter = String(party.torboxSuggestedFilter || ""); send("partyTorboxList", 0); };
    row.appendChild(partyCompactButton(linked ? "Ändern" : "Verknüpfen", "torboxList", open));
    if (linked) row.appendChild(partyCompactButton("Lösen", "torboxUnlink", () => send("partyTorboxUnlink", 0)));
    box.appendChild(row);
  }
  const status = String(party.torboxChoicesStatus || "").trim();
  if (status) box.appendChild(partyElement("p", "party-detail", status));
  return box;
};

const closeAndSendParty = type => {
  closePlayerModal();
  send(type, 0);
};

const buildPartyContent = party => {
  const content = partyElement("div", "party-content");
  const behind = String(party.behindTitle || "").trim();
  if (behind) {
    const section = partyElement("div", "party-section party-card");
    section.appendChild(partyElement("p", "party-text primary", behind));
    section.appendChild(partyButtonElement(partyLabel("catchUp"), "primary", "catchUp", () => closeAndSendParty("partyCatchUp")));
    content.appendChild(section);
  }

  const overview = partyElement("div", "party-overview");
  overview.appendChild(buildPartyCode(party));
  overview.appendChild(buildPartyMembers(party));
  content.appendChild(overview);

  // Different title than the party: what happens to me vs. to everyone.
  const nowWatching = String(party.nowWatching || "").trim();
  if (nowWatching) {
    const section = partyElement("div", "party-section party-card party-switch-card");
    section.appendChild(partyElement("p", "party-card-title", "Anderer Titel"));
    section.appendChild(partyElement("p", "party-text", nowWatching));
    section.appendChild(partyIconTextButton("icon-party", partyLabel("watchWithParty"), "primary", "watch", () => closeAndSendParty("partyWatch")));
    const switchLabel = String(party.switchLabel || "").trim();
    if (switchLabel) {
      section.appendChild(partyElement("div", "party-divider"));
      section.appendChild(partyIconTextButton("icon-swap", switchLabel, "", "switch", () => showPartyConfirm({
        title: partyLabel("switchTitle"),
        message: party.switchMessage,
        confirmLabel: partyLabel("switchConfirm"),
        danger: false,
        onConfirm: () => send("partySwitch", 0),
      })));
    }
    content.appendChild(section);
  }

  if (party.isHost) content.appendChild(buildPartyHostSettings(party));
  if (!party.isHost && party.hostOnly) {
    const note = partyElement("div", "party-host-only-note");
    note.appendChild(partyIcon("icon-lock"));
    note.appendChild(partyElement("span", "", partyLabel("hostOnlyNote")));
    content.appendChild(note);
  }
  if (party.isHost) content.appendChild(buildPartyBrowserShare(party));

  const actions = partyElement("div", "party-actions");
  actions.appendChild(partyButtonElement(partyLabel("leave"), "", "leave", () => closeAndSendParty("partyLeave")));
  if (party.canEnd) {
    actions.appendChild(partyButtonElement(partyLabel("end"), "danger", "end", () => showPartyConfirm({
      title: partyLabel("endTitle"),
      message: partyLabel("endMessage"),
      confirmLabel: partyLabel("end"),
      danger: true,
      onConfirm: () => closeAndSendParty("partyEnd"),
    })));
  }
  content.appendChild(actions);
  return content;
};

const partyEncodeText = text => {
  let binary = "";
  new TextEncoder().encode(text).forEach(byte => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const syncPartyChatVisible = () => {
  const wanted = activeModal === "party" && Boolean(currentParty().active) && partyTab === "chat" && !state.isInPip;
  if (wanted === partyChatSentVisible) return;
  partyChatSentVisible = wanted;
  send("partyChatVisible", wanted ? 1 : 0);
};

const partyChatDistanceFromBottom = () =>
  partyChatScroll.scrollHeight - partyChatScroll.scrollTop - partyChatScroll.clientHeight;

const isPartyChatAtBottom = () => partyChatDistanceFromBottom() <= partyChatBottomSlack;

const updatePartyChatNewButton = () => {
  const visible = partyChatNewBelow && !isPartyChatAtBottom();
  if (visible === !partyChatNew.hidden) return;
  if (visible) {
    partyChatNew.hidden = false;
    partyChatNew.classList.remove("leaving");
    void partyChatNew.offsetWidth;
    partyChatNew.classList.add("entering");
    return;
  }
  partyChatNew.classList.remove("entering");
  partyChatNew.classList.add("leaving");
  window.setTimeout(() => {
    if (!partyChatNewBelow || isPartyChatAtBottom()) {
      partyChatNew.hidden = true;
      partyChatNew.classList.remove("leaving");
    }
  }, 160);
};

const scrollPartyChatToBottom = smooth => {
  window.cancelAnimationFrame(partyChatScrollFrame);
  const target = () => partyChatScroll.scrollHeight - partyChatScroll.clientHeight;
  if (!smooth || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    partyChatScroll.scrollTop = target();
    return;
  }
  const from = partyChatScroll.scrollTop;
  const start = performance.now();
  const step = now => {
    const progress = Math.min(1, (now - start) / partyChatScrollMs);
    const eased = 1 - Math.pow(1 - progress, 3);
    partyChatScroll.scrollTop = from + (target() - from) * eased;
    if (progress < 1) partyChatScrollFrame = window.requestAnimationFrame(step);
  };
  partyChatScrollFrame = window.requestAnimationFrame(step);
};

const resetPartyChatList = () => {
  partyChatRows.clear();
  partyChatList.textContent = "";
  partyChatReady = false;
  partyChatSignature = "";
  partyChatNewestKey = "";
  partyChatNewBelow = false;
  partyChatNew.hidden = true;
  partyChatNew.classList.remove("entering", "leaving");
  partyChatEmpty.hidden = true;
};

const buildPartyChatRow = () => {
  const el = partyElement("div", "party-chat-row");
  const time = partyElement("div", "party-chat-time");
  const name = partyElement("div", "party-chat-name");
  const line = partyElement("div", "party-chat-line");
  const avatar = partyElement("span", "party-chat-avatar");
  const bubble = partyElement("div", "party-chat-bubble");
  line.appendChild(avatar);
  line.appendChild(bubble);
  const row = { el, time, name, avatar, bubble, key: "", avatarKey: "" };
  const failed = partyAction(partyElement("button", "party-chat-failed"), "chatRetry", () => send(`partyChatRetry:${row.key}`, 0));
  row.failed = failed;
  el.appendChild(time);
  el.appendChild(name);
  el.appendChild(line);
  el.appendChild(failed);
  return row;
};

const updatePartyChatRow = (row, message) => {
  const mine = Boolean(message.mine);
  row.key = String(message.key || "");
  row.el.classList.toggle("mine", mine);
  row.el.classList.toggle("starts-group", Boolean(message.startsGroup));
  row.el.classList.toggle("ends-group", Boolean(message.endsGroup));
  row.time.hidden = !message.showTime;
  row.time.textContent = message.time || "";
  const showName = Boolean(message.startsGroup) && !mine;
  row.name.hidden = !showName;
  row.name.textContent = showName ? message.name || "" : "";
  row.avatar.hidden = mine;
  const avatarKey = [message.endsGroup ? 1 : 0, message.initial, message.imageUrl, message.color].join("|");
  if (avatarKey !== row.avatarKey) {
    row.avatarKey = avatarKey;
    row.avatar.textContent = "";
    if (message.endsGroup) row.avatar.appendChild(buildPartyAvatar(message, partyChatAvatarSize));
  }
  row.bubble.textContent = message.body || "";
  row.bubble.classList.toggle("pending", !message.sent);
  row.failed.hidden = !message.failed;
  row.failed.textContent = message.failed ? partyLabel("chatNotSent") : "";
};

const syncPartyChatRows = messages => {
  const firstRender = !partyChatReady;
  const wasAtBottom = firstRender || isPartyChatAtBottom();
  const tops = new Map();
  partyChatRows.forEach((row, key) => tops.set(key, row.el.getBoundingClientRect().top));
  const seen = new Set();
  messages.forEach((message, index) => {
    const key = String(message.key || "");
    let row = partyChatRows.get(key);
    const created = !row;
    if (created) {
      row = buildPartyChatRow();
      partyChatRows.set(key, row);
    }
    updatePartyChatRow(row, message);
    seen.add(key);
    const expected = partyChatList.children[index] || null;
    if (expected !== row.el) partyChatList.insertBefore(row.el, expected);
    if (created && !firstRender) {
      row.el.classList.add("entering");
      row.el.addEventListener("animationend", () => row.el.classList.remove("entering"), { once: true });
    }
  });
  Array.from(partyChatRows.keys()).forEach(key => {
    if (seen.has(key)) return;
    partyChatRows.get(key).el.remove();
    partyChatRows.delete(key);
  });

  if (!firstRender && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    partyChatRows.forEach((row, key) => {
      const top = tops.get(key);
      if (top === undefined) return;
      const delta = top - row.el.getBoundingClientRect().top;
      if (Math.abs(delta) < 1) return;
      row.el.animate(
        [{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }],
        { duration: 300, easing: "cubic-bezier(.2, .8, .2, 1)" },
      );
    });
  }

  const newest = messages[messages.length - 1];
  const newestKey = newest ? String(newest.key || "") : "";
  if (firstRender) {
    scrollPartyChatToBottom(false);
  } else if (newest && newestKey !== partyChatNewestKey) {
    if (newest.mine || wasAtBottom) scrollPartyChatToBottom(true);
    else partyChatNewBelow = true;
  }
  partyChatNewestKey = newestKey;
  partyChatReady = true;
  updatePartyChatNewButton();
};

const updatePartyChatComposer = () => {
  partyChatInput.style.height = "auto";
  partyChatInput.style.height = `${Math.min(partyChatInput.scrollHeight, partyChatMaxInputHeight)}px`;
  partyChatSend.disabled = !partyChatInput.value.trim();
};

const sendPartyChatMessage = () => {
  const text = partyChatInput.value.trim().slice(0, partyChatMaxLength);
  if (!text) return;
  send(`partyChatSend:${partyEncodeText(text)}`, 0);
  partyChatInput.value = "";
  updatePartyChatComposer();
  partyChatInput.focus({ preventScroll: true });
};

const renderPartyChat = visible => {
  partyChatInput.placeholder = partyLabel("chatPlaceholder", "Message");
  partyChatSend.setAttribute("aria-label", partyLabel("chatSend", "Send"));
  partyChatSend.title = partyLabel("chatSend", "Send");
  partyChatNewLabel.textContent = partyLabel("chatNewMessages", "New messages");
  partyChatEmptyTitle.textContent = partyLabel("chatEmptyTitle");
  partyChatEmptyMessage.textContent = partyLabel("chatEmptyMessage");
  const chat = currentPartyChat();
  if (!visible || !chat.ready) {
    if (partyChatReady) resetPartyChatList();
    return;
  }
  const messages = normalizeItems(chat.messages);
  const signature = messages
    .map(message => [message.key, message.sent, message.failed, message.startsGroup, message.endsGroup, message.time, message.name, message.initial, message.imageUrl, message.color, message.body].join("\u0001"))
    .join("\u0002");
  if (signature === partyChatSignature && partyChatReady) return;
  partyChatSignature = signature;
  const firstRender = !partyChatReady;
  syncPartyChatRows(messages);
  partyChatEmpty.hidden = messages.length > 0;
  partyChatEmpty.classList.toggle("compact", partyChatViewport.clientHeight < partyChatCompactHeight);
  if (firstRender) updatePartyChatComposer();
};

const renderPartyTabs = () => {
  const active = Boolean(currentParty().active);
  partyTabs.hidden = !active;
  if (!active) {
    partyTab = "party";
    updatePartyBadge(partyTabBadge, 0);
    return;
  }
  const chat = partyTab === "chat";
  partyTabParty.firstElementChild.textContent = partyLabel("tabParty", "Party");
  partyTabChat.firstElementChild.textContent = partyLabel("tabChat", "Chat");
  partyTabParty.classList.toggle("selected", !chat);
  partyTabChat.classList.toggle("selected", chat);
  partyTabParty.setAttribute("aria-selected", String(!chat));
  partyTabChat.setAttribute("aria-selected", String(chat));
  partyTabIndicator.classList.toggle("chat", chat);
  updatePartyBadge(partyTabBadge, partyUnreadCount());
};

const setPartyTab = tab => {
  if (partyTab === tab) return;
  partyTab = tab;
  if (activeModal === "party") renderPartyModal();
  if (tab === "chat") partyChatInput.focus({ preventScroll: true });
};

const onPartyModalOpened = () => {
  if (partyUnreadCount() > 0) partyTab = "chat";
};

const partyPanelSignature = party => JSON.stringify({
  ...party,
  chat: null,
  pillMessage: "",
  pillPinned: false,
  message: "",
  messageToken: 0,
  panelToken: 0,
  copied: partyCopiedUntil > Date.now(),
});

const renderPartyModal = () => {
  partyPanelTitle.textContent = partyLabel("title", "Watch party");
  partyCloseButton.textContent = partyLabel("close", "Close");
  const party = currentParty();
  renderPartyTabs();
  const chatTab = Boolean(party.active) && partyTab === "chat";
  partyBody.hidden = chatTab;
  partyChatBox.hidden = !chatTab;
  renderPartyChat(chatTab);
  syncPartyChatVisible();
  const key = partyPanelSignature(party);
  if (key === partyPanelKey) return;
  partyPanelKey = key;
  const focusKey = document.activeElement && partyBody.contains(document.activeElement)
    ? document.activeElement.dataset.partyFocus
    : "";
  const scrollTop = partyBody.scrollTop;
  partyBody.textContent = "";
  partyBody.appendChild(party.active ? buildPartyContent(party) : buildPartyStart(party));
  partyBody.scrollTop = scrollTop;
  if (focusKey) {
    const target = Array.from(partyBody.querySelectorAll("[data-party-focus]"))
      .find(element => element.dataset.partyFocus === focusKey);
    if (target) target.focus({ preventScroll: true });
  }
};

const onPartyModalClosed = () => {
  if (partyChatSentVisible) {
    partyChatSentVisible = false;
    send("partyChatVisible", 0);
  }
  resetPartyChatList();
  closePartyConfirm();
  partyPanelKey = "";
  partyKnownMemberIds = null;
};

const applyPartyControls = previous => {
  const party = currentParty();
  const before = previous && typeof previous === "object" ? previous : {};
  const message = String(party.message || "").trim();
  if ((Number(party.messageToken) || 0) !== (Number(before.messageToken) || 0) && message) {
    showPlayerToast(message, { icon: "icon-party", durationMs: partyMessageDurationMs });
  }
  if ((Number(party.panelToken) || 0) !== (Number(before.panelToken) || 0) && activeModal !== "party" && !state.isInPip) {
    openPlayerModal("party");
  }
  if (!party.active && before.active) closePartyConfirm();
};

partyTabParty.addEventListener("click", event => {
  event.stopPropagation();
  setPartyTab("party");
});

partyTabChat.addEventListener("click", event => {
  event.stopPropagation();
  setPartyTab("chat");
});

partyChatInput.addEventListener("input", () => {
  partyChatSend.disabled = !partyChatInput.value.trim();
  if (partyChatComposerFrame) return;
  partyChatComposerFrame = window.requestAnimationFrame(() => {
    partyChatComposerFrame = 0;
    updatePartyChatComposer();
  });
});

partyChatInput.addEventListener("keydown", event => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  sendPartyChatMessage();
});

partyChatSend.addEventListener("click", event => {
  event.stopPropagation();
  sendPartyChatMessage();
});

partyChatNew.addEventListener("click", event => {
  event.stopPropagation();
  partyChatNewBelow = false;
  updatePartyChatNewButton();
  scrollPartyChatToBottom(true);
});

partyChatScroll.addEventListener("scroll", () => {
  if (isPartyChatAtBottom()) partyChatNewBelow = false;
  updatePartyChatNewButton();
}, { passive: true });

partyChatViewport.addEventListener("click", event => {
  if (event.target.closest("button")) return;
  partyChatInput.blur();
});

if (window.ResizeObserver) {
  new ResizeObserver(() => {
    partyChatEmpty.classList.toggle("compact", partyChatViewport.clientHeight < partyChatCompactHeight);
  }).observe(partyChatViewport);
}

partyButton.addEventListener("click", event => {
  event.stopPropagation();
  noteChromeActivity(true);
  openPlayerModal("party");
});

partyPill.addEventListener("click", event => {
  event.stopPropagation();
  openPlayerModal("party");
});

partyCloseButton.addEventListener("click", event => {
  event.stopPropagation();
  closePlayerModal();
});

partyConfirm.addEventListener("click", event => {
  event.stopPropagation();
  if (event.target === partyConfirm) closePartyConfirm();
});

partyConfirmCancel.addEventListener("click", event => {
  event.stopPropagation();
  closePartyConfirm();
});

partyConfirmAccept.addEventListener("click", event => {
  event.stopPropagation();
  const handler = partyConfirmHandler;
  closePartyConfirm();
  if (handler) handler();
});
