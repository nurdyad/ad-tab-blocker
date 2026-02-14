(() => {
  if (window.__ATB_CONTENT_SCRIPT_LOADED__) {
    return;
  }
  window.__ATB_CONTENT_SCRIPT_LOADED__ = true;

  const CHANNEL = "ATB_PAGE_CHANNEL";
  const USER_GESTURE_EVENTS = [
    "pointerdown",
    "mousedown",
    "click",
    "keydown",
    "touchstart",
    "contextmenu",
  ];

  for (const eventName of USER_GESTURE_EVENTS) {
    document.addEventListener(
      eventName,
      (event) => {
        if (!event.isTrusted) {
          return;
        }

        sendRuntimeMessage({
          type: "ATB_USER_GESTURE",
          kind: eventName,
          timestamp: Date.now(),
          pageUrl: location.href,
        });
      },
      true
    );
  }

  document.addEventListener(
    "click",
    (event) => {
      if (!event.isTrusted) {
        return;
      }

      const anchor = findAnchor(event);
      if (!anchor || !anchor.href) {
        return;
      }

      sendRuntimeMessage({
        type: "ATB_CLICK_INFO",
        href: anchor.href,
        timestamp: Date.now(),
        pageUrl: location.href,
        button: event.button,
        ctrlKey: Boolean(event.ctrlKey),
        metaKey: Boolean(event.metaKey),
        shiftKey: Boolean(event.shiftKey),
      });
    },
    true
  );

  window.addEventListener("message", (event) => {
    if (event.source !== window) {
      return;
    }

    const data = event.data;
    if (!data || data.channel !== CHANNEL) {
      return;
    }

    if (data.type === "ATB_PAGE_BLOCKED") {
      sendRuntimeMessage({
        type: "ATB_BLOCKED_EVENT",
        eventType: data.eventType,
        targetUrl: data.targetUrl || "",
        sourceUrl: location.href,
        reason: data.reason || "blocked_in_page_guard",
        timestamp: Date.now(),
      });
      return;
    }

    if (data.type === "ATB_PAGE_USER_GESTURE") {
      sendRuntimeMessage({
        type: "ATB_USER_GESTURE",
        kind: data.kind || "page_gesture",
        timestamp: Date.now(),
        pageUrl: location.href,
      });
      return;
    }

    if (data.type === "ATB_PAGE_CLICK") {
      sendRuntimeMessage({
        type: "ATB_CLICK_INFO",
        href: data.href || "",
        timestamp: Date.now(),
        pageUrl: location.href,
      });
    }
  });

  injectPageGuard(CHANNEL);
})();

function sendRuntimeMessage(payload) {
  try {
    chrome.runtime.sendMessage(payload);
  } catch (error) {
    // Ignore transient messaging errors (e.g., page unload race).
  }
}

function findAnchor(event) {
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

  if (event.target instanceof Element) {
    return event.target.closest("a[href]");
  }

  return null;
}

function injectPageGuard(channel) {
  const script = document.createElement("script");
  const payload = {
    channel,
    gestureWindowMs: 1200,
  };

  script.textContent = `;(${pageGuard.toString()})(${JSON.stringify(payload)});`;
  (document.documentElement || document.head).appendChild(script);
  script.remove();
}

function pageGuard(config) {
  if (window.__ATB_PAGE_GUARD_LOADED__) {
    return;
  }
  window.__ATB_PAGE_GUARD_LOADED__ = true;

  const channel = config.channel;
  const gestureWindowMs = Number(config.gestureWindowMs) || 1200;
  let lastTrustedInputAt = 0;

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

        lastTrustedInputAt = Date.now();
        postMessageToExtension("ATB_PAGE_USER_GESTURE", { kind: eventName });

        if (eventName === "click") {
          const anchor = findAnchorInPage(event);
          if (anchor && anchor.href) {
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
      const allow = sameOrigin || hasRecentGesture();

      if (!allow) {
        postMessageToExtension("ATB_PAGE_BLOCKED", {
          eventType: "popup_window_open",
          targetUrl: resolved ? resolved.href : stringifyUrl(url),
          reason: "window_open_without_recent_user_gesture",
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
    if (sameOrigin || hasRecentGesture()) {
      return false;
    }

    postMessageToExtension("ATB_PAGE_BLOCKED", {
      eventType,
      targetUrl: resolved.href,
      reason: "cross_origin_location_change_without_recent_user_gesture",
    });

    return true;
  }

  function hasRecentGesture() {
    return Date.now() - lastTrustedInputAt <= gestureWindowMs;
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
}
