// Runs in the PAGE (MAIN world) on voice.google.com and the Vici Dialer pages at document_start.
// Plan B call recording: records Google Voice browser calls itself, so no Workspace admin setting is needed.
// - Observes the page's own WebRTC connection (never changes the call): caller audio = remote track,
//   agent audio = the microphone track the page sends.
// - Dual-channel file: agent on the LEFT, caller on the RIGHT (lets the transcript label who spoke).
// - Opus/WebM via the browser's MediaRecorder (~32 kbps ≈ 14 MB per hour) for playback, plus one small mono file per
//   speaker (24 kbps each) so the server can transcribe each side separately ("Agent: … / Caller: …").
// - Only records while the content script says recording is enabled (connected, not paused, admin switch on).
// - The finished file is posted to the content script, which hands it to the service worker for upload.
// - Vici Dialer: the browser phone stays connected for the whole login (calls are bridged into it), so there a
//   file starts/stops on Vici's own call events ("rec-gate" from the Vici bridge), one file per customer call.
(() => {
  const VERSION = 2;
  // one recorder per page: a page hooked by an older copy keeps it until Voice is reloaded (never record twice)
  if (window.__cocoRecorder) return;
  window.__cocoRecorder = VERSION;
  const PC = window.RTCPeerConnection;
  if (!PC || !window.MediaRecorder || !window.AudioContext) return;

  const MIN_SEC = 2;                 // shorter = ringing blip, dropped
  const SEGMENT_SEC = 90 * 60;       // very long calls are split (upload limit 25 MB)
  const BITRATE = 32000;
  const PART_BITRATE = 24000;
  let enabled = false;               // set by the content script (coco-ext / rec-config)
  // Off Google (Vici): record only while the dialer says a customer call is live. Safe default before the bridge speaks.
  let gated = !/(^|\.)google\.com$/.test(location.hostname);
  let callOn = false;
  let gateTag = null;                // Vici call id, attached to the file
  const post = (msg) => window.postMessage({ source: 'coco-rec', ...msg }, window.location.origin);
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));
  const diag = { pcs: 0, sessions: 0, files: 0, errors: 0, lastError: null };
  const report = () => post({ type: 'diag', diag: { ...diag, enabled } });

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.data?.source !== 'coco-ext') return;
    if (ev.data.type === 'rec-gate') {
      gated = true;
      const was = callOn;
      callOn = !!ev.data.on;
      if (callOn) gateTag = ev.data.uid || gateTag;
      if (was && !callOn) sessions.forEach((s) => s.stop());       // customer hung up: finish this call's file
      if (!was && callOn) sessions.forEach((s) => s.maybeStart());
      return;
    }
    if (ev.data.type !== 'rec-config') return;
    const was = enabled;
    enabled = !!ev.data.enabled;
    if (was && !enabled) sessions.forEach((s) => s.stop()); // switched off mid-call: keep what was recorded
    if (!was && enabled) sessions.forEach((s) => s.maybeStart());
  });

  // Microphone tracks the page opened (fallback when the sender track isn't visible yet).
  const mics = new Set();
  const gum = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
  if (gum) {
    navigator.mediaDevices.getUserMedia = async function (constraints) {
      const stream = await gum(constraints);
      try {
        stream.getAudioTracks().forEach((t) => { mics.add(t); t.addEventListener('ended', () => mics.delete(t)); });
      } catch { /* never break the page */ }
      return stream;
    };
  }

  const sessions = new Map(); // RTCPeerConnection -> Session

  class Session {
    constructor(pc) {
      this.pc = pc;
      this.remote = new Map(); // track id -> track
      this.ctx = null; this.cur = null; this.connected = new Set(); this.keep = [];
      this.timer = null;
      diag.pcs++;
      pc.addEventListener('track', (e) => { if (e.track.kind === 'audio') this.addRemote(e.track); });
      const onState = () => {
        const s = pc.connectionState || pc.iceConnectionState;
        if (s === 'connected' || s === 'completed') this.maybeStart();
        if (s === 'closed' || s === 'failed') this.stop();
      };
      pc.addEventListener('connectionstatechange', onState);
      pc.addEventListener('iceconnectionstatechange', onState);
    }

    addRemote(track) {
      if (this.remote.has(track.id)) return;
      this.remote.set(track.id, track);
      track.addEventListener('ended', () => {
        if ([...this.remote.values()].every((t) => t.readyState === 'ended')) this.stop();
      });
      if (this.cur) this.wire(); else this.maybeStart();
    }

    localTracks() {
      const sent = this.pc.getSenders().map((s) => s.track).filter((t) => t && t.kind === 'audio' && t.readyState === 'live');
      if (sent.length) return sent;
      const live = [...mics].filter((t) => t.readyState === 'live');
      return live.slice(-1);
    }

    maybeStart() {
      if (this.cur || this.ctx || !enabled || (gated && !callOn)) return;
      try { this.pc.getReceivers().forEach((r) => { if (r.track?.kind === 'audio' && r.track.readyState === 'live') this.addRemoteSilently(r.track); }); } catch { /* ignore */ }
      const s = this.pc.connectionState || this.pc.iceConnectionState;
      if (!this.remote.size || !(s === 'connected' || s === 'completed')) return;
      this.start();
    }

    addRemoteSilently(track) { if (!this.remote.has(track.id)) this.remote.set(track.id, track); }

    get active() { return !!this.cur; }

    start() {
      try {
        this.ctx = new AudioContext();
        this.ctx.resume?.().catch(() => {});
        this.merger = this.ctx.createChannelMerger(2);
        this.dest = this.ctx.createMediaStreamDestination();
        this.merger.connect(this.dest);
        this.side = [this.ctx.createMediaStreamDestination(), this.ctx.createMediaStreamDestination()]; // agent, caller
        this.wire();
        this.mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
        this.segment();
        // pick up a mic that appears after the call connected; split very long calls
        this.timer = setInterval(() => {
          this.wire();
          if (this.cur && (Date.now() - this.cur.startedAt) / 1000 > SEGMENT_SEC) { const old = this.cur; this.segment(); this.end(old, false); }
        }, 2000);
        diag.sessions++;
        post({ type: 'state', recording: true, startedAt: this.cur.startedAt });
        report();
      } catch (e) {
        diag.errors++; diag.lastError = String(e?.message || e).slice(0, 120); report();
        this.cur = null;
        this.cleanup();
      }
    }

    /** Start a new file on the same audio graph. Each file keeps its own state (id, start, chunks). */
    segment() {
      const opts = (bps) => ({ ...(this.mime ? { mimeType: this.mime } : {}), audioBitsPerSecond: bps });
      const rec = { id: uuid(), startedAt: Date.now(), mime: this.mime || 'audio/webm', open: 0, tracks: {}, tag: gated ? gateTag : null };
      const add = (name, stream, bps) => {
        const mr = new MediaRecorder(stream, opts(bps));
        const t = { mr, chunks: [] };
        mr.ondataavailable = (e) => { if (e.data?.size) t.chunks.push(e.data); };
        mr.onstop = () => { if (--rec.open <= 0) this.deliver(rec); };
        rec.tracks[name] = t; rec.open++;
        mr.start(5000);
      };
      add('mix', this.dest.stream, BITRATE);
      try { add('agent', this.side[0].stream, PART_BITRATE); add('caller', this.side[1].stream, PART_BITRATE); } catch { /* mixed file alone still works */ }
      this.cur = rec;
    }

    /** Connect any not-yet-connected tracks: local mic -> left (0), caller -> right (1). */
    wire() {
      if (!this.ctx || this.ctx.state === 'closed') return;
      const add = (track, channel) => {
        if (this.connected.has(track.id) || track.readyState !== 'live') return;
        const stream = new MediaStream([track]);
        if (channel === 1) {
          // Chrome only feeds remote WebRTC audio into Web Audio while the stream is attached to a media element.
          const a = new Audio(); a.muted = true; a.srcObject = stream; a.play().catch(() => {});
          this.keep.push(a);
        }
        const src = this.ctx.createMediaStreamSource(stream);
        src.connect(this.merger, 0, channel);
        src.connect(this.side[channel]);
        this.connected.add(track.id);
      };
      this.localTracks().forEach((t) => add(t, 0));
      this.remote.forEach((t) => add(t, 1));
    }

    stop() {
      if (!this.cur) return;
      const rec = this.cur;
      this.cur = null;
      this.end(rec, true);
    }

    end(rec, last) {
      rec.endedAt = Date.now();
      for (const t of Object.values(rec.tracks)) {
        try { if (t.mr.state !== 'inactive') t.mr.stop(); else if (--rec.open <= 0) this.deliver(rec); } catch { if (--rec.open <= 0) this.deliver(rec); }
      }
      if (last) {
        // let the recorder flush its last chunk before the audio graph is torn down
        clearInterval(this.timer); this.timer = null;
        setTimeout(() => this.cleanup(), 1500);
        post({ type: 'state', recording: [...sessions.values()].some((s) => s.active) });
      }
    }

    deliver(rec) {
      if (rec.delivered) return;
      rec.delivered = true;
      const durationSec = Math.round(((rec.endedAt || Date.now()) - rec.startedAt) / 1000);
      const blob = (name) => (rec.tracks[name]?.chunks.length ? new Blob(rec.tracks[name].chunks, { type: rec.mime }) : null);
      const mix = blob('mix');
      if (durationSec < MIN_SEC || !mix) return;
      diag.files++;
      post({ type: 'recording', id: rec.id, tag: rec.tag, startedAt: new Date(rec.startedAt).toISOString(), durationSec, mime: rec.mime, blob: mix, agent: blob('agent'), caller: blob('caller') });
      report();
    }

    cleanup() {
      clearInterval(this.timer); this.timer = null;
      this.keep.forEach((a) => { a.srcObject = null; });
      this.keep = [];
      this.connected.clear();
      try { this.ctx?.close(); } catch { /* ignore */ }
      this.ctx = null;
    }
  }

  const session = (pc) => {
    let s = sessions.get(pc);
    if (!s) { s = new Session(pc); sessions.set(pc, s); }
    return s;
  };

  // Hook prototype methods (no constructor swap): every call connection runs these.
  const P = PC.prototype;
  const origSRD = P.setRemoteDescription;
  P.setRemoteDescription = function () {
    try { session(this); } catch { /* never break the page */ }
    return origSRD.apply(this, arguments);
  };
  const origSLD = P.setLocalDescription;
  P.setLocalDescription = function () {
    try { session(this); } catch { /* ignore */ }
    return origSLD.apply(this, arguments);
  };
  const origClose = P.close;
  P.close = function () {
    try { sessions.get(this)?.stop(); sessions.delete(this); } catch { /* ignore */ }
    return origClose.apply(this, arguments);
  };
  window.addEventListener('pagehide', () => sessions.forEach((s) => s.stop()));
  setTimeout(report, 3000);
})();
