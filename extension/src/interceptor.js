// Runs in the PAGE (MAIN world) on voice.google.com at document_start.
// Passively copies responses of Google Voice's own requests. Never modifies, blocks or creates requests.
// Watches EVERY voiceclient endpoint (Google may load threads through different ones); the
// service worker decides what can be parsed and records which endpoints are seen (diagnostics).
(() => {
  const VERSION = 3;
  if ((window.__cocoInterceptor || 0) >= VERSION) return;
  const firstInstall = !window.__cocoInterceptor;
  window.__cocoInterceptor = VERSION;

  // Old JSON API + newer gRPC-web ($rpc) API on voice.clients6 + the live push channel (signaler).
  const MATCH = /\/voice\/v1\/voiceclient\/|voice\.clients6\.google\.com\/\$rpc\/|signaler-pa\.clients6\.google\.com\/punctual\/multi-watch\/channel/;
  const MAX = 8 * 1024 * 1024;
  // NOTE: a page hooked by an older copy keeps the older MATCH until Voice is reloaded.

  const emit = (url, body, reqBody) => {
    if (typeof body !== 'string' || !body || body.length > MAX) return;
    window.postMessage({
      source: 'coco-gv', url: String(url), body,
      reqBody: typeof reqBody === 'string' ? reqBody.slice(0, 20000) : null,
    }, window.location.origin);
  };
  // expose for a newer version of this script to reuse (re-injection after extension update)
  window.__cocoEmit = emit;
  if (!firstInstall) return; // fetch/XHR are already wrapped by an older copy that calls __cocoEmit

  const bodyText = (b) => (typeof b === 'string' ? b : b instanceof URLSearchParams ? b.toString() : null);

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const res = await origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : input?.url;
      if (url && MATCH.test(url)) {
        const reqBody = bodyText(init?.body);
        res.clone().text().then((t) => (window.__cocoEmit || emit)(url, t, reqBody)).catch(() => {});
      }
    } catch { /* never break the page */ }
    return res;
  };

  const XO = XMLHttpRequest.prototype.open;
  const XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__cocoUrl = url;
    return XO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      if (this.__cocoUrl && MATCH.test(String(this.__cocoUrl))) {
        const reqBody = bodyText(body);
        this.addEventListener('load', () => {
          try {
            const rt = this.responseType;
            let text = null;
            if (rt === '' || rt === 'text') text = this.responseText;
            else if (rt === 'json' && this.response != null) text = JSON.stringify(this.response);
            if (text) (window.__cocoEmit || emit)(this.__cocoUrl, text, reqBody);
          } catch { /* ignore */ }
        });
      }
    } catch { /* ignore */ }
    return XS.apply(this, arguments);
  };
})();
