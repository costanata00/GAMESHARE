/* GameShare — renderer
 *
 * Topology: full mesh of up to 10 peers using PeerJS (free public signaling at
 * 0.peerjs.com; media goes directly PC-to-PC, relayed via TURN only if needed).
 *
 * - The room creator registers the peer ID  ROOM_PREFIX + CODE.
 * - A joiner connects to that ID, says hello, and gets back the list of
 *   everyone else, then connects to each of them directly.
 * - If the creator leaves, one of the remaining people registers the room ID
 *   as a "doorman": it only answers newcomers with the member list, so the
 *   room stays joinable while anyone is in it.
 * - Whoever opens a data connection also places the voice call.
 * - Screen shares are separate one-way calls (metadata.kind = 'screen').
 *   Each viewer tells the sharer how big it is showing the screen ('view'
 *   message) and the sharer sends only that resolution to that viewer.
 * - Links heal themselves: leaving says 'bye'; a link that breaks without one
 *   keeps the friend in the room as "Reconnecting…" while both sides redial,
 *   and broken voice / screen calls are placed again (see heal()).
 */
'use strict';

// Room size: the creator picks 2-10 players (the host can change it later).
const MAX_LIMIT = 10, MIN_SIZE = 2, DEFAULT_SIZE = 4;
// Player colours (like couch co-op): one per player, the same on everyone's screen.
const PLAYER_COLORS = ['#ff6b5b', '#4ea8ff', '#ffc93d', '#3ddc97', '#b98cff', '#ff9447', '#3fd8e6', '#ff75b5', '#a6e35a', '#e0c9a0'];
const ROOM_PREFIX = 'gameshare-v1-room-';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
// Pull a room code out of pasted text such as "Join me on GameShare! Room code: AB3CDE".
// Only whole 6-character words count, so "GAMESHARE" is never mistaken for a code.
function findCode(text) {
  const t = String(text || '').toUpperCase();
  const C = '[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}';
  const labelled = new RegExp(`(?:CODE|ROOM)\\W{0,3}(${C})(?![A-Z0-9])`).exec(t);
  if (labelled) return labelled[1];
  const words = t.match(new RegExp(`(?<![A-Z0-9])${C}(?![A-Z0-9])`, 'g')) || [];
  return words.find((w) => /\d/.test(w)) || words[words.length - 1] || null;
}
// Every preset keeps the frame rate steady when the PC or the connection is
// struggling (the picture gets a little softer instead of stuttering).
const QUALITY = {
  '720p30':  { w: 1280, h: 720,  fps: 30, bitrate: 2_500_000 },
  '1080p30': { w: 1920, h: 1080, fps: 30, bitrate: 4_500_000 },
  '1080p60': { w: 1920, h: 1080, fps: 60, bitrate: 8_000_000 }
};
// All viewers of my screen together get at most this many times the preset's
// bitrate, so a big room can't flood my upload (which makes everyone stutter).
const UPLOAD_BUDGET = 2;
const MIN_VIEWER_BITRATE = 350_000;
// Incoming screens play this far behind live so late packets still make it
// (grows by itself if freezes still happen). Voice is not delayed.
const SCREEN_BUFFER_MS = 200, SCREEN_BUFFER_MAX = 600;
// Heights a viewer can ask for. Coarse steps so small resizes don't churn the encoder.
const VIEW_STEPS = [360, 540, 720, 1080];
// Self-healing links. Friends ping each other every second; a link that
// hears nothing for QUIET_MS is dropped and redialed, and a friend who
// doesn't come back within GRACE_MS has left. A call that stays
// "disconnected" for SHAKY_MS is placed again.
const QUIET_MS = 6000, SHAKY_MS = 5000, GRACE_MS = 45000, REDIAL_MS = 3000;
// Quiet but packets still arriving (their app or mine swamped): wait this long.
const QUIET_HARD_MS = 20000;
const HEAL_VERSION = '1.5.0'; // friends on this version or newer heal too

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* ------------------------------------------------------------ preferences */

const prefs = (() => {
  const d = { headphones: false, sounds: true, globalKeys: true, quality: '1080p30', shareSound: true, people: true, roomSize: DEFAULT_SIZE, lastSource: null, lastRoom: null,
              micId: '', outId: '', noiseRemoval: true, overlay: false, overlayCorner: 'top left', stats: false };
  try {
    Object.assign(d, JSON.parse(localStorage.getItem('gs-prefs') || '{}'));
    // carry over settings from older versions
    if (localStorage.getItem('gs-headphones') === '1') d.headphones = true;
    if (localStorage.getItem('gs-people') === 'hidden') d.people = false;
    localStorage.removeItem('gs-headphones');
    localStorage.removeItem('gs-people');
  } catch { /* ignore */ }
  if (!QUALITY[d.quality]) d.quality = '1080p30';
  d.roomSize = Math.min(MAX_LIMIT, Math.max(MIN_SIZE, Number(d.roomSize) || DEFAULT_SIZE));
  return d;
})();
function savePrefs() {
  try { localStorage.setItem('gs-prefs', JSON.stringify(prefs)); } catch { /* ignore */ }
}

const state = {
  peer: null,
  isHost: false,
  code: null,
  name: '',
  mic: null,            // MediaStream (real mic or silent fallback)
  micReal: false,
  muted: false,
  screen: null,         // MediaStream I'm sharing
  previewHidden: false, // I closed my own preview tile (still sharing)
  deafened: false,      // I muted everyone's voice for myself
  version: '',          // this app's version, shared with friends
  screenSound: { sound: 'none' }, // what sound my share carries (shown to viewers)
  headphones: prefs.headphones,   // headphones mode: echo cancellation off = cleaner voice
  quality: prefs.quality,
  peers: new Map(),     // peerId -> PeerInfo
  leaving: false,
  joinTimer: null,
  rejoinCode: null,     // set while "Rejoin" is trying to get back into a room
  windowVisible: true,  // false while GameShare is minimized
  globalKeys: [],       // shortcuts that also work while a game has focus
  doorman: null,        // my extra Peer holding the room ID after the creator left
  doormanOwner: null,   // peer id of whoever holds the room ID now (if not the creator)
  claim: null,          // timer for trying to take over the room ID
  maxPeople: DEFAULT_SIZE, // room size (players)
  color: null,          // my player colour (index into PLAYER_COLORS)
  joinedAt: 0,          // when I joined (decides who re-picks on a colour clash)
  boot: Math.random().toString(36).slice(2, 10), // new on every start: friends can tell I restarted
  resume: null,         // after a crash: who I was in the room, to slip back in as the same player
  quietUntil: 0         // no "joined" toasts until then (friends reconnecting after my restart)
};

const roomId = () => (state.code ? ROOM_PREFIX + state.code : '');

/* ------------------------------------------------------------------ utils */

function makeCode() {
  const buf = new Uint32Array(6);
  crypto.getRandomValues(buf);
  return Array.from(buf, (n) => CODE_ALPHABET[n % CODE_ALPHABET.length]).join('');
}

function toast(msg, kind = '') {
  note(msg);
  const t = el('div', 'toast ' + kind, msg);
  $('#toasts').appendChild(t);
  setTimeout(() => t.classList.add('out'), 3600);
  setTimeout(() => t.remove(), 4100);
}

function initials(name) {
  return (name || '?').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';
}

function hueFor(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

/* ------------------------------------------------------------ player colours
 * Each player announces their colour. A newcomer takes the first colour not
 * used by the people the host listed; if two people grab the same one at the
 * same moment, whoever joined later picks again. */

function colorIndexOf(key) {
  if (key === 'me') return state.color;
  const p = state.peers.get(key);
  return p ? p.color : null;
}

function colorOf(key) {
  const i = colorIndexOf(key);
  if (Number.isInteger(i) && i >= 0 && i < PLAYER_COLORS.length) return PLAYER_COLORS[i];
  // Friends on an older GameShare don't announce one: derive it from their id.
  return PLAYER_COLORS[hueFor(key === 'me' && state.peer ? state.peer.id : key) % PLAYER_COLORS.length];
}

function usedColors() {
  const used = new Set();
  for (const p of state.peers.values()) if (p.greeted && Number.isInteger(p.color)) used.add(p.color);
  return used;
}

function firstFreeColor(used) {
  for (let i = 0; i < PLAYER_COLORS.length; i++) if (!used.has(i)) return i;
  return 0;
}

function setMyColor(i) {
  state.color = i;
  document.documentElement.style.setProperty('--me', PLAYER_COLORS[i]);
  remember();
}

function checkColorClash() {
  if (!Number.isInteger(state.color) || !state.peer) return;
  for (const p of state.peers.values()) {
    if (!p.greeted || p.color !== state.color || !p.joinedAt) continue;
    if (p.joinedAt < state.joinedAt || (p.joinedAt === state.joinedAt && p.id < state.peer.id)) {
      setMyColor(firstFreeColor(usedColors()));
      broadcast(myState());
      renderPeople();
      return;
    }
  }
}

function colorsMap() {
  const m = {};
  if (state.peer && Number.isInteger(state.color)) m[state.peer.id] = state.color;
  for (const p of state.peers.values()) if (p.greeted && Number.isInteger(p.color)) m[p.id] = p.color;
  return m;
}

const greetedCount = () => 1 + [...state.peers.values()].filter((p) => p.greeted).length;
const amHolder = () => state.isHost || !!state.doorman;

// Flash the taskbar button when something happens while GameShare is in the
// background (a friend joins or starts sharing). Stops when you switch to it.
function attention() {
  if (!document.hasFocus() && window.gameshare.attention) window.gameshare.attention();
}

function setNet(text, kind = '') {
  const b = $('#netBadge');
  if (b.textContent !== text) b.textContent = text;
  b.className = 'net-status ' + kind;
}

/* ------------------------------------------------------------ sound cues */

let audioCtx = null;
function ctx() {
  if (!audioCtx) audioCtx = new AudioContext();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

// [frequency Hz, start s, length s]
const CUES = {
  join:     [[660, 0, 0.09], [880, 0.09, 0.14]],
  leave:    [[660, 0, 0.09], [440, 0.09, 0.16]],
  mute:     [[520, 0, 0.07], [390, 0.07, 0.11]],
  unmute:   [[390, 0, 0.07], [520, 0.07, 0.11]],
  deafen:   [[330, 0, 0.08], [247, 0.08, 0.13]],
  undeafen: [[247, 0, 0.08], [330, 0.08, 0.13]],
  share:    [[740, 0, 0.06], [988, 0.06, 0.18]]
};

function cue(name) {
  if (!prefs.sounds || !CUES[name]) return;
  try {
    const c = ctx();
    const t0 = c.currentTime + 0.01;
    for (const [f, at, dur] of CUES[name]) {
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0, t0 + at);
      g.gain.linearRampToValueAtTime(0.06, t0 + at + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
      o.connect(g).connect(c.destination);
      o.start(t0 + at);
      o.stop(t0 + at + dur + 0.02);
    }
  } catch { /* ignore */ }
}

/* --------------------------------------------------------- speaking meter
 * Runs only while someone is connected, and touches the page only when
 * someone starts or stops talking. */

const meters = new Map(); // key ('me' or peer id) -> { analyser, source, data, speaking, lastLoud }
let meterTimer = null;
let micMeterOn = false; // only while Settings is open

function watchLevel(key, stream) {
  unwatchLevel(key);
  if (!stream || !stream.getAudioTracks().length) return;
  try {
    const source = ctx().createMediaStreamSource(stream);
    const analyser = ctx().createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    meters.set(key, { analyser, source, data: new Float32Array(analyser.fftSize), speaking: false, lastLoud: 0 });
    if (!meterTimer) meterTimer = setInterval(tickMeters, 100);
  } catch (e) { console.warn('meter', e); }
}

function unwatchLevel(key) {
  const m = meters.get(key);
  if (!m) return;
  try { m.source.disconnect(); } catch { /* ignore */ }
  meters.delete(key);
  if (m.speaking) setSpeaking(key, false);
  if (!meters.size && meterTimer) { clearInterval(meterTimer); meterTimer = null; }
}

function tickMeters() {
  const now = performance.now();
  for (const [key, m] of meters) {
    m.analyser.getFloatTimeDomainData(m.data);
    let sum = 0;
    for (let i = 0; i < m.data.length; i++) sum += m.data[i] * m.data[i];
    const rms = Math.sqrt(sum / m.data.length);
    const loud = rms > 0.035 && !(key === 'me' && state.muted);
    if (key === 'me' && micMeterOn) {
      const db = 20 * Math.log10(rms + 1e-9);
      $('#micLevel').style.setProperty('--lvl', String(clamp((db + 60) / 50, 0, 1)));
    }
    if (loud) m.lastLoud = now;
    const speaking = loud || now - m.lastLoud < 350; // short hold so it doesn't flicker
    if (speaking !== m.speaking) { m.speaking = speaking; setSpeaking(key, speaking); }
  }
}

function isSpeaking(key) {
  const m = meters.get(key);
  return !!(m && m.speaking);
}

// In-game overlay: who's talking (that you can hear) and whether you're muted.
let overlaySig = '';
function pushOverlay() {
  const on = prefs.overlay === true && document.body.dataset.view === 'room';
  const st = on ? {
    me: { muted: state.muted, deafened: state.deafened },
    talking: state.deafened ? [] : [...state.peers.values()]
      .filter((p) => p.greeted && !p.localMuted && isSpeaking(p.id))
      .map((p) => ({ key: p.id, name: p.name, color: colorOf(p.id) }))
  } : null;
  const corner = prefs.overlayCorner || 'top left';
  const sig = JSON.stringify([on, corner, st]);
  if (sig === overlaySig) return;
  overlaySig = sig;
  try { window.gameshare.overlay({ on, corner, state: st }); } catch { /* ignore */ }
}

function setSpeaking(key, on) {
  const r = rows.get(key);
  if (r) r.li.classList.toggle('speaking', on);
  const t = tiles.get(key);
  if (t) t.tile.classList.toggle('speaking', on);
  const m = partyEls.get(key);
  if (m) m.el.classList.toggle('speaking', on);
  const slot = document.querySelector(`#slots [data-key="${CSS.escape(key)}"]`);
  if (slot) slot.classList.toggle('speaking', on);
  if (key !== 'me') pushOverlay();
}

/* ------------------------------------------------------------ SDP tuning */

// Reorder the payload types of one m= section so `wanted` come first.
function preferCodecs(sdp, kind, pickFirst) {
  const lines = sdp.split('\r\n');
  const mIdx = lines.findIndex((l) => l.startsWith(`m=${kind} `));
  if (mIdx < 0) return sdp;
  let end = lines.findIndex((l, i) => i > mIdx && l.startsWith('m='));
  if (end < 0) end = lines.length;
  const section = lines.slice(mIdx, end);
  const rtpmap = {}; const apt = {};
  for (const l of section) {
    let m = l.match(/^a=rtpmap:(\d+) ([^/]+)/);
    if (m) rtpmap[m[1]] = m[2].toLowerCase();
    m = l.match(/^a=fmtp:(\d+) .*apt=(\d+)/);
    if (m) apt[m[1]] = m[2];
  }
  const parts = lines[mIdx].split(' ');
  const pts = parts.slice(3);
  const first = pts.filter((pt) => pickFirst(rtpmap[pt], pt, rtpmap, apt));
  if (!first.length) return sdp;
  const firstSet = new Set(first);
  // keep each codec's retransmission (rtx) entry right behind it
  const rtx = pts.filter((pt) => rtpmap[pt] === 'rtx' && firstSet.has(apt[pt]));
  rtx.forEach((pt) => firstSet.add(pt));
  lines[mIdx] = parts.slice(0, 3).concat(first, rtx, pts.filter((pt) => !firstSet.has(pt))).join(' ');
  return lines.join('\r\n');
}

// Voice: send every packet with a redundant copy of the previous one (RED),
// forward error correction on, no silence-skipping, mono 64 kbps.
function voiceSdp(sdp) {
  sdp = preferCodecs(sdp, 'audio', (name) => name === 'red');
  sdp = preferCodecs(sdp, 'audio', (name) => name === 'red' || name === 'opus');
  return sdp.replace(/a=fmtp:(\d+) (.*useinbandfec=1.*)/g, (line, pt, params) => {
    const have = new Set(params.split(';').map((x) => x.split('=')[0]));
    const add = [['usedtx', '0'], ['stereo', '0'], ['maxaveragebitrate', '64000']]
      .filter(([k]) => !have.has(k)).map(([k, v]) => `${k}=${v}`);
    return add.length ? `a=fmtp:${pt} ${params};${add.join(';')}` : line;
  });
}

// Screen: prefer H.264, which most gaming PCs encode on the graphics card
// instead of the processor. Falls back to VP8/VP9 automatically.
// Start screen video at a decent bitrate instead of ramping up from blurry.
function startBitrate(sdp, kbps) {
  const lines = sdp.split('\r\n');
  const mIdx = lines.findIndex((l) => l.startsWith('m=video '));
  if (mIdx < 0) return sdp;
  let end = lines.findIndex((l, i) => i > mIdx && l.startsWith('m='));
  if (end < 0) end = lines.length;
  const pts = [];
  for (let i = mIdx; i < end; i++) {
    const m = /^a=rtpmap:(\d+) (H264|VP8|VP9|AV1)\//i.exec(lines[i]);
    if (m) pts.push(m[1]);
  }
  for (const pt of pts) {
    const f = lines.findIndex((l, i) => i > mIdx && i < end && l.startsWith(`a=fmtp:${pt} `));
    if (f >= 0) {
      if (!/x-google-start-bitrate/.test(lines[f])) lines[f] += `;x-google-start-bitrate=${kbps}`;
    } else {
      const r = lines.findIndex((l, i) => i > mIdx && i < end && l.startsWith(`a=rtpmap:${pt} `));
      lines.splice(r + 1, 0, `a=fmtp:${pt} x-google-start-bitrate=${kbps}`);
      end++;
    }
  }
  return lines.join('\r\n');
}

function screenSdp(sdp) {
  sdp = preferCodecs(sdp, 'video', (name) => name === 'h264');
  sdp = startBitrate(sdp, 1500);
  // Shared app sound is stereo music/game audio, not voice: give it room.
  const m = sdp.match(/a=rtpmap:(\d+) opus\/48000/);
  if (m) {
    sdp = sdp.replace(new RegExp(`a=fmtp:${m[1]} ([^\\r\\n]*)`), (line, params) =>
      /stereo=/.test(params) ? line : `a=fmtp:${m[1]} ${params};stereo=1;sprop-stereo=1;maxaveragebitrate=128000`);
  }
  return sdp;
}

/* ------------------------------------------------------------ shared app sound */

const appAudio = { supported: false, ctx: null, node: null, track: null, info: null };

async function startAppAudioTrack(sourceId) {
  const res = await window.gameshare.startAppAudio(sourceId);
  if (!res || !res.ok) throw new Error(res && res.error || 'unknown error');
  appAudio.info = { sound: res.mode === 'app' ? 'app' : 'system', app: res.app || null };
  if (!appAudio.ctx) {
    appAudio.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    await appAudio.ctx.audioWorklet.addModule('app-audio-worklet.js');
  }
  if (appAudio.ctx.state === 'suspended') await appAudio.ctx.resume();
  const node = new AudioWorkletNode(appAudio.ctx, 'gs-pcm-feed', { numberOfInputs: 0, outputChannelCount: [2] });
  const dest = appAudio.ctx.createMediaStreamDestination();
  node.connect(dest);
  window.gameshare.onAppAudio((chunk) => {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    const copy = bytes.slice().buffer; // own, 2-byte aligned buffer
    node.port.postMessage(copy, [copy]);
  });
  window.gameshare.onAppAudioEnded(() => {
    if (appAudio.node === node && state.screen) toast('The shared app’s sound stopped.', 'warn');
  });
  appAudio.node = node;
  appAudio.track = dest.stream.getAudioTracks()[0];
  appAudio.track.contentHint = 'music';
  return appAudio.track;
}

function stopAppAudioTrack() {
  window.gameshare.stopAppAudio();
  if (appAudio.node) { try { appAudio.node.disconnect(); } catch { /* ignore */ } appAudio.node = null; }
  if (appAudio.track) { appAudio.track.stop(); appAudio.track = null; }
}

/* ------------------------------------------------------------ who I hear */

// Voice and stream sound are controlled separately:
//  - voice: per-person mute + slider in the people list, and "Mute voices"
//  - stream: mute button + slider on the shared screen itself
function applyAudio(p) {
  p.audio.muted = state.deafened || !!p.localMuted;
  const t = tiles.get(p.id);
  if (t) {
    t.video.muted = !!p.tileSoundOff;
    t.video.volume = p.streamVolume == null ? 1 : p.streamVolume;
  }
}

function toggleLocalMute(id) {
  const p = state.peers.get(id);
  if (!p) return;
  p.localMuted = !p.localMuted;
  applyAudio(p);
  renderPeople();
}

function toggleDeafen() {
  if (document.body.dataset.view !== 'room') return;
  state.deafened = !state.deafened;
  for (const p of state.peers.values()) applyAudio(p);
  cue(state.deafened ? 'deafen' : 'undeafen');
  broadcast(myState());
  remember();
  updateControls();
  renderPeople();
  pushOverlay();
}

/* ------------------------------------------------------------ media setup */

function silentStream() {
  const dest = ctx().createMediaStreamDestination();
  return dest.stream;
}

/* ------------------------------------------------------------ microphone
 * Your chosen mic (or the system default), with background-noise removal
 * (RNNoise, in noise-worklet.js) when it's on. What's sent to friends is the
 * cleaned-up track; the device itself is released when you leave. */

const mic = { raw: null, ctx: null, ready: null, src: null, node: null, dest: null, failed: false };

async function captureRaw() {
  const useRnn = prefs.noiseRemoval !== false && !mic.failed;
  const audio = { echoCancellation: !state.headphones, noiseSuppression: !useRnn, autoGainControl: true, channelCount: 1 };
  if (prefs.micId) {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: { ...audio, deviceId: { exact: prefs.micId } }, video: false });
    } catch (e) {
      console.warn('chosen mic unavailable', e);
      toast('Your chosen microphone isn’t connected. Using the system default.', 'warn');
    }
  }
  return navigator.mediaDevices.getUserMedia({ audio, video: false });
}

async function noiseGraph(raw) {
  if (!mic.ctx) {
    mic.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    mic.ready = mic.ctx.audioWorklet.addModule('noise-worklet.js');
  }
  await mic.ready;
  if (mic.ctx.state === 'suspended') await mic.ctx.resume();
  const src = mic.ctx.createMediaStreamSource(raw);
  const node = new AudioWorkletNode(mic.ctx, 'gs-noise', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit'
  });
  node.port.onmessage = (e) => {
    if (e.data && e.data.error && !mic.failed) {
      console.warn('noise removal failed', e.data.error);
      mic.failed = true;
      toast('Background noise removal couldn’t start. Using the standard noise filter.', 'warn');
      swapMic();
    }
  };
  const dest = mic.ctx.createMediaStreamDestination();
  dest.channelCount = 1;
  src.connect(node).connect(dest);
  mic.src = src; mic.node = node; mic.dest = dest;
  return dest.stream;
}

function releaseMic() {
  try { mic.src && mic.src.disconnect(); } catch { /* ignore */ }
  try { mic.node && mic.node.disconnect(); } catch { /* ignore */ }
  if (mic.dest) mic.dest.stream.getTracks().forEach((t) => t.stop());
  if (mic.raw) mic.raw.getTracks().forEach((t) => { t.onended = null; t.stop(); });
  mic.src = mic.node = mic.dest = mic.raw = null;
}

async function getMic() {
  let raw;
  try {
    raw = await captureRaw();
  } catch (e) {
    console.warn('No microphone:', e);
    toast('No microphone found. You can listen and share, but others won’t hear you.', 'warn');
    state.micReal = false;
    return silentStream();
  }
  state.micReal = true;
  mic.raw = raw;
  const track = raw.getAudioTracks()[0];
  // Headset unplugged mid-call: carry on with the system default mic.
  if (track) track.onended = () => {
    if (document.body.dataset.view !== 'room' || mic.raw !== raw) return;
    toast('Your microphone was disconnected. Switching to the system default.', 'warn');
    swapMic({ useDefault: true });
  };
  if (prefs.noiseRemoval !== false && !mic.failed) {
    try { return await noiseGraph(raw); } catch (e) {
      console.warn('noise removal unavailable', e);
      mic.failed = true;
      // It was captured without the browser's own noise filter: capture again with it.
      raw.getTracks().forEach((t) => { t.onended = null; t.stop(); });
      return getMic();
    }
  }
  return raw;
}

// Change mic, noise removal or headphones mode mid-call, without reconnecting anyone.
let swapping = null;
async function swapMic(opts = {}) {
  if (!state.mic) return;
  if (swapping) { await swapping; }
  swapping = (async () => {
    const savedId = prefs.micId;
    if (opts.useDefault) prefs.micId = '';
    // Release the old device first: Chrome reuses an open device's processing
    // settings, so a new echo-cancellation or noise setting wouldn't take effect.
    releaseMic();
    const fresh = await getMic();
    if (opts.useDefault) prefs.micId = savedId; // remember their choice for when it's back
    fresh.getAudioTracks().forEach((t) => { t.enabled = !state.muted; });
    const track = fresh.getAudioTracks()[0];
    for (const p of state.peers.values()) {
      const pc = p.voice && p.voice.peerConnection;
      if (!pc) continue;
      for (const sender of pc.getSenders()) {
        if (!sender.track || sender.track.kind === 'audio') {
          try { await sender.replaceTrack(track); } catch (e) { console.warn('replaceTrack', e); }
        }
      }
    }
    state.mic = fresh;
    watchLevel('me', fresh);
    refreshDevices();
  })();
  try { await swapping; } finally { swapping = null; }
}

// Swap the microphone on every open call without reconnecting.
async function setHeadphones(on) {
  state.headphones = on;
  prefs.headphones = on;
  savePrefs();
  updateControls();
  if (!state.mic || !state.peer) return;
  await swapMic();
  toast(on ? 'Headphones mode on: echo cancellation off for clearer voice.' : 'Headphones mode off: echo cancellation on.');
}

/* ------------------------------------------------------------ devices
 * Settings lists your microphones and speakers/headsets. Friends' voices,
 * their stream sound and the sound effects all play on the chosen output. */

function deviceLabel(d, i, kind) {
  return d.label || (kind === 'audioinput' ? `Microphone ${i + 1}` : `Speakers ${i + 1}`);
}

async function refreshDevices() {
  let list = [];
  try { list = await navigator.mediaDevices.enumerateDevices(); } catch { return; }
  for (const [kind, selId, pref] of [['audioinput', '#micSelect', 'micId'], ['audiooutput', '#outSelect', 'outId']]) {
    const sel = $(selId);
    if (!sel) continue;
    const all = list.filter((d) => d.kind === kind);
    const sysDefault = all.find((d) => d.deviceId === 'default');
    const real = all.filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
    const opts = [el('option', null, sysDefault && sysDefault.label
      ? `System default (${sysDefault.label.replace(/^Default\s*-\s*/i, '')})` : 'System default')];
    opts[0].value = '';
    real.forEach((d, i) => { const o = el('option', null, deviceLabel(d, i, kind)); o.value = d.deviceId; opts.push(o); });
    const want = prefs[pref] || '';
    if (want && !real.some((d) => d.deviceId === want)) {
      const o = el('option', null, 'Disconnected device'); o.value = want; o.disabled = true; opts.push(o);
    }
    sel.replaceChildren(...opts);
    sel.value = want;
  }
}

async function applyOutput() {
  const id = prefs.outId || '';
  const els = [];
  for (const p of state.peers.values()) els.push(p.audio);
  for (const t of tiles.values()) if (!t.isMe) els.push(t.video);
  for (const m of els) {
    if (m && m.setSinkId && m.sinkId !== id) {
      try { await m.setSinkId(id); } catch (e) { console.warn('setSinkId', e); if (id) { try { await m.setSinkId(''); } catch { /* ignore */ } } }
    }
  }
  if (audioCtx && audioCtx.setSinkId && audioCtx.sinkId !== id) {
    try { await audioCtx.setSinkId(id); } catch (e) { console.warn('ctx setSinkId', e); }
  }
}

function sinkOne(m) {
  const id = prefs.outId || '';
  if (id && m && m.setSinkId) m.setSinkId(id).catch((e) => console.warn('setSinkId', e));
}

/* ------------------------------------------------------------ peer model */

function getPeer(id) {
  let p = state.peers.get(id);
  if (!p) {
    p = {
      id, name: 'Friend', muted: false, sharing: false, greeted: false,
      conn: null, voice: null, screenOut: null, screenIn: null,
      audio: new Audio(), volume: 1,
      view: null,      // how big this friend shows MY screen: { h, paused }
      sentView: null,  // what I last told this friend about THEIR screen
      net: null,       // { rtt, loss, relay } for the connection quality dots
      // self-healing (see heal())
      lost: 0,         // when the link broke (0 = fine)
      heardAt: 0,      // last message (pings included) on the current link
      linkAt: 0,       // when the current link opened
      dials: [], dialAt: 0, // redial attempts still in progress
      fix: {}          // per call kind: { bad, at, tries } for voice / screen repairs
    };
    p.audio.autoplay = true;
    sinkOne(p.audio);
    state.peers.set(id, p);
  }
  return p;
}

function send(p, msg) {
  if (p.conn && p.conn.open) {
    try { p.conn.send(msg); } catch (e) { console.warn('send', e); }
  }
}

function broadcast(msg) {
  for (const p of state.peers.values()) send(p, msg);
}

function myState() {
  return { type: 'state', name: state.name, muted: state.muted, sharing: !!state.screen, deafened: state.deafened, color: state.color };
}

// joining: I'm not in the room yet (the host answers with a welcome even if it
// still remembers me, e.g. after my app restarted). peers: who I'm connected
// to, so friends who missed someone while their link was down catch up.
function helloMsg(extra) {
  return { type: 'hello', name: state.name, muted: state.muted, sharing: !!state.screen, version: state.version,
           color: state.color, joinedAt: state.joinedAt, deafened: state.deafened, boot: state.boot,
           joining: document.body.dataset.view !== 'room',
           peers: [...state.peers.values()].filter((p) => p.greeted && !p.lost).map((p) => p.id), ...extra };
}

// Toast + sound the first time we learn a friend started sharing.
function noteSharing(p, sharing) {
  if (sharing && !p.announced && p.greeted && !state.leaving && document.body.dataset.view === 'room') {
    p.announced = true;
    toast(`${p.name} started sharing`, 'ok');
    cue('share');
    attention();
  }
  if (!sharing) p.announced = false;
  p.sharing = sharing;
}

function removePeer(id, reason) {
  const p = state.peers.get(id);
  if (!p) return;
  state.peers.delete(id);
  for (const c of [p.voice, p.screenOut, p.screenIn, p.conn, ...p.dials]) { try { c && c.close(); } catch { /* ignore */ } }
  p.dials = [];
  p.audio.srcObject = null;
  unwatchLevel(id);
  removeTile(id);
  if (p.greeted && !state.leaving) {
    toast(`${p.name} ${reason || 'left'}`);
    if (!p.lost) cue('leave'); // a lost friend already had their sound
  }
  renderPeople();
  // Whoever held the room ID is gone: keep the room joinable.
  if (!state.leaving && !p.doorman && (id === roomId() || id === state.doormanOwner)) {
    if (id === state.doormanOwner) state.doormanOwner = null;
    keepRoomOpen();
  }
}

/* ------------------------------------------------------------ connections */

const dialing = new Map(); // peer id -> link I'm opening to someone new
const missing = new Map(); // peer id -> when a friend first mentioned them and I wasn't connected

function connectTo(id) {
  if (!state.peer || id === state.peer.id || state.peers.has(id)) return;
  const pending = dialing.get(id);
  if (pending && performance.now() - pending.gsAt < 10000) return; // already on its way
  const conn = state.peer.connect(id, { reliable: true, metadata: { name: state.name, boot: state.boot } });
  if (!conn) return; // not connected to the server right now
  dialing.set(id, conn);
  wireConn(conn, true);
}

// Who opened a link. Both ends agree on it, so they can agree which of two
// links to keep when both redialed at the same moment.
const dialerOf = (c) => (c.gsOut ? state.peer.id : c.peer);

function wireConn(conn, outgoing) {
  conn.gsAt = performance.now();
  conn.gsOut = outgoing;
  conn.on('open', () => {
    if (dialing.get(conn.peer) === conn) dialing.delete(conn.peer);
    // Left meanwhile, or gave up on this friend while redialing.
    if (state.leaving || !state.peer || (conn.gsRedial && !state.peers.has(conn.peer))) {
      try { conn.close(); } catch { /* ignore */ }
      return;
    }
    const p = getPeer(conn.peer);
    const old = p.conn;
    // A link from a friend whose app restarted: their old link is dead even if
    // it doesn't look it yet.
    const meta = conn.metadata || {};
    const restarted = !outgoing && typeof meta.boot === 'string' && !!p.boot && meta.boot !== p.boot;
    if (old && old !== conn) {
      if (!p.lost && !restarted && old.open && health(old) === 'up' && dialerOf(old) < dialerOf(conn)) {
        try { conn.close(); } catch { /* ignore */ }
        return;
      }
      p.conn = conn; // first, so the old link's 'close' is ignored
      try { old.close(); } catch { /* ignore */ }
    }
    p.conn = conn;
    p.outgoing = outgoing;
    p.linkAt = performance.now();
    dropDials(p, conn);
    if (p.lost) linkBack(p);
    send(p, helloMsg());
    // The room ID may be a doorman (not a person): call it only once it says hello.
    if (outgoing && (conn.peer !== roomId() || p.greeted) && !callOk(p.voice)) placeVoiceCall(p);
  });
  conn.on('data', (msg) => onMessage(conn, msg));
  conn.on('close', () => {
    const p = state.peers.get(conn.peer);
    if (p && p.conn === conn) linkLost(p);
  });
  conn.on('error', (e) => console.warn('conn error', conn.peer, e));
}

/* ------------------------------------------------------------ self-healing
 * Wi-Fi blips, a laptop switching networks or a router hiccup break links
 * without anyone leaving. Instead of dropping the friend, they stay in the
 * room as "Reconnecting…" while both sides redial (the smaller ID first).
 * Once the link is back, voice and screen calls that died with it are placed
 * again. Only a 'bye' (or GRACE_MS without success) removes someone. */

const heals = (p) => !!p.version && !versionLess(p.version, HEAL_VERSION);

// How a link or call is doing: 'up', 'wait' (still connecting), 'shaky'
// (nothing heard for a few seconds) or 'down'.
function health(c) {
  const pc = c && c.peerConnection;
  if (!pc || (c.type === 'data' && !c.open)) return 'down';
  switch (pc.connectionState) {
    case 'connected': return 'up';
    case 'disconnected': return 'shaky';
    case 'failed': case 'closed': return 'down';
    // Still connecting: an answered call can take a while on a busy PC.
    default: return performance.now() - (c.gsAt || 0) < (pc.remoteDescription ? 60000 : 20000) ? 'wait' : 'down';
  }
}
const callOk = (c) => { const h = health(c); return h === 'up' || h === 'wait'; };

function linkLost(p) {
  if (state.leaving || p.lost || !state.peers.has(p.id)) return;
  // Said goodbye, never finished saying hello, or too old to reconnect: gone.
  if (p.bye || !p.greeted || !heals(p)) { removePeer(p.id); return; }
  log(`lost the link to ${p.name}`);
  p.lost = performance.now();
  p.dialAt = 0;
  // The old link stays open: if it was only a stall (a swamped PC), it comes
  // back by itself and nothing has to be redone. A redial that gets through
  // first replaces it.
  setStalled(p.id, true);
  linkNews(p, false);
  renderPeople();
  heal();
}

function linkBack(p) {
  log(`${p.name} is back after ${Math.round(performance.now() - p.lost)} ms`);
  p.lost = 0;
  p.urgent = false;
  p.sentView = null; // tell them again how big I show their screen
  for (const f of Object.values(p.fix)) { f.tries = 0; f.at = 0; }
  linkNews(p, true);
  reportViews();
  renderPeople();
}

// One toast for everyone who dropped (or came back) at about the same moment.
// Someone who drops and comes back before it shows gets no toast at all.
const news = { lost: new Map(), back: new Map(), timer: null };
function linkNews(p, back) {
  if (back) { if (!news.lost.delete(p.id)) news.back.set(p.id, p.name); }
  else { news.back.delete(p.id); news.lost.set(p.id, p.name); }
  clearTimeout(news.timer);
  news.timer = setTimeout(() => {
    const who = (m) => (m.size <= 2 ? [...m.values()].join(' and ') : `${m.size} friends`);
    const friends = [...state.peers.values()].filter((q) => q.greeted);
    if (news.lost.size && !state.leaving) {
      const mine = (state.peer && state.peer.disconnected) || (friends.length > 1 && friends.every((q) => q.lost));
      toast(mine ? 'Your connection dropped. Reconnecting…' : `Lost the connection to ${who(news.lost)}. Reconnecting…`, 'warn');
      cue('leave');
    }
    if (news.back.size && !state.leaving) {
      toast(`${who(news.back)} ${news.back.size === 1 ? 'is' : 'are'} back`, 'ok');
      cue('join');
    }
    news.lost.clear();
    news.back.clear();
  }, 600);
}

function redial(p, now) {
  if (!state.peer || !state.peer.open) return; // my own server link is down: wait for it
  // The smaller ID dials, after a few seconds in which the old link often
  // comes back by itself (short dropouts, a swamped PC); the other one joins
  // in later, in case the first hasn't noticed. Right away when the network
  // is known to have changed (the old link can't come back then).
  if (!p.urgent && now - p.lost < (state.peer.id < p.id ? 8000 : 12000)) return;
  if (now - p.dialAt < REDIAL_MS) return;
  // Attempts the friend answered are left alone however long they take (a
  // busy PC can need a while to finish connecting); unanswered ones are
  // retried every few seconds, at most two at once.
  p.dials = p.dials.filter((d) => {
    const st = dialState(d), age = now - d.gsAt;
    if (st === 'dead' || (st === 'unanswered' && age > 8000) || age > 30000) { try { d.close(); } catch { /* ignore */ } return false; }
    return true;
  });
  if (p.dials.some((d) => dialState(d) === 'answered') || p.dials.length >= 2) return;
  const c = state.peer.connect(p.id, { reliable: true, metadata: { name: state.name, boot: state.boot } });
  if (!c) return;
  p.dialAt = now;
  p.dials.push(c);
  c.gsRedial = true;
  wireConn(c, true);
}

function dialState(d) {
  const pc = d.peerConnection;
  if (!pc || pc.connectionState === 'failed' || pc.connectionState === 'closed') return 'dead';
  return pc.remoteDescription ? 'answered' : 'unanswered';
}

// Stop redial attempts (all of them, or all but the one that got through).
function dropDials(p, keep) {
  for (const c of p.dials) if (c !== keep) { try { c.close(); } catch { /* ignore */ } }
  p.dials = [];
}

// The connection to the matchmaking server can be dead without knowing it:
// after the network changes, the old one can hang for minutes, and every
// redial sent through it is lost. Open a fresh one (the 'disconnected'
// handlers reconnect with the same ID).
let freshAt = 0;
function freshSignal(why) {
  const now = performance.now();
  if (now - freshAt < 8000 || state.leaving) return;
  freshAt = now;
  log(`new connection to the server (${why})`);
  for (const pr of [state.peer, state.doorman]) {
    if (pr && !pr.destroyed && !pr.disconnected) { try { pr.disconnect(); } catch { /* ignore */ } }
  }
}
window.addEventListener('online', () => { if (document.body.dataset.view === 'room') freshSignal('network changed'); });

// Back on the server: redials sent through the old connection may be lost,
// so start them over right away.
function signalBack() {
  for (const p of state.peers.values()) {
    if (!p.lost) continue;
    dropDials(p);
    p.dialAt = 0;
    p.urgent = true;
  }
  updateNetBadge();
  heal();
}

// A call that died while the link is fine: place it again, backing off if
// it keeps failing.
function repair(p, kind, call, redo, now) {
  const f = p.fix[kind] || (p.fix[kind] = { bad: 0, at: 0, tries: 0 });
  const h = health(call);
  if (h === 'up') { f.bad = 0; f.tries = 0; return; }
  if (h === 'wait') { f.bad = 0; return; }
  if (!f.bad) f.bad = now;
  if (h === 'shaky' && now - f.bad < SHAKY_MS) return; // may still recover by itself
  if (now - f.at < Math.min(30000, 3000 * 2 ** f.tries)) return;
  log(`placing the ${kind} call to ${p.name} again`);
  f.at = now;
  f.tries++;
  f.bad = 0;
  redo();
}

// A friend's screen that froze (link or call broken) shows "Reconnecting…".
// If no new stream comes within a while, the tile goes away.
function setStalled(id, on) {
  const t = tiles.get(id);
  if (!t || t.isMe || !!t.stalled === on) return;
  t.stalled = on;
  t.stallAt = on ? performance.now() : 0;
  t.tile.classList.toggle('stalled', on);
}

function syncStall(p, now) {
  const t = tiles.get(p.id);
  if (!t) return;
  const h = health(p.screenIn);
  setStalled(p.id, !!p.lost || t.call !== p.screenIn || h === 'shaky' || h === 'down');
  if (t.stalled && !p.lost && !callOk(p.screenIn) && now - t.stallAt > 15000) removeTile(p.id);
}

// Once a second while in a room.
let healTimer = null, healAt = 0, calmUntil = 0;
function heal() {
  if (!state.peer || state.leaving || document.body.dataset.view !== 'room') return;
  const now = performance.now();
  // If this page itself was frozen for a moment, the PC is swamped (a heavy
  // game, say): friends' pings are still queued and theirs may be late too.
  // Healing would only add load, so hold off on judging links and redoing
  // calls for a while.
  if (healAt && now - healAt > 2500) {
    if (now >= calmUntil) log(`this PC is very busy (the page froze for ${Math.round(now - healAt)} ms): going easy on reconnects`);
    calmUntil = now + 30000;
  }
  healAt = now;
  const late = now < calmUntil;
  for (const p of [...state.peers.values()]) {
    if (!p.greeted) continue;
    if (p.lost) {
      if (now - p.lost > GRACE_MS) { removePeer(p.id, 'lost connection'); continue; }
      send(p, { type: 'ping' }); // on the old link, in case it comes back by itself
      redial(p, now);
    } else if (heals(p)) {
      // The browser can take half a minute to notice a dead link (or never,
      // when only packets stop), so friends ping each other and go by that.
      if (health(p.conn) === 'down') { linkLost(p); continue; }
      const quiet = now - Math.max(p.heardAt, p.linkAt);
      if (!late && quiet > QUIET_MS) checkQuiet(p, quiet);
      send(p, { type: 'ping' });
    }
    // Calls get a few seconds to set up on a new link before they're checked.
    if (!p.lost && !late && now - p.linkAt > 6000) {
      if (p.outgoing) repair(p, 'voice', p.voice, () => placeVoiceCall(p), now);
      if (state.screen && !p.unwatched) repair(p, 'screen', p.screenOut, () => sendScreenTo(p), now);
    }
    syncStall(p, now);
  }
  // Friends mention someone I'm still not connected to after a while: dial them.
  for (const [id, at] of missing) {
    if (state.peers.has(id)) missing.delete(id);
    else if (now - at > 20000) { missing.delete(id); connectTo(id); } // a normal join is done long before
  }
  // Nobody reachable for a while: the problem is probably on my side, and
  // my server connection may be one of the dead things.
  const friends = [...state.peers.values()].filter((p) => p.greeted);
  if (friends.length && friends.every((p) => p.lost && now - p.lost > 8000)) freshSignal('no friends reachable');
  updateNetBadge();
}

// A friend went quiet. Before calling the link lost, ask the network layer
// (which keeps running when the page itself is busy): if packets still
// arrived in the last few seconds, the network is fine and their app (or
// mine) is just swamped by a heavy game, so give it longer.
async function checkQuiet(p, quiet) {
  const c = p.conn;
  if (p.checking || !c || !c.peerConnection) return;
  p.checking = true;
  let alive = false;
  try {
    const st = await c.peerConnection.getStats();
    let pairId = null;
    st.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId; });
    const pair = pairId && st.get(pairId);
    if (pair && pair.lastPacketReceivedTimestamp) alive = pair.timestamp - pair.lastPacketReceivedTimestamp < 5000;
  } catch { /* closed meanwhile */ }
  p.checking = false;
  if (p.conn !== c || p.lost || !state.peers.has(p.id)) return;
  if (!alive || quiet > QUIET_HARD_MS) linkLost(p);
}

// A friend's app restarted (it recovered from a crash): what it had asked of
// me went with it, and calls from before the restart are dead.
function freshStart(p) {
  p.unwatched = false;
  p.view = null;
  p.sentView = null;
  p.encSig = null;
  for (const k of ['voice', 'screenOut', 'screenIn']) {
    const c = p[k];
    if (!c || c.gsAt >= p.linkAt) continue;
    p[k] = null;
    try { c.close(); } catch { /* ignore */ }
    if (k === 'voice') { p.audio.srcObject = null; unwatchLevel(p.id); }
  }
  if (!p.screenIn) removeTile(p.id);
}

function onMessage(conn, msg) {
  if (!msg || typeof msg !== 'object' || state.leaving) return;
  // Data can arrive a moment before our own 'open' event fires on this
  // side, so register the peer here too instead of dropping the message.
  const p = getPeer(conn.peer);
  if (!p.conn) p.conn = conn;
  if (conn === p.conn) {
    p.heardAt = performance.now();
    if (p.lost) { dropDials(p); linkBack(p); } // the old link came back by itself
  }

  switch (msg.type) {
    case 'ping': break; // "still here" (see heal())
    case 'hello': {
      const joined = !p.greeted;
      const restarted = !!p.boot && typeof msg.boot === 'string' && msg.boot !== p.boot;
      if (typeof msg.boot === 'string') p.boot = msg.boot.slice(0, 16);
      p.name = String(msg.name || 'Friend').slice(0, 24);
      p.muted = !!msg.muted;
      p.greeted = true;
      if (joined) p.announced = !!msg.sharing; // already sharing when we met: no "started" alert
      noteSharing(p, !!msg.sharing);
      p.version = typeof msg.version === 'string' ? msg.version : '';
      p.color = Number.isInteger(msg.color) && msg.color >= 0 && msg.color < PLAYER_COLORS.length ? msg.color : null;
      p.joinedAt = Number(msg.joinedAt) || 0;
      p.deafened = !!msg.deafened;
      if (restarted) freshStart(p);
      // Their share ended while we couldn't hear about it.
      if (!p.sharing) {
        p.hidden = false;
        if (p.screenIn || tiles.has(p.id)) {
          const c = p.screenIn;
          p.screenIn = null;
          try { c && c.close(); } catch { /* ignore */ }
          removeTile(p.id);
        }
      }
      // Answer every first-hand hello so a hello lost at connect time heals itself.
      if (!msg.reply) send(p, helloMsg({ reply: true }));
      if (p.outgoing && !callOk(p.voice)) placeVoiceCall(p);

      // Welcome newcomers, and friends coming back after their app restarted.
      if (state.isHost && (joined || msg.joining)) {
        if (joined && greetedCount() > state.maxPeople) {
          send(p, { type: 'full', max: state.maxPeople });
          p.greeted = false; // never shown as having joined
          setTimeout(() => removePeer(p.id), 3000); // time for the message to arrive
          return;
        }
        const others = [...state.peers.values()].filter((q) => q.id !== p.id && q.greeted && !q.lost).map((q) => q.id);
        send(p, { type: 'welcome', peers: others, name: state.name, muted: state.muted, sharing: !!state.screen,
                  maxPeople: state.maxPeople, colors: colorsMap(), color: state.color, joinedAt: state.joinedAt });
      }
      checkColorClash();
      if (state.doorman && (joined || restarted)) send(p, { type: 'doorman' });
      // (Right after my app restarted, everyone "joins" again: no toasts for that.)
      if (joined && !state.leaving && !p.outgoing && document.body.dataset.view === 'room' && performance.now() > state.quietUntil) {
        toast(`${p.name} joined`, 'ok');
        cue('join');
        attention();
      }
      // My screen: to someone new, or again if their copy died with a broken link.
      if (state.screen && !p.unwatched && !callOk(p.screenOut)) sendScreenTo(p);
      // Note anyone they're connected to and I'm not (someone who joined while
      // my link was down, for example); heal() dials them if that lasts.
      if (document.body.dataset.view === 'room' && Array.isArray(msg.peers)) {
        const now = performance.now();
        for (const id of msg.peers.slice(0, MAX_LIMIT)) {
          if (typeof id === 'string' && id !== state.peer.id && !state.peers.has(id) && !missing.has(id)) missing.set(id, now);
        }
      }
      renderPeople();
      break;
    }
    // Leaving on purpose (not a broken link): gone right away.
    case 'bye': {
      p.bye = true;
      removePeer(p.id);
      break;
    }
    case 'welcome': {
      clearTimeout(state.joinTimer);
      const list = Array.isArray(msg.peers) ? msg.peers.filter((id) => typeof id === 'string') : [];
      if (msg.doorman) {
        // The room ID is held by a doorman, not a person: forget that link
        // and connect to the people it listed.
        p.doorman = true;
        state.peers.delete(p.id);
        try { conn.close(); } catch { /* ignore */ }
        if (typeof msg.owner === 'string') state.doormanOwner = msg.owner;
      } else if (!p.greeted) {
        p.name = String(msg.name || 'Friend').slice(0, 24);
        p.muted = !!msg.muted;
        p.greeted = true;
        p.announced = !!msg.sharing;
        if (Number.isInteger(msg.color)) p.color = msg.color;
        if (msg.joinedAt) p.joinedAt = Number(msg.joinedAt) || 0;
        noteSharing(p, !!msg.sharing);
        if (p.outgoing && !p.voice) placeVoiceCall(p);
      }
      if (document.body.dataset.view !== 'room') {
        // Room size and colours come from whoever holds the room (older hosts: 4 players).
        state.maxPeople = clamp(Number(msg.maxPeople) || 4, MIN_SIZE, MAX_LIMIT);
        const colors = msg.colors && typeof msg.colors === 'object' ? msg.colors : {};
        const taken = new Set(Object.entries(colors).filter(([id, c]) => id !== state.peer.id && Number.isInteger(c)).map(([, c]) => c));
        for (const q of state.peers.values()) if (Number.isInteger(q.color)) taken.add(q.color);
        // Back after a restart: keep my colour if nobody took it meanwhile.
        setMyColor(Number.isInteger(state.color) && !taken.has(state.color) ? state.color : firstFreeColor(taken));
        enterRoom();
        broadcast(myState()); // my hello went out before I had a colour
      }
      for (const id of list) connectTo(id);
      renderPeople();
      break;
    }
    case 'full': {
      const max = clamp(Number(msg.max) || 4, MIN_SIZE, MAX_LIMIT);
      if (document.body.dataset.view === 'room') {
        // Never kick someone who is really inside. But someone who was cut off
        // for a long time and is connected to nobody else is outside: say so
        // instead of knocking forever.
        const inside = [...state.peers.values()].some((q) => q !== p && q.greeted && !q.lost);
        if (inside || p.id !== roomId()) break;
        const code = state.code;
        leave(true);
        lobbyStatus(`You were disconnected and room ${code} filled up meanwhile (${max} players).`, 'err');
        break;
      }
      clearTimeout(state.joinTimer);
      leave(true);
      lobbyStatus(`That room is full (${max} players). Ask the host to make it bigger in Settings.`, 'err');
      break;
    }
    case 'state': {
      p.name = String(msg.name || p.name).slice(0, 24);
      p.muted = !!msg.muted;
      p.deafened = !!msg.deafened;
      if (Number.isInteger(msg.color) && msg.color >= 0 && msg.color < PLAYER_COLORS.length) p.color = msg.color;
      noteSharing(p, !!msg.sharing);
      if (!p.sharing) p.hidden = false;
      checkColorClash();
      renderPeople();
      break;
    }
    // The host changed how many players fit in the room.
    case 'room-size': {
      const n = clamp(Number(msg.max) || state.maxPeople, MIN_SIZE, MAX_LIMIT);
      if (n !== state.maxPeople) {
        state.maxPeople = n;
        if (prefs.lastRoom && prefs.lastRoom.code === state.code) { prefs.lastRoom.size = n; savePrefs(); }
        toast(`Room size is now ${n} players`);
        renderPeople();
      }
      break;
    }
    case 'screen-stop': {
      noteSharing(p, false);
      p.hidden = false;
      if (p.screenIn) { const c = p.screenIn; p.screenIn = null; try { c.close(); } catch { /* ignore */ } }
      removeTile(p.id);
      renderPeople();
      break;
    }
    // A friend closed / reopened my screen on their side.
    case 'unwatch': {
      p.unwatched = true;
      if (p.screenOut) { const c = p.screenOut; p.screenOut = null; try { c.close(); } catch { /* ignore */ } }
      break;
    }
    case 'watch': {
      p.unwatched = false;
      if (state.screen && !p.screenOut) sendScreenTo(p);
      break;
    }
    // How big this friend is showing my screen (or that they minimized).
    case 'view': {
      p.view = { h: clamp(Number(msg.h) || 0, 0, 4320), paused: !!msg.paused };
      retuneAll();
      break;
    }
    // This friend now holds the room ID for newcomers.
    case 'doorman': {
      state.doormanOwner = p.id;
      clearTimeout(state.claim);
      state.claim = null;
      renderPeople();
      break;
    }
  }
}

/* ------------------------------------------------------------ keeping the room open
 * When the room ID's holder leaves, the remaining people take turns trying
 * to register it (in a fixed order, so normally the first one simply wins).
 * If someone outside our group took it (for example the creator came back
 * and re-created the room), we connect to them instead, merging both groups. */

function keepRoomOpen(attempt = 0) {
  clearTimeout(state.claim);
  state.claim = null;
  if (state.leaving || !state.peer || state.isHost || state.doorman || !state.code) return;
  if (state.doormanOwner && state.peers.has(state.doormanOwner)) return;
  const holder = state.peers.get(roomId());
  if (holder && holder.greeted) return;
  if (attempt > 50) return; // ~5 minutes: give up quietly

  const order = [state.peer.id, ...[...state.peers.values()].filter((p) => p.greeted).map((p) => p.id)].sort();
  const delay = attempt === 0 ? 800 + order.indexOf(state.peer.id) * 2500 : 6000;
  state.claim = setTimeout(async () => {
    state.claim = null;
    if (state.leaving || state.doorman || (state.doormanOwner && state.peers.has(state.doormanOwner))) return;
    try {
      const d = await createPeer(roomId());
      if (state.leaving || state.doorman || !state.peer) { d.destroy(); return; }
      state.doorman = d;
      state.doormanOwner = null;
      wireDoorman(d);
      broadcast({ type: 'doorman' });
      renderPeople();
    } catch (e) {
      // Taken: either a friend just claimed it (their message is on its way),
      // someone re-created the room (join them), or the old holder's ID hasn't
      // been released yet (keep trying).
      if (e && e.type === 'unavailable-id' && !state.doormanOwner) connectTo(roomId());
      keepRoomOpen(attempt + 1);
    }
  }, delay);
}

function wireDoorman(d) {
  d.on('connection', (conn) => {
    conn.on('data', (msg) => {
      if (!msg || msg.type !== 'hello') return;
      const members = [...state.peers.values()].filter((p) => p.greeted).map((p) => p.id);
      const isMember = members.includes(conn.peer);
      if (!isMember && members.length + 1 >= state.maxPeople) {
        conn.send({ type: 'full', max: state.maxPeople });
      } else {
        conn.send({ type: 'welcome', doorman: true, owner: state.peer.id, peers: [state.peer.id, ...members.filter((id) => id !== conn.peer)],
                    maxPeople: state.maxPeople, colors: colorsMap() });
      }
      setTimeout(() => { try { conn.close(); } catch { /* ignore */ } }, 3000);
    });
  });
  d.on('call', (call) => call.close());
  d.on('disconnected', () => { if (!d.destroyed && state.doorman === d) setTimeout(() => { if (!d.destroyed && d.disconnected) d.reconnect(); }, 2000); });
  d.on('error', (e) => console.warn('doorman', e.type));
}

/* ------------------------------------------------------------ calls */

// Video and the stream's sound share one target so they stay in sync.
function applyScreenBuffer(p) {
  const pc = p.screenIn && p.screenIn.peerConnection;
  if (!pc) return;
  for (const r of pc.getReceivers()) {
    if (r.track && 'jitterBufferTarget' in r) {
      try { r.jitterBufferTarget = p.screenBuffer || SCREEN_BUFFER_MS; } catch { /* ignore */ }
    }
  }
}

// Every few seconds: if a friend's screen froze, give it a bigger cushion;
// after a calm half-minute, shrink it back toward the default.
async function adaptScreenBuffers() {
  for (const p of state.peers.values()) {
    const pc = p.screenIn && p.screenIn.peerConnection;
    if (!pc || pc.connectionState !== 'connected') continue;
    let freezes = null;
    try {
      (await pc.getStats()).forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'video') freezes = r.freezeCount || 0; });
    } catch { continue; }
    if (freezes == null) continue;
    const now = performance.now();
    if (p.freezePrev == null) { p.freezePrev = freezes; p.calmSince = now; continue; }
    const before = p.screenBuffer || SCREEN_BUFFER_MS;
    if (freezes > p.freezePrev) {
      p.screenBuffer = Math.min(SCREEN_BUFFER_MAX, before + 100);
      p.calmSince = now;
    } else if (now - p.calmSince > 30000 && before > SCREEN_BUFFER_MS) {
      p.screenBuffer = Math.max(SCREEN_BUFFER_MS, before - 50);
      p.calmSince = now;
    }
    p.freezePrev = freezes;
    if (p.screenBuffer !== before) applyScreenBuffer(p);
  }
}

function placeVoiceCall(p) {
  if (!state.peer || state.peer.disconnected) return; // can't call without the server; heal() retries
  if (p.voice) { try { p.voice.close(); } catch { /* ignore */ } }
  const call = state.peer.call(p.id, state.mic, { metadata: { kind: 'voice' }, sdpTransform: voiceSdp });
  if (!call) return;
  call.gsAt = performance.now();
  call.gsOut = true;
  p.voice = call;
  wireVoice(p, call);
}

function wireVoice(p, call) {
  call.on('stream', (remote) => {
    if (p.voice !== call) return;
    p.audio.srcObject = remote;
    p.audio.volume = p.volume;
    applyAudio(p);
    p.audio.play().catch(() => {});
    watchLevel(p.id, remote);
  });
  call.on('close', () => { if (p.voice === call) { p.voice = null; p.audio.srcObject = null; unwatchLevel(p.id); } });
  call.on('error', (e) => console.warn('voice error', e));
  watchIce(call);
  const pc = call.peerConnection;
  if (pc) {
    const tune = async () => {
      // Voice goes out first when the connection is busy...
      for (const sender of pc.getSenders()) {
        if (!sender.track || sender.track.kind !== 'audio') continue;
        const params = sender.getParameters();
        if (!params.encodings || !params.encodings.length) params.encodings = [{}];
        params.encodings[0].priority = 'high';
        params.encodings[0].networkPriority = 'high';
        params.encodings[0].maxBitrate = 64000;
        try { await sender.setParameters(params); } catch (e) { console.warn('voice params', e); }
      }
      // ...and a slightly deeper buffer on arrival smooths out bursty delivery.
      for (const r of pc.getReceivers()) {
        if (r.track && r.track.kind === 'audio' && 'jitterBufferTarget' in r) r.jitterBufferTarget = 80;
      }
    };
    pc.addEventListener('connectionstatechange', () => { if (pc.connectionState === 'connected') tune(); });
    if (pc.connectionState === 'connected') tune();
  }
}

function onIncomingCall(call) {
  const kind = call.metadata && call.metadata.kind;
  const p = getPeer(call.peer);

  call.gsAt = performance.now();
  if (kind === 'voice') {
    // We both called at the same moment (we both redialed): keep the call
    // placed by the smaller ID, on both sides, or each would hang up its own
    // call and answer the other's, and both would die.
    if (p.voice && p.voice.gsOut && health(p.voice) === 'wait' && state.peer.id < p.id) {
      try { call.close(); } catch { /* ignore */ }
      return;
    }
    if (p.voice) { try { p.voice.close(); } catch { /* ignore */ } }
    p.voice = call;
    call.answer(state.mic, { sdpTransform: voiceSdp });
    wireVoice(p, call);
  } else if (kind === 'screen') {
    if (p.hidden) { send(p, { type: 'unwatch' }); call.close(); return; }
    if (p.screenIn) { const old = p.screenIn; p.screenIn = null; try { old.close(); } catch { /* ignore */ } }
    p.screenIn = call;
    p.sharing = true; // a screen arriving means they're sharing (their hello may still be on its way)
    p.sentView = null; // tell this sharer our size again for the new share
    call.answer(undefined, { sdpTransform: screenSdp }); // receive only
    const snd = call.metadata && call.metadata.sound;
    p.screenSound = snd && typeof snd === 'object'
      ? { sound: String(snd.sound || 'none'), app: snd.app ? String(snd.app).slice(0, 60) : null }
      : null; // null = friend runs an older GameShare that doesn't say
    p.screenBuffer = SCREEN_BUFFER_MS;
    p.freezePrev = null;
    call.on('stream', (remote) => {
      if (p.screenIn !== call) return;
      applyScreenBuffer(p);
      noteSharing(p, true);
      // If a track shows up later, rebuild the tile so its sound controls appear.
      remote.onaddtrack = () => { if (p.screenIn === call) addTile(p.id, remote, false); };
      addTile(p.id, remote, false);
      renderPeople();
    });
    call.on('close', () => {
      if (p.screenIn !== call) return;
      p.screenIn = null;
      // Still sharing as far as we know: the call broke, a new one is coming.
      // Keep the picture (marked "Reconnecting…") instead of a gap in the layout.
      if (p.sharing && !p.hidden && state.peers.get(p.id) === p) setStalled(p.id, true);
      else removeTile(p.id);
    });
    call.on('error', (e) => console.warn('screen error', e));
  } else {
    call.close();
  }
}

// A call that never got through at all usually means a network blocking
// direct connections. (One that worked and then broke is healed instead.)
function watchIce(call) {
  const pc = call.peerConnection;
  if (!pc) return;
  let worked = false;
  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'connected') worked = true;
    if (pc.connectionState === 'failed' && !worked && !state.leaving) {
      toast('Couldn’t reach a friend directly — their network may be blocking it.', 'warn');
    }
    updateNetBadge();
  });
}

function sendScreenTo(p) {
  if (!state.screen || !state.peer || state.peer.disconnected) return;
  if (p.screenOut) { const old = p.screenOut; p.screenOut = null; try { old.close(); } catch { /* ignore */ } }
  const call = state.peer.call(p.id, state.screen, { metadata: { kind: 'screen', sound: state.screenSound }, sdpTransform: screenSdp });
  if (!call) return;
  call.gsAt = performance.now();
  p.screenOut = call;
  const pc = call.peerConnection;
  if (pc) {
    pc.addEventListener('connectionstatechange', () => { if (pc.connectionState === 'connected') retuneAll(); });
  }
  call.on('close', () => { if (p.screenOut === call) { p.screenOut = null; p.encSig = null; retuneAll(); } });
  call.on('error', (e) => console.warn('screen out error', e));
}

// Encoder settings for one viewer: quality preset, scaled down to the size
// they're actually showing it at, a fair slice of the upload budget, or
// paused while they're minimized. Only touches the encoder when something
// actually changed (every change can cause a tiny hiccup).
async function tuneSenders(pc, p) {
  const q = QUALITY[state.quality];
  const v = p && p.view;
  const track = state.screen && state.screen.getVideoTracks()[0];
  const srcH = (track && track.getSettings().height) || q.h;
  const watching = [...state.peers.values()].filter((x) => x.screenOut && !x.lost && !(x.view && x.view.paused)).length;
  // Until a viewer says how big they show it, a room with several viewers starts at 720p.
  const scale = v && v.h ? Math.max(1, srcH / v.h) : (watching > 2 ? Math.max(1, srcH / 720) : 1);
  const slice = (q.bitrate * UPLOAD_BUDGET) / Math.max(1, watching);
  const active = !(v && v.paused);
  const want = {
    active,
    scale: Math.round(scale * 100) / 100,
    bitrate: Math.round(Math.max(MIN_VIEWER_BITRATE, Math.min(q.bitrate / Math.pow(scale, 1.5), slice))),
    fps: q.fps
  };
  const sig = JSON.stringify(want);
  if (p && p.encSig === sig && p.encPc === pc) return;
  if (p) { p.encSig = sig; p.encPc = pc; }
  for (const sender of pc.getSenders()) {
    if (!sender.track || sender.track.kind !== 'video') continue;
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    params.degradationPreference = 'maintain-framerate';
    const enc = params.encodings[0];
    enc.active = want.active;
    enc.scaleResolutionDownBy = want.scale;
    enc.maxBitrate = want.bitrate;
    enc.maxFramerate = want.fps;
    enc.priority = 'low';
    enc.networkPriority = 'low';
    try { await sender.setParameters(params); } catch (e) { console.warn('setParameters', e); if (p) p.encSig = null; }
  }
}

// Someone started/stopped watching: everyone's slice of the budget changes.
function retuneAll() {
  for (const p of state.peers.values()) {
    const pc = p.screenOut && p.screenOut.peerConnection;
    if (pc && pc.connectionState === 'connected') tuneSenders(pc, p);
  }
}

/* ------------------------------------------------------------ screen share */

async function startShare() {
  const pick = await openPicker();
  if (!pick) return;

  await window.gameshare.chooseSource(pick.id);
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch (e) {
    console.warn('getDisplayMedia', e);
    toast('Couldn’t capture that. On a Mac, allow GameShare under System Settings › Privacy › Screen Recording.', 'err');
    return;
  }

  const track = stream.getVideoTracks()[0];
  if (!track) { stream.getTracks().forEach((t) => t.stop()); return; }
  await applyCaptureQuality(track);
  track.addEventListener('ended', stopShare);

  state.screenSound = { sound: 'none' };
  if (pick.audio) {
    try {
      stream.addTrack(await startAppAudioTrack(pick.id));
      state.screenSound = appAudio.info;
    } catch (e) {
      console.warn('app audio', e);
      stopAppAudioTrack();
      toast(`Sharing without sound: ${e.message}.`, 'warn');
    }
  }

  state.screen = stream;
  addTile('me', stream, true);
  state.previewHidden = false;
  // (friends who are reconnecting get it once they're back)
  for (const p of state.peers.values()) { p.unwatched = false; if (p.greeted && !p.lost) sendScreenTo(p); }
  broadcast(myState());
  updateControls();
  renderPeople();
}

async function applyCaptureQuality(track) {
  const q = QUALITY[state.quality];
  track.contentHint = 'motion';
  try {
    await track.applyConstraints({
      width: { ideal: q.w, max: q.w },
      height: { ideal: q.h, max: q.h },
      frameRate: { ideal: q.fps, max: q.fps }
    });
  } catch (e) { console.warn('applyConstraints', e); }
}

function stopShare() {
  if (!state.screen) return;
  stopAppAudioTrack();
  state.screen.getTracks().forEach((t) => t.stop());
  state.screen = null;
  state.previewHidden = false;
  for (const p of state.peers.values()) {
    p.unwatched = false;
    const c = p.screenOut;
    p.screenOut = null;
    try { c && c.close(); } catch { /* ignore */ }
  }
  broadcast({ type: 'screen-stop' });
  broadcast(myState());
  removeTile('me');
  updateControls();
  renderPeople();
}

/* ------------------------------------------------------------ picker */

let pickerResolve = null;
let pickerSources = [];
let pickerKind = 'window';
let pickerSelected = null;
let thumbRound = 0;

async function openPicker() {
  const modal = $('#picker');
  $('#audioOpt').classList.toggle('hidden', !appAudio.supported);
  $('#audioCheck').checked = !!prefs.shareSound;
  $('#pickerGo').disabled = true;
  pickerSelected = null;
  modal.classList.remove('hidden');

  const done = new Promise((resolve) => { pickerResolve = resolve; });
  await loadSources();
  return done;
}

// Step 1: names and icons (instant). Step 2: thumbnails (slower), patched in.
// The OS sometimes hands back an empty list; keep asking while the picker is
// open (after a few tries it says so meanwhile).
async function loadSources() {
  const round = ++thumbRound;
  $('#sourceGrid').innerHTML = '<p class="loading">Finding windows…</p>';
  pickerSources = [];
  for (let attempt = 0; !pickerSources.length; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, Math.min(2000, 600 * attempt)));
    if (!pickerResolve || round !== thumbRound) return; // picker closed or refreshed meanwhile
    try { pickerSources = await window.gameshare.listSources({ thumbs: false }); } catch (e) { console.warn('listSources', e); }
    if (attempt === 3 && !pickerSources.length && round === thumbRound) renderSources();
  }
  if (!pickerResolve || round !== thumbRound) return;
  // Preselect what you shared last time, if it's still open.
  const last = pickerSources.find((s) => s.id === prefs.lastSource);
  if (last && !pickerSelected) { pickerSelected = last.id; pickerKind = last.kind; }
  if (!pickerSources.some((s) => s.kind === pickerKind)) pickerKind = pickerSources.some((s) => s.kind === 'window') ? 'window' : 'screen';
  if (pickerSelected && !pickerSources.some((s) => s.id === pickerSelected)) pickerSelected = null;
  $('#pickerGo').disabled = !pickerSelected;
  renderSources();

  try {
    const withThumbs = await window.gameshare.listSources({ thumbs: true });
    if (!pickerResolve || round !== thumbRound) return;
    const byId = new Map(withThumbs.map((s) => [s.id, s.thumb]));
    for (const s of pickerSources) if (byId.get(s.id)) s.thumb = byId.get(s.id);
    document.querySelectorAll('#sourceGrid .source').forEach((card) => {
      const t = byId.get(card.dataset.id);
      if (t) setThumb(card.querySelector('.thumb'), t);
    });
  } catch (e) { console.warn('thumbnails', e); }
}

function setThumb(box, src) {
  const img = new Image();
  img.alt = '';
  img.decoding = 'async';
  img.src = src;
  box.replaceChildren(img);
  box.classList.remove('pending');
}

function closePicker(result) {
  $('#picker').classList.add('hidden');
  thumbRound++;
  const r = pickerResolve;
  pickerResolve = null;
  if (r) r(result);
}

function renderSources() {
  document.querySelectorAll('#picker .tab').forEach((t) => {
    const on = t.dataset.kind === pickerKind;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  });
  $('#audioOptText').innerHTML = pickerKind === 'window'
    ? 'Share this app’s sound <small>Only the window you pick. Never your call.</small>'
    : 'Share computer sound <small>Everything except GameShare, so friends never hear themselves.</small>';
  const grid = $('#sourceGrid');
  grid.innerHTML = '';
  const list = pickerSources.filter((s) => s.kind === pickerKind);
  if (!list.length) {
    grid.appendChild(el('p', 'loading', pickerKind === 'window'
      ? 'No windows found. Try the Screens tab.'
      : 'No screens found. On a Mac, allow Screen Recording for GameShare and restart it.'));
    return;
  }
  for (const s of list) {
    const b = el('button', 'source');
    b.type = 'button';
    b.dataset.id = s.id;
    if (s.id === pickerSelected) b.classList.add('selected');
    const thumb = el('div', 'thumb pending');
    if (s.thumb) setThumb(thumb, s.thumb);
    else if (s.icon) { const ic = new Image(); ic.src = s.icon; ic.alt = ''; ic.className = 'thumb-icon'; thumb.appendChild(ic); }
    const cap = el('div', 'cap');
    if (s.icon) { const ic = new Image(); ic.src = s.icon; ic.alt = ''; ic.className = 'app-icon'; cap.appendChild(ic); }
    cap.appendChild(el('span', null, s.name));
    b.title = s.name;
    b.append(thumb, cap);
    b.addEventListener('click', () => {
      pickerSelected = s.id;
      $('#pickerGo').disabled = false;
      grid.querySelectorAll('.source').forEach((x) => x.classList.remove('selected'));
      b.classList.add('selected');
    });
    b.addEventListener('dblclick', () => { pickerSelected = s.id; goPicker(); });
    grid.appendChild(b);
  }
  const sel = grid.querySelector('.source.selected');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

function goPicker() {
  if (!pickerSelected) return;
  prefs.lastSource = pickerSelected;
  savePrefs();
  closePicker({ id: pickerSelected, audio: $('#audioCheck').checked && appAudio.supported });
}

/* ------------------------------------------------------------ stage tiles */

const tiles = new Map(); // id ('me' or peer id) -> { tile, video, isMe, placed, idle }

function addTile(id, stream, isMe) {
  const prev = tiles.get(id);
  const prevStyle = prev ? prev.tile.getAttribute('style') : null;
  removeTile(id, { keepLayout: true });
  const stage = $('#stage');
  const tile = el('div', 'tile');
  tile.dataset.tile = id;
  if (isMe) tile.classList.add('mine');

  const video = el('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = isMe; // never play my own capture back
  video.srcObject = stream;
  video.play().catch(() => {});
  video.addEventListener('resize', scheduleLayout); // real shape known -> refit

  const peer = isMe ? null : state.peers.get(id);
  const who = isMe ? 'You' : (peer ? peer.name : 'Friend');

  // Always-visible name chip (top left)
  const chip = el('div', 'tile-chip');
  tile.style.setProperty('--pc', colorOf(isMe ? 'me' : id));
  chip.append(el('span', 'tile-name', who));
  if (isMe) chip.appendChild(el('span', 'chip-live', 'LIVE'));

  // Controls (bottom, on hover)
  const bar = el('div', 'tile-bar');
  const left = el('div', 'tile-left');
  const soundInfo = isMe ? state.screenSound : (peer || {}).screenSound;
  const hasAudio = stream.getAudioTracks().length > 0;
  left.appendChild(el('span', 'tile-sound', soundLabel(soundInfo, hasAudio, isMe)));
  const tools = el('div', 'tile-tools');

  if (!isMe && !hasAudio) {
    const none = el('div', 'stream-vol disabled');
    none.title = `${who} isn’t sharing sound`;
    none.append(el('span', 'stream-mute off'), el('span', 'stream-none', 'No sound'));
    tools.appendChild(none);
  }
  if (!isMe && hasAudio) {
    const wrap = el('div', 'stream-vol');
    const snd = el('button', 'stream-mute');
    const vol = el('input', 'stream-slider');
    vol.type = 'range'; vol.min = '0'; vol.max = '100';
    vol.value = String(Math.round((peer && peer.streamVolume != null ? peer.streamVolume : 1) * 100));
    vol.title = 'Stream volume';
    vol.setAttribute('aria-label', `${who}’s stream volume`);
    const sync = () => {
      const pr = state.peers.get(id);
      const off = !pr || pr.tileSoundOff || Number(vol.value) === 0;
      snd.classList.toggle('off', off);
      snd.title = pr && pr.tileSoundOff ? 'Unmute stream sound' : 'Mute stream sound';
      snd.setAttribute('aria-label', snd.title);
      vol.style.setProperty('--fill', `${vol.value}%`);
    };
    snd.addEventListener('click', () => {
      const pr = state.peers.get(id);
      if (!pr) return;
      pr.tileSoundOff = !pr.tileSoundOff;
      if (!pr.tileSoundOff && Number(vol.value) === 0) { vol.value = '50'; pr.streamVolume = 0.5; }
      applyAudio(pr); sync();
    });
    vol.addEventListener('input', () => {
      const pr = state.peers.get(id);
      if (!pr) return;
      pr.streamVolume = Number(vol.value) / 100;
      if (pr.streamVolume > 0) pr.tileSoundOff = false;
      applyAudio(pr); sync();
    });
    wrap.append(snd, vol);
    tools.appendChild(wrap);
    sync();
  }
  if (isMe) {
    const stop = el('button', 'tile-btn danger', 'Stop');
    stop.addEventListener('click', () => stopShare());
    tools.appendChild(stop);
  }
  // Stats: resolution, frame rate, bitrate… on every screen (one switch for all).
  const stats = el('button', 'tile-btn stats-btn', 'Stats');
  stats.title = isMe ? 'Show what each friend is getting from you' : 'Show stream numbers: resolution, frame rate, bitrate, delay';
  stats.setAttribute('aria-pressed', String(!!prefs.stats));
  stats.addEventListener('click', () => setStats(!prefs.stats));
  tools.appendChild(stats);
  const full = el('button', 'tile-btn icon full-btn');
  full.title = 'Full screen';
  full.setAttribute('aria-label', 'Full screen');
  full.addEventListener('click', () => toggleFullscreen(tile));
  tools.appendChild(full);
  // Using the controls shouldn't enlarge or full-screen the tile.
  for (const type of ['click', 'dblclick', 'pointerdown']) bar.addEventListener(type, (e) => e.stopPropagation());
  bar.append(left, tools);

  const close = el('button', 'tile-close');
  close.title = isMe ? 'Hide my preview (keeps sharing)' : 'Close this screen';
  close.setAttribute('aria-label', close.title);
  close.addEventListener('click', (e) => { e.stopPropagation(); closeTile(id); });
  close.addEventListener('dblclick', (e) => e.stopPropagation());

  tile.append(video, chip, bar, close, el('div', 'tile-stats'));
  if (!isMe) {
    const stall = el('div', 'tile-stall');
    stall.append(el('i', 'spin'), el('span', null, 'Reconnecting…'));
    tile.appendChild(stall);
  }
  tile.addEventListener('click', () => { if (!document.fullscreenElement) toggleFocus(id); });
  tile.addEventListener('dblclick', () => toggleFullscreen(tile));
  // In full screen, controls and cursor hide after a moment without movement.
  // call: the screen call this picture comes from (a newer one = this one is stale).
  const entry = { tile, video, isMe, placed: !!prevStyle, idle: null, call: peer ? peer.screenIn : null, stalled: false };
  tile.addEventListener('mousemove', () => wake(entry));

  if (prevStyle) tile.setAttribute('style', prevStyle);
  if (isSpeaking(isMe ? 'me' : id)) tile.classList.add('speaking');
  // Friends' screens first in the page, mine last.
  const mine = tiles.get('me');
  if (!isMe && mine) stage.insertBefore(tile, mine.tile); else stage.appendChild(tile);
  tiles.set(id, entry);
  if (!isMe && peer) { applyAudio(peer); sinkOne(video); }
  // Show the controls for a few seconds so people notice them, then only on hover.
  tile.classList.add('reveal');
  setTimeout(() => tile.classList.remove('reveal'), 4000);
  layoutStage();
}

function wake(entry) {
  if (document.fullscreenElement !== entry.tile) return;
  entry.tile.classList.add('awake');
  clearTimeout(entry.idle);
  entry.idle = setTimeout(() => entry.tile.classList.remove('awake'), 2500);
}

function toggleFullscreen(tile) {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  } else {
    tile.requestFullscreen().catch((e) => {
      console.warn('fullscreen', e);
      toast('Couldn’t go full screen.', 'err');
    });
  }
}

document.addEventListener('fullscreenchange', () => {
  const fs = document.fullscreenElement;
  for (const t of tiles.values()) {
    const b = t.tile.querySelector('.full-btn');
    const on = fs === t.tile;
    b.title = on ? 'Exit full screen' : 'Full screen';
    b.setAttribute('aria-label', b.title);
    b.classList.toggle('exit', on);
    if (on) wake(t); else t.tile.classList.remove('awake');
  }
  reportViews(); // full screen wants the full resolution
});

// Close a screen tile. For a friend's screen this also tells them to stop
// sending it to me (saves both of our bandwidth). Reopen from the people list.
function closeTile(id) {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (id === 'me') {
    state.previewHidden = true;
    removeTile('me');
    toast('Preview hidden. You’re still sharing.');
  } else {
    const p = state.peers.get(id);
    if (!p) return;
    p.hidden = true;
    if (p.screenIn) { const c = p.screenIn; p.screenIn = null; try { c.close(); } catch { /* ignore */ } }
    send(p, { type: 'unwatch' });
    removeTile(id);
  }
  renderPeople();
}

function reopenTile(id) {
  if (id === 'me') {
    if (!state.screen) return;
    state.previewHidden = false;
    addTile('me', state.screen, true);
  } else {
    const p = state.peers.get(id);
    if (!p) return;
    p.hidden = false;
    send(p, { type: 'watch' });
  }
  renderPeople();
}

function versionLess(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0); }
  return false;
}

function soundLabel(info, hasAudio) {
  if (!hasAudio) return 'no sound';
  if (!info) return 'sound: unknown (they need to update GameShare)';
  if (info.sound === 'app') return `sound: ${info.app || 'this app'} only`;
  if (info.sound === 'system') return 'sound: whole computer except GameShare';
  return 'sound';
}

function removeTile(id, { keepLayout = false } = {}) {
  const t = tiles.get(id);
  if (t) {
    clearTimeout(t.idle);
    t.video.srcObject = null;
    t.tile.remove();
    tiles.delete(id);
  }
  if (!keepLayout) {
    if ($('#stage').dataset.focus === id) delete $('#stage').dataset.focus;
    layoutStage();
  }
}

function toggleFocus(id) {
  const stage = $('#stage');
  if (stage.dataset.focus === id) delete stage.dataset.focus;
  else stage.dataset.focus = id;
  layoutStage();
}

/* ------------------------------------------------------------ stage layout
 * Every screen gets the biggest box with its own shape that fits, instead of
 * equal cells with black bars. My own preview shrinks to a corner while
 * friends are sharing. Clicking a screen makes it big with the rest in a strip. */

let layoutQueued = false;
function scheduleLayout() {
  if (layoutQueued) return;
  layoutQueued = true;
  requestAnimationFrame(() => { layoutQueued = false; layoutStage(); });
}

function aspectOf(t) {
  const v = t.video;
  return v.videoWidth && v.videoHeight ? clamp(v.videoWidth / v.videoHeight, 1, 2.6) : 16 / 9;
}

function gridRects(n, x0, y0, W, H, A, gap) {
  let best = null;
  for (let c = 1; c <= n; c++) {
    const r = Math.ceil(n / c);
    const cw = (W - (c - 1) * gap) / c, ch = (H - (r - 1) * gap) / r;
    if (cw <= 0 || ch <= 0) continue;
    const w = Math.min(cw, ch * A), h = w / A;
    if (!best || w * h > best.w * best.h) best = { c, r, w, h };
  }
  if (!best) return { rects: [], area: 0 };
  const rects = [];
  let y = y0 + (H - (best.r * best.h + (best.r - 1) * gap)) / 2;
  for (let row = 0; row < best.r; row++) {
    const inRow = Math.min(best.c, n - row * best.c);
    let x = x0 + (W - (inRow * best.w + (inRow - 1) * gap)) / 2;
    for (let i = 0; i < inRow; i++) { rects.push({ x, y, w: best.w, h: best.h }); x += best.w + gap; }
    y += best.h + gap;
  }
  return { rects, area: best.w * best.h };
}

function layoutStage() {
  const stage = $('#stage');
  const pad = 14, gap = 12;
  const W = Math.max(0, stage.clientWidth - pad * 2), H = Math.max(0, stage.clientHeight - pad * 2);
  const all = [...tiles.values()];
  const remote = all.filter((t) => !t.isMe);
  const me = all.find((t) => t.isMe);
  $('#emptyStage').classList.toggle('hidden', all.length > 0);

  let focus = stage.dataset.focus;
  if (focus && !tiles.has(focus)) { delete stage.dataset.focus; focus = null; }
  const focusOn = !!focus && all.length > 1;
  const pip = !focusOn && !!me && remote.length > 0;
  const place = [];

  if (focusOn) {
    const main = tiles.get(focus);
    const others = [...remote, ...(me ? [me] : [])].filter((t) => t !== main);
    const sw = clamp(W * 0.2, 150, 280);
    const mainW = W - sw - gap;
    const A = aspectOf(main);
    const w = Math.min(mainW, H * A), h = w / A;
    place.push([main, { x: pad + (mainW - w) / 2, y: pad + (H - h) / 2, w, h }, 'main']);
    let sh = sw / (16 / 9), stripW = sw;
    if (others.length * sh + (others.length - 1) * gap > H) {
      sh = (H - (others.length - 1) * gap) / others.length;
      stripW = sh * 16 / 9;
    }
    let y = pad + (H - (others.length * sh + (others.length - 1) * gap)) / 2;
    for (const t of others) {
      place.push([t, { x: pad + W - sw + (sw - stripW) / 2, y, w: stripW, h: sh }, 'strip']);
      y += sh + gap;
    }
  } else {
    const main = pip ? remote : [...remote, ...(me ? [me] : [])];
    const A = main.length ? main.reduce((s, t) => s + aspectOf(t), 0) / main.length : 16 / 9;
    let grid = gridRects(main.length, pad, pad, W, H, A, gap);
    if (pip) {
      // My preview never covers a friend's screen (or its volume controls):
      // it gets its own column on the right or its own row at the bottom,
      // whichever leaves the friends' screens bigger.
      const pw = clamp(W * 0.2, 170, 300), ph = pw / aspectOf(me);
      const side = gridRects(main.length, pad, pad, W - pw - gap, H, A, gap);
      const below = gridRects(main.length, pad, pad, W, H - ph - gap, A, gap);
      const useSide = side.area > below.area;
      grid = useSide ? side : below;
      // Center friends' screens + my preview as one group, preview tucked
      // against their bottom-right corner, so there are no lopsided gaps.
      const bx0 = Math.min(...grid.rects.map((r) => r.x)), by0 = Math.min(...grid.rects.map((r) => r.y));
      const bx1 = Math.max(...grid.rects.map((r) => r.x + r.w)), by1 = Math.max(...grid.rects.map((r) => r.y + r.h));
      let dx = 0, dy = 0, pip;
      if (useSide) {
        dx = pad + (W - ((bx1 - bx0) + gap + pw)) / 2 - bx0;
        pip = { x: bx1 + dx + gap, y: Math.max(pad, by1 - ph), w: pw, h: ph };
      } else {
        dy = pad + (H - ((by1 - by0) + gap + ph)) / 2 - by0;
        pip = { x: Math.max(pad, bx1 - pw), y: by1 + dy + gap, w: pw, h: ph };
      }
      grid.rects = grid.rects.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy }));
      place.push([me, pip, 'pip']);
    }
    main.forEach((t, i) => grid.rects[i] && place.push([t, grid.rects[i], 'grid']));
  }

  for (const [t, r, kind] of place) {
    const s = t.tile.style;
    if (!t.placed) t.tile.classList.add('no-anim');
    s.left = `${Math.round(r.x)}px`;
    s.top = `${Math.round(r.y)}px`;
    s.width = `${Math.round(r.w)}px`;
    s.height = `${Math.round(r.h)}px`;
    t.tile.dataset.kind = kind;
    t.tile.classList.toggle('focused', kind === 'main');
    if (!t.placed) {
      t.placed = true;
      requestAnimationFrame(() => requestAnimationFrame(() => t.tile.classList.remove('no-anim')));
    }
  }
  stage.dataset.count = String(all.length);
  reportViews();
}

/* ------------------------------------------------------------ view size reports
 * Tell each sharer how many pixels tall we're showing their screen, so they
 * send us that instead of full 1080p. Paused entirely while minimized. */

let viewTimer = null;
function reportViews() {
  clearTimeout(viewTimer);
  viewTimer = setTimeout(sendViews, 300);
}

function wantedView(id) {
  const t = tiles.get(id);
  if (!t) return null;
  if (!state.windowVisible) return { h: 0, paused: true };
  const px = t.tile.clientHeight * (window.devicePixelRatio || 1);
  const h = VIEW_STEPS.find((s) => s >= px * 0.9) || VIEW_STEPS[VIEW_STEPS.length - 1];
  return { h, paused: false };
}

// Bigger: ask right away. Smaller: only once it has stayed smaller for a few
// seconds, so resizing the window or a layout change doesn't make the
// sharer's encoder switch back and forth (each switch is a small hiccup).
const SHRINK_AFTER_MS = 3000;
function sendViews() {
  const now = performance.now();
  for (const p of state.peers.values()) {
    if (!p.screenIn) continue;
    const v = wantedView(p.id);
    if (!v) continue;
    const key = v.paused ? 'paused' : String(v.h);
    if (p.sentView === key) { p.shrinkAt = null; continue; }
    const prevH = p.sentView && p.sentView !== 'paused' ? Number(p.sentView) : null;
    if (!v.paused && prevH && v.h < prevH) {
      if (!p.shrinkAt) p.shrinkAt = now;
      if (now - p.shrinkAt < SHRINK_AFTER_MS) {
        clearTimeout(p.shrinkTimer);
        p.shrinkTimer = setTimeout(sendViews, SHRINK_AFTER_MS - (now - p.shrinkAt) + 50);
        continue;
      }
    }
    p.shrinkAt = null;
    p.sentView = key;
    send(p, { type: 'view', h: v.h, paused: v.paused });
  }
}

/* ------------------------------------------------------------ people list
 * Rows are created once and updated in place, so a slider you're dragging
 * isn't replaced under your mouse when someone mutes. */

const rows = new Map(); // key ('me' or peer id) -> row refs

function makeRow(key, me) {
  const li = el('li', 'person' + (me ? ' me' : ''));
  li.dataset.person = key;
  const av = el('div', 'avatar');
  const info = el('div', 'p-info');
  const top = el('div', 'p-name');
  const name = el('span', 'p-label');
  const host = el('span', 'host-icon hidden');
  host.title = 'Host: can change the room size';
  top.append(name, host);
  const sub = el('div', 'p-sub');
  const watch = el('button', 'watch-btn hidden');
  watch.addEventListener('click', (e) => { e.stopPropagation(); reopenTile(key); });
  info.append(top, sub, watch);
  const status = el('span', 'p-status');
  const r = { li, av, name, host, sub, watch, status, sig: '' };
  r.mic = el('span', 'p-mic hidden');
  r.deaf = el('span', 'p-deaf hidden');
  status.append(r.mic, r.deaf);
  if (!me) {
    r.net = el('span', 'net unknown');
    r.net.append(el('i'), el('i'), el('i'));
    status.append(r.net);
    r.hear = el('button', 'hear-btn');
    r.hear.addEventListener('click', (e) => { e.stopPropagation(); toggleLocalMute(key); });
    li.tabIndex = 0;
    li.title = 'Volume and options';
    li.addEventListener('click', () => openPersonMenu(key));
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPersonMenu(key); } });
  }
  li.append(av, info, status);
  if (r.hear) li.append(r.hear);
  return r;
}

function netLevel(n) {
  if (!n || n.rtt == null) return 'unknown';
  const loss = n.loss || 0;
  if (n.rtt < 120 && loss < 2) return 'good';
  if (n.rtt < 250 && loss < 8) return 'ok';
  return 'bad';
}

function updateRow(r, d) {
  const sig = JSON.stringify(d);
  if (sig === r.sig) return;
  r.sig = sig;
  r.li.style.setProperty('--pc', d.color);
  r.av.style.setProperty('--pc', d.color);
  r.av.textContent = initials(d.name);
  r.name.textContent = d.me ? `${d.name} (you)` : d.name;
  r.name.title = r.name.textContent;
  r.host.classList.toggle('hidden', !d.host);
  r.li.classList.toggle('lost', !!d.lost);
  const sub = [];
  if (d.lost) sub.push(el('span', 'lost-tag', 'Reconnecting…'));
  if (d.sharing) sub.push(el('span', 'live-tag', 'Live'));
  if (d.deafened) sub.push(el('span', null, d.me ? 'Voices muted' : 'Can’t hear voices'));
  if (d.localMuted) sub.push(el('span', null, 'Muted for you'));
  if (d.outdated) {
    const t = el('span', 'warn-tag', 'Old version');
    t.title = `${d.name} is running an older GameShare. Ask them to update so everything works the same for everyone.`;
    sub.push(t);
  }
  r.sub.replaceChildren(...sub);
  const showWatch = d.sharing && d.closed;
  r.watch.classList.toggle('hidden', !showWatch);
  r.watch.textContent = showWatch ? (d.me ? 'Show my preview' : 'Watch screen') : '';
  r.mic.classList.toggle('hidden', !d.muted);
  r.mic.title = d.me ? 'Your mic is off' : `${d.name}’s mic is off`;
  r.deaf.classList.toggle('hidden', !d.deafened);
  r.deaf.title = d.me ? 'You muted everyone’s voice' : `${d.name} can’t hear voices right now`;
  r.li.classList.toggle('muted-for-me', !!d.localMuted);
  if (r.hear) {
    r.hear.className = 'hear-btn' + (d.localMuted ? ' off' : '');
    r.hear.title = d.localMuted ? `Unmute ${d.name}’s voice for me` : `Mute ${d.name}’s voice for me (their stream has its own volume)`;
    r.hear.setAttribute('aria-label', r.hear.title);
  }
  if (r.net) {
    const lvl = d.lost ? 'bad' : netLevel(d.net);
    r.net.className = 'net ' + lvl;
    r.net.title = d.lost ? 'Connection lost. Reconnecting…' : netText(d.net);
  }
}

function netText(n) {
  if (!n || n.rtt == null) return 'Connection: measuring…';
  return `Ping ${n.rtt} ms, ${n.loss == null ? '–' : n.loss.toFixed(n.loss < 1 ? 1 : 0)}% lost` +
    (n.relay ? ', going through a relay server' : ', direct');
}

// One square per player slot: filled in each player's colour, open slots hollow.
function renderSlots(list) {
  const box = $('#slots');
  const sig = list.map((d) => d.key + d.color).join() + '|' + state.maxPeople;
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  const out = [];
  for (let i = 0; i < Math.max(state.maxPeople, list.length); i++) {
    const d = list[i];
    const sq = el('i', d ? '' : 'open');
    if (d) {
      sq.dataset.key = d.key;
      sq.style.setProperty('--pc', d.color);
      if (isSpeaking(d.key)) sq.classList.add('speaking');
    }
    out.push(sq);
  }
  box.replaceChildren(...out);
}

// Nobody sharing: everyone's avatar, big, lighting up as they talk.
const partyEls = new Map();
function renderParty(list) {
  const grid = $('#partyGrid');
  const keep = new Set();
  list.forEach((d, i) => {
    let m = partyEls.get(d.key);
    if (!m) {
      const elx = el('div', 'party-member');
      const av = el('div', 'avatar');
      const nm = el('div', 'party-name');
      elx.append(av, nm);
      m = { el: elx, av, nm, sig: '' };
      partyEls.set(d.key, m);
    }
    const sig = d.name + d.color + !!d.localMuted + !!d.lost;
    if (m.sig !== sig) {
      m.sig = sig;
      m.el.style.setProperty('--pc', d.color);
      m.av.style.setProperty('--pc', d.color);
      m.av.textContent = initials(d.name);
      m.nm.textContent = d.me ? `${d.name} (you)` : d.lost ? `${d.name} · reconnecting…` : d.name;
      m.el.classList.toggle('muted-for-me', !!d.localMuted);
      m.el.classList.toggle('lost', !!d.lost);
    }
    m.el.classList.toggle('speaking', isSpeaking(d.key));
    keep.add(d.key);
    if (grid.children[i] !== m.el) grid.insertBefore(m.el, grid.children[i] || null);
  });
  for (const [k, m] of partyEls) if (!keep.has(k)) { m.el.remove(); partyEls.delete(k); }
}

let rosterSig = '';
function renderPeople() {
  // Keep the saved room details up to date with who's in it (for a restart).
  const sig = [...state.peers.values()].filter((p) => p.greeted).map((p) => p.id).join();
  if (sig !== rosterSig) { rosterSig = sig; remember(); }
  const ul = $('#peopleList');
  const holderId = state.doormanOwner || roomId();
  const list = [{
    key: 'me', me: true, name: state.name, color: colorOf('me'), muted: state.muted || !state.micReal, sharing: !!state.screen,
    host: amHolder(), closed: state.previewHidden, deafened: state.deafened
  }];
  for (const p of state.peers.values()) {
    if (!p.greeted) continue;
    list.push({
      key: p.id, name: p.name, color: colorOf(p.id), muted: p.muted, sharing: p.sharing, host: p.id === holderId,
      closed: !!p.hidden, localMuted: !!p.localMuted, deafened: !!p.deafened, lost: !!p.lost,
      outdated: !!state.version && (!p.version || versionLess(p.version, state.version)),
      net: p.net ? { rtt: p.net.rtt, loss: p.net.loss == null ? null : Math.round(p.net.loss * 10) / 10, relay: p.net.relay } : null
    });
    const t = tiles.get(p.id);
    if (t) {
      const n = t.tile.querySelector('.tile-name');
      if (n.textContent !== p.name) n.textContent = p.name;
      t.tile.style.setProperty('--pc', colorOf(p.id));
    }
  }
  const mine = tiles.get('me');
  if (mine) mine.tile.style.setProperty('--pc', colorOf('me'));
  const keep = new Set();
  list.forEach((d, i) => {
    let r = rows.get(d.key);
    if (!r) { r = makeRow(d.key, d.me); rows.set(d.key, r); }
    updateRow(r, d);
    r.li.classList.toggle('speaking', isSpeaking(d.key));
    keep.add(d.key);
    // Only move a row if it's out of place (moving it would cancel a click or drag).
    if (ul.children[i] !== r.li) ul.insertBefore(r.li, ul.children[i] || null);
  });
  for (const [k, r] of rows) if (!keep.has(k)) { r.li.remove(); rows.delete(k); }

  const count = list.length;
  $('#peopleCount').textContent = `${count}/${state.maxPeople}`;
  renderSlots(list);
  // Empty stage: invite when alone, everyone's avatars otherwise.
  $('#emptyInvite').classList.toggle('hidden', count > 1);
  $('#emptyIdle').classList.toggle('hidden', count <= 1);
  renderParty(list);
  updatePersonMenu();
  updateSizeControls();
  updateNetBadge();
  pushOverlay();
}

/* ------------------------------------------------------------ player menu
 * Click a player: their voice volume, mute-for-me, and their screen. */

let menuKey = null;

function openPersonMenu(key) {
  const p = state.peers.get(key);
  if (!p || !p.greeted) return;
  const m = $('#personMenu');
  if (menuKey === key && !m.classList.contains('hidden')) { closePersonMenu(); return; }
  closeSettings();
  menuKey = key;
  const vol = m.querySelector('.pop-vol');
  vol.value = String(Math.round((p.volume == null ? 1 : p.volume) * 100));
  vol.style.setProperty('--fill', `${vol.value}%`);
  vol.setAttribute('aria-label', `${p.name}’s voice volume`);
  m.classList.remove('hidden');
  updatePersonMenu();
  positionPersonMenu();
  for (const [k, r] of rows) r.li.classList.toggle('menu-open', k === key);
}

function positionPersonMenu() {
  const r = rows.get(menuKey);
  const m = $('#personMenu');
  if (!r || m.classList.contains('hidden')) return;
  const a = r.li.getBoundingClientRect();
  const panel = $('#panel').getBoundingClientRect();
  const top = clamp(a.top - 6, 8, window.innerHeight - m.offsetHeight - 8);
  m.style.left = `${Math.round(panel.right + 8)}px`;
  m.style.top = `${Math.round(top)}px`;
}

function updatePersonMenu() {
  if (!menuKey) return;
  const p = state.peers.get(menuKey);
  if (!p || !p.greeted) { closePersonMenu(); return; }
  const m = $('#personMenu');
  const color = colorOf(menuKey);
  m.style.setProperty('--pc', color);
  const av = m.querySelector('.pop-avatar');
  av.style.setProperty('--pc', color);
  av.textContent = initials(p.name);
  m.querySelector('.pop-name').textContent = p.name;
  const bits = [];
  if (p.lost) bits.push('reconnecting…');
  if (p.sharing) bits.push('sharing their screen');
  if (p.muted) bits.push('mic off');
  if (p.deafened) bits.push('can’t hear voices');
  const sub = bits.length ? bits.join(', ') : 'in the room';
  m.querySelector('.pop-sub').textContent = sub.charAt(0).toUpperCase() + sub.slice(1);
  m.querySelector('.pop-mute').setAttribute('aria-checked', String(!!p.localMuted));
  const watch = m.querySelector('.pop-watch');
  watch.classList.toggle('hidden', !p.sharing);
  watch.textContent = p.hidden ? 'Watch their screen' : 'Close their screen';
  m.querySelector('.pop-net').textContent = p.net ? netText(p.net) : '';
}

function closePersonMenu() {
  menuKey = null;
  $('#personMenu').classList.add('hidden');
  for (const r of rows.values()) r.li.classList.remove('menu-open');
}

/* ------------------------------------------------------------ room size */

function holderName() {
  if (amHolder()) return 'you';
  const id = state.doormanOwner || roomId();
  const p = state.peers.get(id);
  return p && p.greeted ? p.name : 'the host';
}

function updateSizeControls() {
  const host = amHolder();
  const count = greetedCount();
  $('#sizeNow').textContent = String(state.maxPeople);
  $('#sizeStepper').classList.toggle('locked', !host);
  $('#sizeDown').disabled = !host || state.maxPeople <= Math.max(MIN_SIZE, count);
  $('#sizeUp').disabled = !host || state.maxPeople >= MAX_LIMIT;
  $('#sizeHint').textContent = host
    ? `How many players fit, up to ${MAX_LIMIT}`
    : `Only ${holderName()} can change it`;
}

function setRoomSize(n) {
  if (!amHolder()) return;
  n = clamp(n, Math.max(MIN_SIZE, greetedCount()), MAX_LIMIT);
  if (n === state.maxPeople) return;
  state.maxPeople = n;
  prefs.roomSize = n;
  if (prefs.lastRoom && prefs.lastRoom.code === state.code) prefs.lastRoom.size = n;
  savePrefs();
  broadcast({ type: 'room-size', max: n });
  renderPeople();
}

// Lobby: one square per player; click the last one you want.
function renderSizePicker() {
  const box = $('#sizePicker');
  const out = [];
  for (let i = 1; i <= MAX_LIMIT; i++) {
    const b = el('button', 'size-pip' + (i === 1 ? ' you' : i <= prefs.roomSize ? ' on' : ''));
    b.type = 'button';
    b.title = i === 1 ? 'You' : `${i} players`;
    b.setAttribute('aria-label', i === 1 ? 'You' : `Room for ${i} players`);
    b.setAttribute('aria-pressed', String(i === prefs.roomSize));
    if (i > 1) b.addEventListener('click', () => { prefs.roomSize = i; savePrefs(); renderSizePicker(); });
    out.push(b);
  }
  box.replaceChildren(...out);
  $('#sizeValue').textContent = `${prefs.roomSize} players`;
}

function updateNetBadge() {
  if (!state.peer) return;
  const friends = [...state.peers.values()].filter((p) => p.greeted);
  const lost = friends.filter((p) => p.lost);
  if (lost.length && (state.peer.disconnected || (friends.length > 1 && lost.length === friends.length))) {
    setNet('Your connection dropped. Reconnecting…', 'warn');
  } else if (lost.length) {
    setNet(lost.length === 1 ? `Reconnecting to ${lost[0].name}…` : `Reconnecting to ${lost.length} friends…`, 'warn');
  } else if (state.peer.disconnected) {
    // Only the matchmaking server: calls in progress keep working.
    setNet('Reconnecting to the server…', 'warn');
  } else {
    setNet(friends.length ? 'Connected' : 'Waiting for friends', friends.length ? 'ok' : '');
  }
}

/* ------------------------------------------------------------ connection quality
 * Every 3 s, read ping and packet loss from each friend's voice connection. */

/* ------------------------------------------------------------ stream numbers
 * What a screen call is actually doing, for the Stats view on screens and the
 * diagnostics report: resolution, frame rate, bitrate, codec, hardware or
 * software coding, loss, buffering, freezes and the route it takes. */

const lastSample = new WeakMap(); // call -> previous counters, for per-second rates

async function callStats(call, dir) {
  const pc = call && call.peerConnection;
  if (!pc) return null;
  let st;
  try { st = await pc.getStats(); } catch { return null; }
  const byId = new Map();
  let rtp = null, pairId = null;
  st.forEach((r) => {
    byId.set(r.id, r);
    if (r.type === (dir === 'in' ? 'inbound-rtp' : 'outbound-rtp') && r.kind === 'video') rtp = r;
    if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
  });
  if (!rtp) return { state: pc.connectionState };
  const pair = pairId && byId.get(pairId);
  const codec = rtp.codecId && byId.get(rtp.codecId);
  const cand = (id) => byId.get(id) || {};
  const now = performance.now();
  const bytes = dir === 'in' ? rtp.bytesReceived : rtp.bytesSent;
  const prev = lastSample.get(call);
  lastSample.set(call, { t: now, bytes, lost: rtp.packetsLost || 0, recv: rtp.packetsReceived || 0,
                         delay: rtp.jitterBufferDelay || 0, emitted: rtp.jitterBufferEmittedCount || 0 });
  const dt = prev ? (now - prev.t) / 1000 : 0;
  const s = {
    state: pc.connectionState,
    w: rtp.frameWidth || 0, h: rtp.frameHeight || 0, fps: Math.round(rtp.framesPerSecond || 0),
    kbps: dt > 0.2 ? Math.max(0, Math.round(((bytes - prev.bytes) * 8) / dt / 1000)) : null,
    codec: codec && codec.mimeType ? codec.mimeType.split('/')[1] : '',
    rtt: pair && pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null,
    relay: !!pair && (cand(pair.localCandidateId).candidateType === 'relay' || cand(pair.remoteCandidateId).candidateType === 'relay')
  };
  if (dir === 'in') {
    const lost = prev ? rtp.packetsLost - prev.lost : 0, got = prev ? rtp.packetsReceived - prev.recv : 0;
    s.loss = lost + got > 0 ? (100 * Math.max(0, lost)) / (lost + got) : 0;
    const emitted = prev ? rtp.jitterBufferEmittedCount - prev.emitted : 0;
    s.buffer = emitted > 0 ? Math.round(((rtp.jitterBufferDelay - prev.delay) / emitted) * 1000) : null;
    s.freezes = rtp.freezeCount || 0;
    s.impl = rtp.decoderImplementation || '';
    s.hw = rtp.powerEfficientDecoder;
  } else {
    s.impl = rtp.encoderImplementation || '';
    s.hw = rtp.powerEfficientEncoder;
    s.limit = rtp.qualityLimitationReason || 'none';
    s.active = rtp.active !== false;
  }
  return s;
}

const mbps = (kbps) => (kbps == null ? '…' : kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${kbps} kbps`);
const coder = (s, what) => (s.hw == null ? (s.impl || '') : `${s.hw ? 'hardware' : 'software'} ${what}${s.impl ? ` (${s.impl})` : ''}`);

// compact: for small screens (a strip thumbnail, your own preview).
function describeIn(s, compact) {
  if (!s || !s.w) return s && s.state !== 'connected' ? `not connected (${s.state})` : 'waiting for video…';
  if (compact) return `${s.h}p · ${s.fps} fps · ${mbps(s.kbps)}\n${s.buffer != null ? `${s.buffer} ms buffer · ` : ''}${s.freezes} freeze${s.freezes === 1 ? '' : 's'}`;
  return [
    `${s.w}×${s.h} · ${s.fps} fps · ${mbps(s.kbps)}`,
    [s.codec, coder(s, 'decoding')].filter(Boolean).join(' · '),
    `${s.buffer != null ? `buffer ${s.buffer} ms · ` : ''}${s.freezes} freeze${s.freezes === 1 ? '' : 's'} · ${s.loss.toFixed(1)}% lost`,
    `${s.relay ? 'via relay server' : 'direct'}${s.rtt != null ? ` · ping ${s.rtt} ms` : ''}`
  ].join('\n');
}

function describeOut(name, s, p, compact) {
  if (!s || s.state !== 'connected') return `${name}: connecting…`;
  if (!s.active || (p.view && p.view.paused)) return compact ? `${name}: paused` : `${name}: paused (they minimized GameShare)`;
  if (compact) return `${name}: ${s.h}p ${s.fps} fps ${mbps(s.kbps)}${s.limit === 'cpu' ? ' · CPU' : s.limit === 'bandwidth' ? ' · net' : ''}`;
  return `${name}: ${s.w}×${s.h} · ${s.fps} fps · ${mbps(s.kbps)}${s.limit !== 'none' ? ` · held back by ${s.limit === 'cpu' ? 'your CPU' : s.limit === 'bandwidth' ? 'the connection' : s.limit}` : ''}`;
}

// Stats view: a small panel on every screen, refreshed each second.
let statsTimer = null;
function setStats(on) {
  prefs.stats = !!on;
  savePrefs();
  document.body.classList.toggle('show-stats', prefs.stats);
  for (const t of tiles.values()) { const b = t.tile.querySelector('.stats-btn'); if (b) b.setAttribute('aria-pressed', String(prefs.stats)); }
  clearInterval(statsTimer);
  statsTimer = prefs.stats ? setInterval(updateStats, 1000) : null;
  if (prefs.stats) updateStats();
}

async function updateStats() {
  for (const [id, t] of tiles) {
    const box = t.tile.querySelector('.tile-stats');
    if (!box) continue;
    const compact = t.tile.clientWidth < 360 || t.tile.clientHeight < 200;
    box.classList.toggle('compact', compact);
    let text;
    if (t.isMe) {
      const lines = [];
      let enc = '';
      for (const p of state.peers.values()) {
        if (!p.greeted || !p.screenOut) continue;
        const s = await callStats(p.screenOut, 'out');
        lines.push(describeOut(p.name, s, p, compact));
        if (s && s.impl && !enc) enc = compact ? (s.hw == null ? '' : `${s.hw ? 'hardware' : 'software'} encoding`) : coder(s, 'encoding');
      }
      text = lines.length ? [...lines, enc].filter(Boolean).join('\n') : 'Nobody is watching yet';
    } else {
      const p = state.peers.get(id);
      text = p && p.screenIn ? describeIn(await callStats(p.screenIn, 'in'), compact) : 'reconnecting…';
    }
    if (box.textContent !== text) box.textContent = text;
  }
}

/* ------------------------------------------------------------ diagnostics
 * "Copy report" in Settings: everything useful for figuring out a problem,
 * as plain text to paste to a friend. No IP addresses. */

const diagLog = []; // recent notices and connection events, newest last
function note(msg) {
  diagLog.push(`${new Date().toTimeString().slice(0, 8)} ${msg}`);
  if (diagLog.length > 40) diagLog.shift();
}
// Connection events: to the console and the report.
function log(msg) {
  console.log('[heal] ' + msg);
  note(msg);
}

async function diagnostics() {
  const info = await window.gameshare.diagInfo().catch(() => ({}));
  const L = [];
  L.push(`GameShare ${state.version} report, ${new Date().toString().slice(0, 24)}`);
  L.push(`System: ${info.os || navigator.platform} · Electron ${info.electron || '?'} · Chromium ${info.chrome || '?'}`);
  if (info.gpu) {
    const g = info.gpu;
    L.push(`Graphics: compositing ${g.gpu_compositing || '?'} · video decode ${g.video_decode || '?'} · video encode ${g.video_encode || '?'}`);
  }
  const custom = new URLSearchParams(location.search).get('signal');
  L.push(`Matchmaking server: ${custom ? 'your own' : 'PeerJS public'} · ${state.peer ? (state.peer.open ? 'connected' : 'reconnecting') : 'not connected'}`);
  const sel = (q) => { const o = $(q) && $(q).selectedOptions[0]; return o ? o.textContent : 'default'; };
  if (document.body.dataset.view !== 'room') {
    L.push('Not in a room.');
  } else {
    L.push(`Room ${state.code}: ${greetedCount()}/${state.maxPeople} players · host: ${holderName()}`);
    L.push(`Me (${state.name}): ${state.muted ? 'muted' : 'mic on'}${state.micReal ? '' : ' (no microphone found)'} · ${state.deafened ? 'voices muted' : 'hearing voices'} · ${state.screen ? 'sharing' : 'not sharing'}`);
  }
  L.push(`Settings: quality ${state.quality} · headphones mode ${state.headphones ? 'on' : 'off'} · noise removal ${prefs.noiseRemoval === false ? 'off' : mic.failed ? 'failed, using the standard filter' : 'on'} · overlay ${prefs.overlay ? 'on' : 'off'} · in-game shortcuts ${prefs.globalKeys === false ? 'off' : 'on'}`);
  L.push(`Devices: microphone "${sel('#micSelect')}" · output "${sel('#outSelect')}"`);
  for (const p of state.peers.values()) {
    if (!p.greeted) continue;
    L.push('');
    L.push(`${p.name} (GameShare ${p.version || 'older than 1.2'}): ${p.lost ? `RECONNECTING for ${Math.round((performance.now() - p.lost) / 1000)} s` : 'connected'} · ${netText(p.net)}`);
    L.push(`  link ${health(p.conn)} · voice ${health(p.voice)}${p.localMuted ? ' (muted by me)' : ''}${p.muted ? ' · their mic is off' : ''}`);
    if (p.screenIn) L.push('  their screen: ' + describeIn(await callStats(p.screenIn, 'in')).replace(/\n/g, ' · ') + (p.screenBuffer ? ` · target buffer ${p.screenBuffer} ms` : ''));
    else if (p.sharing) L.push(`  their screen: ${p.hidden ? 'closed by me' : 'not received'}`);
    if (p.screenOut) {
      const s = await callStats(p.screenOut, 'out');
      L.push('  my screen to them: ' + describeOut('', s, p).replace(/^: /, '') + (s && s.impl ? ` · ${coder(s, 'encoding')}` : ''));
    }
  }
  if (diagLog.length) {
    L.push('');
    L.push('Recent events:');
    for (const e of diagLog) L.push('  ' + e);
  }
  return L.join('\n');
}

async function copyDiagnostics() {
  const text = await diagnostics();
  try { await navigator.clipboard.writeText(text); toast('Report copied. Paste it to whoever is helping you.', 'ok'); }
  catch { toast('Couldn’t copy the report.', 'err'); }
  return text;
}

let netTimer = null;
async function pollNet() {
  for (const p of state.peers.values()) {
    const pc = p.voice && p.voice.peerConnection;
    if (!pc || pc.connectionState !== 'connected') continue;
    try {
      const stats = await pc.getStats();
      const byId = new Map();
      let pairId = null, inbound = null;
      stats.forEach((r) => {
        byId.set(r.id, r);
        if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
        if (r.type === 'inbound-rtp' && r.kind === 'audio') inbound = r;
      });
      let pair = pairId && byId.get(pairId);
      if (!pair) stats.forEach((r) => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
      const rtt = pair && pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null;
      const cand = (cid) => byId.get(cid) || {};
      const relay = !!pair && (cand(pair.localCandidateId).candidateType === 'relay' || cand(pair.remoteCandidateId).candidateType === 'relay');
      let loss = p.net ? p.net.loss : null;
      if (inbound) {
        const prev = p.netPrev;
        if (prev) {
          const lost = Math.max(0, inbound.packetsLost - prev.lost), got = Math.max(0, inbound.packetsReceived - prev.recv);
          if (lost + got > 0) loss = (100 * lost) / (lost + got);
        }
        p.netPrev = { lost: inbound.packetsLost, recv: inbound.packetsReceived };
      }
      p.net = { rtt, loss, relay };
    } catch { /* ignore */ }
  }
  await adaptScreenBuffers();
  if (document.body.dataset.view === 'room') renderPeople();
}

function updateControls() {
  const micBtn = $('#micBtn');
  micBtn.classList.toggle('off', state.muted);
  micBtn.setAttribute('aria-pressed', String(state.muted));
  micBtn.querySelector('.ctrl-label').textContent = state.muted ? 'Unmute' : 'Mute';
  const deafBtn = $('#deafenBtn');
  deafBtn.classList.toggle('off', state.deafened);
  deafBtn.setAttribute('aria-pressed', String(state.deafened));
  deafBtn.querySelector('.ctrl-label').textContent = state.deafened ? 'Voices off' : 'Voices';
  micBtn.title = state.muted ? 'Unmute your mic (Ctrl+Shift+M)' : 'Mute your mic (Ctrl+Shift+M)';
  deafBtn.title = state.deafened ? 'Hear everyone’s voice again (Ctrl+Shift+D)' : 'Mute everyone’s voice for you. Streams keep playing (Ctrl+Shift+D)';
  $('#headphonesBtn').setAttribute('aria-checked', String(state.headphones));
  $('#soundsBtn').setAttribute('aria-checked', String(!!prefs.sounds));
  $('#globalKeysBtn').setAttribute('aria-checked', String(prefs.globalKeys !== false));
  $('#noiseBtn').setAttribute('aria-checked', String(prefs.noiseRemoval !== false && !mic.failed));
  $('#overlayBtn').setAttribute('aria-checked', String(prefs.overlay === true));
  $('#overlayCornerRow').classList.toggle('hidden', prefs.overlay !== true);
  $('#overlayCorner').value = prefs.overlayCorner || 'top left';
  const shareBtn = $('#shareBtn');
  shareBtn.classList.toggle('live', !!state.screen);
  shareBtn.querySelector('.ctrl-label').textContent = state.screen ? 'Stop sharing' : 'Share screen';
}

/* ------------------------------------------------------------ room flow */

function lobbyStatus(text, kind = '') {
  const s = $('#lobbyStatus');
  s.textContent = text;
  s.className = 'status ' + kind;
}

function setLobbyBusy(busy) {
  $('#createBtn').disabled = busy;
  $('#joinBtn').disabled = busy;
  $('#rejoinBtn').disabled = busy;
}

function renderRejoin() {
  const r = prefs.lastRoom;
  const fresh = r && r.code && Date.now() - r.at < 12 * 3600 * 1000;
  const b = $('#rejoinBtn');
  b.classList.toggle('hidden', !fresh);
  if (fresh) b.querySelector('b').textContent = r.code;
}

// Signaling server: free public PeerJS cloud by default, or a custom one
// passed in as ?signal=https://host:port/path (set GAMESHARE_SIGNAL).
function peerOptions() {
  const opts = { debug: 1 };
  const custom = new URLSearchParams(location.search).get('signal');
  if (custom) {
    try {
      const u = new URL(custom);
      opts.host = u.hostname;
      opts.port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
      opts.path = u.pathname || '/';
      opts.secure = u.protocol === 'https:';
    } catch (e) { console.warn('Bad signal URL', e); }
  }
  return opts;
}

function createPeer(id) {
  return new Promise((resolve, reject) => {
    const peer = id ? new Peer(id, peerOptions()) : new Peer(peerOptions());
    const onOpen = () => { cleanup(); resolve(peer); };
    const onErr = (e) => { cleanup(); peer.destroy(); reject(e); };
    const cleanup = () => { peer.off('open', onOpen); peer.off('error', onErr); };
    peer.on('open', onOpen);
    peer.on('error', onErr);
  });
}

function wirePeer(peer) {
  peer.on('connection', (conn) => {
    if (state.peers.size >= MAX_LIMIT - 1 && !state.peers.has(conn.peer)) {
      conn.on('open', () => { conn.send({ type: 'full', max: state.maxPeople }); setTimeout(() => conn.close(), 3000); });
      return;
    }
    wireConn(conn, false);
  });
  peer.on('call', onIncomingCall);
  peer.on('disconnected', () => {
    updateNetBadge();
    if (!state.leaving && !peer.destroyed) setTimeout(() => { if (!peer.destroyed && peer.disconnected) peer.reconnect(); }, 1500);
  });
  peer.on('open', signalBack);
  peer.on('error', (e) => {
    console.warn('peer error', e.type, e);
    if (e.type === 'peer-unavailable') {
      // A redial that the server couldn't deliver: free the slot for the next try.
      const id = (/peer (\S+)$/.exec(e.message || '') || [])[1];
      const lost = id && state.peers.get(id);
      if (lost && lost.dials.length) dropDials(lost);
      if (id && dialing.has(id)) { try { dialing.get(id).close(); } catch { /* ignore */ } dialing.delete(id); }
      if (document.body.dataset.view !== 'room') {
        const code = state.rejoinCode;
        clearTimeout(state.joinTimer);
        leave(true);
        if (code) {
          // Nobody is in that room any more: open it again under the same code.
          createRoom(code);
        } else {
          lobbyStatus('No room with that code. Check it and try again.', 'err');
        }
      }
      // in-room: someone left mid-connect, ignore
    } else if (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error') {
      setNet('Reconnecting…', 'warn');
    }
  });
}

async function prepare() {
  const name = $('#nameInput').value.trim();
  if (!name) { lobbyStatus('Pick a name first.', 'err'); $('#nameInput').focus(); return false; }
  state.name = name.slice(0, 24);
  try { localStorage.setItem('gs-name', state.name); } catch { /* ignore */ }
  state.leaving = false;
  ctx();
  state.mic = await getMic();
  // Back after a restart: muted and "voices off" stay as they were.
  const r = state.resume;
  state.muted = !!(r && r.muted);
  if (r) state.deafened = !!r.deafened;
  state.mic.getAudioTracks().forEach((t) => { t.enabled = !state.muted; });
  watchLevel('me', state.mic);
  return true;
}

// fixedCode: re-open a specific room (used by Rejoin when the room was empty).
// Resolves to true once in the room.
async function createRoom(fixedCode) {
  const fixed = typeof fixedCode === 'string' ? fixedCode : null;
  const r = state.resume;
  setLobbyBusy(true);
  lobbyStatus(r ? `Getting you back into room ${fixed}…` : fixed ? `Room ${fixed} was empty, opening it again…` : 'Creating room…');
  if (!(await prepare())) { setLobbyBusy(false); return false; }
  for (let attempt = 0; attempt < (fixed ? 1 : 4); attempt++) {
    const code = fixed || makeCode();
    try {
      state.peer = await createPeer(ROOM_PREFIX + code);
      state.code = code;
      state.isHost = true;
      state.maxPeople = fixed
        ? ((prefs.lastRoom && prefs.lastRoom.code === fixed && prefs.lastRoom.size) || prefs.roomSize)
        : prefs.roomSize;
      state.joinedAt = (r && r.joinedAt) || Date.now();
      setMyColor(r && Number.isInteger(r.color) ? r.color : 0);
      wirePeer(state.peer);
      enterRoom();
      if (fixed && !r) toast(`Room ${code} is open again. Friends can join with the same code.`, 'ok');
      return true;
    } catch (e) {
      if (e && e.type === 'unavailable-id') continue;
      console.warn(e);
      cleanupMedia();
      setLobbyBusy(false);
      lobbyStatus('Couldn’t reach the connection server. Check your internet and try again.', 'err');
      return false;
    }
  }
  cleanupMedia();
  setLobbyBusy(false);
  lobbyStatus(fixed ? `Couldn’t reopen room ${fixed} yet. Try again in a minute, or create a new room.` : 'Couldn’t create a room right now. Try again.', 'err');
  return false;
}

async function joinRoom(opts) {
  const code = $('#codeInput').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 6) { lobbyStatus('Room codes are 6 characters.', 'err'); $('#codeInput').focus(); return; }
  const r = state.resume;
  setLobbyBusy(true);
  lobbyStatus(r ? `Getting you back into room ${code}…` : opts && opts.rejoin ? `Rejoining room ${code}…` : 'Joining…');
  if (!(await prepare())) { setLobbyBusy(false); return; }
  // Back after a restart: the same player ID, so friends see me come back
  // instead of a second me joining.
  const reuse = r && typeof r.peerId === 'string' && !r.peerId.startsWith(ROOM_PREFIX) ? r.peerId : undefined;
  try {
    state.peer = await createPeer(reuse).catch((e) => {
      if (reuse && e && e.type === 'unavailable-id') return createPeer(); // still taken: join as new
      throw e;
    });
  } catch (e) {
    console.warn(e);
    cleanupMedia();
    setLobbyBusy(false);
    lobbyStatus('Couldn’t reach the connection server. Check your internet and try again.', 'err');
    return;
  }
  state.code = code;
  state.isHost = false;
  state.rejoinCode = opts && opts.rejoin ? code : null;
  state.color = r && Number.isInteger(r.color) ? r.color : null; // confirmed when the room answers
  state.joinedAt = (r && r.joinedAt) || Date.now();
  wirePeer(state.peer);
  connectTo(roomId());
  state.joinTimer = setTimeout(() => {
    leave(true);
    lobbyStatus('The room didn’t answer. Make sure your friend is still in it.', 'err');
  }, 15000);
}

// After a crash the app reloads with ?rejoin=1: slip back into the room as
// the same player (same ID, colour, mute state) so friends barely notice.
async function autoRejoin() {
  const r = prefs.lastRoom;
  state.resume = { ...r };
  $('#codeInput').value = r.code;
  // I held the room's address: take it back (or, if someone else holds it now, join them).
  if (r.peerId === ROOM_PREFIX + r.code && (await createRoom(r.code))) return;
  if (document.body.dataset.view !== 'room') joinRoom({ rejoin: true });
}

// What a restart needs to put me back in the room as the same player.
function remember() {
  if (!state.code || !state.peer || document.body.dataset.view !== 'room') return;
  prefs.lastRoom = { code: state.code, at: Date.now(), size: state.maxPeople, peerId: state.peer.id,
                     color: state.color, joinedAt: state.joinedAt, muted: state.muted, deafened: state.deafened,
                     peers: [...state.peers.values()].filter((p) => p.greeted).map((p) => p.id).slice(0, MAX_LIMIT) };
  prefs.inRoom = true;
  savePrefs();
}

function enterRoom() {
  document.body.dataset.view = 'room';
  state.rejoinCode = null;
  $('#lobby').classList.add('hidden');
  $('#room').classList.remove('hidden');
  $('#roomCode').textContent = state.code;
  $('#inviteCodeText').textContent = state.code;
  document.title = `GameShare · Room ${state.code}`;
  const resumed = !!state.resume;
  const knew = resumed && Array.isArray(state.resume.peers) ? state.resume.peers : [];
  state.resume = null;
  remember();
  // Back after a restart: call the friends I was with right away, rather than
  // wait for them to notice my old links died.
  for (const id of knew) if (typeof id === 'string') connectTo(id);
  window.gameshare.inRoom(true);
  setLobbyBusy(false);
  lobbyStatus('');
  updateControls();
  renderPeople();
  layoutStage();
  applyGlobalKeys();
  clearInterval(netTimer);
  netTimer = setInterval(pollNet, 3000);
  clearInterval(healTimer);
  healTimer = setInterval(heal, 1000);
  state.quietUntil = resumed ? performance.now() + 15000 : 0;
  if (resumed) toast('GameShare hit a problem and restarted. You’re back in the room.', 'ok');
}

function cleanupMedia() {
  releaseMic();
  if (state.mic) state.mic.getTracks().forEach((t) => t.stop());
  state.mic = null;
  unwatchLevel('me');
}

function leave(silent = false) {
  // Leaving on purpose: say so (after stopping my share), or friends would
  // wait for me to reconnect.
  const sayBye = !!state.peer && !state.leaving && document.body.dataset.view === 'room';
  state.leaving = true;
  clearTimeout(state.joinTimer);
  clearTimeout(state.claim);
  state.claim = null;
  clearInterval(netTimer);
  netTimer = null;
  clearInterval(healTimer);
  healTimer = null;
  clearTimeout(news.timer);
  news.lost.clear();
  news.back.clear();
  if (prefs.inRoom) { prefs.inRoom = false; savePrefs(); }
  window.gameshare.inRoom(false);
  if (state.screen) stopShare();
  if (sayBye) broadcast({ type: 'bye' });
  for (const id of [...state.peers.keys()]) removePeer(id);
  for (const c of dialing.values()) { try { c.close(); } catch { /* ignore */ } }
  dialing.clear();
  missing.clear();
  if (state.doorman) { try { state.doorman.destroy(); } catch { /* ignore */ } }
  state.doorman = null;
  state.doormanOwner = null;
  if (state.peer) { try { state.peer.destroy(); } catch { /* ignore */ } }
  state.peer = null;
  cleanupMedia();
  state.code = null;
  state.isHost = false;
  for (const id of [...tiles.keys()]) removeTile(id, { keepLayout: true });
  delete $('#stage').dataset.focus;
  for (const r of rows.values()) r.li.remove();
  rows.clear();
  for (const m of partyEls.values()) m.el.remove();
  partyEls.clear();
  closePersonMenu();
  state.color = null;
  document.documentElement.style.removeProperty('--me');
  window.gameshare.setShortcuts(false).catch(() => {});
  state.globalKeys = [];
  document.title = 'GameShare';
  document.body.dataset.view = 'lobby';
  $('#room').classList.add('hidden');
  $('#lobby').classList.remove('hidden');
  closeSettings();
  setLobbyBusy(false);
  renderRejoin();
  pushOverlay();
  if (!silent) lobbyStatus('You left the room.');
}

function setPeoplePanel(show) {
  $('#room').classList.toggle('collapsed', !show);
  const b = $('#peopleToggle');
  b.setAttribute('aria-pressed', String(show));
  b.title = show ? 'Collapse the panel (Ctrl+Shift+P)' : 'Expand the panel (Ctrl+Shift+P)';
  prefs.people = show;
  savePrefs();
  closePersonMenu();
  scheduleLayout();
}

function toggleMute() {
  if (!state.mic || document.body.dataset.view !== 'room') return;
  state.muted = !state.muted;
  state.mic.getAudioTracks().forEach((t) => { t.enabled = !state.muted; });
  cue(state.muted ? 'mute' : 'unmute');
  broadcast(myState());
  remember();
  updateControls();
  renderPeople();
  pushOverlay();
}

async function copyInvite() {
  const text = `Join me on GameShare! Room code: ${state.code}`;
  try { await navigator.clipboard.writeText(text); toast('Invite copied. Paste it to your friends.', 'ok'); }
  catch { toast(`Room code: ${state.code}`); }
}

// System-wide mute shortcuts: only while in a room, and only if wanted.
function applyGlobalKeys() {
  const on = prefs.globalKeys !== false && document.body.dataset.view === 'room';
  window.gameshare.setShortcuts(on).then((ok) => { state.globalKeys = ok || []; }).catch(() => { state.globalKeys = []; });
}

/* ------------------------------------------------------------ settings menu */

function openSettings() {
  closePersonMenu();
  updateSizeControls();
  refreshDevices();
  micMeterOn = true;
  $('#settingsMenu').classList.remove('hidden');
  $('#settingsBtn').setAttribute('aria-expanded', 'true');
}
function closeSettings() {
  micMeterOn = false;
  $('#settingsMenu').classList.add('hidden');
  $('#settingsBtn').setAttribute('aria-expanded', 'false');
}

/* ------------------------------------------------------------ wiring */

function init() {
  document.body.dataset.view = 'lobby';
  try { $('#nameInput').value = localStorage.getItem('gs-name') || ''; } catch { /* ignore */ }
  renderRejoin();
  if (!$('#nameInput').value) $('#nameInput').focus();

  $('#createBtn').addEventListener('click', () => createRoom());
  $('#joinBtn').addEventListener('click', () => joinRoom());
  $('#rejoinBtn').addEventListener('click', () => {
    if (!prefs.lastRoom) return;
    $('#codeInput').value = prefs.lastRoom.code;
    joinRoom({ rejoin: true });
  });
  $('#codeInput').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  });
  // Pasting a whole message ("Join me on GameShare! Room code: ABC123") keeps just the code.
  $('#codeInput').addEventListener('paste', (e) => {
    const text = (e.clipboardData && e.clipboardData.getData('text') || '').toUpperCase();
    const code = findCode(text);
    e.preventDefault();
    e.target.value = code || text.replace(/[^A-Z0-9]/g, '').slice(0, 6);
  });
  $('#codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
  // Enter in the name box joins if a code is typed, otherwise creates a room.
  $('#nameInput').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if ($('#codeInput').value.length === 6) joinRoom(); else createRoom();
  });

  $('#micBtn').addEventListener('click', toggleMute);
  $('#deafenBtn').addEventListener('click', toggleDeafen);
  window.gameshare.appAudioSupported().then((ok) => { appAudio.supported = !!ok; }).catch(() => {});
  window.gameshare.version().then((v) => {
    state.version = String(v || '');
    $('#lobbyVersion').textContent = `v${state.version}`;
    $('#menuVersion').textContent = `GameShare v${state.version}`;
  }).catch(() => {});
  window.gameshare.onShortcut((action) => {
    if (action === 'mute') toggleMute();
    if (action === 'deafen') toggleDeafen();
  });
  window.gameshare.onWindowVisible((visible) => {
    state.windowVisible = !!visible;
    clearTimeout(viewTimer);
    sendViews();
  });

  // Settings
  $('#settingsBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    if ($('#settingsMenu').classList.contains('hidden')) openSettings(); else closeSettings();
  });
  $('#settingsMenu').addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', closeSettings);
  $('#headphonesBtn').addEventListener('click', () => setHeadphones(!state.headphones));
  $('#noiseBtn').addEventListener('click', async () => {
    prefs.noiseRemoval = prefs.noiseRemoval === false;
    if (prefs.noiseRemoval) mic.failed = false; // give it another try
    savePrefs();
    updateControls();
    await swapMic();
    updateControls();
  });
  $('#overlayBtn').addEventListener('click', () => {
    prefs.overlay = prefs.overlay !== true;
    savePrefs();
    updateControls();
    pushOverlay();
    if (prefs.overlay) toast('Overlay on: it shows who’s talking while you’re in another window, like your game.');
  });
  $('#overlayCorner').addEventListener('change', (e) => {
    prefs.overlayCorner = e.target.value;
    savePrefs();
    pushOverlay();
  });
  $('#diagBtn').addEventListener('click', copyDiagnostics);
  setStats(prefs.stats);
  $('#micSelect').addEventListener('change', async (e) => {
    prefs.micId = e.target.value;
    savePrefs();
    await swapMic();
  });
  $('#outSelect').addEventListener('change', async (e) => {
    prefs.outId = e.target.value;
    savePrefs();
    await applyOutput();
    cue('join'); // a quick sound so you can hear where it plays
  });
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => {
      if (!$('#settingsMenu').classList.contains('hidden')) refreshDevices();
      applyOutput();
    });
  }
  $('#globalKeysBtn').addEventListener('click', () => {
    prefs.globalKeys = prefs.globalKeys === false;
    savePrefs();
    updateControls();
    applyGlobalKeys();
  });
  $('#soundsBtn').addEventListener('click', () => {
    prefs.sounds = !prefs.sounds;
    savePrefs();
    updateControls();
    if (prefs.sounds) cue('join');
  });
  $('#qualitySelect').value = state.quality;
  $('#qualitySelect').addEventListener('change', async (e) => {
    state.quality = e.target.value;
    prefs.quality = state.quality;
    savePrefs();
    if (state.screen) {
      const track = state.screen.getVideoTracks()[0];
      if (track) await applyCaptureQuality(track);
      for (const p of state.peers.values()) p.encSig = null;
      retuneAll();
      toast('Quality updated');
    }
  });
  updateControls();

  $('#peopleToggle').addEventListener('click', () => setPeoplePanel($('#room').classList.contains('collapsed')));
  setPeoplePanel(prefs.people !== false);
  $('#shareBtn').addEventListener('click', () => (state.screen ? stopShare() : startShare()));
  $('#leaveBtn').addEventListener('click', () => leave());
  $('#copyBtn').addEventListener('click', copyInvite);
  $('#inviteCode').addEventListener('click', copyInvite);
  $('#inviteCopy').addEventListener('click', copyInvite);

  // Room size: lobby picker, and the host's stepper in Settings
  renderSizePicker();
  $('#sizePicker').addEventListener('keydown', (e) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    prefs.roomSize = clamp(prefs.roomSize + d, MIN_SIZE, MAX_LIMIT);
    savePrefs();
    renderSizePicker();
    const pip = $('#sizePicker').children[prefs.roomSize - 1];
    if (pip) pip.focus();
  });
  $('#sizeDown').addEventListener('click', () => setRoomSize(state.maxPeople - 1));
  $('#sizeUp').addEventListener('click', () => setRoomSize(state.maxPeople + 1));

  // Player menu
  const menu = $('#personMenu');
  menu.querySelector('.pop-vol').addEventListener('input', (e) => {
    const p = state.peers.get(menuKey);
    e.target.style.setProperty('--fill', `${e.target.value}%`);
    if (p) { p.volume = Number(e.target.value) / 100; p.audio.volume = p.volume; }
  });
  menu.querySelector('.pop-mute').addEventListener('click', () => { if (menuKey) toggleLocalMute(menuKey); });
  menu.querySelector('.pop-watch').addEventListener('click', () => {
    const p = state.peers.get(menuKey);
    if (!p) return;
    if (p.hidden) reopenTile(p.id); else closeTile(p.id);
  });
  document.addEventListener('pointerdown', (e) => {
    if (menu.classList.contains('hidden')) return;
    if (menu.contains(e.target) || (e.target.closest && e.target.closest('.person'))) return;
    closePersonMenu();
  });
  window.addEventListener('resize', positionPersonMenu);
  $('#peopleList').addEventListener('scroll', positionPersonMenu);

  document.querySelectorAll('#picker .tab').forEach((t) => t.addEventListener('click', () => {
    pickerKind = t.dataset.kind;
    renderSources();
  }));
  $('#audioCheck').addEventListener('change', (e) => { prefs.shareSound = e.target.checked; savePrefs(); });
  $('#pickerCancel').addEventListener('click', () => closePicker(null));
  $('#pickerRefresh').addEventListener('click', loadSources);
  $('#pickerGo').addEventListener('click', goPicker);
  $('#picker').addEventListener('click', (e) => { if (e.target.id === 'picker') closePicker(null); });

  new ResizeObserver(scheduleLayout).observe($('#stage'));

  document.addEventListener('keydown', (e) => {
    const pickerOpen = !$('#picker').classList.contains('hidden');
    if (e.key === 'Escape') {
      if (pickerOpen) closePicker(null);
      closeSettings();
      closePersonMenu();
    }
    if (e.key === 'Enter' && pickerOpen && pickerSelected && !e.repeat) { e.preventDefault(); goPicker(); }
    const inRoom = document.body.dataset.view === 'room';
    if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || !inRoom) return;
    const k = e.key.toLowerCase();
    // When registered system-wide these arrive through onShortcut instead.
    if (k === 'm' && !state.globalKeys.includes('mute')) { e.preventDefault(); toggleMute(); }
    if (k === 'd' && !state.globalKeys.includes('deafen')) { e.preventDefault(); toggleDeafen(); }
    if (k === 'p') { e.preventDefault(); setPeoplePanel($('#room').classList.contains('collapsed')); }
  });

  // Closing the window while in a room: the main process waits a moment so
  // the goodbye goes out (otherwise friends would see "Reconnecting…").
  window.gameshare.onClosing(() => {
    leave(true);
    setTimeout(() => window.gameshare.closeNow(), 150);
  });
  window.addEventListener('beforeunload', () => {
    if (!state.leaving && state.peer && document.body.dataset.view === 'room') broadcast({ type: 'bye' });
    state.leaving = true;
    if (state.doorman) state.doorman.destroy();
    if (state.peer) state.peer.destroy();
  });

  // Reloaded after a crash while in a room: straight back in.
  const crashed = new URLSearchParams(location.search).get('rejoin') === '1';
  const last = prefs.lastRoom;
  if (crashed && prefs.inRoom && last && last.code && $('#nameInput').value.trim()) {
    autoRejoin();
  } else if (prefs.inRoom) {
    prefs.inRoom = false;
    savePrefs();
  }
}

init();
