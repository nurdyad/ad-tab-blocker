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
