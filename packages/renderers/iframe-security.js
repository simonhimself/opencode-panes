export function createArtifactEgressGuardScript() {
  return `(() => {
    const securityError = (name) => new DOMException(name + " is disabled in artifact previews", "SecurityError");
    const fail = (name) => function () { throw securityError(name); };
    const lock = (target, name, value) => {
      try { Object.defineProperty(target, name, { configurable: false, writable: false, value }); }
      catch { try { target[name] = value; } catch {} }
    };
    for (const name of ["WebSocket", "RTCPeerConnection", "webkitRTCPeerConnection"]) lock(globalThis, name, fail(name));
    lock(globalThis, "open", fail("window.open"));
    const hints = new Set(["dns-prefetch", "modulepreload", "preconnect", "prefetch", "preload", "prerender"]);
    const isHint = (value) => String(value).toLowerCase().split(/\s+/).some((token) => hints.has(token));
    const removeHint = (node) => {
      if (node instanceof HTMLLinkElement && isHint(node.getAttribute("rel") || "")) node.remove();
      if (node instanceof Element) for (const link of node.querySelectorAll("link[rel]")) if (isHint(link.getAttribute("rel") || "")) link.remove();
    };
    const nativeSetAttribute = Element.prototype.setAttribute;
    lock(Element.prototype, "setAttribute", function (name, value) {
      if (this instanceof HTMLLinkElement && String(name).toLowerCase() === "rel" && isHint(value)) throw securityError("resource hints");
      return nativeSetAttribute.call(this, name, value);
    });
    const relDescriptor = Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype, "rel");
    if (relDescriptor?.get && relDescriptor.set) {
      try {
        Object.defineProperty(HTMLLinkElement.prototype, "rel", {
          configurable: false,
          enumerable: relDescriptor.enumerable,
          get: relDescriptor.get,
          set(value) {
            if (isHint(value)) throw securityError("resource hints");
            relDescriptor.set.call(this, value);
          },
        });
      } catch {}
    }
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes") removeHint(record.target);
        for (const node of record.addedNodes) removeHint(node);
      }
    }).observe(document.documentElement, { attributeFilter: ["rel"], attributes: true, childList: true, subtree: true });
  })();`;
}
