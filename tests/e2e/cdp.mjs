// Minimal Chrome DevTools Protocol client (flat sessions) using Node's built-in WebSocket.
export class CDP {
  static async connect(port) {
    const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const c = new CDP(new WebSocket(v.webSocketDebuggerUrl));
    await new Promise((res, rej) => { c.ws.onopen = res; c.ws.onerror = rej; });
    return c;
  }
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = [];
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(`${msg.error.message} ${msg.error.data || ''}`)) : res(msg.result);
      } else if (msg.method) {
        for (const h of this.handlers) h(msg);
      }
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  on(fn) { this.handlers.push(fn); }
  async attach(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return sessionId;
  }
  /** Evaluate an expression (may return a promise) in a session; returns the value. */
  async eval(sessionId, expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}
