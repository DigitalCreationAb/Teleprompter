'use strict';

const $ = (s) => document.querySelector(s);
const STORE_KEY = 'dc-teleprompter:v1';

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const settings = Object.assign(
  { speeches: [], currentId: null, lang: 'sv-SE', fontSize: 56, mirror: false },
  load()
);

// Earlier versions stored a single script in settings.text; keep it as the first speech.
if (typeof settings.text === 'string') {
  if (settings.text.trim() && !settings.speeches.length) settings.speeches.push(newSpeech('', settings.text));
  delete settings.text;
}
if (!settings.speeches.length) settings.speeches.push(newSpeech());
if (!settings.speeches.some((s) => s.id === settings.currentId)) settings.currentId = settings.speeches[0].id;

// tokens: every word as rendered. seq: indices into tokens that can be matched (have letters/digits).
// pos: index into seq of the next word the speaker is expected to say.
let tokens = [];
let seq = [];
let pos = 0;

let recog = null;
let listening = false; // user intent: should we be listening?
let wakeLock = null;
let lastTail = '';
let backCandidate = null; // pending "we jumped too far" position awaiting confirmation

// Talk timer: starts on the first recognized speech, pauses while the mic is off.
let talkedMs = 0;
let talkingSince = null;
let clockTimer = null;

/* ---------- persistence ---------- */
function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch { /* private mode etc. */ }
}

/* ---------- speeches ---------- */
function newSpeech(title = '', text = '') {
  return { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), title, text };
}

function current() {
  return settings.speeches.find((s) => s.id === settings.currentId);
}

function speechLabel(s) {
  return s.title.trim() || s.text.trim().split(/\s+/).slice(0, 6).join(' ') || 'Untitled';
}

function renderSpeechList() {
  const list = $('#speechList');
  list.innerHTML = '';
  for (const s of settings.speeches) list.add(new Option(speechLabel(s), s.id, false, s.id === settings.currentId));
}

function showSpeech(id) {
  settings.currentId = id;
  save();
  $('#title').value = current().title;
  $('#script').value = current().text;
  renderSpeechList();
  renderPreview();
}

/* ---------- text processing ---------- */
function norm(w) {
  return w
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// Forgiving word comparison: recognizers misspell, split compounds and emit partial words.
function similar(a, b) {
  if (a === b) return true;
  const short = Math.min(a.length, b.length);
  const long = Math.max(a.length, b.length);
  if (short >= 4 && (a.startsWith(b) || b.startsWith(a))) return true;
  if (short < 4) return false;
  return lev(a, b) <= (long >= 7 ? 2 : 1);
}

function scriptWord(i) {
  return tokens[seq[i]].norm;
}

/* ---------- rendering ---------- */
function buildText() {
  const root = $('#text');
  root.innerHTML = '';
  tokens = [];
  seq = [];

  const paragraphs = current().text.trim().split(/\n\s*\n/);
  for (const para of paragraphs) {
    const p = document.createElement('p');
    const lines = para.split('\n');
    lines.forEach((line, li) => {
      if (li > 0) p.appendChild(document.createElement('br'));
      for (const word of line.split(/\s+/).filter(Boolean)) {
        const span = document.createElement('span');
        span.className = 'w';
        span.textContent = word;
        span.dataset.t = tokens.length;
        const n = norm(word);
        if (n) seq.push(tokens.length);
        tokens.push({ el: span, norm: n });
        p.appendChild(span);
        p.appendChild(document.createTextNode(' '));
      }
    });
    root.appendChild(p);
  }
}

function setPos(next, { force = false } = {}) {
  next = Math.max(0, Math.min(seq.length, next));
  if (next === pos && !force) return;
  pos = next;
  const curToken = pos < seq.length ? seq[pos] : tokens.length;
  tokens.forEach((t, i) => {
    t.el.classList.toggle('spoken', i < curToken);
    t.el.classList.toggle('current', i === curToken);
  });
  scrollToCurrent();
}

function scrollToCurrent() {
  const text = $('#text');
  const curToken = pos < seq.length ? seq[pos] : tokens.length - 1;
  const el = tokens[curToken]?.el;
  if (!el) return;
  const focusY = window.innerHeight * parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--focus')) / 100;
  text.style.transform = `translateY(${focusY - el.offsetTop}px)`;
}

/* ---------- talk timer ---------- */
function elapsedMs() {
  return talkedMs + (talkingSince ? Date.now() - talkingSince : 0);
}

function renderClock() {
  const s = Math.floor(elapsedMs() / 1000);
  const h = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  $('#clock').textContent = h ? `${h}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
  $('#clock').classList.toggle('running', !!talkingSince);
}

function startClock() {
  if (talkingSince) return;
  talkingSince = Date.now();
  clockTimer = setInterval(renderClock, 250);
  renderClock();
}

function pauseClock() {
  if (talkingSince) talkedMs += Date.now() - talkingSince;
  talkingSince = null;
  clearInterval(clockTimer);
  renderClock();
}

function resetClock() {
  pauseClock();
  talkedMs = 0;
  renderClock();
}

/* ---------- speech following ---------- */
// Find where in the script the speaker most likely is, given the last few words heard.
// Matches the spoken tail backwards against the script ending at each candidate position.
function follow(spoken) {
  const tail = spoken.slice(-8);
  const key = tail.join(' ');
  if (!tail.length || key === lastTail) return;
  lastTail = key;

  // Search behind the current position too, so a jump that went too far can be undone.
  const cur = pos - 1; // last word we believe was spoken
  const from = Math.max(0, pos - 40);
  const to = Math.min(seq.length - 1, pos + 40);
  let best = null;

  for (let p = from; p <= to; p++) {
    if (!similar(tail[tail.length - 1], scriptWord(p))) continue;

    // Short words ("och", "en", "the") appear everywhere, so they count as half evidence.
    let score = 0, si = p, ti = tail.length - 1, misses = 0;
    while (ti >= 0 && si >= 0 && misses < 3) {
      if (similar(tail[ti], scriptWord(si))) { score += scriptWord(si).length <= 3 ? 0.5 : 1; ti--; si--; }
      else if (ti > 0 && similar(tail[ti - 1], scriptWord(si))) { ti--; misses++; } // extra spoken word
      else if (si > 0 && similar(tail[ti], scriptWord(si - 1))) { si--; misses++; } // skipped script word
      else { ti--; si--; misses++; }
    }

    // The further the move, the more evidence we require. Going back needs a solid phrase match.
    const dist = p - cur;
    const needed = dist >= 0
      ? (dist <= 2 ? 1 : dist <= 12 ? 2 : 3)
      : (dist >= -15 ? 3 : 4);
    if (score < needed) continue;
    // Equal evidence: stay closest to where we are.
    if (!best || score > best.score || (score === best.score && Math.abs(dist) < Math.abs(best.dist))) {
      best = { p, score, dist };
    }
  }

  if (!best) return;

  if (best.dist >= 0) {
    backCandidate = null;
    if (best.p + 1 > pos) setPos(best.p + 1);
    return;
  }

  // We seem to be ahead of the speaker. Only back up when two checks in a row agree,
  // so a single garbled interim result can't yank the text backwards.
  if (backCandidate !== null && Math.abs(best.p - backCandidate) <= 3) {
    backCandidate = null;
    setPos(best.p + 1);
  } else {
    backCandidate = best.p;
  }
}

function startListening() {
  if (!SpeechRecognition) return;
  listening = true;
  $('#mic').classList.add('live');
  lastTail = '';
  backCandidate = null;

  recog = new SpeechRecognition();
  recog.lang = settings.lang;
  recog.continuous = true;
  recog.interimResults = true;
  recog.maxAlternatives = 1;

  recog.onresult = (e) => {
    let transcript = '';
    for (let i = 0; i < e.results.length; i++) transcript += e.results[i][0].transcript + ' ';
    const words = transcript.split(/\s+/).map(norm).filter(Boolean);
    if (words.length) startClock();
    $('#heard').textContent = transcript.trim().slice(-80);
    follow(words);
  };

  recog.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      $('#heard').textContent = 'Microphone access was blocked. Allow it in the browser settings.';
      stopListening();
    }
  };

  // Recognition stops on its own after silence or ~60s; restart while the user wants it on.
  recog.onend = () => {
    if (!listening) return;
    try { recog.start(); }
    catch { stopListening(); $('#heard').textContent = 'Tap 🎤 to resume listening.'; }
  };

  try { recog.start(); } catch { /* already started */ }
}

function stopListening() {
  listening = false;
  pauseClock();
  $('#mic').classList.remove('live');
  if (recog) {
    recog.onend = null;
    try { recog.abort(); } catch { /* ignore */ }
    recog = null;
  }
}

/* ---------- screen wake lock ---------- */
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* unsupported */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !$('#prompter').hidden) keepAwake();
});

/* ---------- view switching ---------- */
function renderPreview() {
  const box = $('#previewText');
  const words = current().text.trim().split(/\s+/).filter(Boolean).slice(0, 60);
  box.classList.toggle('placeholder', !words.length);
  box.textContent = '';
  if (!words.length) {
    box.textContent = 'This is how big your text will be in the prompter.';
    return;
  }
  const first = document.createElement('span');
  first.className = 'current';
  first.textContent = words[0];
  box.append(first, ' ' + words.slice(1).join(' '));
}

function applyLook() {
  document.documentElement.style.setProperty('--font-size', settings.fontSize + 'px');
  $('#prompter').classList.toggle('mirror', settings.mirror);
  $('#preview').classList.toggle('mirror', settings.mirror);
  $('#sizeVal').textContent = settings.fontSize + 'px';
  $('#size').value = settings.fontSize;
  $('#mirror').checked = settings.mirror;
}

function openPrompter() {
  if (!current().text.trim()) { $('#script').focus(); return; }

  $('#editor').hidden = true;
  $('#prompter').hidden = false;
  buildText();
  applyLook();
  setPos(0, { force: true });
  resetClock();
  keepAwake();
  startListening();
  poke();
}

function closePrompter() {
  stopListening();
  wakeLock?.release?.();
  wakeLock = null;
  $('#prompter').hidden = true;
  $('#editor').hidden = false;
}

// Hide controls while reading; show them on touch/mouse movement.
let idleTimer = null;
function poke() {
  $('#prompter').classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => $('#prompter').classList.add('idle'), 3000);
}

/* ---------- wiring ---------- */
$('#lang').value = settings.lang;
applyLook();
showSpeech(settings.currentId);

if (!SpeechRecognition) {
  $('#support').hidden = false;
  $('#support').textContent =
    'Speech recognition is not supported in this browser. Use Chrome (desktop/Android) or Safari (iPhone). You can still scroll manually.';
}

// Edits save straight into the selected speech.
$('#script').addEventListener('input', () => {
  current().text = $('#script').value;
  save();
  renderPreview();
  if (!current().title.trim()) $('#speechList').selectedOptions[0].text = speechLabel(current());
});
$('#title').addEventListener('input', () => {
  current().title = $('#title').value;
  save();
  $('#speechList').selectedOptions[0].text = speechLabel(current());
});
$('#speechList').addEventListener('change', () => showSpeech($('#speechList').value));
$('#newSpeech').addEventListener('click', () => {
  const s = newSpeech();
  settings.speeches.push(s);
  showSpeech(s.id);
  $('#title').focus();
});
$('#deleteSpeech').addEventListener('click', () => {
  if (!confirm(`Delete "${speechLabel(current())}"?`)) return;
  const i = settings.speeches.findIndex((s) => s.id === settings.currentId);
  settings.speeches.splice(i, 1);
  if (!settings.speeches.length) settings.speeches.push(newSpeech());
  showSpeech(settings.speeches[Math.max(0, i - 1)].id);
});
$('#lang').addEventListener('change', () => { settings.lang = $('#lang').value; save(); });
$('#size').addEventListener('input', () => { settings.fontSize = +$('#size').value; save(); applyLook(); flashPreview(); });
$('#size').addEventListener('pointerdown', flashPreview);
$('#mirror').addEventListener('change', () => { settings.mirror = $('#mirror').checked; save(); applyLook(); flashPreview(); });

// Show the size preview only while the slider is being used.
let previewTimer = null;
function flashPreview() {
  $('#preview').classList.add('show');
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => $('#preview').classList.remove('show'), 1200);
}
$('#start').addEventListener('click', openPrompter);

$('#exit').addEventListener('click', closePrompter);
$('#mic').addEventListener('click', () => (listening ? stopListening() : startListening()));
$('#back').addEventListener('click', () => setPos(pos - 5));
$('#fwd').addEventListener('click', () => setPos(pos + 5));
$('#smaller').addEventListener('click', () => changeSize(-4));
$('#bigger').addEventListener('click', () => changeSize(4));
$('#flip').addEventListener('click', () => { settings.mirror = !settings.mirror; save(); applyLook(); });

function changeSize(delta) {
  settings.fontSize = Math.max(24, Math.min(160, settings.fontSize + delta));
  save();
  applyLook();
  scrollToCurrent();
}

// Tap a word to jump there (e.g. if you skipped ahead or went back).
$('#text').addEventListener('click', (e) => {
  const t = e.target.closest('.w');
  if (!t) return;
  const i = seq.findIndex((s) => s >= +t.dataset.t);
  setPos(i === -1 ? seq.length : i, { force: true });
  lastTail = '';
  backCandidate = null;
});

['pointermove', 'pointerdown', 'keydown'].forEach((ev) => $('#prompter').addEventListener(ev, poke));
document.addEventListener('pointerdown', () => { if (!$('#prompter').hidden) poke(); });

document.addEventListener('keydown', (e) => {
  if ($('#prompter').hidden) return;
  if (e.key === 'Escape') closePrompter();
  else if (e.key === ' ') { e.preventDefault(); listening ? stopListening() : startListening(); }
  else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') setPos(pos + 1);
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') setPos(pos - 1);
  poke();
});

window.addEventListener('resize', scrollToCurrent);
