const DEFAULT_SETTINGS = Object.freeze({
  globalEnabled: true,
  protectedDomains: ["cinefreak.net"],
  siteOverrides: {},
});

const USER_GESTURE_WINDOW_MS = 1500;
const CONTEXT_MENU_GESTURE_WINDOW_MS = 8000;
const CLICK_MATCH_WINDOW_MS = 3000;
const NEW_TAB_CONTEXT_TTL_MS = 15000;
const MAX_LOG_ENTRIES = 100;

const ALLOWED_USER_TRANSITIONS = new Set([
  "typed",
  "auto_bookmark",
  "keyword",
  "keyword_generated",
  "generated",
  "start_page",
  "reload",
]);

let settingsCache = null;

const blockedEvents = [];
const tabState = new Map();
const recentGestures = new Map();
const recentClicks = new Map();
const newTabContexts = new Map();
const restoreInFlight = new Map();

chrome.runtime.onInstalled.addListener(() => {
  void initializeRuntime();
});

chrome.runtime.onStartup.addListener(() => {
  void initializeRuntime();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (
    Object.prototype.hasOwnProperty.call(changes, "globalEnabled") ||
    Object.prototype.hasOwnProperty.call(changes, "protectedDomains") ||
    Object.prototype.hasOwnProperty.call(changes, "siteOverrides")
  ) {
    settingsCache = null;
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void (async () => {
    try {
      const response = await handleMessage(message, sender);
      sendResponse(response ?? { ok: true });
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();

  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (typeof changeInfo.url === "string" && changeInfo.url) {
    tabState.set(tabId, { url: changeInfo.url, ts: Date.now() });
  }

  if (
    (changeInfo.status === "loading" || typeof changeInfo.url === "string") &&
    tab.url
  ) {
    void maybeInjectProtection(tabId, tab.url);
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  void handleCreatedTab(tab);
});

chrome.webNavigation.onCommitted.addListener((details) => {
  void handleCommittedNavigation(details);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  cleanupTabState(tabId);
});

void initializeRuntime();

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "ATB_USER_GESTURE": {
      if (sender.tab?.id != null) {
        recordGesture(sender.tab.id, message.kind, message.timestamp);
      }
      return { ok: true };
    }

    case "ATB_CLICK_INFO": {
      if (sender.tab?.id != null) {
        recordGesture(sender.tab.id, "click", message.timestamp);
        recentClicks.set(sender.tab.id, {
          ts: numberOrNow(message.timestamp),
          href: typeof message.href === "string" ? message.href : "",
          pageUrl: typeof message.pageUrl === "string" ? message.pageUrl : "",
        });
      }
      return { ok: true };
    }

    case "ATB_BLOCKED_EVENT": {
      if (sender.tab?.id != null) {
        addBlockedEvent({
          type: message.eventType || "content_block",
          targetUrl: message.targetUrl || "",
          sourceTabId: sender.tab.id,
          sourceUrl: message.sourceUrl || sender.tab.url || "",
          reason: message.reason || "blocked_in_content_script",
        });
      }
      return { ok: true };
    }

    case "ATB_GET_STATE": {
      return buildPopupState(message.host || "");
    }

    case "ATB_SET_GLOBAL_ENABLED": {
      await setGlobalEnabled(Boolean(message.enabled));
      return { ok: true };
    }

    case "ATB_SET_SITE_OVERRIDE": {
      return setSiteOverride(message.host, Boolean(message.enabled));
    }

    case "ATB_GET_LOGS": {
      return { ok: true, logs: blockedEvents.slice(0, 50) };
    }

    case "ATB_CLEAR_LOGS": {
      blockedEvents.length = 0;
      return { ok: true };
    }

    default:
      return { ok: false, error: "unknown_message_type" };
  }
}

async function initializeRuntime() {
  await ensureSettings();
  await bootstrapCurrentTabs();
}

async function bootstrapCurrentTabs() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (error) {
    return;
  }

  const now = Date.now();
  for (const tab of tabs) {
    if (tab.id == null || !tab.url) {
      continue;
    }

    tabState.set(tab.id, { url: tab.url, ts: now });
    await maybeInjectProtection(tab.id, tab.url);
  }
}

async function ensureSettings() {
  const existing = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const toSeed = {};

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (typeof existing[key] === "undefined") {
      toSeed[key] = value;
    }
  }

  if (Object.keys(toSeed).length > 0) {
    await chrome.storage.local.set(toSeed);
  }

  await getSettings();
}

async function getSettings() {
  if (settingsCache) {
    return settingsCache;
  }

  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  settingsCache = sanitizeSettings(stored);
  return settingsCache;
}

function sanitizeSettings(raw) {
  const protectedDomains = Array.isArray(raw.protectedDomains)
    ? raw.protectedDomains
        .map((entry) => normalizeHost(entry))
        .filter((entry) => Boolean(entry))
    : [...DEFAULT_SETTINGS.protectedDomains];

  const siteOverrides =
    raw.siteOverrides && typeof raw.siteOverrides === "object"
      ? Object.fromEntries(
          Object.entries(raw.siteOverrides)
            .map(([host, value]) => [normalizeHost(host), Boolean(value)])
            .filter(([host]) => Boolean(host))
        )
      : {};

  return {
    globalEnabled: raw.globalEnabled !== false,
    protectedDomains,
    siteOverrides,
  };
}

async function saveSettings(nextSettings) {
  const sanitized = sanitizeSettings(nextSettings);
  settingsCache = sanitized;
  await chrome.storage.local.set(sanitized);
}

async function setGlobalEnabled(enabled) {
  const settings = await getSettings();
  await saveSettings({ ...settings, globalEnabled: enabled });
}

async function setSiteOverride(hostInput, enabled) {
  const host = normalizeHost(hostInput);
  if (!host) {
    return { ok: false, error: "invalid_host" };
  }

  const settings = await getSettings();
  const nextOverrides = { ...settings.siteOverrides, [host]: enabled };

  await saveSettings({ ...settings, siteOverrides: nextOverrides });

  const state = await buildPopupState(host);
  return { ok: true, state };
}

async function buildPopupState(hostInput) {
  const settings = await getSettings();
  const host = normalizeHost(hostInput);

  const hasExplicitOverride =
    host && Object.prototype.hasOwnProperty.call(settings.siteOverrides, host);

  const siteOverride = hasExplicitOverride ? settings.siteOverrides[host] : null;
  const domainListed = host
    ? settings.protectedDomains.some((domain) => domainMatches(host, domain))
    : false;

  const siteEnabled =
    typeof siteOverride === "boolean" ? siteOverride : domainListed;

  return {
    ok: true,
    host,
    globalEnabled: settings.globalEnabled,
    siteEnabled,
    effectiveEnabled: settings.globalEnabled && siteEnabled,
    siteOverride,
    domainListed,
    logs: blockedEvents.slice(0, 50),
  };
}

async function maybeInjectProtection(tabId, url) {
  if (!(await isProtectionEnabledForUrl(url))) {
    return;
  }

  if (!isWebUrl(url)) {
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ["content_script.js"],
      injectImmediately: true,
    });
  } catch (error) {
    // Ignore pages that cannot be injected (Chrome internals, restricted pages).
  }
}

async function handleCreatedTab(tab) {
  if (tab.id == null || tab.openerTabId == null) {
    return;
  }

  const openerTabId = tab.openerTabId;
  const openerUrl = await resolveTabUrl(openerTabId);

  if (!openerUrl || !(await isProtectionEnabledForUrl(openerUrl))) {
    return;
  }

  const now = Date.now();
  const targetUrl = tab.pendingUrl || tab.url || "";
  const recentClick = getFreshClickInfo(openerTabId, now);
  const hasContextMenuGesture = hasRecentGestureOfKinds(
    openerTabId,
    new Set(["contextmenu"]),
    now
  );

  newTabContexts.set(tab.id, {
    openerTabId,
    openerUrl,
    expectedHref: recentClick?.href || "",
    createdTs: now,
    contextMenuIntent: hasContextMenuGesture,
  });

  if (!targetUrl || isBlankLikeUrl(targetUrl)) {
    return;
  }

  const recentClickMatch =
    Boolean(recentClick) &&
    doesTargetMatchClickedLink(targetUrl, recentClick.href);

  const shouldAllow =
    isSameOrigin(targetUrl, openerUrl) ||
    recentClickMatch ||
    hasContextMenuGesture;

  if (shouldAllow) {
    return;
  }

  newTabContexts.delete(tab.id);

  try {
    await chrome.tabs.remove(tab.id);
  } catch (error) {
    // Tab may already be gone.
  }

  addBlockedEvent({
    type: "popup_tab",
    targetUrl: targetUrl || "about:blank",
    sourceTabId: openerTabId,
    sourceUrl: openerUrl,
    reason: "new_tab_without_recent_user_intent",
  });
}

async function handleCommittedNavigation(details) {
  if (details.frameId !== 0 || details.tabId < 0) {
    return;
  }

  const now = Date.now();
  const tabId = details.tabId;
  const targetUrl = details.url;

  const restoreState = restoreInFlight.get(tabId);
  if (
    restoreState &&
    restoreState.url === targetUrl &&
    now - restoreState.ts < 5000
  ) {
    restoreInFlight.delete(tabId);
    tabState.set(tabId, { url: targetUrl, ts: now });
    await maybeInjectProtection(tabId, targetUrl);
    return;
  }

  const newTabContext = newTabContexts.get(tabId);
  if (newTabContext) {
    const decision = evaluateNewTabNavigation(details, newTabContext, now);

    if (!decision.allow) {
      newTabContexts.delete(tabId);

      try {
        await chrome.tabs.remove(tabId);
      } catch (error) {
        // Tab may already be gone.
      }

      addBlockedEvent({
        type: "popup_tab",
        targetUrl,
        sourceTabId: newTabContext.openerTabId,
        sourceUrl: newTabContext.openerUrl,
        reason: decision.reason,
      });
      return;
    }

    if (!decision.keepContext) {
      newTabContexts.delete(tabId);
    }
  }

  const previousUrl = tabState.get(tabId)?.url || "";
  const sourceProtected =
    Boolean(previousUrl) && (await isProtectionEnabledForUrl(previousUrl));

  if (sourceProtected) {
    const decision = evaluateNavigation(details, previousUrl);

    if (!decision.allow) {
      restoreInFlight.set(tabId, { url: previousUrl, ts: now });

      addBlockedEvent({
        type: "forced_redirect",
        targetUrl,
        sourceTabId: tabId,
        sourceUrl: previousUrl,
        reason: decision.reason,
      });

      try {
        await chrome.tabs.update(tabId, { url: previousUrl });
      } catch (error) {
        restoreInFlight.delete(tabId);
      }

      return;
    }
  }

  tabState.set(tabId, { url: targetUrl, ts: now });
  await maybeInjectProtection(tabId, targetUrl);
}

function evaluateNavigation(details, previousUrl) {
  const targetUrl = details.url;

  if (!isWebUrl(previousUrl) || !isWebUrl(targetUrl)) {
    return { allow: true, reason: "non_web_navigation" };
  }

  if (isSameOrigin(previousUrl, targetUrl)) {
    return { allow: true, reason: "same_origin" };
  }

  if (isExplicitBrowserNavigation(details)) {
    return { allow: true, reason: "browser_ui_navigation" };
  }

  const clickInfo = recentClicks.get(details.tabId);
  if (
    clickInfo &&
    Date.now() - clickInfo.ts <= CLICK_MATCH_WINDOW_MS &&
    doesTargetMatchClickedLink(targetUrl, clickInfo.href)
  ) {
    return { allow: true, reason: "matches_clicked_link" };
  }

  if (hasRecentGesture(details.tabId) && details.transitionType === "form_submit") {
    return { allow: true, reason: "recent_form_submit" };
  }

  return {
    allow: false,
    reason: "cross_origin_without_explicit_user_intent",
  };
}

function evaluateNewTabNavigation(details, context, now = Date.now()) {
  if (now - context.createdTs > NEW_TAB_CONTEXT_TTL_MS) {
    return {
      allow: true,
      keepContext: false,
      reason: "new_tab_context_expired",
    };
  }

  const targetUrl = details.url;
  if (!targetUrl || isBlankLikeUrl(targetUrl) || !isWebUrl(targetUrl)) {
    return {
      allow: true,
      keepContext: true,
      reason: "waiting_for_initial_web_navigation",
    };
  }

  if (isSameOrigin(targetUrl, context.openerUrl)) {
    return {
      allow: true,
      keepContext: false,
      reason: "same_origin_new_tab_navigation",
    };
  }

  if (
    context.expectedHref &&
    doesTargetMatchClickedLink(targetUrl, context.expectedHref)
  ) {
    return {
      allow: true,
      keepContext: false,
      reason: "new_tab_matches_clicked_link",
    };
  }

  if (context.contextMenuIntent && details.transitionType === "link") {
    return {
      allow: true,
      keepContext: false,
      reason: "context_menu_new_tab_open",
    };
  }

  if (isExplicitBrowserNavigation(details)) {
    return {
      allow: true,
      keepContext: false,
      reason: "browser_ui_navigation",
    };
  }

  return {
    allow: false,
    keepContext: false,
    reason: "new_tab_without_clicked_link_match",
  };
}

function isExplicitBrowserNavigation(details) {
  if (ALLOWED_USER_TRANSITIONS.has(details.transitionType)) {
    return true;
  }

  const qualifiers = Array.isArray(details.transitionQualifiers)
    ? details.transitionQualifiers
    : [];

  return (
    qualifiers.includes("from_address_bar") ||
    qualifiers.includes("forward_back")
  );
}

async function isProtectionEnabledForUrl(url) {
  if (!isWebUrl(url)) {
    return false;
  }

  const host = hostFromUrl(url);
  if (!host) {
    return false;
  }

  const settings = await getSettings();
  if (!settings.globalEnabled) {
    return false;
  }

  return isHostProtected(host, settings);
}

function isHostProtected(host, settings) {
  const override = settings.siteOverrides[host];
  if (typeof override === "boolean") {
    return override;
  }

  return settings.protectedDomains.some((domain) => domainMatches(host, domain));
}

function addBlockedEvent({ type, targetUrl, sourceTabId, sourceUrl, reason }) {
  blockedEvents.unshift({
    id:
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}_${Math.random().toString(16).slice(2)}`,
    type,
    targetUrl,
    timestamp: new Date().toISOString(),
    sourceTabId,
    sourceUrl,
    reason,
  });

  if (blockedEvents.length > MAX_LOG_ENTRIES) {
    blockedEvents.length = MAX_LOG_ENTRIES;
  }
}

function recordGesture(tabId, kind = "unknown", timestamp = Date.now()) {
  recentGestures.set(tabId, {
    ts: numberOrNow(timestamp),
    kind: typeof kind === "string" ? kind : "unknown",
  });
}

function hasRecentGesture(tabId) {
  const gesture = recentGestures.get(tabId);
  if (!gesture) {
    return false;
  }

  const windowMs =
    gesture.kind === "contextmenu"
      ? CONTEXT_MENU_GESTURE_WINDOW_MS
      : USER_GESTURE_WINDOW_MS;

  return Date.now() - gesture.ts <= windowMs;
}

function hasRecentGestureOfKinds(tabId, kinds, now = Date.now()) {
  const gesture = recentGestures.get(tabId);
  if (!gesture || !kinds.has(gesture.kind)) {
    return false;
  }

  const windowMs =
    gesture.kind === "contextmenu"
      ? CONTEXT_MENU_GESTURE_WINDOW_MS
      : USER_GESTURE_WINDOW_MS;

  return now - gesture.ts <= windowMs;
}

function getFreshClickInfo(tabId, now = Date.now()) {
  const clickInfo = recentClicks.get(tabId);
  if (!clickInfo) {
    return null;
  }

  if (now - clickInfo.ts > CLICK_MATCH_WINDOW_MS) {
    return null;
  }

  return clickInfo;
}

function doesTargetMatchClickedLink(targetUrl, clickedHref) {
  const target = safeUrl(targetUrl);
  const clicked = safeUrl(clickedHref);

  if (!target || !clicked) {
    return false;
  }

  const comparableTarget = `${target.origin}${target.pathname}${target.search}`;
  const comparableClicked = `${clicked.origin}${clicked.pathname}${clicked.search}`;
  const comparableTargetPath = `${target.origin}${target.pathname}`;
  const comparableClickedPath = `${clicked.origin}${clicked.pathname}`;

  return (
    comparableTarget === comparableClicked ||
    comparableTargetPath === comparableClickedPath
  );
}

function isSameOrigin(urlA, urlB) {
  const parsedA = safeUrl(urlA);
  const parsedB = safeUrl(urlB);

  if (!parsedA || !parsedB) {
    return false;
  }

  return parsedA.origin === parsedB.origin;
}

function isWebUrl(url) {
  const parsed = safeUrl(url);
  return Boolean(parsed) && (parsed.protocol === "http:" || parsed.protocol === "https:");
}

function hostFromUrl(url) {
  const parsed = safeUrl(url);
  return parsed ? normalizeHost(parsed.hostname) : "";
}

function normalizeHost(hostInput) {
  if (!hostInput || typeof hostInput !== "string") {
    return "";
  }

  const trimmed = hostInput.trim().toLowerCase();
  if (!trimmed) {
    return "";
  }

  if (trimmed.includes("://")) {
    const parsed = safeUrl(trimmed);
    return parsed ? normalizeHost(parsed.hostname) : "";
  }

  return trimmed.replace(/^\.+/, "").replace(/\.+$/, "");
}

function domainMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function safeUrl(input) {
  try {
    return new URL(input);
  } catch (error) {
    return null;
  }
}

async function resolveTabUrl(tabId) {
  const fromCache = tabState.get(tabId)?.url || "";
  if (fromCache) {
    return fromCache;
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    return tab.url || "";
  } catch (error) {
    return "";
  }
}

function isBlankLikeUrl(url) {
  if (!url) {
    return true;
  }

  return (
    url === "about:blank" ||
    url.startsWith("about:blank#") ||
    url.startsWith("chrome://newtab")
  );
}

function numberOrNow(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
}

function cleanupTabState(tabId) {
  tabState.delete(tabId);
  recentGestures.delete(tabId);
  recentClicks.delete(tabId);
  newTabContexts.delete(tabId);
  restoreInFlight.delete(tabId);
}
