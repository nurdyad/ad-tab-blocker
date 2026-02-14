(() => {
  if (window.__ATB_PAGE_GUARD_LOADED__) {
    return;
  }
  window.__ATB_PAGE_GUARD_LOADED__ = true;

  const channel = "ATB_PAGE_CHANNEL";
  const gestureWindowMs = 1200;
  let lastTrustedAnchorHref = "";
  let lastTrustedAnchorAt = 0;

  const trackedEvents = [
    "pointerdown",
    "mousedown",
    "click",
    "keydown",
    "touchstart",
    "contextmenu",
  ];

  for (const eventName of trackedEvents) {
    document.addEventListener(
      eventName,
      (event) => {
        if (!event.isTrusted) {
          return;
        }

        postMessageToExtension("ATB_PAGE_USER_GESTURE", { kind: eventName });

        if (eventName === "click") {
          const anchor = findAnchorInPage(event);
          if (anchor && anchor.href) {
            lastTrustedAnchorHref = anchor.href;
            lastTrustedAnchorAt = Date.now();
            postMessageToExtension("ATB_PAGE_CLICK", { href: anchor.href });
          }
        }
      },
      true
    );
  }

  const originalOpen = window.open;
  if (typeof originalOpen === "function") {
    window.open = function guardedOpen(url, target, features) {
      const resolved = resolveUrl(url);
      const sameOrigin = Boolean(resolved) && resolved.origin === location.origin;
      const allow = sameOrigin || hasRecentMatchingAnchorClick(resolved);

      if (!allow) {
        postMessageToExtension("ATB_PAGE_BLOCKED", {
          eventType: "popup_window_open",
          targetUrl: resolved ? resolved.href : stringifyUrl(url),
          reason: "window_open_without_matching_user_click",
        });
        return null;
      }

      return originalOpen.call(this, url, target, features);
    };
  }

  if (
    window.Location &&
    window.Location.prototype &&
    typeof window.Location.prototype.assign === "function"
  ) {
    const originalAssign = window.Location.prototype.assign;
    window.Location.prototype.assign = function guardedAssign(url) {
      if (shouldBlockLocationMutation(url, "location_assign")) {
        return;
      }

      return originalAssign.call(this, url);
    };
  }

  if (
    window.Location &&
    window.Location.prototype &&
    typeof window.Location.prototype.replace === "function"
  ) {
    const originalReplace = window.Location.prototype.replace;
    window.Location.prototype.replace = function guardedReplace(url) {
      if (shouldBlockLocationMutation(url, "location_replace")) {
        return;
      }

      return originalReplace.call(this, url);
    };
  }

  function shouldBlockLocationMutation(url, eventType) {
    const resolved = resolveUrl(url);

    if (!resolved) {
      return false;
    }

    const sameOrigin = resolved.origin === location.origin;
    if (sameOrigin || hasRecentMatchingAnchorClick(resolved)) {
      return false;
    }

    postMessageToExtension("ATB_PAGE_BLOCKED", {
      eventType,
      targetUrl: resolved.href,
      reason: "cross_origin_location_change_without_matching_user_click",
    });

    return true;
  }

  function hasRecentMatchingAnchorClick(targetUrl) {
    if (!targetUrl || !lastTrustedAnchorHref) {
      return false;
    }

    if (Date.now() - lastTrustedAnchorAt > gestureWindowMs) {
      return false;
    }

    const clicked = resolveUrl(lastTrustedAnchorHref);
    if (!clicked) {
      return false;
    }

    if (targetUrl.origin !== clicked.origin) {
      return false;
    }

    return (
      targetUrl.pathname === clicked.pathname ||
      `${targetUrl.pathname}${targetUrl.search}` ===
        `${clicked.pathname}${clicked.search}`
    );
  }

  function resolveUrl(value) {
    try {
      return new URL(stringifyUrl(value), location.href);
    } catch (error) {
      return null;
    }
  }

  function stringifyUrl(value) {
    if (typeof value === "string") {
      return value;
    }
    if (value == null) {
      return "";
    }
    return String(value);
  }

  function findAnchorInPage(event) {
    if (typeof event.composedPath === "function") {
      const path = event.composedPath();
      for (const node of path) {
        if (
          node &&
          typeof node === "object" &&
          node.tagName === "A" &&
          typeof node.href === "string"
        ) {
          return node;
        }
      }
    }

    if (event.target && typeof event.target.closest === "function") {
      return event.target.closest("a[href]");
    }

    return null;
  }

  function postMessageToExtension(type, payload) {
    window.postMessage(
      {
        channel,
        type,
        ...payload,
      },
      "*"
    );
  }
})();
