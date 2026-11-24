// Left-docked mini tracker on voice.google.com (Shadow DOM, isolated from Google's styles).
// Collapsed = small tab on the left edge. Closing it never stops tracking; "Pause" does.
(() => {
  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  if (window.top !== window) return;
  document.getElementById('coco-voice-widget')?.remove(); // replace a copy left by an older version

  const host = document.createElement('div');
  host.id = 'coco-voice-widget';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
<style>
  :host { all: initial; }
  [hidden] { display: none !important; }
  * { box-sizing: border-box; font-family: 'DM Sans', system-ui, Arial, sans-serif; }
  .wrap { position: fixed; left: 0; top: 50%; transform: translateY(-50%); z-index: 2147483000; }
  .tab { display: flex; flex-direction: column; align-items: center; gap: 6px; width: 34px; padding: 10px 0;
    background: #000; color: #fff; border: 1px solid #262626; border-left: 0; border-radius: 0 10px 10px 0;
    cursor: pointer; box-shadow: 0 4px 16px rgba(0,0,0,.35); position: relative; overflow: hidden; }
  .tab::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 4px;
    background: linear-gradient(#ffba00 0 33%, #00843d 33% 66%, #cc3433 66%); }
  .tab .n { font: 700 15px 'Oswald', 'Arial Narrow', Arial, sans-serif; color: #ffba00; }
  .tab .v { writing-mode: vertical-rl; transform: rotate(180deg); font: 600 11px 'Oswald', 'Arial Narrow', Arial, sans-serif; letter-spacing: .12em; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #777; flex: none; }
  .ok { background: #00843d; } .warn { background: #ffba00; } .bad { background: #cc3433; } .paused { background: #777; }
  .card { width: 248px; margin-left: 8px; background: #111; color: #c0c0c0; border: 1px solid #262626; border-radius: 12px;
    overflow: hidden; box-shadow: 0 8px 28px rgba(0,0,0,.45); }
  .stripe { display: flex; height: 5px; } .stripe i { flex: 1; }
  .stripe i:nth-child(1) { background: #ffba00; } .stripe i:nth-child(2) { background: #00843d; } .stripe i:nth-child(3) { background: #cc3433; }
  .hd { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px 6px; }
  .brand { font: 700 16px 'Oswald', 'Arial Narrow', Arial, sans-serif; color: #fff; letter-spacing: .03em; }
  .brand span { color: #ffba00; }
  .x { background: none; border: 0; color: #c0c0c0; font-size: 18px; line-height: 1; cursor: pointer; padding: 2px 6px; border-radius: 6px; }
  .x:hover { background: #262626; color: #fff; }
  .st { display: flex; align-items: center; gap: 6px; padding: 0 12px 8px; font-size: 12px; color: #fff; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; padding: 0 12px; }
  .k { background: #171717; border: 1px solid #262626; border-radius: 8px; padding: 6px 8px; border-left: 3px solid #ffba00; }
  .k.g { border-left-color: #00843d; } .k.r { border-left-color: #cc3433; }
  .k.hero { grid-column: 1 / -1; background: #ffba00; border-color: #ffba00; }
  .k.hero .l, .k.hero .num { color: #000; }
  .l { font: 600 10px 'Oswald', 'Arial Narrow', Arial, sans-serif; text-transform: uppercase; letter-spacing: .06em; color: #c0c0c0; }
  .num { font: 700 18px 'Oswald', 'Arial Narrow', Arial, sans-serif; color: #fff; }
  .btns { display: flex; gap: 6px; padding: 10px 12px 4px; }
  button.b { flex: 1; border: 0; border-radius: 8px; padding: 8px; font: 600 12px 'DM Sans', system-ui, Arial; cursor: pointer; background: #ffba00; color: #000; }
  button.b.dark { background: #171717; color: #fff; border: 1px solid #262626; }
  button.b.stop { background: #cc3433; color: #fff; }
  button.b.go { background: #00843d; color: #fff; }
  .rec { display: flex; align-items: center; gap: 6px; margin: 0 12px 8px; padding: 5px 8px; border-radius: 8px; background: #cc3433; color: #fff; font: 600 11px 'DM Sans', system-ui, Arial; }
  .rec i { width: 8px; height: 8px; border-radius: 50%; background: #fff; animation: blink 1.2s infinite; }
  .tab .r { width: 9px; height: 9px; border-radius: 50%; background: #cc3433; animation: blink 1.2s infinite; }
  @keyframes blink { 50% { opacity: .25; } }
  @media (prefers-reduced-motion: reduce) { .rec i, .tab .r { animation: none; } }
  .note { font-size: 10px; color: #8a8a8a; padding: 4px 12px 10px; }
</style>
<div class="wrap">
  <div class="tab" part="tab" title="Coco Voice — click to open"><span class="dot"></span><span class="r" hidden title="This call is being recorded"></span><span class="n">0</span><span class="v">COCO</span></div>
  <div class="card" hidden>
    <div class="stripe"><i></i><i></i><i></i></div>
    <div class="hd"><div class="brand">COCO <span>VOICE</span></div><button class="x" title="Close (keeps tracking)">×</button></div>
    <div class="st"><span class="dot"></span><span class="stt">…</span></div>
    <div class="rec" hidden role="status"><i></i>REC · this call is being recorded</div>
    <div class="grid">
      <div class="k hero"><div class="l">Outbound today (calls + texts)</div><div class="num" data-k="outboundTotal">0</div></div>
      <div class="k"><div class="l">Calls out</div><div class="num" data-k="outboundCalls">0</div></div>
      <div class="k"><div class="l">Texts out</div><div class="num" data-k="outboundTexts">0</div></div>
      <div class="k g" data-tile="in"><div class="l">Calls in</div><div class="num" data-k="inboundCalls">0</div></div>
      <div class="k g"><div class="l">Texts in</div><div class="num" data-k="inboundTexts">0</div></div>
    </div>
    <div class="btns"><button class="b stop" data-a="pause">Pause</button><button class="b dark" data-a="sync">Sync now</button></div>
    <div class="note">Closing this keeps tracking on. Use Pause to stop.</div>
  </div>
</div>`;

  const $ = (s) => root.querySelector(s);
  const tab = $('.tab');
  const card = $('.card');
  let state = {};

  function render() {
    const s = state.summaryToday || {};
    const level = state.status?.level || 'warn';
    root.querySelectorAll('.dot').forEach((d) => { d.className = `dot ${level}`; });
    $('.stt').textContent = state.status?.text || 'Starting…';
    $('.n').textContent = s.outboundTotal ?? 0;
    root.querySelectorAll('[data-k]').forEach((el) => { el.textContent = s[el.dataset.k] ?? 0; });
    const tileIn = $('[data-tile="in"]');
    tileIn.classList.toggle('r', (s.missedCalls || 0) > 0);
    tileIn.classList.toggle('g', !(s.missedCalls > 0));
    const pause = $('[data-a="pause"]');
    pause.textContent = state.paused ? 'Resume' : 'Pause';
    pause.className = `b ${state.paused ? 'go' : 'stop'}`;
    const rec = state.recState?.on === true && Date.now() - (state.recState.at || 0) < 4 * 3600e3;
    $('.rec').hidden = !rec;
    $('.tab .r').hidden = !rec;
    const open = state.widgetOpen === true;
    card.hidden = !open;
    tab.hidden = open;
    host.style.display = state.showWidget === false ? 'none' : '';
  }

  const load = async () => {
    if (!alive()) return;
    state = await chrome.storage.local.get(['summaryToday', 'status', 'paused', 'showWidget', 'widgetOpen', 'recState']);
    render();
  };
  const save = (obj) => { if (alive()) chrome.storage.local.set(obj); };
  const send = (msg) => (alive() ? chrome.runtime.sendMessage(msg).catch(() => {}) : Promise.resolve());

  tab.addEventListener('click', () => save({ widgetOpen: true }));
  $('.x').addEventListener('click', () => save({ widgetOpen: false }));
  root.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'pause') {
      if (state.paused || confirm('Pause tracking? Live capture stops until you resume, and your manager will see that tracking is paused. Activity from the pause can still be counted from Voice history after you resume.')) send({ type: 'set-paused', paused: !state.paused });
    }
    if (a === 'sync') { e.target.textContent = 'Syncing…'; await send({ type: 'sync-now' }); e.target.textContent = 'Sync now'; }
  });

  const onChange = () => { if (!alive()) { chrome.storage?.onChanged?.removeListener?.(onChange); host.remove(); return; } load(); };
  chrome.storage.onChanged.addListener(onChange);

  const mount = () => { (document.body || document.documentElement).appendChild(host); load(); };
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount, { once: true });
})();
