// Voice front-end. Everything the server says is spoken aloud; nothing is rendered as HTML.
const $ = (id) => document.getElementById(id);
const talk = $('talk'), label = $('talk-label'), log = $('log'), hold = $('hold'), modeEl = $('mode');

let sessionId = null;
let rate = 1;
let lastSpoken = '';
let polling = null;
let listening = false;

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const synth = window.speechSynthesis;

// ── earcons: one short tone per risk band, so danger is audible before any words ──
let audioCtx = null;
const TONES = { read: [660], low: [523], medium: [440, 440], high: [330, 330, 330], severe: [247, 247, 247, 247], blocked: [175, 140] };
function earcon(band) {
  const seq = TONES[band];
  if (!seq) return;
  try {
    audioCtx ??= new AudioContext();
    let t = audioCtx.currentTime;
    for (const f of seq) {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = f; o.type = 'sine';
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.15, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      o.connect(g).connect(audioCtx.destination); o.start(t); o.stop(t + 0.2);
      t += 0.22;
    }
  } catch { /* audio is a nicety, never a requirement */ }
}

function add(text, cls) {
  const li = document.createElement('li');
  li.textContent = text;
  if (cls) li.className = cls;
  log.prepend(li);
}

function speak(text) {
  lastSpoken = text;
  if (!synth) return Promise.resolve();
  synth.cancel();
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = rate; u.onend = u.onerror = () => resolve();
    synth.speak(u);
  });
}

async function api(path, body) {
  const res = await fetch(path, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

function setHold(until) {
  clearInterval(polling); polling = null;
  if (!until) { hold.hidden = true; return; }
  hold.hidden = false;
  const tick = async () => {
    const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    hold.textContent = left > 0 ? `Payment on hold: ${left} seconds. Say cancel to stop it.` : 'Finishing…';
    if (left <= 0 || left % 2 === 0) {
      const r = await api(`/api/session/${sessionId}/events`);
      for (const e of r.json.events ?? []) { add(e, 'read'); await speak(e); }
      if (r.json.state && r.json.state !== 'cooling') setHold(null);
    }
  };
  tick(); polling = setInterval(tick, 1000);
}

async function send(text, meta = {}) {
  if (!text.trim()) return;
  add(text, 'you');
  const r = await api('/api/turn', { sessionId, text, utcOffsetMinutes: -new Date().getTimezoneOffset(), lastAssistantText: lastSpoken, ...meta });
  const out = r.json;
  const say = out.say ?? 'Something went wrong. Nothing was sent.';
  if (out.rate) rate = out.rate === 'slower' ? Math.max(0.6, rate - 0.2) : Math.min(1.6, rate + 0.2);
  earcon(out.band);
  add(say, out.band);
  await speak(say);
  for (const e of out.events ?? []) { add(e, 'read'); await speak(e); }
  setHold(out.holdUntil);
}

// ── microphone: press to talk, stop talking, we send ──
function listen() {
  if (!SR) {
    // Browsers withhold the microphone outside a secure context, which looks identical
    // to an unsupported browser unless we check.
    speak(window.isSecureContext
      ? 'Voice input is not supported in this browser. Please type your request.'
      : 'Voice input needs a secure connection. This page is not served over HTTPS, so the microphone is blocked. Please type your request.');
    $('text').focus();
    return;
  }
  if (listening) return;
  synth?.cancel(); // pressing the button is an intentional barge-in
  const rec = new SR();
  rec.lang = 'en-US'; rec.interimResults = false; rec.maxAlternatives = 1; rec.continuous = false;
  let handled = false;
  rec.onstart = () => { listening = true; talk.setAttribute('aria-pressed', 'true'); label.textContent = 'Listening…'; };
  rec.onresult = (ev) => {
    handled = true;
    const r = ev.results[ev.results.length - 1], alt = r[0];
    // If our own voice is still playing when the result lands, the mic may have heard us, not the user.
    send(alt.transcript, { confidence: alt.confidence || undefined, isFinal: r.isFinal, duringPlayback: !!synth?.speaking });
  };
  rec.onerror = (e) => { if (!handled && e.error !== 'aborted') speak(e.error === 'no-speech' ? 'I did not hear anything.' : 'I could not use the microphone.'); };
  rec.onend = () => { listening = false; talk.setAttribute('aria-pressed', 'false'); label.textContent = 'Talk'; };
  rec.start();
}

talk.addEventListener('click', listen);
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !/^(INPUT|TEXTAREA|BUTTON)$/.test(document.activeElement?.tagName ?? '')) { e.preventDefault(); listen(); }
});
$('typed').addEventListener('submit', (e) => {
  e.preventDefault();
  const el = $('text'); const v = el.value; el.value = '';
  send(v, { confidence: 1, isFinal: true, duringPlayback: false });
});

(async function start() {
  const h = await api('/api/health');
  modeEl.textContent = h.json.mode === 'sandbox' ? 'PayPal sandbox' : 'Demo mode';
  modeEl.classList.add(h.json.mode ?? 'mock');
  const s = await api('/api/session', {});
  if (!s.ok) { modeEl.textContent = 'Offline'; add('Could not start a session.', 'blocked'); return; }
  sessionId = s.json.sessionId;
  add(s.json.say, 'read');
  speak(s.json.say);
})();
