// ── PIN AUTH ─────────────────────────────────────────
const PIN_HASH = '75ecfe343389accb161d946713b42f407bd06d3114e20f9a0b727186c0f17034';
const SESSION_KEY = 'kp_auth';
let pinBuffer = '';

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

function renderDots() {
  const el = document.getElementById('pinDots');
  el.innerHTML = '';
  for (let i = 0; i < 8; i++) {
    const d = document.createElement('div');
    d.style.cssText = `
      width:12px;height:12px;border-radius:50%;transition:background 0.15s,transform 0.15s;
      background:${i < pinBuffer.length ? '#a78bfa' : 'rgba(255,255,255,0.2)'};
      transform:${i < pinBuffer.length ? 'scale(1.15)' : 'scale(1)'};
    `;
    el.appendChild(d);
  }
}

function pinKey(k) {
  if (pinBuffer.length >= 8) return;
  pinBuffer += k;
  document.getElementById('pinError').textContent = '';
  renderDots();
  if (pinBuffer.length === 8) setTimeout(pinSubmit, 180);
}

function pinDel() {
  pinBuffer = pinBuffer.slice(0, -1);
  renderDots();
}

async function pinSubmit() {
  if (!pinBuffer.length) return;
  const hash = await sha256(pinBuffer);
  if (hash === PIN_HASH) {
    sessionStorage.setItem(SESSION_KEY, '1');
    const screen = document.getElementById('pinScreen');
    screen.style.transition = 'opacity 0.3s';
    screen.style.opacity = '0';
    setTimeout(() => screen.remove(), 300);
  } else {
    pinBuffer = '';
    renderDots();
    const box = document.querySelector('#pinScreen > div:nth-child(2)');
    document.getElementById('pinError').textContent = 'PIN incorrecto, intenta de nuevo';
    box.classList.remove('pin-shake');
    void box.offsetWidth;
    box.classList.add('pin-shake');
  }
}

// Keyboard support
document.addEventListener('keydown', e => {
  if (!document.getElementById('pinScreen')) return;
  if (e.key >= '0' && e.key <= '9') pinKey(e.key);
  else if (e.key === 'Backspace') pinDel();
  else if (e.key === 'Enter') pinSubmit();
});

// Check session — skip PIN if already authenticated this session
if (sessionStorage.getItem(SESSION_KEY) === '1') {
  document.getElementById('pinScreen').remove();
} else {
  renderDots();
}

// ════════════════════════════════════════════════════
//  CONSTANTS & STATE
// ════════════════════════════════════════════════════
// Piano key dimensions — smaller on phone so all 88 keys fit in landscape
// 52 white keys × 15px = 780px → fits S25 Ultra landscape (~820px)
const MOBILE_LAYOUT_QUERY = '(max-width: 1366px)';
const PHONE_EXCLUSIVE_QUERY = '(max-width: 760px), (max-width: 960px) and (max-height: 520px)';
const _onPhone = window.matchMedia(PHONE_EXCLUSIVE_QUERY).matches;
const WW = _onPhone ? 15 : 20;
const WH = _onPhone ? 96 : 130;
const BW = _onPhone ? 10 : 13;
const BH = _onPhone ? 60 : 82;
const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const BLACK_SET  = new Set([1,3,6,8,10]);
const STEP_SEMI  = {C:0,D:2,E:4,F:5,G:7,A:9,B:11};

let songData       = null;
let currentMeasure = 1;
let activeClef     = 'both';
let isPlaying      = false;
let audioCtx       = null;

// ── Backing track state ───────────────────────────────
let backingBuffer   = null;   // decoded AudioBuffer
let backingBlob     = null;   // original File/Blob (for IndexedDB)
let backingBlobName = '';     // original file name
let backingSource   = null;   // active BufferSourceNode
let backingPreviewSrc = null; // preview source node
let backingGain     = null;   // GainNode
let backingVolume   = parseFloat(localStorage.getItem('pianoBackingVolume') ?? '0.8');
let backingOffsetSec = 0;     // seconds of intro before piano enters
let backingOriginalBpm = 0;   // BPM when backing was loaded (0 = not set)
let measureStartBeats = [];   // cumulative beat-position for each measure (multiply by beatSec)
let backingEnabled  = true;   // backing on/off (when file loaded)
let backingPreviewing = false;
let previewStartedAt = 0;  // AudioContext time when preview started
let previewFromSec   = 0;  // offset at preview start
let backingCtxStart  = 0;  // AudioContext.currentTime when backing last started
let backingPosStart  = 0;  // backing audio position (sec) when it last started
let pianoMuted      = false;  // mute piano notes
let activeNodes    = [];
let playTimers     = [];

// Sequence mode state
let sequenceMode   = true;   // true = step by step, false = show all
let currentStep    = 0;
let measureSteps   = [];     // [{beat, notes:[...]}] for current measure

// ════════════════════════════════════════════════════
//  BUILD KEY MAP  (MIDI 21–108)
// ════════════════════════════════════════════════════
const pianoKeys = [];
const midi2key  = {};
let wCount = 0;

for (let m = 21; m <= 108; m++) {
  const n   = ((m - 12) % 12 + 12) % 12;
  const oct = Math.floor(m / 12) - 1;
  const blk = BLACK_SET.has(n);
  const key = { midi: m, name: NOTE_NAMES[n] + oct, isBlack: blk };
  if (!blk) { key.wi = wCount++; }
  else       { key.lwi = wCount - 1; }
  pianoKeys.push(key);
  midi2key[m] = key;
}

// ════════════════════════════════════════════════════
//  RENDER PIANO
// ════════════════════════════════════════════════════
function buildPiano() {
  const wrap = document.getElementById('piano');
  wrap.innerHTML = '';
  wrap.style.cssText = `position:relative;width:${wCount*WW}px;height:${WH}px;`;

  pianoKeys.forEach(k => {
    const el = document.createElement('div');
    el.id = 'k' + k.midi;

    if (!k.isBlack) {
      el.className = 'key-w';
      el.style.cssText = `width:${WW}px;height:${WH}px;`;
      const n = ((k.midi-12)%12+12)%12;
      if (n === 0) {
        const lbl = document.createElement('span');
        lbl.className = 'c-label';
        lbl.textContent = k.name;
        el.appendChild(lbl);
      }
      wrap.appendChild(el);
    } else {
      el.className = 'key-b';
      el.style.cssText =
        `width:${BW}px;height:${BH}px;` +
        `left:${(k.lwi+1)*WW - BW/2}px;top:0;position:absolute;`;
      wrap.appendChild(el);
    }
  });

  // Octave markers
  const pw = document.querySelector('.piano-wrap');
  document.querySelectorAll('.octave-tick').forEach(e=>e.remove());
  pianoKeys.forEach(k => {
    const n = ((k.midi-12)%12+12)%12;
    if (!k.isBlack && n===0) {
      const t = document.createElement('span');
      t.className = 'octave-tick';
      t.textContent = k.name;
      t.style.left = (k.wi * WW + WW/2) + 'px';
      pw.appendChild(t);
    }
  });
}

buildPiano();

// ════════════════════════════════════════════════════
//  STEP COMPUTATION
// ════════════════════════════════════════════════════
function computeMeasureStartBeats() {
  measureStartBeats = [0];
  if (!songData) return;
  for (let i = 0; i < songData.measures.length; i++) {
    const steps = computeSteps(i);
    const notes = steps.flatMap(s => s.notes);
    let maxEnd = 4; // 4 beats default (4/4)
    notes.forEach(n => {
      const end = (n.beat || 0) + Math.max(0.05, n.duration || 0.5);
      if (end > maxEnd) maxEnd = end;
    });
    measureStartBeats.push(measureStartBeats[i] + maxEnd);
  }
}

function computeSteps(measureIdx) {
  if (!songData || measureIdx < 0 || measureIdx >= songData.measures.length) return [];
  const m   = songData.measures[measureIdx];
  const map = new Map();

  const add = (n, staff) => {
    const key = Math.round(n.beat * 100000); // stable float key
    if (!map.has(key)) map.set(key, { beat: n.beat, notes: [] });
    map.get(key).notes.push({ ...n, staff });
  };

  if (activeClef !== 'bass')   m.treble.forEach(n => add(n, 'treble'));
  if (activeClef !== 'treble') m.bass.forEach(n   => add(n, 'bass'));

  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v);
}

// ════════════════════════════════════════════════════
//  HIGHLIGHT  (diff-based — detects retriggers)
// ════════════════════════════════════════════════════
let activeHL = new Map(); // midi → hlClass currently on screen

function clearHL() {
  activeHL.forEach((_, midi) => {
    const el = document.getElementById('k' + midi);
    if (!el) return;
    el.classList.remove('hl-treble','hl-bass','hl-both','hl-correct','retrigger');
    el.querySelectorAll('.note-label').forEach(l => l.remove());
  });
  activeHL.clear();
}

// Main highlight function: computes desired state, diffs vs current, animates retriggers
function highlightNotes(noteList) {
  const T = new Set(), B = new Set();
  noteList.forEach(n => {
    if (n.staff === 'treble') T.add(n.midi);
    else                      B.add(n.midi);
  });

  const desired = new Map();
  T.forEach(m => desired.set(m, B.has(m) ? 'hl-both' : 'hl-treble'));
  B.forEach(m => { if (!T.has(m)) desired.set(m, 'hl-bass'); });

  // Remove keys no longer needed
  activeHL.forEach((cls, midi) => {
    if (!desired.has(midi)) {
      const el = document.getElementById('k' + midi);
      if (el) {
        el.classList.remove('hl-treble','hl-bass','hl-both','hl-correct','retrigger');
        el.querySelectorAll('.note-label').forEach(l => l.remove());
      }
    }
  });

  // Add / retrigger keys
  desired.forEach((cls, midi) => {
    const el = document.getElementById('k' + midi);
    if (!el) return;
    const isBlack = midi2key[midi]?.isBlack;

    if (activeHL.has(midi)) {
      // Key was already lit → retrigger animation
      const prevCls = activeHL.get(midi);
      if (prevCls !== cls) {
        el.classList.remove('hl-treble','hl-bass','hl-both');
        el.classList.add(cls);
      }
      el.classList.remove('hl-correct'); // clear green before retrigger
      // Restart retrigger animation
      el.classList.remove('retrigger');
      void el.offsetWidth; // force reflow so animation restarts
      el.classList.add('retrigger');
      el.addEventListener('animationend', () => el.classList.remove('retrigger'), { once: true });
    } else {
      // New key — add highlight + label
      el.classList.add(cls);
      const lbl = document.createElement('span');
      lbl.className = 'note-label';
      lbl.textContent = midi2key[midi]?.name || '';
      el.appendChild(lbl);
    }
  });

  activeHL = desired;
}

// Main entry point after measure or step changes
function highlight(measureIdx) {
  if (!songData || measureIdx < 0 || measureIdx >= songData.measures.length) {
    clearHL(); return;
  }

  // Recompute steps whenever measure or clef changes
  measureSteps = computeSteps(measureIdx);
  currentStep  = 0;

  renderSequencePanel(); // always render full sequence (both modes)
  updateNotationMeasure(measureIdx + 1); // update SVG measure highlight

  if (sequenceMode) {
    showStep(0);
  } else {
    // Overview: show all notes
    const all = measureSteps.flatMap(s => s.notes);
    highlightNotes(all);
    updateNotePanel(songData.measures[measureIdx]);
    updateNotationNotes(null); // clear note highlights in overview
  }

  updateStepNav();
}

// Show a specific step index
function showStep(idx) {
  if (!measureSteps.length) { clearHL(); return; }
  idx = Math.max(0, Math.min(idx, measureSteps.length - 1));
  currentStep = idx;
  const step = measureSteps[idx];
  highlightNotes(step.notes);
  updateNotePanelFromNotes(step.notes);
  updateStepNav();
  updateSequenceActive(idx);
  updateNotationNotes(step); // highlight notes in SVG
  scrollToActive();
}

// ════════════════════════════════════════════════════
//  SEQUENCE PANEL
// ════════════════════════════════════════════════════
function renderSequencePanel() {
  const container = document.getElementById('sequenceSteps');
  if (!container) return;
  container.innerHTML = '';

  if (!measureSteps.length) {
    container.innerHTML = '<span style="color:var(--text-dim);font-size:12px;align-self:center">—</span>';
    return;
  }

  measureSteps.forEach((step, i) => {
    const card = document.createElement('div');
    card.className = 'step-card' + (i === currentStep ? ' active' : '');
    card.id = 'seq-' + i;
    card.onclick = () => showStep(i);

    // Step number header
    const num = document.createElement('div');
    num.className = 'step-card-num';
    num.textContent = i + 1;
    card.appendChild(num);

    // Notes body
    const body = document.createElement('div');
    body.className = 'step-card-notes';

    const treble = [...new Map(
      step.notes.filter(n => n.staff === 'treble').map(n => [n.midi, n])
    ).values()].sort((a, b) => b.midi - a.midi); // high → low (visual top)

    const bass = [...new Map(
      step.notes.filter(n => n.staff === 'bass').map(n => [n.midi, n])
    ).values()].sort((a, b) => b.midi - a.midi);

    treble.forEach(n => {
      const s = document.createElement('span');
      s.className = 'seq-note treble';
      s.textContent = midi2key[n.midi]?.name || n.midi;
      body.appendChild(s);
    });

    if (treble.length && bass.length) {
      const div = document.createElement('div');
      div.className = 'step-divider-line';
      body.appendChild(div);
    }

    bass.forEach(n => {
      const s = document.createElement('span');
      s.className = 'seq-note bass';
      s.textContent = midi2key[n.midi]?.name || n.midi;
      body.appendChild(s);
    });

    card.appendChild(body);
    container.appendChild(card);
  });

  // Scroll active card into view
  scrollSequenceToActive();
}

function updateSequenceActive(idx) {
  document.querySelectorAll('.step-card').forEach((c, i) => {
    c.classList.toggle('active', i === idx);
  });
  scrollSequenceToActive();
}

function scrollSequenceToActive() {
  const active = document.getElementById('seq-' + currentStep);
  if (active) active.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
}

// ════════════════════════════════════════════════════
//  NOTE PANEL
// ════════════════════════════════════════════════════
function updateNotePanel(m) {
  updateNotePanelFromNotes([
    ...m.treble.map(n => ({...n, staff:'treble'})),
    ...m.bass.map(n   => ({...n, staff:'bass'}))
  ]);
}

function updateNotePanelFromNotes(notes) {
  const T = new Map(), B = new Map();
  notes.forEach(n => {
    if (n.staff === 'treble') T.set(n.midi, n);
    else                      B.set(n.midi, n);
  });

  const fmt = (map, cls) =>
    map.size
      ? [...map.values()].sort((a,b)=>a.midi-b.midi)
          .map(n => `<span class="note-chip ${cls}">${midi2key[n.midi]?.name||n.midi}</span>`).join(' ')
      : `<span class="note-chip rest">silencio</span>`;

  document.getElementById('trebleNotes').innerHTML = fmt(T, 'treble');
  document.getElementById('bassNotes').innerHTML   = fmt(B, 'bass');
}

// ════════════════════════════════════════════════════
//  STEP NAV UI
// ════════════════════════════════════════════════════
function updateStepNav() {
  const total = measureSteps.length;
  const nav   = document.getElementById('stepNav');

  // Always show when a song is loaded; dim+disable in overview mode
  nav.style.display       = total > 0 ? 'flex' : 'none';
  nav.style.opacity       = (sequenceMode && total > 0) ? '1'    : '0.28';
  nav.style.pointerEvents = (sequenceMode && total > 0) ? ''     : 'none';
  nav.style.transition    = 'opacity 0.2s';

  if (!total) return;
  document.getElementById('stepCount').textContent   = currentStep + 1;
  document.getElementById('stepTotal').textContent   = '/ ' + total;
  document.getElementById('btnStepPrev').disabled    = currentStep <= 0;
  document.getElementById('btnStepNext').disabled    = currentStep >= total - 1;
}

function changeStep(d) {
  if (!measureSteps.length) return;
  const nxt = currentStep + d;
  if (nxt >= 0 && nxt < measureSteps.length) showStep(nxt);
}

// ════════════════════════════════════════════════════
//  MODE TOGGLE
// ════════════════════════════════════════════════════
function toggleMode() {
  sequenceMode = !sequenceMode;
  const btn = document.getElementById('modeBtn');
  if (sequenceMode) {
    btn.innerHTML = '📊<span class="btn-label"> Todas las notas</span>';
    btn.classList.remove('overview');
  } else {
    btn.innerHTML = '👣<span class="btn-label"> Paso a paso</span>';
    btn.classList.add('overview');
  }
  updateStepNav();
  highlight(currentMeasure - 1);
  saveState();
}

// ════════════════════════════════════════════════════
//  CONTROLS
// ════════════════════════════════════════════════════
function setClef(c) {
  activeClef = c;
  ['both','treble','bass'].forEach(x => {
    const cap = x[0].toUpperCase() + x.slice(1);
    document.getElementById('btn' + cap)?.classList.toggle('active', x === c);
    document.getElementById('mBtn' + cap)?.classList.toggle('active', x === c); // mobile popup
  });
  highlight(currentMeasure - 1);
  saveState();
}

function changeMeasure(d) {
  if (!songData) return;
  const nxt = currentMeasure + d;
  if (nxt >= 1 && nxt <= songData.measures.length) {
    currentMeasure = nxt;
    document.getElementById('measureInput').value = nxt;
    updateNav();
    highlight(currentMeasure - 1);
    saveState();
  }
}

function goToMeasure(v) {
  if (!songData) return;
  const n = Math.max(1, Math.min(songData.measures.length, v|0));
  currentMeasure = n;
  document.getElementById('measureInput').value = n;
  updateNav();
  highlight(currentMeasure - 1);
  saveState();
}

function updateNav() {
  const total = songData ? songData.measures.length : 0;
  document.getElementById('btnPrev').disabled = currentMeasure <= 1;
  document.getElementById('btnNext').disabled = currentMeasure >= total;
  document.getElementById('measureTotal').textContent = '/ ' + (total || '—');
  // keep range end >= start
  const endEl = document.getElementById('measureEnd');
  if (endEl.value && parseInt(endEl.value) < currentMeasure) endEl.value = currentMeasure;
  if (endEl.value && parseInt(endEl.value) > total) endEl.value = total;
  syncMeasureSliderUI();
}

let measureSliderTarget = 'start';

function openMeasureSlider(event, target = 'start') {
  event?.preventDefault();
  event?.stopPropagation();
  if (!songData) {
    showToast('Carga una pieza primero', true);
    return;
  }
  measureSliderTarget = target === 'end' ? 'end' : 'start';
  closeMobExtras();
  syncMeasureSliderUI();
  document.getElementById('measureSliderOverlay')?.classList.add('open');
  document.getElementById('measureSliderPanel')?.classList.add('open');
  requestAnimationFrame(() => {
    document.getElementById('measureSliderRange')?.focus({ preventScroll: true });
  });
}

function closeMeasureSlider() {
  document.getElementById('measureSliderOverlay')?.classList.remove('open');
  document.getElementById('measureSliderPanel')?.classList.remove('open');
}

function syncMeasureSliderUI() {
  const range = document.getElementById('measureSliderRange');
  const current = document.getElementById('measureSliderCurrent');
  const totalLabel = document.getElementById('measureSliderTotal');
  const title = document.getElementById('measureSliderTitle');
  const clearBtn = document.getElementById('measureSliderClear');
  if (!range || !current || !totalLabel) return;
  const total = songData ? songData.measures.length : 1;
  const isEnd = measureSliderTarget === 'end';
  const min = isEnd ? Math.max(1, currentMeasure || 1) : 1;
  const rawEnd = parseInt(document.getElementById('measureEnd')?.value || '', 10);
  const value = isEnd
    ? Math.max(min, Math.min(total, Number.isFinite(rawEnd) ? rawEnd : min))
    : Math.max(1, Math.min(total, currentMeasure || 1));
  range.min = String(min);
  range.max = String(total);
  range.value = String(value);
  current.textContent = String(value);
  totalLabel.textContent = `/ ${total || '—'}`;
  if (title) title.textContent = isEnd ? 'Seleccionar compás final' : 'Seleccionar compás';
  if (clearBtn) clearBtn.style.display = isEnd ? 'block' : 'none';
}

function setMeasureFromSlider(value) {
  if (!songData) return;
  const total = songData.measures.length;
  if (measureSliderTarget === 'end') {
    const min = Math.max(1, currentMeasure || 1);
    const next = Math.max(min, Math.min(total, Number(value) || min));
    const endEl = document.getElementById('measureEnd');
    if (endEl) endEl.value = String(next);
    onRangeEndChange();
    syncMeasureSliderUI();
    saveState();
    return;
  }
  const next = Math.max(1, Math.min(total, Number(value) || currentMeasure || 1));
  if (next !== currentMeasure) goToMeasure(next);
  else syncMeasureSliderUI();
}

function nudgeMeasureSlider(delta) {
  const range = document.getElementById('measureSliderRange');
  const base = Number(range?.value) || currentMeasure || 1;
  setMeasureFromSlider(base + delta);
}

function clearMeasureEndFromSlider() {
  const endEl = document.getElementById('measureEnd');
  if (endEl) endEl.value = '';
  syncMeasureSliderUI();
  saveState();
  closeMeasureSlider();
}

function scrollToActive() {
  const first = document.querySelector('.hl-treble, .hl-bass, .hl-both');
  if (first) first.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
}


// ════════════════════════════════════════════════════
//  BACKING TRACK — IndexedDB persistence
// ════════════════════════════════════════════════════
const BACKING_DB   = 'pv_backings';
const BACKING_STORE = 'tracks';
const BACKING_DB_VER = 1;

function openBackingDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(BACKING_DB, BACKING_DB_VER);
    req.onupgradeneeded = e => e.target.result.createObjectStore(BACKING_STORE);
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

async function persistBackingToDB() {
  if (!songData) return;
  try {
    const db  = await openBackingDB();
    const key = songData.title;
    if (!backingBuffer) {
      // No backing — delete any stored entry
      const tx = db.transaction(BACKING_STORE, 'readwrite');
      tx.objectStore(BACKING_STORE).delete(key);
      return;
    }
    // Store blob + offset (we need the original blob, saved in backingBlob)
    if (!backingBlob) return;
    const tx  = db.transaction(BACKING_STORE, 'readwrite');
    tx.objectStore(BACKING_STORE).put({
      blob:      backingBlob,
      name:      backingBlobName,
      offsetSec: backingOffsetSec,
      enabled:   backingEnabled,
      bpm:       Math.max(20, Math.min(400, parseInt(document.getElementById('tempoInput').value) || 120))
    }, key);
  } catch(e) { console.warn('Backing DB save error:', e); }
}

async function loadBackingFromDB(songTitle) {
  try {
    const db  = await openBackingDB();
    const tx  = db.transaction(BACKING_STORE, 'readonly');
    return new Promise((res, rej) => {
      const req = tx.objectStore(BACKING_STORE).get(songTitle);
      req.onsuccess = e => res(e.target.result || null);
      req.onerror   = e => rej(e.target.error);
    });
  } catch(e) { return null; }
}

async function restoreBackingForSong(songTitle) {
  const rec = await loadBackingFromDB(songTitle);
  if (!rec || !rec.blob) {
    clearBackingTrack(false); // clear UI, no DB write
    return;
  }
  // Decode blob
  const ctx = getCtx();
  if (ctx.state === 'suspended') await ctx.resume();
  try {
    const ab  = await rec.blob.arrayBuffer();
    backingBuffer   = await ctx.decodeAudioData(ab);
    backingBlob     = rec.blob;
    backingBlobName = rec.name || 'backing';
    backingOffsetSec   = rec.offsetSec || 0;
    backingEnabled     = rec.enabled !== false;
    backingOriginalBpm = rec.bpm || 0;
    ['backingFileName','mobBackingFileName'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.textContent = backingBlobName; el.dataset.name = backingBlobName; }
    });
    syncBackingUI();
  } catch(e) { console.warn('Backing restore decode error:', e); }
}

// ════════════════════════════════════════════════════
//  BACKING TRACK
// ════════════════════════════════════════════════════
async function loadBackingTrack(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  event.target.value = '';

  // Block load if BPM was changed from song's original
  if (songData && songData.origBpm) {
    const cur = Math.max(20, Math.min(400, parseInt(document.getElementById('tempoInput').value) || 120));
    if (cur !== songData.origBpm) {
      showToast('⚠️ Restablece el tempo a ' + songData.origBpm + ' BPM antes de cargar el backing track', true);
      return;
    }
  }

  const ctx = getCtx();
  if (ctx.state === 'suspended') await ctx.resume();
  try {
    const arrayBuf = await file.arrayBuffer();
    backingBuffer      = await ctx.decodeAudioData(arrayBuf);
    backingBlob        = file;
    backingBlobName    = file.name;
    backingEnabled     = true;
    backingOriginalBpm = Math.max(20, Math.min(400, parseInt(document.getElementById('tempoInput').value) || 120));
    ['backingFileName','mobBackingFileName'].forEach(id => {
      const el = document.getElementById(id); if (el) { el.textContent = file.name; el.dataset.name = file.name; }
    });
    syncBackingUI();
    persistBackingToDB();
    showToast('🎵 Backing cargado — ajusta el offset si la canción tiene intro');
  } catch(e) {
    showToast('No se pudo decodificar el audio: ' + e.message, true);
  }
}

function clearBackingTrack() {
  stopBackingSource();
  stopBackingPreview();
  stopBackingPreview();
  backingBuffer    = null;
  backingEnabled   = true;
  backingOffsetSec = 0;
  syncBackingUI();
}

function stopBackingSource() {
  if (backingSource) {
    try { backingSource.stop(); } catch(_) {}
    backingSource.disconnect();
    backingSource = null;
  }
}

function stopBackingPreview() {
  if (backingPreviewSrc) {
    try { backingPreviewSrc.stop(); } catch(_) {}
    backingPreviewSrc.disconnect();
    backingPreviewSrc = null;
  }
  backingPreviewing = false;
  const btn = document.getElementById('bpPreviewBtn');
  if (btn) btn.textContent = '▶ Escuchar';
}

function toggleBackingPreview() {
  if (backingPreviewing) { stopBackingPreview(); return; }
  if (!backingBuffer) return;
  const ctx = getCtx();
  if (!backingGain) {
    backingGain = ctx.createGain();
    backingGain.gain.value = backingVolume;
    backingGain.connect(ctx.destination);
  }
  backingPreviewSrc = ctx.createBufferSource();
  backingPreviewSrc.buffer = backingBuffer;
  backingPreviewSrc.connect(backingGain);
  // Always preview from second 0 — user marks entry point during playback
  const from = 0;
  backingPreviewSrc.start(ctx.currentTime, from);
  previewStartedAt = ctx.currentTime;
  previewFromSec   = 0;
  backingPreviewSrc.onended = () => { backingPreviewing = false; backingPreviewSrc = null; const b = document.getElementById('bpPreviewBtn'); if(b) b.textContent = '▶ Escuchar'; };
  backingPreviewing = true;
  const btn = document.getElementById('bpPreviewBtn');
  if (btn) btn.textContent = '■ Detener';
}

function startBackingAt(offsetSec, atAudioTime) {
  if (!backingBuffer || !backingEnabled) return;
  stopBackingSource();
  stopBackingPreview();
  const ctx = getCtx();
  if (!backingGain) {
    backingGain = ctx.createGain();
    backingGain.gain.value = backingVolume;
    backingGain.connect(ctx.destination);
  }
  backingSource = ctx.createBufferSource();
  backingSource.buffer = backingBuffer;
  backingSource.connect(backingGain);
  const from = Math.max(0, Math.min(offsetSec, backingBuffer.duration - 0.01));
  backingSource.start(atAudioTime, from);
  backingCtxStart = atAudioTime;   // when (in ctx time) backing starts
  backingPosStart = from;          // where (in audio) backing starts
  const _src = backingSource;
  backingSource.onended = () => { if (backingSource === _src) backingSource = null; };
}

function setBackingVolume(val) {
  backingVolume = parseFloat(val);
  if (backingGain) backingGain.gain.value = backingVolume;
  try { localStorage.setItem('pianoBackingVolume', backingVolume); } catch(e) {}
  syncBackingUI();
}

function setBackingOffset(val) {
  backingOffsetSec = Math.max(0, parseFloat(val) || 0);
  syncBackingUI();
  persistBackingToDB();
}

// Returns true if BPM is wrong and backing should be blocked
function backingBpmMismatch() {
  if (!backingBuffer || backingOriginalBpm <= 0) return false;
  const cur = Math.max(20, Math.min(400, parseInt(document.getElementById('tempoInput').value) || 120));
  return cur !== backingOriginalBpm;
}

function forceDisableBacking() {
  if (!backingBuffer || !backingEnabled) return;
  backingEnabled = false;
  syncBackingUI();
  persistBackingToDB();
  showToast('⚠️ Backing desactivado — tempo cambiado. Original: ' + backingOriginalBpm + ' BPM', true);
}

function toggleBackingEnabled() {
  if (!backingEnabled) {
    // Trying to turn ON — check BPM first
    if (backingBpmMismatch()) {
      showToast('⚠️ Para activar el backing track restablece el tempo a ' + backingOriginalBpm + ' BPM', true);
      return;
    }
  }
  backingEnabled = !backingEnabled;
  syncBackingUI();
  persistBackingToDB();
}

function checkBackingBpm() {
  if (!backingBuffer) return;
  const cur = Math.max(20, Math.min(400, parseInt(document.getElementById('tempoInput').value) || 120));
  if (backingOriginalBpm <= 0) { backingOriginalBpm = cur; return; }
  if (cur !== backingOriginalBpm && backingEnabled) forceDisableBacking();
}

function togglePianoMute() {
  pianoMuted = !pianoMuted;
  syncBackingUI();
}

function toggleBackingPanel() {
  const panel = document.getElementById('backingPanel');
  const btn   = document.getElementById('backingIconBtn');
  if (!panel) return;
  const isOpen = panel.classList.toggle('open');
  if (btn) btn.classList.toggle('active', isOpen);
}

function markBackingEntry() {
  if (!backingPreviewing || !backingBuffer) {
    showToast('Primero inicia el preview con ▶ Escuchar', true);
    return;
  }
  const ctx = getCtx();
  const elapsed = ctx.currentTime - previewStartedAt;
  const captured = Math.max(0, previewFromSec + elapsed);
  backingOffsetSec = Math.round(captured * 100) / 100; // 2 decimals
  syncBackingUI();
  syncBackingUI();
  persistBackingToDB();
  showToast('🎯 Entrada marcada en ' + backingOffsetSec.toFixed(2) + 's');
}

function toggleVistaPanel() {
  const panel = document.getElementById('vistaPanel');
  const btn   = document.getElementById('vistaMenuBtn');
  if (!panel) return;
  const isOpen = panel.classList.toggle('open');
  if (btn) btn.classList.toggle('active', isOpen);
  if (isOpen) syncVistaPanel();
}

function syncVistaPanel() {
  // Sync clef buttons
  ['both','treble','bass'].forEach(c => {
    const cap = c[0].toUpperCase() + c.slice(1);
    document.getElementById('vBtn' + cap)?.classList.toggle('active', c === activeClef);
  });
  // Show level wrap if song has levels
  const hasLevels = document.getElementById('levelSelector')?.style.display !== 'none';
  const wrap = document.getElementById('vistaPanelLevelWrap');
  if (wrap) wrap.style.display = hasLevels ? '' : 'none';
  // Sync level buttons
  ['Original','Intermediate','Basic','Accompaniment'].forEach(l => {
    const mainBtn = document.getElementById('lvl' + l);
    const vBtn    = document.getElementById('vLvl' + l);
    if (mainBtn && vBtn) {
      vBtn.classList.toggle('active', mainBtn.classList.contains('active'));
      vBtn.disabled = mainBtn.disabled;
    }
  });
}

function updateVistaClef() { syncVistaPanel(); }
function updateVistaLevel() { syncVistaPanel(); }

function syncBackingUI() {
  const hasFile = !!backingBuffer;
  // Desktop panel
  const rows = ['bpActiveRow','bpVolRow','bpOffsetRow','bpPreviewRow','bpDivider1'];
  rows.forEach(id => { const el = document.getElementById(id); if(el) el.style.display = hasFile ? '' : 'none'; });

  const nameEl  = document.getElementById('backingFileName');
  if (nameEl) nameEl.textContent = hasFile ? (nameEl.dataset.name || '—') : 'Sin archivo';

  const enBtn = document.getElementById('bpEnableBtn');
  if (enBtn) {
    const locked = backingBpmMismatch();
    enBtn.textContent = locked ? '🔒 Backing: bloqueado' : (backingEnabled ? '🎵 Backing: ON' : '🔇 Backing: OFF');
    enBtn.classList.toggle('active', backingEnabled && !locked);
    enBtn.style.opacity = locked ? '0.6' : '';
  }
  const pmBtn = document.getElementById('pianoMuteBtn');
  if (pmBtn) {
    pmBtn.innerHTML = (pianoMuted ? '🔇' : '🔊') + ' <span class="btn-label">Piano</span>';
    pmBtn.classList.toggle('active', !pianoMuted);
  }
  const volEl = document.getElementById('backingVol');
  if (volEl) volEl.value = backingVolume;
  const volLbl = document.getElementById('backingVolLabel');
  if (volLbl) volLbl.textContent = Math.round(backingVolume * 100) + '%';
  const offEl = document.getElementById('backingOffset');
  if (offEl) offEl.value = backingOffsetSec.toFixed(2);

  // Mobile panel
  const mobRows = ['mobBpActiveRow','mobBpVolRow','mobBpOffsetRow'];
  mobRows.forEach(id => { const el = document.getElementById(id); if(el) el.style.display = hasFile ? '' : 'none'; });
  const mobName = document.getElementById('mobBackingFileName');
  if (mobName) mobName.textContent = hasFile ? (mobName.dataset.name || '—') : 'Sin archivo';
  const mobEnBtn = document.getElementById('mobBpEnableBtn');
  if (mobEnBtn) {
    const locked = backingBpmMismatch();
    mobEnBtn.textContent = locked ? '🔒' : (backingEnabled ? '🎵 ON' : '🔇 OFF');
    mobEnBtn.classList.toggle('active', backingEnabled && !locked);
    mobEnBtn.style.opacity = locked ? '0.6' : '';
  }

  const mobVol = document.getElementById('mobBackingVol');
  if (mobVol) mobVol.value = backingVolume;
  const mobVolLbl = document.getElementById('mobBackingVolLabel');
  if (mobVolLbl) mobVolLbl.textContent = Math.round(backingVolume * 100) + '%';
  const mobOff = document.getElementById('mobBackingOffset');
  if (mobOff) mobOff.value = backingOffsetSec.toFixed(2);
}



// ════════════════════════════════════════════════════
//  AUDIO  (Web Audio API)
// ════════════════════════════════════════════════════
function getCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (!backingGain) {
    backingGain = audioCtx.createGain();
    backingGain.gain.value = backingVolume;
    backingGain.connect(audioCtx.destination);
  }
  return audioCtx;
}

function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

function playNote(midi, startOffset, durSec) {
  if (pianoMuted) return;
  const ctx = getCtx();

  // ── Sample path (MIDI.js soundfonts decodificados) ─
  if (noteBuffers.size > 0) {
    const when = ctx.currentTime + startOffset;

    // Busca buffer exacto, o el más cercano con pitch-shift
    let buf    = noteBuffers.get(midi);
    let detune = 0;
    if (!buf) {
      let nearest = -1, minDist = 999;
      for (const [m] of noteBuffers) {
        const d = Math.abs(m - midi);
        if (d < minDist) { minDist = d; nearest = m; }
      }
      if (nearest >= 0) { buf = noteBuffers.get(nearest); detune = (midi - nearest) * 100; }
    }

    if (buf) {
      const source = ctx.createBufferSource();
      source.buffer = buf;
      if (detune) source.detune.value = detune;

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.85, when);
      gain.gain.setValueAtTime(0.85, when + Math.max(durSec, 0.05));
      gain.gain.exponentialRampToValueAtTime(0.001, when + Math.max(durSec, 0.05) + 0.6);

      source.connect(gain);
      gain.connect(ctx.destination);
      source.start(when);
      source.stop(when + Math.max(durSec, 0.05) + 0.7);
      activeNodes.push(source);
      return;
    }
  }

  // ── Oscilador fallback (mientras el instrumento carga) ─
  const freq = midiToFreq(midi);
  const now  = ctx.currentTime + startOffset;
  const master = ctx.createGain();
  master.gain.setValueAtTime(0, now);
  master.gain.linearRampToValueAtTime(0.22, now + 0.015);
  master.gain.exponentialRampToValueAtTime(0.07, now + 0.18);
  master.gain.setValueAtTime(0.07, now + durSec);
  master.gain.exponentialRampToValueAtTime(0.0001, now + durSec + 0.7);
  master.connect(ctx.destination);
  [
    { type: 'triangle', mult: 1, gain: 1.0   },
    { type: 'sine',     mult: 2, gain: 0.027 },
    { type: 'sine',     mult: 3, gain: 0.012 },
  ].forEach(h => {
    const osc = ctx.createOscillator();
    const g   = ctx.createGain();
    osc.type = h.type; osc.frequency.value = freq * h.mult;
    g.gain.value = h.gain * 0.22;
    osc.connect(g); g.connect(master);
    osc.start(now); osc.stop(now + durSec + 0.75);
    activeNodes.push(osc);
  });
}

// ════════════════════════════════════════════════════
//  LOOP & RANGE
// ════════════════════════════════════════════════════
let loopEnabled      = false;
let playStartMeasure = 1;
let playEndMeasure   = 1;
let playCurrentMeasure = 1;
let savedStartMeasure = 1; // start measure saved at play begin, restored by stop

function toggleLoop() {
  loopEnabled = !loopEnabled;
  document.getElementById('loopBtn').classList.toggle('active', loopEnabled);
  saveState();
}

function getRangeEnd() {
  const total = songData ? songData.measures.length : 1;
  const val   = parseInt(document.getElementById('measureEnd').value);
  if (!val || isNaN(val)) return currentMeasure;
  return Math.max(currentMeasure, Math.min(val, total));
}

function onRangeEndChange() {
  // clamp value
  const total = songData ? songData.measures.length : 1;
  const el  = document.getElementById('measureEnd');
  const val = parseInt(el.value);
  if (val && !isNaN(val)) el.value = Math.max(currentMeasure, Math.min(val, total));
}

// ════════════════════════════════════════════════════
//  PLAYBACK  (multi-measure + loop)
// ════════════════════════════════════════════════════
// ── Backing restart helper — used by initial play AND loop ──────────────────
// Stops any current backing and starts it from the correct position for
// the given 1-based measure number. Returns true if it handled a delayed
// start (intro case), false otherwise.
function startBackingForMeasure(measureNum) {
  if (!backingBuffer || !backingEnabled) return false;
  const ctx     = getCtx();
  const bpm     = Math.max(20, Math.min(400, parseInt(document.getElementById('tempoInput').value) || 120));
  // BPM lock: if tempo changed from when backing was loaded, disable and warn
  if (backingOriginalBpm > 0 && bpm !== backingOriginalBpm) {
    backingEnabled = false;
    syncBackingUI();
    persistBackingToDB();
    showToast('⚠️ Backing desactivado — restablece el tempo a ' + backingOriginalBpm + ' BPM para usarlo', true);
    return false;
  }
  const beatSec = 60 / bpm;
  const m0      = measureNum - 1;   // 0-based
  const beats   = measureStartBeats[m0] || 0;
  const audioPos = backingOffsetSec + beats * beatSec;
  if (m0 === 0 && backingOffsetSec > 0) {
    // Measure 1 with intro: play backing from 0, piano enters after offset
    startBackingAt(0, ctx.currentTime + 0.05);
    return true;   // caller must delay scheduleMeasure by backingOffsetSec
  } else {
    startBackingAt(audioPos, ctx.currentTime + 0.05);
    return false;
  }
}

async function togglePlay() {
  if (!songData) return;
  // If currently playing → pause (not stop)
  if (isPlaying || followPlaying) { pausePlay(); return; }

  // Resume paused follow session
  if (followPaused) { resumeFollowPlay(); return; }

  // Resume paused audio session
  if (audioPaused) {
    audioPaused = false;
    isPlaying   = true;
    document.getElementById('playBtn').innerHTML = '⏸';
    document.getElementById('playBtn').classList.add('playing');
    // Resume backing from where it was paused
    if (backingBuffer && backingEnabled && backingPosStart < backingBuffer.duration) {
      startBackingAt(backingPosStart, getCtx().currentTime + 0.05);
    }
    const _fromBeat = pausedBeatInMeasure;
    pausedBeatInMeasure = 0;
    scheduleMeasure(_fromBeat);
    return;
  }

  // ── Follow mode: wait for MIDI input ──────────────────────────
  if (followMode) {
    if (!midiInput) { showToast('Conecta un dispositivo MIDI para usar el seguimiento', true); return; }
    startFollowPlay();
    return;
  }

  // ── Normal audio playback ──────────────────────────────────────
  const ctx = getCtx();
  if (ctx.state === 'suspended') await ctx.resume();

  playStartMeasure   = currentMeasure;
  playEndMeasure     = getRangeEnd();
  playCurrentMeasure = currentMeasure;
  savedStartMeasure  = currentMeasure;

  isPlaying = true;
  audioPaused = false;
  document.getElementById('playBtn').innerHTML = '⏸';
  document.getElementById('playBtn').classList.add('playing');

  playTimers.forEach(t => clearTimeout(t));
  playTimers = [];

  // Backing track sync:
  // backingOffsetSec = seconds in audio where measure 1 starts (after intro).
  // For measure N: audio position = backingOffsetSec + beatsToMeasureN * beatSec.
  // If starting from measure 1 with an intro, play from 0 and delay piano.
  const introDelay = startBackingForMeasure(playStartMeasure);
  if (introDelay) {
    // Measure 1 with intro: delay piano until after the intro
    playTimers.push(setTimeout(() => {
      if (isPlaying) scheduleMeasure();
    }, backingOffsetSec * 1000));
    return;
  }

  scheduleMeasure();
}

function scheduleMeasure(fromBeat = 0) {
  if (!isPlaying) return;

  const bpm     = Math.max(20, Math.min(400, parseInt(document.getElementById('tempoInput').value) || 120));
  const beatSec = 60 / bpm;
  const fromSec = fromBeat * beatSec;

  // Record wall-clock time of this measure's virtual start
  // (if resuming mid-measure, backdate so future pauses calc correctly)
  measureStartWallTime = Date.now() - fromSec * 1000;

  // Update UI to current play measure
  currentMeasure = playCurrentMeasure;
  document.getElementById('measureInput').value = currentMeasure;
  updateNav();
  updateNotationMeasure(currentMeasure); // advance highlight + scroll in notation panel

  // Recompute steps & refresh display
  measureSteps = computeSteps(currentMeasure - 1);
  renderSequencePanel();

  if (sequenceMode && measureSteps.length) {
    // Find the last step at-or-before fromBeat to show immediately
    let startIdx = 0;
    for (let i = 0; i < measureSteps.length; i++) {
      if ((measureSteps[i].beat || 0) <= fromBeat + 0.001) startIdx = i;
      else break;
    }
    currentStep = startIdx;
    highlightNotes(measureSteps[startIdx].notes);
    updateNotePanelFromNotes(measureSteps[startIdx].notes);
    updateStepNav();
    updateSequenceActive(startIdx);
    updateNotationNotes(measureSteps[startIdx]);
  } else if (!sequenceMode) {
    const all = measureSteps.flatMap(s => s.notes);
    highlightNotes(all);
    updateNotePanel(songData.measures[currentMeasure - 1]);
  }

  // Gather notes & schedule audio — skip notes already past, offset timing
  const allSteps = computeSteps(currentMeasure - 1);
  const allNotes = allSteps.flatMap(s => s.notes);
  let maxEnd = beatSec * 4; // fallback for silent measures

  allNotes.forEach(n => {
    const noteBeat = n.beat || 0;
    const noteEndSec = noteBeat * beatSec + Math.max(0.08, (n.duration || 0.5) * beatSec);
    maxEnd = Math.max(maxEnd, noteEndSec); // always track full measure end
    if (noteBeat < fromBeat - 0.01) return; // already played — skip
    const start = (noteBeat - fromBeat) * beatSec; // delay relative to now
    const dur   = Math.max(0.08, (n.duration || 0.5) * beatSec);
    playNote(n.midi, start, dur);
  });

  // Visual step advances — skip steps already shown, offset remaining
  if (sequenceMode) {
    allSteps.forEach((step, i) => {
      const stepBeat = step.beat || 0;
      if (stepBeat <= fromBeat + 0.001) return; // already shown or at/before resume point
      const delay = (stepBeat - fromBeat) * beatSec * 1000;
      const t = setTimeout(() => {
        if (!isPlaying || currentMeasure !== playCurrentMeasure) return;
        currentStep = i;
        highlightNotes(step.notes);
        updateNotePanelFromNotes(step.notes);
        updateStepNav();
        updateSequenceActive(i);
        updateNotationNotes(step);
        scrollToActive();
      }, Math.round(delay));
      playTimers.push(t);
    });
  }

  // Schedule advance to next measure — remaining time from fromBeat
  const remainingMs = Math.max(0, Math.round((maxEnd - fromSec) * 1000));
  const t = setTimeout(() => {
    if (!isPlaying) return;
    const next = playCurrentMeasure + 1;
    if (next > playEndMeasure) {
      if (loopEnabled) {
        playCurrentMeasure = playStartMeasure;
        const loopIntro = startBackingForMeasure(playStartMeasure);
        if (loopIntro) {
          // Intro exists: delay piano just like the initial play
          playTimers.push(setTimeout(() => {
            if (isPlaying) scheduleMeasure();
          }, backingOffsetSec * 1000));
        } else {
          scheduleMeasure();
        }
      } else {
        stopPlay(true); // reset to start of range on natural end
      }
    } else {
      playCurrentMeasure = next;
      scheduleMeasure();
    }
  }, remainingMs);
  playTimers.push(t);
}

function stopPlay(resetToStart = false) {
  // ── Stop follow play session ───────────────────────────
  if (followPlaying || followPaused) {
    followPlaying = false;
    followPaused  = false;
    resetFollowInputState({ clearHighlights: true });
  }
  // ── Stop audio playback ───────────────────────────────
  isPlaying   = false;
  audioPaused = false;
  playTimers.forEach(t => clearTimeout(t));
  playTimers = [];
  activeNodes.forEach(n => { try { n.stop(); } catch(e){} });
  activeNodes = [];
  stopBackingSource();
  // ── Reset to configured start measure ────────────────
  if (resetToStart) {
    goToMeasure(savedStartMeasure);
    highlight(savedStartMeasure - 1);
  }
  // ── Reset UI ──────────────────────────────────────────
  document.getElementById('playBtn').innerHTML = '▶';
  document.getElementById('playBtn').classList.remove('playing');
}

// ── Follow play session ───────────────────────────────
function startFollowPlay() {
  if (!ensureActiveMIDIHandler()) {
    showToast('Conecta un dispositivo MIDI para usar el seguimiento', true);
    return;
  }
  const total  = songData ? songData.measures.length : 1;
  const endVal = parseInt(document.getElementById('measureEnd').value);

  followStart   = currentMeasure;
  savedStartMeasure = currentMeasure;
  followEnd     = (!endVal || isNaN(endVal)) ? total
                  : Math.max(currentMeasure, Math.min(endVal, total));
  followPlaying = true;

  resetFollowInputState({ clearHighlights: true });

  // Ensure step-by-step mode (required for note-by-note advance)
  if (!sequenceMode) {
    sequenceMode = true;
    const btn = document.getElementById('modeBtn');
    if (btn) btn.innerHTML = '📊<span class="btn-label"> Todas las notas</span>';
  }

  followPaused = false;
  document.getElementById('playBtn').innerHTML = '⏸';
  document.getElementById('playBtn').classList.add('playing');

  // Display first step of starting measure
  highlight(followStart - 1);

  const rangeLabel = followEnd > followStart
    ? ` (compases ${followStart}–${followEnd})`
    : ` (compás ${followStart})`;
  showToast('🎹 Seguimiento iniciado' + rangeLabel + ' — toca las notas iluminadas');
}

// ════════════════════════════════════════════════════
//  MUSICXML PARSER
// ════════════════════════════════════════════════════
function parseMusicXML(xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('XML inválido o corrompido.');

  const title    = (doc.querySelector('movement-title, work-title')?.textContent ||
                    doc.querySelector('credit-words')?.textContent || 'Sin título').trim();
  const composer = doc.querySelector('creator[type="composer"]')?.textContent?.trim() || '';

  // Extract tempo from <sound tempo="120"/> or <per-minute>
  let origBpm = null;
  const soundEl = doc.querySelector('sound[tempo]');
  if (soundEl) origBpm = Math.round(parseFloat(soundEl.getAttribute('tempo')));
  if (!origBpm) {
    const perMin = doc.querySelector('per-minute');
    if (perMin) origBpm = Math.round(parseFloat(perMin.textContent));
  }

  const part = doc.querySelector('part');
  if (!part) throw new Error('No se encontró ninguna parte en el archivo.');

  let divisions = 1;
  let timeSig = '4/4', timNum = 4, timDen = 4;

  const measures = [];

  part.querySelectorAll('measure').forEach(mEl => {
    // Update divisions/timesig if redefined in this measure
    const dEl = mEl.querySelector('divisions');
    if (dEl) divisions = parseInt(dEl.textContent) || 1;
    const tsEl = mEl.querySelector('time');
    if (tsEl) {
      timNum = parseInt(tsEl.querySelector('beats')?.textContent||'4');
      timDen = parseInt(tsEl.querySelector('beat-type')?.textContent||'4');
      timeSig = `${timNum}/${timDen}`;
    }

    const treble = [], bass = [];
    let cursor = 0, endCursor = 0;

    // Iterate ALL child elements in order so <backup> and <forward> are respected.
    // <backup> rewinds the cursor (MusicXML uses this to switch from staff 1 → staff 2).
    // <forward> advances the cursor (used for skipped rests).
    Array.from(mEl.children).forEach(child => {
      const tag = child.tagName;

      if (tag === 'backup') {
        const dur = parseInt(child.querySelector('duration')?.textContent || '0');
        endCursor = Math.max(0, endCursor - dur / divisions);
        cursor = endCursor;
        return;
      }

      if (tag === 'forward') {
        const dur = parseInt(child.querySelector('duration')?.textContent || '0');
        endCursor += dur / divisions;
        cursor = endCursor;
        return;
      }

      if (tag !== 'note') return;

      const nEl = child;
      const isChord = !!nEl.querySelector('chord');
      const isRest  = !!nEl.querySelector('rest');
      const durTicks = parseInt(nEl.querySelector('duration')?.textContent||'0');
      const durBeats = durTicks / divisions;

      if (!isChord) cursor = endCursor;

      if (!isRest) {
        const pitch  = nEl.querySelector('pitch');
        if (pitch) {
          const step  = pitch.querySelector('step')?.textContent || 'C';
          const oct   = parseInt(pitch.querySelector('octave')?.textContent || '4');
          const alter = parseFloat(pitch.querySelector('alter')?.textContent || '0');
          const midi  = 12*(oct+1) + (STEP_SEMI[step]||0) + Math.round(alter);
          const staff = parseInt(nEl.querySelector('staff')?.textContent||'1');

          if (midi >= 21 && midi <= 108) {
            const note = { midi, beat: cursor, duration: durBeats };
            (staff === 1 ? treble : bass).push(note);
          }
        }
      }

      if (!isChord) endCursor = cursor + durBeats;
    });

    measures.push({ treble, bass });
  });

  if (!measures.length) throw new Error('El archivo no contiene compases.');
  return { title, composer, timeSig, origBpm, measures, format: 'MusicXML' };
}

// ════════════════════════════════════════════════════
//  MIDI PARSER
// ════════════════════════════════════════════════════
function parseMIDI(buf) {
  const d = new Uint8Array(buf);
  let p = 0;
  const r32 = () => { const v=((d[p]<<24)|(d[p+1]<<16)|(d[p+2]<<8)|d[p+3])>>>0; p+=4; return v; };
  const r16 = () => { const v=(d[p]<<8)|d[p+1]; p+=2; return v; };
  const rVL = () => { let v=0,b; do { b=d[p++]; v=(v<<7)|(b&0x7F); } while(b&0x80); return v; };

  if (r32() !== 0x4D546864) throw new Error('No es un archivo MIDI válido.');
  r32(); // header length
  r16(); // format
  const nTracks = r16();
  const TPB     = r16(); // ticks per beat

  const tracks = [];
  for (let t = 0; t < nTracks; t++) {
    if (p >= d.length) break;
    const magic = r32();
    const tLen  = r32();
    const tEnd  = p + tLen;
    if (magic !== 0x4D54726B) { p = tEnd; continue; }

    const evts = [];
    let tick = 0, rs = 0;

    while (p < tEnd) {
      const dt = rVL();
      tick += dt;
      let st = d[p];
      if (st & 0x80) { rs = st; p++; } else { st = rs; }
      const type = (st & 0xF0) >> 4, ch = st & 0x0F;

      if (st === 0xFF) {
        const mt = d[p++], ml = rVL();
        if (mt === 0x51 && ml >= 3) {
          evts.push({ tick, type:'tempo', tempo:(d[p]<<16)|(d[p+1]<<8)|d[p+2] });
        }
        p += ml;
      } else if (st === 0xF0 || st === 0xF7) {
        p += rVL();
      } else if (type === 9) {
        const note=d[p++], vel=d[p++];
        evts.push({ tick, type: vel>0?'on':'off', ch, note });
      } else if (type === 8) {
        const note=d[p++]; p++;
        evts.push({ tick, type:'off', ch, note });
      } else if (type===0xA||type===0xB||type===0xE) { p+=2; }
        else if (type===0xC||type===0xD)              { p+=1; }
        else                                           { p+=1; }
    }
    p = tEnd;
    tracks.push(evts);
  }

  let allEvts = [].concat(...tracks).sort((a,b)=>a.tick-b.tick);
  let tempo = 500000;
  let TPM = TPB * 4; // ticks/measure (4/4 default)

  // first pass: get tempo
  allEvts.forEach(e => { if (e.type==='tempo') tempo = e.tempo; });

  const maxTick = allEvts.reduce((mx,e)=>Math.max(mx,e.tick),0);
  const nMeasures = Math.max(1, Math.ceil((maxTick+1)/TPM));
  const measures = Array.from({length:nMeasures}, ()=>({treble:[],bass:[]}));

  const active = {};
  allEvts.forEach(e => {
    const k = `${e.ch}-${e.note}`;
    if (e.type==='on') {
      active[k] = e.tick;
    } else if (e.type==='off' && active[k]!=null) {
      const s=active[k], dur=e.tick-s;
      const mi = Math.floor(s/TPM);
      const beat = (s%TPM)/TPB;
      const durB = dur/TPB;
      if (mi<measures.length && e.note>=21 && e.note<=108) {
        const nd = { midi:e.note, beat, duration:durB };
        (e.ch===0||(e.ch!==1&&e.note>=60) ? measures[mi].treble : measures[mi].bass).push(nd);
      }
      delete active[k];
    }
  });

  const origBpm = Math.round(60000000 / tempo);
  return { title:'MIDI File', composer:'', timeSig:'4/4', origBpm, measures, format:'MIDI' };
}

// ════════════════════════════════════════════════════
//  FILE LOADING
// ════════════════════════════════════════════════════
function loadFile(file) {
  const isXML  = /\.(xml|musicxml)$/i.test(file.name);
  const isMIDI = /\.(mid|midi)$/i.test(file.name);
  if (!isXML && !isMIDI) { showToast('Formato no soportado. Usa .xml, .musicxml, .mid o .midi', true); return; }

  const reader = new FileReader();
  rawFileName  = file.name;
  currentLevel = detectLevel(file.name);   // set level from filename suffix

  if (isXML) {
    reader.readAsText(file);
    reader.onload = e => {
      try {
        rawMusicXML    = e.target.result;
        rawFileContent = e.target.result;
        onLoaded(parseMusicXML(e.target.result), file.name);
      } catch (err) { showToast('Error MusicXML: ' + err.message, true); console.error(err); }
    };
  } else {
    rawMusicXML = null;
    reader.readAsArrayBuffer(file);
    reader.onload = e => {
      try {
        rawFileContent = e.target.result.slice(0); // copy ArrayBuffer
        onLoaded(parseMIDI(e.target.result), file.name);
      } catch (err) { showToast('Error MIDI: ' + err.message, true); console.error(err); }
    };
  }
}

function onLoaded(data, filename, options = {}) {
  songData = data;
  currentMeasure = 1;
  computeMeasureStartBeats();

  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('pianoSection').style.display = 'flex';

  document.getElementById('songTitle').textContent = data.title || filename;
  const meta = [];
  if (data.composer) meta.push(data.composer);
  if (data.timeSig)  meta.push('Compás: ' + data.timeSig);
  meta.push(data.measures.length + ' compases');
  meta.push(data.format);
  document.getElementById('songMeta').textContent = meta.join('  ·  ');

  document.getElementById('measureInput').value = 1;
  document.getElementById('measureInput').max   = data.measures.length;
  document.getElementById('measureEnd').value   = '';
  document.getElementById('measureEnd').max     = data.measures.length;

  // Tempo: set input to original BPM (clamped), show reference
  if (data.origBpm && data.origBpm >= 20 && data.origBpm <= 400) {
    document.getElementById('tempoInput').value = data.origBpm;
    document.getElementById('tempoOrig').textContent = '♩=' + data.origBpm;
  } else {
    document.getElementById('tempoInput').value = 120;
    document.getElementById('tempoOrig').textContent = '';
  }

  // Restore last session for this song (overrides the defaults set above)
  const restored = restoreState(data.title);

  updateNav();
  highlight(currentMeasure - 1);
  setTimeout(scrollToActive, 100);

  // Level selector
  const knownLevels = options.levels || null;
  updateLevelSelector(knownLevels);

  // Toast
  const levelLabel = currentLevel === 'intermediate'   ? ' (Intermedio)'     :
                     currentLevel === 'basic'          ? ' (Básico)'         :
                     currentLevel === 'accompaniment'  ? ' (Acompañamiento)' : '';
  showToast(restored
    ? `✓ "${data.title}"${levelLabel} — retomando desde el compás ${currentMeasure}`
    : `✓ "${data.title}"${levelLabel} cargada — ${data.measures.length} compases`
  );

  // Save to recent songs & refresh list (skip if coming from level switch / recent load)
  // Restore backing track for this song from IndexedDB
  restoreBackingForSong(data.title).catch(() => {});

  if (!options.skipDB) {
    saveSongToDB().then(async () => {
      await renderRecentSongs();
      // Reload record from IDB so we can show all available levels in the selector
      const id  = songBaseId(rawFileName, songData && songData.title);
      const rec = await idbGet(id).catch(() => null);
      if (rec && rec.levels) updateLevelSelector(rec.levels);
    }).catch(() => {});
  }

  // Reset notation state
  vrvRendered = false;
  measureNoteMap = {};
  document.getElementById('notationSVG').innerHTML = '';
  document.getElementById('notationMsg').style.display = 'flex';
  document.getElementById('notationMsg').textContent = 'Renderizando partitura…';

  // Auto-activate notation for MusicXML files (default-on)
  // On phones: keep teclado as default — only activate notation if no piano
  if (rawMusicXML && !notationActive) {
    if (!isPhone()) {
      // Desktop/tablet: show notation by default
      notationActive = true;
      document.getElementById('notationWrapper').classList.add('active');
      document.getElementById('notationToggle').classList.add('active');
    }
    // Phone: notation stays off — user can toggle it with 🎼
  }
  // Hide notation panel if no XML (MIDI files)
  if (!rawMusicXML && notationActive) {
    notationActive = false;
    document.getElementById('notationWrapper').classList.remove('active');
    document.getElementById('notationToggle').classList.remove('active');
  }
  // Enable/disable print button
  const pBtn = document.getElementById('printScoreBtn');
  if (pBtn) pBtn.disabled = !rawMusicXML;

  if (notationActive && vrvToolkit && rawMusicXML) renderNotation();
}

// ── Level selector update ─────────────────────────────
function updateLevelSelector(levels) {
  // levels: object with keys 'original'/'intermediate'/'basic'/'accompaniment', or null (single file)
  const sel = document.getElementById('levelSelector');
  const btnO = document.getElementById('lvlOriginal');
  const btnS = document.getElementById('lvlIntermediate');
  const btnA = document.getElementById('lvlAccompaniment');
  const btnB = document.getElementById('lvlBasic');

  // If no multi-level info yet, try to derive from IDB lazily
  if (!levels) {
    // Just show as original only (no selector visible, or show selector hidden)
    sel.style.display = 'none';
    return;
  }

  const hasOrig = !!levels.original;
  const hasSimp = !!levels.intermediate;
  const hasAccomp = !!levels.accompaniment;
  const hasBas  = !!levels.basic;

  // Show selector only if at least one non-original level exists
  if (!hasSimp && !hasBas && !hasAccomp) {
    sel.style.display = 'none';
    return;
  }

  sel.style.display = 'flex';
  btnO.disabled = !hasOrig;
  btnS.disabled = !hasSimp;
  btnB.disabled = !hasBas;
  if (btnA) btnA.disabled = !hasAccomp;

  // Active state
  [btnO, btnS, btnB, btnA].filter(Boolean).forEach(b => b.classList.remove('active'));
  if (currentLevel === 'original')   btnO.classList.add('active');
  if (currentLevel === 'intermediate')   btnS.classList.add('active');
  if (currentLevel === 'accompaniment')  btnA && btnA.classList.add('active');
  if (currentLevel === 'basic')      btnB.classList.add('active');

  // Store levels on selector element for switchLevel to access
  sel._levels = levels;

  // Keep mobile level section in sync
  syncMobLevelSelector();
}

// ── Switch between song levels ────────────────────────
async function switchLevel(level) {
  const sel    = document.getElementById('levelSelector');
  const levels = sel._levels;
  if (!levels) return;

  const levelData = levels[level];
  if (!levelData) { showToast('Nivel no disponible', true); return; }

  currentLevel   = level;
  rawFileContent = levelData.content;
  rawFileName    = levelData.filename || rawFileName;

  let data;
  try {
    if (rawFileName.toLowerCase().endsWith('.mid') || rawFileName.toLowerCase().endsWith('.midi')) {
      const buf = rawFileContent instanceof ArrayBuffer
        ? rawFileContent
        : new Uint8Array(Object.values(rawFileContent)).buffer;
      data = parseMIDI(buf);
      rawMusicXML = null;
    } else {
      data = parseMusicXML(rawFileContent);
      rawMusicXML = rawFileContent;
    }
    // Preserve user-renamed display title across level switches
    if (songData && songData.title) data.title = songData.title;
    onLoaded(data, rawFileName, { skipDB: true, levels });
  } catch(e) {
    showToast('Error al cambiar nivel: ' + e.message, true);
    console.error(e);
  }
}

// ════════════════════════════════════════════════════
//  WEB MIDI API — device detection + follow mode
// ════════════════════════════════════════════════════
let midiAccess   = null;
let midiInput    = null;   // active MIDIInput port
let followMode    = false;  // flag: Seguimiento button is ON
let followPlaying = false;  // flag: active follow-play session (Play pressed with followMode=ON)
let followStart   = 1;      // first measure of follow session
let followPaused  = false;  // paused mid-session (position saved)
let audioPaused   = false;  // audio playback paused
let measureStartWallTime = 0;   // Date.now() (ms) when current measure audio scheduling began
let pausedBeatInMeasure  = 0;   // beat offset within measure where we paused
let pausedMeasure = 1;      // measure saved at pause
let pausedStep    = 0;      // step saved at pause
let followEnd     = 1;      // last measure of follow session
let pressedNotes  = new Set();  // MIDI note numbers currently held
let followTimer   = null;       // debounce before advancing
let correctNotes  = new Set();  // notes pressed correctly in this step
let heldFromPrevStep = new Set(); // notes held over from previous step — must release+repress
let releaseTimers   = {};           // delayed removal from heldFromPrevStep (Casio retrigger guard)
let followErrorSoundEnabled = localStorage.getItem('pv_follow_error_sound') === 'on';
let lastFollowErrorSoundAt = 0;
let incompleteChordTimer = null;
const INCOMPLETE_CHORD_GRACE_MS = 700;

function resetFollowInputState(options = {}) {
  const { clearHighlights = false } = options;
  clearIncompleteChordWarning();
  pressedNotes.clear();
  correctNotes.clear();
  heldFromPrevStep.clear();
  if (followTimer) { clearTimeout(followTimer); followTimer = null; }
  Object.values(releaseTimers).forEach(t => clearTimeout(t));
  releaseTimers = {};
  document.querySelectorAll('.hl-correct').forEach(el => el.classList.remove('hl-correct'));
  if (clearHighlights) clearHL();
}

function ensureActiveMIDIHandler() {
  if (!midiInput) return false;
  midiInput.onmidimessage = onMIDIMessage;
  updateMIDIDot(true);
  updateFollowBtn();
  return true;
}

function followStepToken() {
  return `${currentMeasure}:${currentStep}`;
}

function clearIncompleteChordWarning() {
  if (incompleteChordTimer) {
    clearTimeout(incompleteChordTimer);
    incompleteChordTimer = null;
  }
}

function isFollowStepComplete(required = currentStepRequired()) {
  if (!required.size) return true;
  return [...required].every(midi => correctNotes.has(midi) && pressedNotes.has(midi));
}

function scheduleIncompleteChordWarning(required) {
  clearIncompleteChordWarning();
  if (!followPlaying || required.size < 2 || correctNotes.size === 0) return;
  const token = followStepToken();
  incompleteChordTimer = setTimeout(() => {
    incompleteChordTimer = null;
    if (!followPlaying || followStepToken() !== token) return;
    const currentRequired = currentStepRequired();
    const hasPartial = [...currentRequired].some(midi => correctNotes.has(midi) || pressedNotes.has(midi));
    if (currentRequired.size > 1 && hasPartial && !isFollowStepComplete(currentRequired)) {
      playFollowErrorSound();
    }
  }, INCOMPLETE_CHORD_GRACE_MS);
}

function onFollowErrorSoundToggle(enabled) {
  followErrorSoundEnabled = Boolean(enabled);
  localStorage.setItem('pv_follow_error_sound', followErrorSoundEnabled ? 'on' : 'off');
}

function initFollowErrorSoundUI() {
  const toggle = document.getElementById('followErrorSoundToggle');
  if (toggle) toggle.checked = followErrorSoundEnabled;
}

function playFollowErrorSound() {
  if (!followErrorSoundEnabled) return;
  const nowMs = performance.now();
  if (nowMs - lastFollowErrorSoundAt < 170) return;
  lastFollowErrorSoundAt = nowMs;

  const ctx = getCtx();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  const start = ctx.currentTime + 0.005;
  const end = start + 0.16;

  const master = ctx.createGain();
  master.gain.setValueAtTime(0.0001, start);
  master.gain.exponentialRampToValueAtTime(0.15, start + 0.012);
  master.gain.exponentialRampToValueAtTime(0.0001, end);
  master.connect(ctx.destination);

  [
    { type: 'square', from: 220, to: 150, gain: 0.75 },
    { type: 'sawtooth', from: 207, to: 135, gain: 0.25 }
  ].forEach(tone => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = tone.type;
    osc.frequency.setValueAtTime(tone.from, start);
    osc.frequency.exponentialRampToValueAtTime(tone.to, end);
    gain.gain.value = tone.gain;
    osc.connect(gain);
    gain.connect(master);
    osc.start(start);
    osc.stop(end + 0.03);
  });
}

async function initMIDI() {
  if (!navigator.requestMIDIAccess) return; // unsupported browser
  try {
    midiAccess = await navigator.requestMIDIAccess({ sysex: false });
    refreshMIDIDevices();
    midiAccess.onstatechange = refreshMIDIDevices;
  } catch(e) { /* user denied permission — silently skip */ }
}

function refreshMIDIDevices() {
  const inputs  = Array.from(midiAccess.inputs.values());
  const sel     = document.getElementById('midiSelect');
  const mobSel  = document.getElementById('mobMidiSelect');
  const dot     = document.getElementById('midiDot');
  const ctrl    = document.getElementById('midiControl');
  const fBtn    = document.getElementById('followBtn');
  const mobSect = document.getElementById('mobMidiSection');

  // Populate both selects identically
  [sel, mobSel].forEach(s => { if (s) s.innerHTML = ''; });

  if (!inputs.length) {
    ctrl.style.display  = 'none';
    fBtn.style.display  = 'none';
    if (mobSect) mobSect.style.display = 'none';
    if (midiInput) disconnectMIDI();
    return;
  }

  inputs.forEach(inp => {
    const label = inp.name.length > 22 ? inp.name.slice(0, 22) + '…' : inp.name;
    [sel, mobSel].forEach(s => {
      if (!s) return;
      const opt = document.createElement('option');
      opt.value = inp.id; opt.textContent = label;
      s.appendChild(opt);
    });
  });

  ctrl.style.display  = 'flex';
  fBtn.style.display  = 'flex';
  if (mobSect) mobSect.style.display = '';

  // Auto-select if only one device (or reconnection of known device)
  if (inputs.length === 1) {
    if (sel)    sel.value    = inputs[0].id;
    if (mobSel) mobSel.value = inputs[0].id;
    selectMIDIDevice(inputs[0].id);
  } else if (midiInput && midiAccess.inputs.has(midiInput.id)) {
    if (sel)    sel.value    = midiInput.id;
    if (mobSel) mobSel.value = midiInput.id;
  } else {
    updateMIDIDot(false);
    updateFollowBtn();
  }
}

function selectMIDIDevice(id) {
  if (midiInput) { midiInput.onmidimessage = null; midiInput = null; }
  if (!id) { updateMIDIDot(false); updateFollowBtn(); return; }

  midiInput = midiAccess.inputs.get(id);
  if (midiInput) {
    midiInput.onmidimessage = onMIDIMessage;
    updateMIDIDot(true);
    showToast('🎹 ' + midiInput.name + ' conectado');
  }
  updateFollowBtn();
}

function disconnectMIDI() {
  if (midiInput) { midiInput.onmidimessage = null; midiInput = null; }
  if (followMode) disableFollowMode();
  updateMIDIDot(false);
  updateFollowBtn();
}

function updateMIDIDot(on) {
  ['midiDot', 'mobMidiDot'].forEach(id => {
    const dot = document.getElementById(id);
    if (dot) dot.classList.toggle('connected', on);
  });
  // Keep both selects in sync when a device is chosen
  if (on && midiInput) {
    const mobSel = document.getElementById('mobMidiSelect');
    if (mobSel) mobSel.value = midiInput.id;
    const sel = document.getElementById('midiSelect');
    if (sel) sel.value = midiInput.id;
  }
}


function updateFollowBtn() {
  const btn = document.getElementById('followBtn');
  if (!btn) return;
  btn.disabled = !midiInput;

}

// ── MIDI message handler ──────────────────────────────
function onMIDIMessage(e) {
  const cmd  = e.data[0] & 0xF0;
  const note = e.data[1];
  const vel  = e.data[2];

  if (cmd === 0x90 && vel > 0) {
    // Note On
    pressedNotes.add(note);
    if (followPlaying) onFollowNoteOn(note);
  } else if (cmd === 0x80 || (cmd === 0x90 && vel === 0)) {
    // Note Off
    pressedNotes.delete(note);
    // Delayed removal from heldFromPrevStep — guards against Casio NoteOff→NoteOn
    // retrigger pairs (sent while key is physically held). If a NoteOn comes within
    // 80ms of this NoteOff for the same note, the pending timer is cancelled in
    // onFollowNoteOn and the note stays blocked. A genuine re-press takes >100ms.
    if (heldFromPrevStep.has(note)) {
      if (releaseTimers[note]) clearTimeout(releaseTimers[note]);
      releaseTimers[note] = setTimeout(() => {
        heldFromPrevStep.delete(note);
        delete releaseTimers[note];
      }, 80);
    } else {
      if (releaseTimers[note]) { clearTimeout(releaseTimers[note]); delete releaseTimers[note]; }
    }
    if (followPlaying) clearCorrectKey(note);
  }
}

// ── Follow mode logic ─────────────────────────────────
function onFollowNoteOn(note) {
  // If note is still held-from-prev-step, this NoteOn is a Casio retrigger
  // (NoteOff→NoteOn pair while physically holding). Cancel any pending release
  // timer so the block stays in place until a genuine release (>80ms gap).
  if (heldFromPrevStep.has(note)) {
    if (releaseTimers[note]) { clearTimeout(releaseTimers[note]); delete releaseTimers[note]; }
    return;
  }

  const required = currentStepRequired();
  if (!required.size) { scheduleFollowAdvance(); return; }

  if (required.has(note)) {
    markCorrectKey(note);
    correctNotes.add(note);
  } else if (!followTimer) {
    clearIncompleteChordWarning();
    playFollowErrorSound();
    return;
  }

  // For chords, every required note must be freshly pressed and currently held.
  if (isFollowStepComplete(required)) {
    clearIncompleteChordWarning();
    scheduleFollowAdvance();
  } else {
    scheduleIncompleteChordWarning(required);
  }
}

function pausePlay() {
  // Works for both audio and follow mode
  if (followPlaying) { pauseFollowPlay(); return; }
  if (!isPlaying) return;
  // Snapshot backing position before stopping
  if (backingSource && backingBuffer) {
    const ctx = getCtx();
    const elapsed = Math.max(0, ctx.currentTime - backingCtxStart);
    backingPosStart = backingPosStart + elapsed; // position in audio file right now
  }
  // Snapshot beat position within current measure
  {
    const _bpm = Math.max(20, Math.min(400, parseInt(document.getElementById('tempoInput').value) || 120));
    const _beatSec = 60 / _bpm;
    const _elapsedSec = Math.max(0, (Date.now() - measureStartWallTime) / 1000);
    pausedBeatInMeasure = _elapsedSec / _beatSec;
  }
  // Audio pause: stop timers, save position (playCurrentMeasure already set)
  audioPaused = true;
  isPlaying   = false;
  playTimers.forEach(t => clearTimeout(t));
  playTimers = [];
  activeNodes.forEach(n => { try { n.stop(); } catch(e){} });
  activeNodes = [];
  stopBackingSource();
  document.getElementById('playBtn').innerHTML = '▶';
  document.getElementById('playBtn').classList.remove('playing');
}

function pauseFollowPlay() {
  if (!followPlaying) return;
  pausedMeasure = currentMeasure;
  pausedStep    = currentStep;
  followPlaying = false;
  followPaused  = true;
  resetFollowInputState({ clearHighlights: false });
  // Keep piano highlighted (don't clearHL) so user sees where they left off
  // Update UI
  document.getElementById('playBtn').innerHTML = '▶';
  document.getElementById('playBtn').classList.remove('playing');

}

function resumeFollowPlay() {
  if (!followPaused) return;
  followPaused  = false;
  followPlaying = true;
  ensureActiveMIDIHandler();
  resetFollowInputState({ clearHighlights: false });
  // Restore paused position
  goToMeasure(pausedMeasure);
  highlight(pausedMeasure - 1);
  showStep(pausedStep);
  // Update UI
  document.getElementById('playBtn').innerHTML = '⏸';
  document.getElementById('playBtn').classList.add('playing');
  showToast('▶ Reanudando desde compás ' + pausedMeasure);
}

function currentStepRequired() {
  if (!songData || !measureSteps.length || currentStep >= measureSteps.length) return new Set();
  return new Set(measureSteps[currentStep].notes.map(n => n.midi));
}

function markCorrectKey(midi) {
  const el = document.getElementById('k' + midi);
  if (!el) return;
  el.querySelectorAll('.note-label').forEach(l => l.remove());
  el.classList.add('hl-correct'); // layered on top, CSS order makes it win visually
  // Retrigger press animation
  el.classList.remove('retrigger');
  void el.offsetWidth;
  el.classList.add('retrigger');
  el.addEventListener('animationend', () => el.classList.remove('retrigger'), { once: true });
}

function clearCorrectKey(midi) {
  const el = document.getElementById('k' + midi);
  if (el) el.classList.remove('hl-correct');
}

function scheduleFollowAdvance() {
  clearIncompleteChordWarning();
  if (followTimer) return;
  followTimer = setTimeout(() => {
    followTimer = null;
    if (followPlaying) doFollowAdvance();
  }, 80); // short pause
}

function doFollowAdvance() {
  if (!followPlaying) return;
  clearIncompleteChordWarning();
  // Snapshot held notes BEFORE clearing — user must release these to press again
  heldFromPrevStep = new Set(pressedNotes);
  correctNotes.clear();

  const atLastStep    = currentStep >= measureSteps.length - 1;
  const atLastMeasure = currentMeasure >= followEnd;

  if (!atLastStep) {
    changeStep(1);
  } else if (!atLastMeasure) {
    changeMeasure(1);
  } else {
    if (loopEnabled) {
      // Restart from the configured start measure — keep followPlaying = true
      resetFollowInputState({ clearHighlights: false });
      goToMeasure(followStart);
      highlight(followStart - 1);
      showToast('🔁 ¡Bien hecho! Reiniciando desde compás ' + followStart);
    } else {
      stopPlay(false); // don't reset position on natural completion
      clearHL();
      showToast('✅ ¡Secuencia completada! ¡Bien hecho!', false, 'success');
    }
  }
}

function toggleFollowMode() {
  if (!midiInput) { showToast('Conecta un dispositivo MIDI primero', true); return; }
  followMode = !followMode;
  const btn = document.getElementById('followBtn');
  if (followMode) {
    btn.classList.add('active');
    btn.innerHTML = '🟢 <span class="btn-label">Seguimiento</span>';
    showToast('Seguimiento activado — dale ▶ Play para comenzar');
  } else {
    disableFollowMode();
  }
}

function disableFollowMode() {
  followMode = false;
  // If a follow session is running, stop it
  if (followPlaying) stopPlay();
  const btn = document.getElementById('followBtn');
  if (btn) {
    btn.classList.remove('active');
    btn.innerHTML = '🎵 <span class="btn-label">Seguimiento</span>';
  }
}

// ── MIDI enable/disable via Settings toggle ───────────
function onMidiToggleChange(enabled) {
  localStorage.setItem('pv_midi', enabled ? 'on' : 'off');
  if (enabled) {
    initMIDI();
  } else {
    // Disconnect and hide all MIDI UI
    disconnectMIDI();
    if (midiAccess) {
      midiAccess.onstatechange = null;
      midiAccess = null;
    }
    document.getElementById('midiControl').style.display = 'none';
    document.getElementById('followBtn').style.display  = 'none';
    const mobSect = document.getElementById('mobMidiSection');
    if (mobSect) mobSect.style.display = 'none';
    if (followMode) disableFollowMode();
  }
}

// Init MIDI only if user previously enabled it
(function initMidiFromPrefs() {
  const tog = document.getElementById('midiToggle');
  const enabled = localStorage.getItem('pv_midi') === 'on';
  if (tog) tog.checked = enabled;
  if (enabled) initMIDI();
})();

// ════════════════════════════════════════════════════
//  PIANO VISIBILITY TOGGLE
// ════════════════════════════════════════════════════
let pianoVisible = true;

function togglePianoVisible() {
  pianoVisible = !pianoVisible;
  const outer = document.getElementById('pianoOuter');
  const btn   = document.getElementById('pianoToggleBtn');
  if (outer) outer.style.display = pianoVisible ? 'flex' : 'none';
  btn.classList.toggle('active', pianoVisible);

  // On phones: showing piano hides notation to free space
  if (pianoVisible && isPhone() && notationActive) {
    notationActive = false;
    document.getElementById('notationWrapper').classList.remove('active');
    document.getElementById('notationToggle')?.classList.remove('active');
  }
}

// ════════════════════════════════════════════════════
//  FULLSCREEN
// ════════════════════════════════════════════════════
function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
}

document.addEventListener('fullscreenchange', () => {
  const btn = document.getElementById('fsBtn');
  if (document.fullscreenElement) {
    btn.textContent = '✕';
    btn.title = 'Salir de pantalla completa';
    // Lock to landscape on mobile
    if (screen.orientation && screen.orientation.lock) {
      screen.orientation.lock('landscape').catch(() => {});
    }
  } else {
    btn.textContent = '⛶';
    btn.title = 'Pantalla completa';
    if (screen.orientation && screen.orientation.unlock) {
      screen.orientation.unlock();
    }
  }
});

// ── Mobile welcome modal (fullscreen suggestion) ──────
(function initMobileWelcome() {
  const WELCOME_KEY = 'pv_welcome_seen_v1';
  if (localStorage.getItem(WELCOME_KEY) === '1') return;
  const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
                   || ('ontouchstart' in window && window.innerWidth <= 1366);
  if (!isMobile) return;

  window.dismissWelcomeModal = function(enterFullscreen) {
    localStorage.setItem(WELCOME_KEY, '1');
    document.getElementById('welcomeModal')?.remove();
    if (enterFullscreen) toggleFullscreen();
  };

  const modal = document.createElement('div');
  modal.id = 'welcomeModal';
  modal.innerHTML = `
    <div class="welcome-box">
      <div class="welcome-icon">🎹</div>
      <div class="welcome-title">KeyPlay</div>
      <div class="welcome-msg">Para la mejor experiencia en móvil activa la pantalla completa y gira el dispositivo en horizontal.</div>
      <button class="welcome-fs-btn" onclick="dismissWelcomeModal(true)">⛶ Activar pantalla completa</button>
      <button class="welcome-skip-btn" onclick="dismissWelcomeModal(false)">Continuar sin activar</button>
    </div>`;
  document.body.appendChild(modal);
})();

// ════════════════════════════════════════════════════
//  PANEL CONTROLS — Biblioteca + Settings
// ════════════════════════════════════════════════════
function closeAllPanels() {
  closeMeasureSlider();
  document.getElementById('biblioPanel').classList.remove('open');
  document.getElementById('settingsPanel').classList.remove('open');
  document.getElementById('panelOverlay').classList.remove('open');
  document.getElementById('biblioBtn').classList.remove('open');
  document.getElementById('settingsBtn').classList.remove('open');
}

function toggleBiblioteca() {
  const isOpen = document.getElementById('biblioPanel').classList.contains('open');
  closeAllPanels();
  if (!isOpen) {
    document.getElementById('biblioPanel').classList.add('open');
    document.getElementById('panelOverlay').classList.add('open');
    document.getElementById('biblioBtn').classList.add('open');
  }
}

function toggleSettings() {
  const isOpen = document.getElementById('settingsPanel').classList.contains('open');
  closeAllPanels();
  if (!isOpen) {
    document.getElementById('settingsPanel').classList.add('open');
    document.getElementById('panelOverlay').classList.add('open');
    document.getElementById('settingsBtn').classList.add('open');
  }
}

// Close panels on Escape key
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeAllPanels();
});

// ════════════════════════════════════════════════════
//  SOUND SYSTEM  (MIDI.js soundfonts — gleitz CDN)
//  • Carga como <script> tag → sin CORS, funciona en file://
//  • Player propio con Web Audio API nativo — sin dependencias externas
//  • Los .js de gleitz definen MIDI.Soundfont['name'] = { 'C4': 'data:audio/mpeg;base64,...' }
// ════════════════════════════════════════════════════
let currentSound = localStorage.getItem('pv_sound') || 'classic';
let sfLoading    = false;
let noteBuffers  = new Map(); // midi_number → AudioBuffer

const SOUND_PRESETS = {
  classic: {
    url:      'https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/acoustic_grand_piano-mp3.js',
    fontName: 'acoustic_grand_piano',
    label:    'Clásico',
  },
  bright: {
    url:      'https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/electric_grand_piano-mp3.js',
    fontName: 'electric_grand_piano',
    label:    'Eléctrico',
  },
  soft: {
    url:      'https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/electric_piano_1-mp3.js',
    fontName: 'electric_piano_1',
    label:    'Suave (Rhodes)',
  },
};

// Convierte nombre de nota ('C4', 'Bb3', 'Db2'…) a número MIDI
function noteNameToMidi(name) {
  const letters = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const m = name.match(/^([A-G])(b?)(-?\d+)$/);
  if (!m) return -1;
  return (parseInt(m[3]) + 1) * 12 + letters[m[1]] + (m[2] ? -1 : 0);
}

// Decodifica todos los samples del font usando Web Audio API nativo
async function decodeSoundfont(fontObj) {
  const ctx = getCtx();
  noteBuffers.clear();
  await Promise.all(
    Object.entries(fontObj).map(async ([noteName, dataUri]) => {
      const midi = noteNameToMidi(noteName);
      if (midi < 0) return;
      try {
        const base64 = dataUri.split(',')[1];
        const binary = atob(base64);
        const bytes  = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const buf = await ctx.decodeAudioData(bytes.buffer.slice(0));
        noteBuffers.set(midi, buf);
      } catch(e) { /* nota fallida — se omite */ }
    })
  );
}

// Carga el script del instrumento y decodifica
function loadInstrument(soundName, silent) {
  const preset = SOUND_PRESETS[soundName];
  if (!preset) return;

  sfLoading = true;
  setSoundLoadingUI(soundName, true);

  const doDecodeAndFinish = () => {
    decodeSoundfont(window.MIDI.Soundfont[preset.fontName])
      .then(() => {
        sfLoading = false;
        setSoundLoadingUI(soundName, false);
        if (!silent) showToast(`🎹 ${preset.label} listo`);
      })
      .catch(() => {
        sfLoading = false;
        setSoundLoadingUI(soundName, false);
        showToast('Error decodificando audio', true);
      });
  };

  // ¿Ya está cargado el script?
  if (window.MIDI && window.MIDI.Soundfont && window.MIDI.Soundfont[preset.fontName]) {
    doDecodeAndFinish();
    return;
  }

  const s  = document.createElement('script');
  s.src    = preset.url;
  s.onload = () => {
    if (!window.MIDI?.Soundfont?.[preset.fontName]) {
      sfLoading = false;
      setSoundLoadingUI(soundName, false);
      showToast('Error cargando instrumento', true);
      return;
    }
    doDecodeAndFinish();
  };
  s.onerror = () => {
    sfLoading = false;
    setSoundLoadingUI(soundName, false);
    showToast('Sin conexión — usando síntesis básica', true);
  };
  document.head.appendChild(s);
}

// ── UI de carga ───────────────────────────────────────
function setSoundLoadingUI(soundName, loading) {
  document.querySelectorAll('.sound-option').forEach(el => {
    el.classList.toggle('active', el.dataset.sound === currentSound);
    const check = el.querySelector('.sound-option-check');
    if (!check) return;
    if (el.dataset.sound === soundName && loading) {
      check.style.cssText = 'background:none;border:2px solid var(--accent)';
      check.innerHTML = '<div style="width:8px;height:8px;border-radius:50%;background:var(--accent);animation:sf-spin 0.8s linear infinite;margin:3px auto 0"></div>';
    } else {
      check.style.cssText = '';
      check.innerHTML = '';
    }
  });
}

function selectSound(name) {
  if (sfLoading) return;
  currentSound = name;
  localStorage.setItem('pv_sound', name);
  noteBuffers.clear();  // limpia buffers del instrumento anterior
  loadInstrument(name);
}

function initSoundUI() {
  document.querySelectorAll('.sound-option').forEach(el => {
    el.classList.toggle('active', el.dataset.sound === currentSound);
  });
  loadInstrument(currentSound, true);
}

// ════════════════════════════════════════════════════
//  INDEXED DB — recent songs storage
// ════════════════════════════════════════════════════
const IDB_NAME    = 'KeyPlayDB';
const IDB_VER     = 2;           // bumped for multi-level schema
const IDB_STORE   = 'songs';
const MAX_RECENT  = 10;
let   idb         = null;
let   rawFileContent = null; // string (XML) or ArrayBuffer (MIDI)
let   rawFileName    = '';
let   currentLevel   = 'original'; // 'original' | 'intermediate' | 'basic' | 'accompaniment'

// ── Level helpers ─────────────────────────────────────
function detectLevel(filename) {
  const base = filename.replace(/\.[^.]+$/, ''); // strip extension
  if (base.endsWith('-b')) return 'basic';
  if (base.endsWith('-i')) return 'intermediate';
  if (base.endsWith('-a')) return 'accompaniment';
  return 'original';
}

function songBaseId(filename, title) {
  // If we have a title, use it — this matches IDs created by the old code
  // and is consistent across all 3 levels (which share the same title in their XML)
  if (title) {
    return 'song_' + title.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 60);
  }
  // Fallback: filename-based, stripping the level suffix (-s / -b)
  let base = filename.replace(/\.[^.]+$/, ''); // strip extension
  if (base.endsWith('-b') || base.endsWith('-i') || base.endsWith('-a')) base = base.slice(0, -2);
  return 'song_' + base.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 60);
}

function idbGet(id) {
  return new Promise((res, rej) => {
    const tx  = idb.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(id);
    req.onsuccess = e => res(e.target.result || null);
    req.onerror   = e => rej(e.target.error);
  });
}

function idbOpen() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(IDB_NAME, IDB_VER);
    req.onupgradeneeded = e => {
      const db  = e.target.result;
      const old = e.oldVersion;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        const st = db.createObjectStore(IDB_STORE, { keyPath: 'id' });
        st.createIndex('ts', 'ts');
      }
      // v1→v2: migrate flat `content` records to `levels.original`
      if (old === 1) {
        const tx = e.target.transaction;
        const st = tx.objectStore(IDB_STORE);
        st.openCursor().onsuccess = ev => {
          const cursor = ev.target.result;
          if (!cursor) return;
          const rec = cursor.value;
          if (rec.content !== undefined && !rec.levels) {
            rec.levels = { original: { content: rec.content, filename: rec.filename } };
            delete rec.content;
            cursor.update(rec);
          }
          cursor.continue();
        };
      }
    };
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

function idbAll() {
  return new Promise((res, rej) => {
    const tx  = idb.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).index('ts').getAll();
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

async function saveSongToDB() {
  if (!idb || !songData || !rawFileContent) return Promise.resolve();

  const level  = detectLevel(rawFileName);
  const id     = songBaseId(rawFileName, songData.title);

  // Load existing record (may have other levels already stored)
  const existing = await idbGet(id);

  const levelData = { content: rawFileContent, filename: rawFileName };

  let record;
  if (existing) {
    record = existing;
    record.levels          = record.levels || {};
    record.levels[level]   = levelData;
    record.ts              = Date.now();
    // Use original level's metadata as the canonical title/meta
    if (level === 'original' || !record.title) {
      record.title    = songData.title    || rawFileName;
      record.composer = songData.composer || '';
      record.format   = songData.format;
      record.timeSig  = songData.timeSig  || '4/4';
      record.measures = songData.measures.length;
    }
  } else {
    record = {
      id,
      title:    songData.title    || rawFileName,
      composer: songData.composer || '',
      format:   songData.format,
      timeSig:  songData.timeSig  || '4/4',
      measures: songData.measures.length,
      levels:   { [level]: levelData },
      ts:       Date.now()
    };
  }

  // Return a Promise that resolves after the transaction commits
  return new Promise((res, rej) => {
    const tx = idb.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(record);
    tx.oncomplete = async () => {
      // Trim to MAX_RECENT
      const all = await idbAll();
      if (all.length > MAX_RECENT) {
        all.sort((a, b) => a.ts - b.ts);
        const trim = idb.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE);
        all.slice(0, all.length - MAX_RECENT).forEach(r => trim.delete(r.id));
      }
      res();
    };
    tx.onerror = e => rej(e.target.error);
  });
}

async function deleteSongFromDB(id) {
  if (!idb) return;
  idb.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).delete(id);
  await renderRecentSongs();
}

function confirmClearAll() {
  if (!confirm('¿Borrar toda la biblioteca?\nEsta acción eliminará todas las canciones guardadas y no se puede deshacer.')) return;
  clearAllRecent();
}

async function clearAllRecent() {
  if (!idb) return;
  idb.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).clear();
  await renderRecentSongs();
}

function startRename(recId) {
  const titleEl = document.getElementById('title-' + recId);
  if (!titleEl) return;
  const currentTitle = titleEl.textContent;

  // Replace title text with an input
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'recent-rename-input';
  input.value = currentTitle;

  titleEl.innerHTML = '';
  titleEl.appendChild(input);
  input.focus();
  input.select();

  const finish = async (save) => {
    const newTitle = input.value.trim();
    if (save && newTitle && newTitle !== currentTitle) {
      await commitRename(recId, newTitle);
    } else {
      // Restore original text
      titleEl.textContent = currentTitle;
    }
  };

  input.addEventListener('blur',    () => finish(true));
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = currentTitle; input.blur(); }
  });
}

async function commitRename(recId, newTitle) {
  if (!idb) return;
  const rec = await idbGet(recId).catch(() => null);
  if (!rec) return;
  rec.title = newTitle;
  await new Promise((resolve, reject) => {
    const tx = idb.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(rec);
    tx.oncomplete = resolve;
    tx.onerror    = reject;
  });
  // If this song is currently loaded, update the title in the top bar
  if (songData && songBaseId(rawFileName, songData.title) === recId) {
    songData.title = newTitle;
    document.getElementById('songTitle').textContent = newTitle;
  }
  await renderRecentSongs();
}

function relativeTime(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1)   return 'Ahora mismo';
  if (m < 60)  return `Hace ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `Hace ${h}h`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'Ayer';
  if (d < 30)  return `Hace ${d} días`;
  return new Date(ts).toLocaleDateString('es', { month: 'short', day: 'numeric' });
}

async function renderRecentSongs() {
  if (!idb) return;
  const all = await idbAll();
  all.sort((a, b) => b.ts - a.ts);

  const list = document.getElementById('biblioList');

  // Update counter badge on the Biblioteca button
  const countEl = document.getElementById('biblioCount');
  if (all.length) {
    countEl.textContent = all.length;
    countEl.style.display = 'inline-flex';
  } else {
    countEl.style.display = 'none';
  }

  if (!list) return;
  list.innerHTML = '';

  if (!all.length) {
    list.innerHTML = `
      <div class="biblio-empty">
        <div class="biblio-empty-icon">🎼</div>
        <div>Tu biblioteca está vacía.<br>Carga una pieza para comenzar.</div>
      </div>`;
    return;
  }

  all.forEach(rec => {
    const card = document.createElement('div');
    card.className = 'recent-card';
    card.onclick   = () => { loadFromRecent(rec); closeAllPanels(); };

    const icon = rec.format === 'MIDI' ? '🎹' : '🎼';
    const meta = [rec.timeSig, `${rec.measures} compases`];
    if (rec.composer) meta.unshift(rec.composer);

    // Level badges
    const levels = rec.levels || (rec.content ? { original: true } : {});
    const badges = [];
    if (levels.original)   badges.push(`<span class="level-badge orig">Original</span>`);
    if (levels.intermediate)   badges.push(`<span class="level-badge simp">Intermedio</span>`);
    if (levels.accompaniment) badges.push(`<span class="level-badge acmp">Acomp.</span>`);
    if (levels.basic)      badges.push(`<span class="level-badge basic">Básico</span>`);

    card.innerHTML = `
      <div class="recent-icon">${icon}</div>
      <div class="recent-info">
        <div class="recent-song-title" id="title-${rec.id}">${rec.title}</div>
        <div class="recent-song-meta">
          <span class="recent-badge">${rec.format || 'MusicXML'}</span>
          ${meta.join(' · ')}
          ${badges.join('')}
          <span style="margin-left:auto;flex-shrink:0">${relativeTime(rec.ts)}</span>
        </div>
      </div>
      <button class="recent-rename" title="Renombrar"
        onclick="event.stopPropagation();startRename('${rec.id}')">✏️</button>
      <button class="recent-del" title="Eliminar"
        onclick="event.stopPropagation();deleteSongFromDB('${rec.id}')">✕</button>
    `;
    list.appendChild(card);
  });
}

function loadFromRecent(rec, preferLevel) {
  try {
    // Support both old flat schema and new levels schema
    const levels = rec.levels || (rec.content ? { original: { content: rec.content, filename: rec.filename || '' } } : {});
    const orderedLevels = ['original', 'intermediate', 'basic', 'accompaniment'];
    const targetLevel = preferLevel || orderedLevels.find(l => levels[l]) || 'original';
    const levelData   = levels[targetLevel];
    if (!levelData) { showToast('Nivel no disponible', true); return; }

    rawFileContent = levelData.content;
    rawFileName    = levelData.filename || rec.filename || '';
    currentLevel   = targetLevel;

    let data;
    if (rec.format === 'MIDI') {
      const buf = rawFileContent instanceof ArrayBuffer
        ? rawFileContent
        : new Uint8Array(Object.values(rawFileContent)).buffer;
      data = parseMIDI(buf);
      rawMusicXML = null;
    } else {
      data = parseMusicXML(rawFileContent);
      rawMusicXML = rawFileContent;
    }
    // Use user-renamed display title instead of raw XML/filename title
    if (rec.title) data.title = rec.title;
    onLoaded(data, rawFileName, { skipDB: true, songRecord: rec, levels });
    // Update timestamp
    rec.ts = Date.now();
    idb.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).put(rec);
  } catch(e) {
    showToast('Error al cargar: ' + e.message, true);
    console.error(e);
  }
}

// Init DB on startup
idbOpen().then(db => {
  idb = db;
  renderRecentSongs();
}).catch(() => {}); // silently skip if IndexedDB unavailable

// Init sound UI on startup
initSoundUI();
initFollowErrorSoundUI();

// ════════════════════════════════════════════════════
//  STATE PERSISTENCE  (localStorage, keyed by song title)
// ════════════════════════════════════════════════════
function stateKey(title) {
  return 'pv_' + (title || 'unknown').replace(/\s+/g, '_').slice(0, 80);
}

function saveState() {
  if (!songData) return;
  try {
    localStorage.setItem(stateKey(songData.title), JSON.stringify({
      measure:      currentMeasure,
      clef:         activeClef,
      // tempo intentionally NOT saved — always restored from song's origBpm
      sequenceMode: sequenceMode,
      loop:         loopEnabled,
      rangeEnd:     document.getElementById('measureEnd').value || ''
    }));
  } catch(e) {}
}

function restoreState(title) {
  try {
    const raw = localStorage.getItem(stateKey(title));
    if (!raw) return false;
    const s = JSON.parse(raw);

    // Measure
    if (s.measure >= 1 && s.measure <= songData.measures.length) {
      currentMeasure = s.measure;
      document.getElementById('measureInput').value = s.measure;
    }
    // Clef
    if (['both','treble','bass'].includes(s.clef)) {
      activeClef = s.clef;
      ['both','treble','bass'].forEach(x =>
        document.getElementById('btn' + x[0].toUpperCase() + x.slice(1))
          .classList.toggle('active', x === s.clef)
      );
    }
    // Tempo: NOT restored from state — always set from song's origBpm on load

    // Sequence mode
    if (typeof s.sequenceMode === 'boolean' && s.sequenceMode !== sequenceMode) {
      sequenceMode = s.sequenceMode;
      const btn = document.getElementById('modeBtn');
      btn.textContent = sequenceMode ? '📊 Todas las notas' : '👣 Paso a paso';
      btn.classList.toggle('overview', !sequenceMode);
    }
    // Loop
    if (typeof s.loop === 'boolean') {
      loopEnabled = s.loop;
      document.getElementById('loopBtn').classList.toggle('active', loopEnabled);
    }
    // Range end
    if (s.rangeEnd) document.getElementById('measureEnd').value = s.rangeEnd;

    return true;
  } catch(e) { return false; }
}

// ════════════════════════════════════════════════════
//  DRAG & DROP
// ════════════════════════════════════════════════════
document.getElementById('fileInput').addEventListener('change', e => {
  const f = e.target.files[0]; if (f) loadFile(f); e.target.value='';
});

const dz = document.getElementById('dropZone');
dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('drag-over'); });
dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
dz.addEventListener('drop', e => {
  e.preventDefault(); dz.classList.remove('drag-over');
  const f = e.dataTransfer.files[0]; if (f) loadFile(f);
});

// ════════════════════════════════════════════════════
//  KEYBOARD SHORTCUTS
// ════════════════════════════════════════════════════
document.addEventListener('keydown', e => {
  if (!songData) return;
  if (document.activeElement.tagName === 'INPUT') return;

  if (e.key === ' ') { e.preventDefault(); togglePlay(); return; }

  // Shift + arrows → measure navigation
  if (e.shiftKey) {
    if (e.key === 'ArrowRight') { e.preventDefault(); changeMeasure(1);  }
    if (e.key === 'ArrowLeft')  { e.preventDefault(); changeMeasure(-1); }
    return;
  }

  // Arrows → step navigation (sequence mode) or measure navigation (overview)
  if (e.key === 'ArrowRight') {
    e.preventDefault();
    if (sequenceMode && measureSteps.length) {
      if (currentStep < measureSteps.length - 1) changeStep(1);
      else changeMeasure(1); // advance to next measure at end of steps
    } else changeMeasure(1);
  }
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    if (sequenceMode && measureSteps.length) {
      if (currentStep > 0) changeStep(-1);
      else changeMeasure(-1); // go to previous measure at beginning
    } else changeMeasure(-1);
  }
});

// ════════════════════════════════════════════════════
//  VEROVIO NOTATION
// ════════════════════════════════════════════════════
let vrvToolkit     = null;   // Verovio toolkit instance
let notationActive = false;  // panel visible?
let rawMusicXML    = null;   // original XML string (Verovio needs the raw file)
let measureNoteMap = {};     // {measureNum: {beatKey: [svgNoteIds]}}
let noteStaffMap   = {};     // {svgNoteId: 1|2}  — 1=treble, 2=bass
let staffGroupIds  = {1:[],2:[]};  // staff IDs by number, for dimming
let vrvRendered    = false;  // has renderNotation() been called for current file?

// ── Load Verovio dynamically ─────────────────────────
function loadVerovio() {
  const s = document.createElement('script');
  s.src = 'https://www.verovio.org/javascript/latest/verovio-toolkit-wasm.js';
  s.onload = () => {
    // WASM initializes asynchronously — poll until toolkit is constructable
    let tries = 0;
    const poll = setInterval(() => {
      tries++;
      try {
        vrvToolkit = new verovio.toolkit();
        clearInterval(poll);
        onVerovioReady();
      } catch(e) {
        if (tries > 80) clearInterval(poll); // give up after ~8s
      }
    }, 100);
  };
  s.onerror = () => {}; // silently fail in artifact / offline
  document.head.appendChild(s);
}

function onVerovioReady() {
  // Show the toggle button
  const btn = document.getElementById('notationToggle');
  btn.style.display = 'flex';
  // If a song is already loaded and panel is active, render now
  if (notationActive && rawMusicXML) renderNotation();
}

// ── Toggle panel ─────────────────────────────────────
function toggleNotation() {
  notationActive = !notationActive;
  document.getElementById('notationWrapper').classList.toggle('active', notationActive);
  document.getElementById('notationToggle').classList.toggle('active', notationActive);

  // On phones: activating notation hides piano to free space
  if (notationActive && isPhone()) {
    pianoVisible = false;
    const outer = document.getElementById('pianoOuter');
    if (outer) outer.style.display = 'none';
    document.getElementById('pianoToggleBtn')?.classList.remove('active');
  }

  if (notationActive && vrvToolkit && rawMusicXML && !vrvRendered) {
    renderNotation();
  } else if (notationActive) {
    updateNotationMeasure(currentMeasure);
  }
}

// ── Beam injection ────────────────────────────────────
// Verovio respeta los <beam> del MusicXML. Si el archivo no los tiene (o
// los tiene incorrectos), las notas aparecen con corchetes individuales.
// Esta función los inyecta correctamente según la firma de tiempo.
function addBeamsToMusicXML(xmlStr) {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlStr, 'application/xml');
    if (doc.querySelector('parsererror')) return xmlStr;

    doc.querySelectorAll('part').forEach(part => {
      let divisions = 1;
      let beatTicks = 1;  // ticks por tiempo (= una negra por defecto)

      part.querySelectorAll('measure').forEach(measure => {
        // Actualizar divisions si cambia en este compás
        const divEl = measure.querySelector('attributes > divisions');
        if (divEl) divisions = Math.max(1, parseInt(divEl.textContent) || 1);

        // beat-type: 4=negra, 8=corchea... beatTicks = divisions * 4 / beatType
        const btEl = measure.querySelector('attributes > time > beat-type');
        if (btEl) beatTicks = Math.round(divisions * 4 / (parseInt(btEl.textContent) || 4));
        else       beatTicks = divisions;

        // Recorrer notas del compás y recopilar por voz
        const byVoice = new Map();
        let pos = 0, lastPos = 0;

        for (const child of Array.from(measure.children)) {
          const tag = child.tagName;
          if (tag === 'backup') {
            pos = Math.max(0, pos - (parseInt(child.querySelector('duration')?.textContent) || 0));
          } else if (tag === 'forward') {
            pos += parseInt(child.querySelector('duration')?.textContent) || 0;
          } else if (tag === 'note') {
            const isChord = !!child.querySelector('chord');
            const isRest  = !!child.querySelector('rest');
            const isGrace = !!child.querySelector('grace');
            const dur     = parseInt(child.querySelector('duration')?.textContent || '0');
            const voice   = child.querySelector('voice')?.textContent || '1';
            const notePos = isChord ? lastPos : pos;

            if (!byVoice.has(voice)) byVoice.set(voice, []);
            if (!isRest && !isGrace) byVoice.get(voice).push({ note: child, pos: notePos, dur, isChord });

            if (!isChord) { lastPos = pos; pos += dur; }
          }
        }

        // Para cada voz, eliminar beams viejos e inyectar nuevos
        byVoice.forEach(items => {
          // Borrar beams existentes (pueden estar mal)
          items.forEach(({ note }) => Array.from(note.querySelectorAll('beam')).forEach(b => b.remove()));

          // Sólo procesar notas principales (no chord-notes: comparten plica)
          const stems = items.filter(i => !i.isChord);

          let group = [], groupBeat = -1;
          const flush = () => { if (group.length >= 2) _applyBeamGroup(group, beatTicks, doc); group = []; groupBeat = -1; };

          stems.forEach(item => {
            if (item.dur >= beatTicks) { flush(); return; }   // negra o mayor: no agrupa
            const beat = Math.floor(item.pos / beatTicks);
            if (group.length && beat !== groupBeat) flush();
            group.push(item);
            groupBeat = beat;
          });
          flush();
        });
      });
    });

    return new XMLSerializer().serializeToString(doc);
  } catch (e) {
    console.warn('addBeamsToMusicXML error:', e);
    return xmlStr;
  }
}

function _applyBeamGroup(group, beatTicks, doc) {
  const n = group.length;

  // Beam 1 — para todas las notas del grupo (corcheas y menores)
  group.forEach((item, i) => {
    _insertBeam(item.note, 1, i === 0 ? 'begin' : i === n - 1 ? 'end' : 'continue', doc);
  });

  // Beam 2 — para semicorcheas (dur ≤ beatTicks/2) y menores
  const tick16 = Math.round(beatTicks / 2);
  const tick32 = Math.round(beatTicks / 4);
  _applySubBeam(group, 2, tick16, doc);
  _applySubBeam(group, 3, tick32, doc);
}

// Agrupa runs de notas con dur ≤ maxDur y les pone beam número `num`
function _applySubBeam(group, num, maxDur, doc) {
  let run = [];
  const flush = () => {
    if (run.length >= 2) {
      run.forEach((item, i) => _insertBeam(item.note, num,
        i === 0 ? 'begin' : i === run.length - 1 ? 'end' : 'continue', doc));
    } else if (run.length === 1) {
      _insertBeam(run[0].note, num, 'forward hook', doc);
    }
    run = [];
  };
  group.forEach(item => { if (item.dur <= maxDur) run.push(item); else flush(); });
  flush();
}

function _insertBeam(noteEl, number, value, doc) {
  const beam = doc.createElement('beam');
  beam.setAttribute('number', String(number));
  beam.textContent = value;
  // Insertar antes de <notations> o <lyric> si existen, si no al final
  const ref = noteEl.querySelector('notations') || noteEl.querySelector('lyric');
  if (ref) noteEl.insertBefore(beam, ref);
  else noteEl.appendChild(beam);
}

// ── Render full score ─────────────────────────────────
function renderNotation() {
  if (!vrvToolkit || !rawMusicXML) return;

  document.getElementById('notationMsg').style.display = 'flex';
  document.getElementById('notationSVG').innerHTML = '';

  // Run in next tick so the "renderizando" message shows
  setTimeout(() => {
    try {
      vrvToolkit.setOptions({
        pageWidth:        60000,   // very wide → no line breaks
        pageHeight:       800,
        scale:            33,
        adjustPageWidth:  1,
        adjustPageHeight: 1,
        breaks:           'none',
        spacingSystem:    16,
        spacingStaff:     8,
        footer:           'none',
        header:           'none',
        xmlIdSeed:        0,
        mnumInterval:     1,       // show measure number on every measure
      });

      // Inyectar beams correctos antes de pasar a Verovio
      const beamedXML = addBeamsToMusicXML(rawMusicXML);
      vrvToolkit.loadData(beamedXML);
      const svg = vrvToolkit.renderToSVG(1, {});
      document.getElementById('notationSVG').innerHTML = svg;
      document.getElementById('notationMsg').style.display = 'none';

      vrvRendered = true;

      buildNoteMap();
      updateNotationMeasure(currentMeasure);
    } catch(e) {
      document.getElementById('notationMsg').textContent = 'Error al renderizar la partitura.';
      console.error('Verovio render error:', e);
    }
  }, 30);
}

// ── Print score ───────────────────────────────────────
function printScore() {
  if (!vrvToolkit || !rawMusicXML) {
    showToast('Carga una pieza MusicXML primero', true);
    return;
  }

  const btn = document.getElementById('printScoreBtn');
  btn.disabled = true;
  btn.textContent = '⏳ Preparando…';

  const format  = document.querySelector('input[name="printFormat"]:checked')?.value || 'a4';
  const isA4    = format !== 'letter';

  // Verovio page dimensions (internal units, ~1/10 mm)
  // A4: 210×297mm, Letter: 216×279mm
  // We target ~180mm usable width at scale 55 → comfortable staff size
  const pgW     = isA4 ? 2100 : 2160;   // full paper width (margins applied separately)
  const pgH     = isA4 ? 2970 : 2790;
  const margin  = 120;                   // ~12mm margin on each side

  setTimeout(() => {
    try {
      // Save current toolkit options so we can restore them
      vrvToolkit.setOptions({
        pageWidth:        pgW - margin * 2,
        pageHeight:       pgH - margin * 2,
        pageMarginTop:    0,
        pageMarginBottom: 0,
        pageMarginLeft:   0,
        pageMarginRight:  0,
        scale:            55,
        adjustPageWidth:  0,
        adjustPageHeight: 0,
        breaks:           'auto',
        spacingSystem:    12,
        spacingStaff:     6,
        footer:           'none',
        header:           'none',
        xmlIdSeed:        0,
        mnumInterval:     1,
      });
      vrvToolkit.loadData(addBeamsToMusicXML(rawMusicXML));

      const pageCount = vrvToolkit.getPageCount();
      const title     = songData?.title || 'Partitura';
      let pages = '';
      for (let p = 1; p <= pageCount; p++) {
        const svg = vrvToolkit.renderToSVG(p, {});
        pages += `<div class="page${p === pageCount ? ' last-page' : ''}">${svg}</div>`;
      }

      // Restore app rendering
      vrvRendered = false;
      if (notationActive && rawMusicXML) renderNotation();

      btn.disabled = false;
      btn.textContent = '🖨️ Imprimir partitura';

      // Build print window
      const win = window.open('', '_blank', 'width=900,height=700');
      if (!win) { showToast('El navegador bloqueó la ventana de impresión', true); return; }

      const paperCSS = isA4 ? 'size: A4 portrait' : 'size: letter portrait';
      const marginMM = '12mm';

      win.document.write(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>${title} — KeyPlay</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #fff; font-family: serif; }
    .sheet-title {
      font-size: 16px; font-weight: bold; text-align: center;
      padding: 10mm ${marginMM} 4mm; color: #111;
    }
    .page {
      width: 100%;
      padding: 0 ${marginMM} 8mm;
      page-break-after: always;
      break-after: page;
    }
    .page.last-page { page-break-after: avoid; break-after: avoid; }
    .page svg { width: 100%; height: auto; display: block; }
    .page:first-child { padding-top: 0; }
    .print-footer {
      font-size: 9px; color: #999; text-align: center;
      padding: 4mm 0 2mm;
    }
    @page { ${paperCSS}; margin: ${marginMM}; }
    @media screen {
      body { background: #e0e0e0; }
      .sheet {
        background: #fff;
        max-width: ${isA4 ? '210mm' : '216mm'};
        margin: 10mm auto;
        box-shadow: 0 2px 12px rgba(0,0,0,0.2);
        padding: 10mm ${marginMM};
      }
    }
    @media print {
      html, body { background: white; min-height: 0; }
      .sheet { padding: 0; box-shadow: none; max-width: none; margin: 0; }
      .page { padding: 0; overflow: hidden; }
      .no-print { display: none; }
      .sheet-title,
      .print-footer { display: none !important; }
    }
  </style>
</head>
<body>
  <div class="no-print" style="background:#5b21b6;color:#fff;text-align:center;padding:10px;font-family:sans-serif;font-size:13px">
    <strong>Vista previa de impresión</strong> —
    <button onclick="window.print()" style="background:#fff;color:#5b21b6;border:none;border-radius:5px;padding:5px 16px;font-weight:700;cursor:pointer;margin-left:8px">🖨️ Imprimir</button>
    <button onclick="window.close()" style="background:transparent;color:#fff;border:1px solid rgba(255,255,255,0.5);border-radius:5px;padding:5px 12px;cursor:pointer;margin-left:6px">✕ Cerrar</button>
  </div>
  <div class="sheet">
    <div class="sheet-title">${title}</div>
    ${pages}
    <div class="print-footer">Generado con KeyPlay</div>
  </div>
  <script>
    // Auto-open print dialog after a short delay for render
    window.onload = () => setTimeout(() => window.print(), 600);
  <\/script>
</body>
</html>`);
      win.document.close();

    } catch(e) {
      showToast('Error al preparar la impresión', true);
      console.error('Print error:', e);
      btn.disabled = false;
      btn.textContent = '🖨️ Imprimir partitura';
      // Ensure app rendering is restored
      vrvRendered = false;
      if (notationActive && rawMusicXML) renderNotation();
    }
  }, 50);
}

// ── Build note map from Verovio timemap ───────────────
function buildNoteMap() {
  measureNoteMap = {};
  noteStaffMap   = {};
  if (!vrvToolkit || !songData) return;

  try {
    const raw = vrvToolkit.renderToTimemap();
    const tm  = (typeof raw === 'string') ? JSON.parse(raw) : raw;
    if (!Array.isArray(tm)) { console.warn('Unexpected timemap format'); return; }

    const parts = (songData.timeSig || '4/4').split('/');
    const num   = parseInt(parts[0]) || 4;
    const den   = parseInt(parts[1]) || 4;
    const qpm   = num * (4 / den);

    tm.forEach(entry => {
      if (!entry.on || !entry.on.length) return;
      const mIdx    = Math.floor(entry.qstamp / qpm);
      const beat    = entry.qstamp - mIdx * qpm;
      const mNum    = mIdx + 1;
      const beatKey = Math.round(beat * 10000);
      if (!measureNoteMap[mNum])          measureNoteMap[mNum] = {};
      if (!measureNoteMap[mNum][beatKey]) measureNoteMap[mNum][beatKey] = [];
      measureNoteMap[mNum][beatKey].push(...entry.on);
    });
  } catch(e) {
    console.warn('Note map build failed:', e);
  }

  // Build note→staff lookup from the rendered SVG.
  // Walk every staff group (Verovio uses g.staff with n="1"/"2"); record
  // every [id] element inside so we can filter by clef without DOM traversal later.
  buildStaffMap();
}

function buildStaffMap() {
  noteStaffMap  = {};
  staffGroupIds = { 1: [], 2: [] };
  const svgEl = document.querySelector('#notationSVG svg');
  if (!svgEl) return;

  // Verovio does NOT use an n= attribute on g.staff.
  // Within each g.measure the staves appear in DOM order:
  //   first  g.staff = treble (staff 1)
  //   second g.staff = bass   (staff 2)
  svgEl.querySelectorAll('g.measure').forEach(measureEl => {
    const staffEls = Array.from(measureEl.querySelectorAll(':scope > g.staff'));
    staffEls.forEach((staffEl, idx) => {
      const staffN = idx + 1; // 1 = treble, 2 = bass
      if (staffN > 2) return;
      if (staffEl.id) staffGroupIds[staffN].push(staffEl.id);
      staffEl.querySelectorAll('[id]').forEach(el => {
        if (el.id) noteStaffMap[el.id] = staffN;
      });
    });
  });

}

function notationScreenRectToSvg(svgEl, rect) {
  const ctm = svgEl.getScreenCTM();
  if (!ctm) return null;
  const inv = ctm.inverse();
  const pt1 = svgEl.createSVGPoint();
  const pt2 = svgEl.createSVGPoint();
  pt1.x = rect.left;
  pt1.y = rect.top;
  pt2.x = rect.right;
  pt2.y = rect.bottom;
  const sp1 = pt1.matrixTransform(inv);
  const sp2 = pt2.matrixTransform(inv);
  return {
    x: Math.min(sp1.x, sp2.x),
    y: Math.min(sp1.y, sp2.y),
    width: Math.abs(sp2.x - sp1.x),
    height: Math.abs(sp2.y - sp1.y),
  };
}

function usableScreenRect(rect) {
  return rect && Number.isFinite(rect.left) && Number.isFinite(rect.right)
      && Number.isFinite(rect.top) && Number.isFinite(rect.bottom)
      && rect.right >= rect.left && rect.bottom >= rect.top;
}

function unionScreenRects(rects) {
  const valid = rects.filter(usableScreenRect);
  if (!valid.length) return null;
  return {
    left:   Math.min(...valid.map(r => r.left)),
    right:  Math.max(...valid.map(r => r.right)),
    top:    Math.min(...valid.map(r => r.top)),
    bottom: Math.max(...valid.map(r => r.bottom)),
  };
}

function elementScreenRect(el) {
  if (!el) return null;
  const direct = el.getBoundingClientRect();
  if (usableScreenRect(direct) && (direct.width > 0 || direct.height > 0)) return direct;
  return unionScreenRects(Array.from(el.querySelectorAll('*')).map(child => child.getBoundingClientRect()))
      || (usableScreenRect(direct) ? direct : null);
}

function getMeasureElement(svgEl, measureNum) {
  const measures = svgEl.querySelectorAll('g.measure');
  return measures[measureNum - 1] || null;
}

function measureDurationBeats(measureNum) {
  const parts = (songData?.timeSig || '4/4').split('/');
  const num   = parseInt(parts[0]) || 4;
  const den   = parseInt(parts[1]) || 4;
  let span    = Math.max(1, num * (4 / den));

  const measure = songData?.measures?.[measureNum - 1];
  const notes = measure ? [...(measure.treble || []), ...(measure.bass || [])] : [];
  notes.forEach(n => {
    const end = (Number(n.beat) || 0) + Math.max(0.05, Number(n.duration) || 0.5);
    if (end > span) span = end;
  });
  return span;
}

function ensureNotationPlayhead(svgEl) {
  svgEl.querySelector('#vrv-mhl')?.remove();

  let layer = svgEl.querySelector('#vrv-playhead-layer');
  if (!layer) {
    layer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    layer.id = 'vrv-playhead-layer';
    layer.setAttribute('pointer-events', 'none');
    svgEl.appendChild(layer);
  }

  layer.querySelector('#vrv-playhead-soft')?.remove();
  layer.querySelector('#vrv-playhead-core')?.remove();

  let bar = layer.querySelector('#vrv-playhead-bar');
  if (!bar) {
    bar = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bar.id = 'vrv-playhead-bar';
    bar.setAttribute('fill', '#0284c7');
    bar.setAttribute('rx', '2');
    layer.appendChild(bar);
  }
  bar.style.mixBlendMode = 'multiply';

  return { layer, bar };
}

function setNotationPlayheadRect(svgEl, rectEl, centerX, top, bottom, width, opacity) {
  const svgRect = notationScreenRectToSvg(svgEl, {
    left: centerX - width / 2,
    right: centerX + width / 2,
    top,
    bottom,
  });
  if (!svgRect) return false;
  rectEl.setAttribute('x', svgRect.x);
  rectEl.setAttribute('y', svgRect.y);
  rectEl.setAttribute('width', Math.max(0.1, svgRect.width));
  rectEl.setAttribute('height', Math.max(0.1, svgRect.height));
  rectEl.setAttribute('opacity', opacity);
  return true;
}

function positionNotationPlayhead(svgEl, measureNum, step, noteIds = []) {
  const playhead = ensureNotationPlayhead(svgEl);
  const measureEl = getMeasureElement(svgEl, measureNum);
  if (!measureEl) {
    playhead.layer.setAttribute('display', 'none');
    return;
  }

  try {
    const measureRect = elementScreenRect(measureEl);
    if (!usableScreenRect(measureRect)) {
      playhead.layer.setAttribute('display', 'none');
      return;
    }

    const staffRects = Array.from(measureEl.querySelectorAll(':scope > g.staff'))
      .map(elementScreenRect);
    const staffRect = unionScreenRects(staffRects) || measureRect;

    const noteRects = noteIds
      .map(id => svgEl.querySelector(`#${CSS.escape(id)}`))
      .filter(Boolean)
      .map(elementScreenRect);
    const noteRect = unionScreenRects(noteRects);
    const hasNotes = !!noteRect;

    let centerX;
    if (noteRect) {
      centerX = (noteRect.left + noteRect.right) / 2;
    } else {
      const beat  = Number.isFinite(step?.beat) ? step.beat : 0;
      const span  = measureDurationBeats(measureNum);
      const ratio = Math.max(0, Math.min(1, beat / span));
      const pad   = Math.min(10, Math.max(0, measureRect.width * 0.04));
      centerX = (measureRect.left + pad) + (measureRect.width - pad * 2) * ratio;
    }

    const top    = staffRect.top - 4;
    const bottom = staffRect.bottom + 4;
    const barOk = setNotationPlayheadRect(svgEl, playhead.bar, centerX, top, bottom, 15, hasNotes ? '0.42' : '0.16');
    if (barOk) playhead.layer.removeAttribute('display');
    else playhead.layer.setAttribute('display', 'none');
  } catch(e) {
    playhead.layer.setAttribute('display', 'none');
    console.warn('Notation playhead error:', e);
  }
}

function notationStepNoteIds(step) {
  if (!step || !step.notes || !step.notes.length) return [];
  const beatKey = Math.round((step.beat || 0) * 10000);
  const allIds  = (measureNoteMap[currentMeasure] || {})[beatKey] || [];

  return allIds.filter(id => {
    if (activeClef === 'both') return true;
    const staffN = noteStaffMap[id];
    if (!staffN) return true; // staff unknown: keep it visible
    return activeClef === 'treble' ? staffN === 1 : staffN === 2;
  });
}

// ── Move the current sheet-music playhead ─────────────
function updateNotationMeasure(measureNum) {
  if (!notationActive || !vrvRendered) return;
  const svgEl = document.querySelector('#notationSVG svg');
  if (!svgEl) return;

  const target = getMeasureElement(svgEl, measureNum);
  positionNotationPlayhead(svgEl, measureNum, null, []);
  if (!target) return;
  scrollNotationTo(target);
}

// ── Sync the sheet-music playhead with the active step ─
function updateNotationNotes(step) {
  if (!notationActive || !vrvRendered) return;
  const svgEl = document.querySelector('#notationSVG svg');
  if (!svgEl) return;

  let styleEl = svgEl.querySelector('#vrv-note-style');
  if (!styleEl) {
    styleEl = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    styleEl.id = 'vrv-note-style';
    svgEl.insertBefore(styleEl, svgEl.firstChild);
  }

  let css = '';

  // ── Dim the inactive staff ────────────────────────────────────
  if (activeClef !== 'both') {
    const dimN   = activeClef === 'treble' ? 2 : 1;
    const dimIds = staffGroupIds[dimN] || [];
    if (dimIds.length) {
      const sels = dimIds.map(id => '#' + CSS.escape(id)).join(', ');
      css += `${sels} { opacity: 0.15; }\n`;
    }
  }

  styleEl.textContent = css;
  positionNotationPlayhead(svgEl, currentMeasure, step, notationStepNoteIds(step));
}

// ── Scroll notation to bring measure into view ────────
function scrollNotationTo(measureEl) {
  const container = document.getElementById('notationWrapper');
  if (!container || !measureEl) return;
  try {
    const mRect = measureEl.getBoundingClientRect();
    const cRect = container.getBoundingClientRect();
    const offset = mRect.left - cRect.left + mRect.width / 2 - container.clientWidth / 2;
    container.scrollBy({ left: offset, behavior: 'smooth' });
  } catch(e) {}
}

// Start loading Verovio immediately (will silently fail in artifact)
loadVerovio();

// ════════════════════════════════════════════════════
//  MOBILE UX — single-panel collapse + extras popup
// ════════════════════════════════════════════════════

// Uses matchMedia so it always agrees with the CSS breakpoint
const phoneQuery = window.matchMedia(PHONE_EXCLUSIVE_QUERY);
function isPhone() { return phoneQuery.matches; }

// ── Single note-panel collapse (whole bar at once) ────
function toggleNotePanel() {
  const content  = document.getElementById('notePanelContent');
  const arrow    = document.getElementById('notePanelArrow');
  const overlay  = document.getElementById('notePanelOverlay');
  if (!content) return;
  const isOpen = content.classList.contains('open');
  content.classList.toggle('open', !isOpen);
  if (arrow)   arrow.classList.toggle('open', !isOpen);
  if (overlay) overlay.classList.toggle('open', !isOpen);
}

// ── Mobile extras popup ────────────────────────────────
function toggleMobExtras() {
  const panel   = document.getElementById('mobExtrasPanel');
  const overlay = document.getElementById('mobExtrasOverlay');
  if (!panel) return;
  if (panel.classList.contains('open')) {
    closeMobExtras();
  } else {
    // Sync BPM
    const mobBpm = document.getElementById('tempoInputMob');
    if (mobBpm) mobBpm.value = document.getElementById('tempoInput').value;
    const mobOrig = document.getElementById('tempoOrigMob');
    if (mobOrig) mobOrig.textContent = document.getElementById('tempoOrig').textContent;
    // Sync mobile clef buttons to current state
    syncMobClefButtons();
    // Sync level selector
    syncMobLevelSelector();
    panel.classList.add('open');
    if (overlay) overlay.classList.add('open');
  }
}

function closeMobExtras() {
  const panel   = document.getElementById('mobExtrasPanel');
  const overlay = document.getElementById('mobExtrasOverlay');
  if (panel)   panel.classList.remove('open');
  if (overlay) overlay.classList.remove('open');
}

// ── Sync helpers ──────────────────────────────────────
function syncMobClefButtons() {
  ['both','treble','bass'].forEach(x => {
    const cap = x[0].toUpperCase() + x.slice(1);
    document.getElementById('mBtn' + cap)?.classList.toggle('active', x === activeClef);
  });
}

function syncMobLevelSelector() {
  const mainSel = document.getElementById('levelSelector');
  const mobSec  = document.getElementById('mobLevelSection');
  if (!mainSel || !mobSec) return;

  const visible = mainSel.style.display === 'flex';
  mobSec.style.display = visible ? '' : 'none';
  if (!visible) return;

  [['Original','original'],['Intermediate','intermediate'],['Basic','basic'],['Accompaniment','accompaniment']].forEach(([cap, l]) => {
    const mainBtn = document.getElementById('lvl' + cap);
    const mobBtn  = document.getElementById('mLvl' + cap);
    if (mainBtn && mobBtn) {
      mobBtn.disabled = mainBtn.disabled;
      mobBtn.classList.toggle('active', mainBtn.classList.contains('active'));
    }
  });
}

// ════════════════════════════════════════════════════
//  TOAST
// ════════════════════════════════════════════════════
// ── Tempo input event listeners (fire on every keystroke/spinner) ────────────
document.addEventListener('DOMContentLoaded', function() {
  ['tempoInput', 'tempoInputMob'].forEach(function(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input',  function() { checkBackingBpm(); syncBackingUI(); });
    el.addEventListener('change', function() { checkBackingBpm(); syncBackingUI(); });
  });
});

let toastTimer;
function showToast(msg, isError=false, type='') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  let cls = 'toast show';
  if (isError) cls += ' error';
  else if (type) cls += ' ' + type;
  t.className = cls;
  clearTimeout(toastTimer);
  const dur = type === 'success' ? 4000 : 3200;
  toastTimer = setTimeout(() => t.classList.remove('show'), dur);
}

// ════════════════════════════════════════════════════
//  BPM SLIDER (mobile/tablet)
// ════════════════════════════════════════════════════

function openBpmSlider(event) {
  event?.preventDefault();
  event?.stopPropagation();
  if (!songData) { showToast('Carga una pieza primero', true); return; }
  syncBpmSliderUI();
  document.getElementById('bpmSliderOverlay')?.classList.add('open');
  document.getElementById('bpmSliderPanel')?.classList.add('open');
  requestAnimationFrame(() => {
    document.getElementById('bpmSliderRange')?.focus({ preventScroll: true });
  });
}

function closeBpmSlider() {
  document.getElementById('bpmSliderOverlay')?.classList.remove('open');
  document.getElementById('bpmSliderPanel')?.classList.remove('open');
}

function syncBpmSliderUI() {
  const cur = Math.max(20, Math.min(400, parseInt(document.getElementById('tempoInput')?.value) || 120));
  const range = document.getElementById('bpmSliderRange');
  const disp  = document.getElementById('bpmSliderCurrent');
  const mob   = document.getElementById('bpmMobInput');
  if (range) range.value = String(cur);
  if (disp)  disp.textContent = String(cur);
  if (mob)   mob.value = String(cur);
}

function setBpmFromSlider(value) {
  const v = Math.max(20, Math.min(400, Number(value) || 120));
  ['tempoInput', 'tempoInputMob', 'bpmMobInput'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = String(v);
  });
  const disp = document.getElementById('bpmSliderCurrent');
  if (disp) disp.textContent = String(v);
  checkBackingBpm();
  syncBackingUI();
  saveState();
}

function nudgeBpmSlider(delta) {
  const cur = Math.max(20, Math.min(400, parseInt(document.getElementById('tempoInput')?.value) || 120));
  setBpmFromSlider(cur + delta);
  const range = document.getElementById('bpmSliderRange');
  if (range) range.value = String(Math.max(20, Math.min(400, cur + delta)));
}

// Keep mob input in sync whenever tempoInput changes
document.addEventListener('DOMContentLoaded', function() {
  const main = document.getElementById('tempoInput');
  if (main) {
    main.addEventListener('change', () => syncBpmSliderUI());
    main.addEventListener('input',  () => syncBpmSliderUI());
  }
});

// ════════════════════════════════════════════════════
//  DOUBLE-TAP STEP NAVIGATION (touch)
// ════════════════════════════════════════════════════

(function() {
  let lastTap = 0;
  let lastX   = 0;

  document.addEventListener('touchend', function(e) {
    // Ignore taps inside the bottom bar or any overlay/panel
    if (e.target.closest('.bottom-bar, #mobExtrasPanel, .measure-slider-panel, #bpmSliderPanel, #notePanel, #backingPanel, #pinScreen')) return;

    // Only active in step-by-step mode (stepNav visible)
    const stepNav = document.getElementById('stepNav');
    if (!stepNav || stepNav.style.display === 'none' || getComputedStyle(stepNav).display === 'none') return;

    const now = Date.now();
    const touch = e.changedTouches[0];
    const x = touch?.clientX ?? 0;

    if (now - lastTap < 300 && Math.abs(x - lastX) < 80) {
      // Double tap detected
      e.preventDefault();
      if (x < window.innerWidth / 2) {
        changeStep(-1);
      } else {
        changeStep(1);
      }
      lastTap = 0; // reset so triple-tap doesn't trigger again
    } else {
      lastTap = now;
      lastX   = x;
    }
  }, { passive: false });
})();

// ════════════════════════════════════════════════════
//  CLICK ON MEASURE IN SHEET MUSIC → navigate
// ════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', function() {
  const svgContainer = document.getElementById('notationSVG');
  if (!svgContainer) return;

  svgContainer.addEventListener('click', function(e) {
    if (!songData) return;

    const svgEl = svgContainer.querySelector('svg');
    if (!svgEl) return;

    const measures = Array.from(svgEl.querySelectorAll('g.measure'));
    if (!measures.length) return;

    // Try direct hit first (click on a note or measure number)
    let measureEl = e.target.closest('g.measure');

    // Fallback: find which measure's bounding box contains the click point
    if (!measureEl) {
      const cx = e.clientX;
      const cy = e.clientY;
      measureEl = measures.find(m => {
        const r = m.getBoundingClientRect();
        return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
      }) || null;
    }

    if (!measureEl) return;

    const idx = measures.indexOf(measureEl);
    if (idx < 0) return;

    const measureNum = idx + 1; // 1-based

    // Navigate and update both start and end fields
    goToMeasure(measureNum);
    const endEl = document.getElementById('measureEnd');
    if (endEl) {
      endEl.value = String(measureNum);
      onRangeEndChange?.();
    }

    // Visual flash feedback
    flashMeasureEl(measureEl);
  });
});

function flashMeasureEl(measureEl) {
  // Brief purple tint overlay using a temporary rect inside the measure
  const svgNS = 'http://www.w3.org/2000/svg';
  const bbox = measureEl.getBBox?.();
  if (!bbox) return;

  const rect = document.createElementNS(svgNS, 'rect');
  rect.setAttribute('x', bbox.x);
  rect.setAttribute('y', bbox.y);
  rect.setAttribute('width',  bbox.width);
  rect.setAttribute('height', bbox.height);
  rect.setAttribute('fill', 'rgba(91,33,182,0.18)');
  rect.setAttribute('rx', '4');
  rect.style.pointerEvents = 'none';
  measureEl.appendChild(rect);
  setTimeout(() => rect.remove(), 350);
}
