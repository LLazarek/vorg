// Bridges window.postMessage from the OrgHTML canvas to the extension background.
// Injected into http://127.0.0.1:*/* by the manifest content_scripts declaration.
console.log("[orghtml-ext] content script loaded on", window.location.href);

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;
  const msg = event.data;
  if (!msg || msg.type !== "orghtml-open") return;
  console.log("[orghtml-ext] content received orghtml-open", msg);
  // Ack immediately so the canvas knows the extension is alive.
  window.postMessage({ type: "orghtml-open-ack", reqId: msg.reqId, stage: "content" }, window.location.origin);
  chrome.runtime.sendMessage(
    { type: "open", snapshotId: msg.snapshotId, url: msg.url, title: msg.title },
    (response) => {
      if (chrome.runtime.lastError) {
        console.error("[orghtml-ext] sendMessage failed:", chrome.runtime.lastError.message);
      } else {
        console.log("[orghtml-ext] background responded:", response);
      }
    }
  );
});
