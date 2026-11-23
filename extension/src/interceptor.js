// Runs in the PAGE (MAIN world) on voice.google.com at document_start.
// Passively copies responses of Google Voice's own requests. Never modifies,
// blocks or creates requests.
(() => {
  if (window.__cocoInterceptor) return;
  window.__cocoInterceptor = true;

  const MATCH = /\/voice\/v1\/voiceclient\/(api2thread\/(list|get|sendsms)|account\/get)/;
  const MAX = 5 * 1024 * 1024;

  const emit = (url, body, reqBody) => {
    if (typeof body !== 'string' || body.length > MAX) return;
    window.postMessage({
      source: 'coco-gv', url: String(url), body,
      reqBody: typeof reqBody === 'string' ? reqBody.slice(0, 20000) : null,
    }, window.location.origin);
  };

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const res = await origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : input?.url;
      if (url && MATCH.test(url)) {
        const reqBody = init && typeof init.body === 'string' ? init.body : null;
        res.clone().text().then((t) => emit(url, t, reqBody)).catch(() => {});
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
      if (this.__cocoUrl && MATCH.test(this.__cocoUrl)) {
        const reqBody = typeof body === 'string' ? body : null;
        this.addEventListener('load', () => {
          try {
            if (this.responseType === '' || this.responseType === 'text') emit(this.__cocoUrl, this.responseText, reqBody);
          } catch { /* ignore */ }
        });
      }
    } catch { /* ignore */ }
    return XS.apply(this, arguments);
  };
})();
