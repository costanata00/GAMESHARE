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
// Pull a room code out of pasted text such as "Join me on GameShare! Room code: AB3CDE"
// (or the Portuguese invite, "Código da sala: AB3CDE").
// Only whole 6-character words count, so "GAMESHARE" is never mistaken for a code.
function findCode(text) {
  const t = String(text || '').toUpperCase();
  const C = '[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}';
  const labelled = new RegExp(`(?:CODE|ROOM|SALA|C[OÓ]DIGO)\\W{0,3}(${C})(?![A-Z0-9])`).exec(t);
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
// Bitrate choices in Settings (kbps per friend). 'auto' = the preset's, ×1.5 in Video mode.
const BITRATES = [3000, 5000, 8000, 12000, 16000, 20000];
// All viewers of my screen together get at most this many times the preset's
// bitrate, so a big room can't flood my upload (which makes everyone stutter).
const UPLOAD_BUDGET = 2;
const MIN_VIEWER_BITRATE = 350_000;
// Incoming screens play this far behind live so late packets still make it
// (grows by itself if freezes still happen). Voice is not delayed.
const SCREEN_BUFFER_MS = 200, SCREEN_BUFFER_MAX = 600;
// Sharing modes, picked by the sharer in the share picker:
//  - 'game': everything above. Lowest delay.
//  - 'video' (films, YouTube, a player): smoothness beats delay. Friends play
//    that screen about a second behind live, which absorbs hiccups (more if
//    freezes still happen), and the sharer's encoder gets more bitrate so it
//    drops fewer frames. Voice is still not delayed.
const VIDEO_BUFFER_MS = 1000, VIDEO_BUFFER_MAX = 3000, VIDEO_BITRATE_BOOST = 1.5;
// What a friend's hello / state / call says about their share. 1.6 only knew
// "movie: true", which is treated as Video mode.
const modeOf = (m) => (m && (m.mode === 'video' || (m.mode == null && m.movie)) ? 'video' : 'game');
const isVideo = (p) => p.screenMode === 'video';
const bufferBase = (p) => (isVideo(p) ? VIDEO_BUFFER_MS : SCREEN_BUFFER_MS);
const bufferMax = (p) => (isVideo(p) ? VIDEO_BUFFER_MAX : SCREEN_BUFFER_MAX);
// Windows that usually show a film or a video: the picker suggests Video mode
// for them (it never switches by itself).
// (Browser windows are titled "<page> - <browser name>".)
const BROWSER_RE = /(google chrome|chromium|firefox|microsoft\W{0,3}edge|opera( gx)?|brave|vivaldi|safari)\s*$/i;
const PLAYER_RE = /\bvlc\b|\bmpv\b|mpc-hc|mpc-be|media player|potplayer|\bkodi\b|\bplex\b|stremio|netflix|youtube|prime video|disney\+|twitch|movies & tv|filmes e tv/i;
const looksLikeVideo = (name) => BROWSER_RE.test(name || '') || PLAYER_RE.test(name || '');
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
              micId: '', outId: '', duck: false, duckTo: 40, sbVolume: 60, noiseRemoval: true, overlay: false, overlayCorner: 'top left', stats: false, shareMode: null, lang: 'auto', bitrate: 'auto', updateCheck: true, skipUpdate: null };
  try {
    Object.assign(d, JSON.parse(localStorage.getItem('gs-prefs') || '{}'));
    // carry over settings from older versions
    if (localStorage.getItem('gs-headphones') === '1') d.headphones = true;
    if (localStorage.getItem('gs-people') === 'hidden') d.people = false;
    localStorage.removeItem('gs-headphones');
    localStorage.removeItem('gs-people');
  } catch { /* ignore */ }
  if (!QUALITY[d.quality]) d.quality = '1080p30';
  // 1.6 had a "Movie mode" switch in Settings; it became the Video mode.
  if (d.shareMode !== 'game' && d.shareMode !== 'video') d.shareMode = d.movie === true ? 'video' : 'game';
  delete d.movie;
  if (!BITRATES.includes(Number(d.bitrate))) d.bitrate = 'auto';
  d.roomSize = Math.min(MAX_LIMIT, Math.max(MIN_SIZE, Number(d.roomSize) || DEFAULT_SIZE));
  d.duckTo = Math.min(80, Math.max(10, Number(d.duckTo) || 40));
  d.sbVolume = Math.min(100, Math.max(5, Number(d.sbVolume) || 60));
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
  mode: 'game',         // sharing mode of my current share: 'game' or 'video'
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
  quietUntil: 0,        // no "joined" toasts until then (friends reconnecting after my restart)
  cinema: null          // cinema mode: the id of the friend's screen that fills the window
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

// A notice that stays until it's closed (one per key), for things worth
// reading properly. Shown where the toasts are.
const notices = new Map();
function showNotice(key, title, text) {
  closeNotice(key);
  const n = el('div', 'toast notice warn');
  n.setAttribute('role', 'alert');
  const x = el('button', 'notice-close', '✕');
  x.title = tr('Close');
  x.setAttribute('aria-label', x.title);
  x.addEventListener('click', () => closeNotice(key));
  n.append(el('b', null, title), el('p', null, text), x);
  $('#toasts').appendChild(n);
  notices.set(key, n);
}
function closeNotice(key) {
  const n = notices.get(key);
  if (n) n.remove();
  notices.delete(key);
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
    labels: { muted: tr('You’re muted'), deafened: tr('Voices muted') },
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
  if (key !== 'me') { pushOverlay(); updateDuck(); }
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
// Start screen video at a decent bitrate instead of ramping up from blurry,
// and never let the bandwidth estimate fall below a floor: a share squeezed to
// a few dozen kbps sends so little that the estimate can't climb back, and the
// picture stays tiny (seen: 320×180 at 39 kbps on a healthy link).
const SCREEN_START_KBPS = 1500, SCREEN_MIN_KBPS = 250;
function videoBitrates(sdp, startKbps, minKbps) {
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
    const add = [['x-google-start-bitrate', startKbps], ['x-google-min-bitrate', minKbps]];
    if (f >= 0) {
      for (const [k, v] of add) if (!lines[f].includes(k)) lines[f] += `;${k}=${v}`;
    } else {
      const r = lines.findIndex((l, i) => i > mIdx && i < end && l.startsWith(`a=rtpmap:${pt} `));
      lines.splice(r + 1, 0, `a=fmtp:${pt} ${add.map(([k, v]) => `${k}=${v}`).join(';')}`);
      end++;
    }
  }
  return lines.join('\r\n');
}

// The stream's sound is stereo music / film / game audio, not voice: Opus in
// stereo with room to breathe (more in Video mode, where it's the soundtrack),
// and never skipping "silence" (DTX), which would chop quiet passages. This
// track doesn't come from a microphone, so it gets no echo cancellation,
// automatic gain or noise suppression either: those are only on the mic.
const STREAM_AUDIO_BPS = { game: 128_000, video: 192_000 };
// mode: of the share this call carries. Both sides put the same numbers in
// their half of the call setup; the sharer's encoder is also told directly
// (see tuneSenders).
function screenSdp(mode) {
  const want = { stereo: 1, 'sprop-stereo': 1, maxaveragebitrate: STREAM_AUDIO_BPS[mode] || STREAM_AUDIO_BPS.game, usedtx: 0 };
  return (sdp) => {
    sdp = preferCodecs(sdp, 'video', (name) => name === 'h264');
    sdp = videoBitrates(sdp, SCREEN_START_KBPS, SCREEN_MIN_KBPS);
    const m = sdp.match(/a=rtpmap:(\d+) opus\/48000/);
    if (!m) return sdp;
    return sdp.replace(new RegExp(`a=fmtp:${m[1]} ([^\\r\\n]*)`), (line, params) => {
      const kept = params.split(';').filter((kv) => kv && !(kv.split('=')[0].trim() in want));
      return `a=fmtp:${m[1]} ${kept.concat(Object.entries(want).map(([k, v]) => `${k}=${v}`)).join(';')}`;
    });
  };
}

/* ------------------------------------------------------------ shared app sound */

// stat: the sound buffer's last report (see app-audio-worklet.js)
const appAudio = { supported: false, ctx: null, node: null, track: null, info: null, port: null, stat: null, direct: false };

// The main process's direct line for the sound (see preload.js). It can
// arrive before or after the audio node exists; whichever comes second
// connects them.
window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || e.data.gsAppAudioPort !== true || !e.ports.length) return;
  appAudio.port = e.ports[0];
  feedAppAudio();
});
function feedAppAudio() {
  if (!appAudio.port || !appAudio.node) return;
  const port = appAudio.port;
  appAudio.port = null;
  try { appAudio.node.port.postMessage({ feed: port }, [port]); appAudio.direct = true; } catch (e) { console.warn('app audio port', e); }
}

// Why the sound helper couldn't start, in words (its own messages are technical English).
function audioWhy(msg) {
  const m = String(msg || '');
  if (/only available on Windows/i.test(m)) return tr('it only works on Windows');
  if (/Windows 10 version 2004/i.test(m)) return tr('it needs Windows 10 version 2004 or newer');
  if (/window not found/i.test(m)) return tr('that window was closed');
  if (/timed out/i.test(m)) return tr('sound capture took too long to start');
  if (/helper exited/i.test(m)) return tr('the sound capture stopped');
  return m;
}

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
    if (appAudio.node === node && state.screen) toast(tr('The shared app’s sound stopped.'), 'warn');
  });
  node.port.onmessage = (e) => { if (appAudio.node === node) appAudio.stat = { ...e.data, at: performance.now() }; };
  appAudio.node = node;
  appAudio.stat = null;
  appAudio.direct = false;
  feedAppAudio();
  appAudio.track = dest.stream.getAudioTracks()[0];
  appAudio.track.contentHint = 'music';
  return appAudio.track;
}

function stopAppAudioTrack() {
  window.gameshare.stopAppAudio();
  if (appAudio.node) { try { appAudio.node.disconnect(); } catch { /* ignore */ } appAudio.node = null; }
  appAudio.port = null;
  appAudio.stat = null;
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
    t.video.volume = (p.streamVolume == null ? 1 : p.streamVolume) * duck.level;
  }
}

/* Voice over the film (Settings → Voice, off by default, only for me): while
 * a friend I can hear is talking, every stream's sound drops to a share of
 * its volume (prefs.duckTo, in %), and comes back when they stop. Down
 * quickly (about 0.2 s), back up gently (about 0.6 s after a short hold), so
 * it doesn't pump between words. */
const duck = { level: 1, timer: null, holdUntil: 0 };

function friendTalking() {
  if (state.deafened) return false;
  for (const p of state.peers.values()) if (p.greeted && !p.localMuted && isSpeaking(p.id)) return true;
  return false;
}

function stepDuck() {
  const now = performance.now();
  const on = prefs.duck === true;
  if (on && friendTalking()) duck.holdUntil = now + 500;
  const target = on && now < duck.holdUntil ? clamp(prefs.duckTo, 10, 80) / 100 : 1;
  const before = duck.level;
  duck.level = target < before ? Math.max(target, before - 0.15) : Math.min(target, before + 0.04);
  if (duck.level !== before) {
    for (const [id, t] of tiles) {
      const p = state.peers.get(id);
      if (p && !t.isMe) t.video.volume = (p.streamVolume == null ? 1 : p.streamVolume) * duck.level;
    }
  } else if (target === 1) {
    clearInterval(duck.timer);
    duck.timer = null;
  }
}

// Someone started or stopped talking, or the setting changed.
function updateDuck() {
  if (!duck.timer && (prefs.duck === true || duck.level !== 1)) duck.timer = setInterval(stepDuck, 40);
}

function updateDuckUi() {
  $('#duckBtn').setAttribute('aria-checked', String(prefs.duck === true));
  $('#duckRow').classList.toggle('hidden', prefs.duck !== true);
  $('#duckSlider').value = String(prefs.duckTo);
  $('#duckSlider').style.setProperty('--fill', `${((prefs.duckTo - 10) / 70) * 100}%`);
  $('#duckText').textContent = tr('Streams play at {n}% of their volume while a friend talks', { n: prefs.duckTo });
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

/* ------------------------------------------------------------ soundboard
 * Short sounds you add yourself (any audio file Chromium can read). They are
 * kept on this computer, in the app's own storage (IndexedDB), so they are
 * still there the next time GameShare opens. Nothing is uploaded: a sound
 * only leaves this PC as audio, while it plays.
 *
 * Playing one: you hear it through your speakers, and friends hear it in
 * your voice. For as long as it plays, what's sent to each friend is your
 * microphone mixed with the sound, swapped in on the open voice calls
 * without reconnecting (like changing microphones) and swapped back when it
 * ends. The rest of the time the voice path is exactly as before. A muted
 * microphone adds silence to the mix, so sounds work while you're muted.
 * It goes out as voice (mono, 64 kbps), so friends on any version hear it. */
const SB_MAX_SOUNDS = 30, SB_MAX_MB = 10, SB_MAX_SECONDS = 60;
const sb = { db: null, sounds: [], buffers: new Map(), playing: null, loaded: false };

function sbDb() {
  if (sb.db) return sb.db;
  sb.db = new Promise((resolve, reject) => {
    const req = indexedDB.open('gs-soundboard', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('sounds', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  sb.db.catch(() => { sb.db = null; });
  return sb.db;
}
// One request against the sounds store; resolves with its result.
async function sbStore(mode, fn) {
  const db = await sbDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('sounds', mode);
    const req = fn(tx.objectStore('sounds'));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

async function sbLoad() {
  if (sb.loaded) return;
  sb.loaded = true;
  try {
    const all = (await sbStore('readonly', (s) => s.getAll())) || [];
    sb.sounds = all.sort((a, b) => a.added - b.added);
  } catch (e) { console.warn('soundboard', e); sb.sounds = []; }
  sbRender();
}

async function sbBuffer(sound) {
  let buf = sb.buffers.get(sound.id);
  if (!buf) {
    buf = await ctx().decodeAudioData(sound.data.slice(0)); // (decoding empties the buffer it's given)
    sb.buffers.set(sound.id, buf);
  }
  return buf;
}

async function sbAddFiles(files) {
  let added = 0;
  for (const f of files) {
    const name = f.name.replace(/\.[^.]+$/, '').trim().slice(0, 40) || tr('Sound');
    if (sb.sounds.length >= SB_MAX_SOUNDS) { toast(tr('The soundboard is full ({n} sounds). Remove one first.', { n: SB_MAX_SOUNDS }), 'warn'); break; }
    if (f.size > SB_MAX_MB * 1024 * 1024) { toast(tr('“{name}” is too big (over {n} MB).', { name, n: SB_MAX_MB }), 'warn'); continue; }
    let data, buf;
    try {
      data = await f.arrayBuffer();
      buf = await ctx().decodeAudioData(data.slice(0));
    } catch { toast(tr('Couldn’t read “{name}” as audio.', { name }), 'warn'); continue; }
    if (buf.duration > SB_MAX_SECONDS) { toast(tr('“{name}” is too long (over {n} s).', { name, n: SB_MAX_SECONDS }), 'warn'); continue; }
    const sound = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, name, data, added: Date.now() };
    try { await sbStore('readwrite', (s) => s.put(sound)); } catch (e) {
      console.warn('soundboard save', e);
      toast(tr('Couldn’t save the sound on this computer.'), 'err');
      break;
    }
    sb.sounds.push(sound);
    sb.buffers.set(sound.id, buf);
    added++;
  }
  if (added) toast(tr(added === 1 ? '{n} sound added' : '{n} sounds added', { n: added }), 'ok');
  sbRender();
}

async function sbRemove(id) {
  const sound = sb.sounds.find((s) => s.id === id);
  if (!sound) return;
  if (sb.playing && sb.playing.id === id) sbStop();
  try { await sbStore('readwrite', (s) => s.delete(id)); } catch (e) { console.warn('soundboard delete', e); }
  sb.sounds = sb.sounds.filter((s) => s.id !== id);
  sb.buffers.delete(id);
  toast(tr('“{name}” removed', { name: sound.name }));
  sbRender();
}

// What friends get from me on the open voice calls: `track`.
async function sbSend(track) {
  if (!track) return;
  for (const p of state.peers.values()) {
    const pc = p.voice && p.voice.peerConnection;
    if (!pc || pc.connectionState === 'closed') continue;
    for (const sender of pc.getSenders()) {
      if (sender.track && sender.track.kind === 'audio' && sender.track !== track) {
        try { await sender.replaceTrack(track); } catch (e) { console.warn('soundboard replaceTrack', e); }
      }
    }
  }
}

function sbStop() {
  const p = sb.playing;
  if (!p) return;
  sb.playing = null;
  p.src.onended = null;
  try { p.src.stop(); } catch { /* ignore */ }
  // Back to the plain microphone, then take the mixer apart.
  sbSend(state.mic && state.mic.getAudioTracks()[0]).finally(() => {
    for (const n of [p.src, p.gain, p.micSrc]) { try { n && n.disconnect(); } catch { /* ignore */ } }
    p.dest.stream.getTracks().forEach((t) => t.stop());
  });
  sbRender();
}

async function sbPlay(id) {
  const again = sb.playing && sb.playing.id === id;
  sbStop();
  if (again) return; // clicking the sound that's playing stops it
  const sound = sb.sounds.find((s) => s.id === id);
  if (!sound || !state.mic || document.body.dataset.view !== 'room') return;
  let buf;
  try { buf = await sbBuffer(sound); } catch (e) {
    console.warn('soundboard decode', e);
    toast(tr('Couldn’t play that sound.'), 'err');
    return;
  }
  if (sb.playing) return; // another click got here first
  const c = ctx();
  const src = c.createBufferSource();
  src.buffer = buf;
  const gain = c.createGain();
  gain.gain.value = clamp(prefs.sbVolume, 5, 100) / 100;
  const dest = c.createMediaStreamDestination();
  dest.channelCount = 1;
  src.connect(gain);
  gain.connect(c.destination); // for me
  gain.connect(dest);          // for friends, with my microphone
  let micSrc = null;
  if (state.mic.getAudioTracks().length) {
    try { micSrc = c.createMediaStreamSource(state.mic); micSrc.connect(dest); } catch (e) { console.warn('soundboard mic', e); }
  }
  const playing = { id, src, gain, dest, micSrc };
  sb.playing = playing;
  sbRender();
  await sbSend(dest.stream.getAudioTracks()[0]);
  if (sb.playing !== playing) return; // stopped meanwhile
  src.onended = () => { if (sb.playing === playing) sbStop(); };
  src.start();
}

function sbRender() {
  const grid = $('#sbGrid');
  if (!grid) return;
  grid.replaceChildren();
  if (!sb.sounds.length) {
    grid.appendChild(el('p', 'sb-empty', tr('No sounds yet. Add audio files (MP3, WAV, OGG…) and they stay saved on this computer.')));
  }
  for (const s of sb.sounds) {
    const b = el('button', 'sb-sound');
    b.type = 'button';
    b.title = s.name;
    b.classList.toggle('playing', !!sb.playing && sb.playing.id === s.id);
    b.appendChild(el('span', null, s.name));
    b.addEventListener('click', () => sbPlay(s.id));
    const x = el('span', 'sb-del', '✕');
    x.setAttribute('role', 'button');
    x.tabIndex = 0;
    x.title = tr('Remove “{name}”', { name: s.name });
    x.setAttribute('aria-label', x.title);
    const del = (e) => { e.stopPropagation(); e.preventDefault(); sbRemove(s.id); };
    x.addEventListener('click', del);
    x.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') del(e); });
    b.appendChild(x);
    grid.appendChild(b);
  }
  const v = $('#sbVolume');
  v.value = String(prefs.sbVolume);
  v.style.setProperty('--fill', `${((prefs.sbVolume - 5) / 95) * 100}%`);
}

function openSounds() {
  closeSettings();
  closePersonMenu();
  sbLoad();
  sbRender();
  $('#soundMenu').classList.remove('hidden');
  $('#sbBtn').setAttribute('aria-expanded', 'true');
}
function closeSounds() {
  $('#soundMenu').classList.add('hidden');
  $('#sbBtn').setAttribute('aria-expanded', 'false');
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
      toast(tr('Your chosen microphone isn’t connected. Using the system default.'), 'warn');
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
      toast(tr('Background noise removal couldn’t start. Using the standard noise filter.'), 'warn');
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
    toast(tr('No microphone found. You can listen and share, but others won’t hear you.'), 'warn');
    state.micReal = false;
    return silentStream();
  }
  state.micReal = true;
  mic.raw = raw;
  const track = raw.getAudioTracks()[0];
  // Headset unplugged mid-call: carry on with the system default mic.
  if (track) track.onended = () => {
    if (document.body.dataset.view !== 'room' || mic.raw !== raw) return;
    toast(tr('Your microphone was disconnected. Switching to the system default.'), 'warn');
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
    sbStop(); // a soundboard sound was mixed with the old microphone
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
  toast(on ? tr('Headphones mode on: echo cancellation off for clearer voice.') : tr('Headphones mode off: echo cancellation on.'));
}

/* ------------------------------------------------------------ devices
 * Settings lists your microphones and speakers/headsets. Friends' voices,
 * their stream sound and the sound effects all play on the chosen output. */

function deviceLabel(d, i, kind) {
  return d.label || (kind === 'audioinput' ? tr('Microphone {n}', { n: i + 1 }) : tr('Speakers {n}', { n: i + 1 }));
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
      ? tr('System default ({name})', { name: sysDefault.label.replace(/^Default\s*-\s*/i, '') }) : tr('System default'))];
    opts[0].value = '';
    real.forEach((d, i) => { const o = el('option', null, deviceLabel(d, i, kind)); o.value = d.deviceId; opts.push(o); });
    const want = prefs[pref] || '';
    if (want && !real.some((d) => d.deviceId === want)) {
      const o = el('option', null, tr('Disconnected device')); o.value = want; o.disabled = true; opts.push(o);
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
      id, name: tr('Friend'), muted: false, sharing: false, greeted: false,
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
  return { type: 'state', name: state.name, muted: state.muted, sharing: !!state.screen, deafened: state.deafened, color: state.color,
           mode: state.screen ? state.mode : null,
           movie: !!state.screen && state.mode === 'video' }; // movie: what 1.6 understands
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
    toast(tr('{name} started sharing', { name: p.name }), 'ok');
    cue('share');
    attention();
  }
  if (!sharing) { p.announced = false; p.audioDelay = null; }
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
    toast(reason === 'lost connection' ? tr('{name} lost connection', { name: p.name }) : tr('{name} left', { name: p.name }));
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
    const who = (m) => (m.size <= 2 ? [...m.values()].join(` ${tr('and')} `) : tr('{n} friends', { n: m.size }));
    const friends = [...state.peers.values()].filter((q) => q.greeted);
    if (news.lost.size && !state.leaving) {
      const mine = (state.peer && state.peer.disconnected) || (friends.length > 1 && friends.every((q) => q.lost));
      toast(mine ? tr('Your connection dropped. Reconnecting…') : tr('Lost the connection to {who}. Reconnecting…', { who: who(news.lost) }), 'warn');
      cue('leave');
    }
    if (news.back.size && !state.leaving) {
      toast(trn(news.back.size, '{who} is back', '{who} are back', { who: who(news.back) }), 'ok');
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
      p.name = String(msg.name || tr('Friend')).slice(0, 24);
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
        toast(tr('{name} joined', { name: p.name }), 'ok');
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
        p.name = String(msg.name || tr('Friend')).slice(0, 24);
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
        lobbyStatus(tr('You were disconnected and room {code} filled up meanwhile ({n} players).', { code, n: max }), 'err');
        break;
      }
      clearTimeout(state.joinTimer);
      leave(true);
      lobbyStatus(tr('That room is full ({n} players). Ask the host to make it bigger in Settings.', { n: max }), 'err');
      break;
    }
    case 'state': {
      p.name = String(msg.name || p.name).slice(0, 24);
      p.muted = !!msg.muted;
      p.deafened = !!msg.deafened;
      if (Number.isInteger(msg.color) && msg.color >= 0 && msg.color < PLAYER_COLORS.length) p.color = msg.color;
      noteSharing(p, !!msg.sharing);
      if (!p.sharing) p.hidden = false;
      setScreenMode(p, msg.sharing ? modeOf(msg) : 'game');
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
        toast(tr('Room size is now {n} players', { n }));
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
    // About the screen they're sharing with me: how long its sound waits on
    // their side before it's sent (see applyScreenBuffer).
    case 'share-info': {
      const d = Number(msg.audioDelay);
      const before = audioLead(p);
      p.audioDelay = Number.isFinite(d) && d > 0 ? Math.min(500, d) : null;
      if (audioLead(p) !== before) applyScreenBuffer(p);
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

// Lip sync in Video mode. WebRTC lines sound and picture up by when each was
// captured, but the shared app's sound reaches the sharer's GameShare a little
// after the picture does (it waits in a small buffer, see
// app-audio-worklet.js), so it would play that much late. The sharer says how
// long that wait is ('share-info'), and the viewer plays the sound that much
// sooner. Up to SYNC_LEAD_MAX only: WebRTC leaves differences under 30 ms
// alone and would undo anything bigger.
const SYNC_LEAD_MAX = 25;
const audioLead = (p) => (isVideo(p) && p.audioDelay > 0 ? Math.min(SYNC_LEAD_MAX, Math.round(p.audioDelay / 5) * 5) : 0);

// Video and the stream's sound share one target so they stay in sync.
function applyScreenBuffer(p) {
  const pc = p.screenIn && p.screenIn.peerConnection;
  if (!pc) return;
  const target = p.screenBuffer || bufferBase(p);
  for (const r of pc.getReceivers()) {
    if (r.track && 'jitterBufferTarget' in r) {
      try { r.jitterBufferTarget = r.track.kind === 'audio' ? Math.max(0, target - audioLead(p)) : target; } catch { /* ignore */ }
    }
  }
}

// A friend's share changed mode: start over from the matching cushion.
function setScreenMode(p, mode) {
  if ((p.screenMode || 'game') === mode) return;
  p.screenMode = mode;
  p.screenBuffer = bufferBase(p);
  p.freezePrev = null;
  applyScreenBuffer(p);
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
    const before = p.screenBuffer || bufferBase(p);
    if (freezes > p.freezePrev) {
      p.screenBuffer = Math.min(bufferMax(p), before + (isVideo(p) ? 500 : 100));
      p.calmSince = now;
    } else if (now - p.calmSince > 30000 && before > bufferBase(p)) {
      p.screenBuffer = Math.max(bufferBase(p), before - (isVideo(p) ? 125 : 50));
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
    call.answer(undefined, { sdpTransform: screenSdp(modeOf(call.metadata)) }); // receive only
    const snd = call.metadata && call.metadata.sound;
    p.screenSound = snd && typeof snd === 'object'
      ? { sound: String(snd.sound || 'none'), app: snd.app ? String(snd.app).slice(0, 60) : null }
      : null; // null = friend runs an older GameShare that doesn't say
    p.screenMode = modeOf(call.metadata);
    p.screenBuffer = bufferBase(p);
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
      toast(tr('Couldn’t reach a friend directly — their network may be blocking it.'), 'warn');
    }
    updateNetBadge();
  });
}

function sendScreenTo(p) {
  if (!state.screen || !state.peer || state.peer.disconnected) return;
  if (p.screenOut) { const old = p.screenOut; p.screenOut = null; try { old.close(); } catch { /* ignore */ } }
  const call = state.peer.call(p.id, state.screen, { metadata: { kind: 'screen', sound: state.screenSound, mode: state.mode, movie: state.mode === 'video' }, sdpTransform: screenSdp(state.mode) });
  if (!call) return;
  call.gsAt = performance.now();
  p.screenOut = call;
  p.infoSig = null; // tell this viewer about the share again (see watchShare)
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
  const rate = shareBitrate();
  const v = p && p.view;
  const track = state.screen && state.screen.getVideoTracks()[0];
  const srcH = (track && track.getSettings().height) || q.h;
  const watching = [...state.peers.values()].filter((x) => x.screenOut && !x.lost && !(x.view && x.view.paused)).length;
  // Until a viewer says how big they show it, a room with several viewers starts at 720p.
  const scale = v && v.h ? Math.max(1, srcH / v.h) : (watching > 2 ? Math.max(1, srcH / 720) : 1);
  const slice = (rate * UPLOAD_BUDGET) / Math.max(1, watching);
  const active = !(v && v.paused);
  const want = {
    active,
    scale: Math.round(scale * 100) / 100,
    bitrate: Math.round(Math.max(MIN_VIEWER_BITRATE, Math.min(rate / Math.pow(scale, 1.5), slice))),
    fps: q.fps,
    // Busy PC or connection: keep the frame rate and let the picture soften.
    // Except in Video mode while the picture stands still (a paused film, a
    // menu): then sharpness is all that matters, so small text and subtitles
    // stay readable (see watchShare).
    pref: share.still ? 'maintain-resolution' : 'maintain-framerate'
  };
  const sig = JSON.stringify(want);
  if (p) p.encWant = want;
  if (p && p.encSig === sig && p.encPc === pc) return;
  if (p) { p.encSig = sig; p.encPc = pc; }
  for (const sender of pc.getSenders()) {
    if (!sender.track || sender.track.kind !== 'video') continue;
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    params.degradationPreference = want.pref;
    const enc = params.encodings[0];
    enc.active = want.active;
    enc.scaleResolutionDownBy = want.scale;
    enc.maxBitrate = want.bitrate;
    enc.maxFramerate = want.fps;
    enc.priority = 'low';
    enc.networkPriority = 'low';
    try { await sender.setParameters(params); } catch (e) { console.warn('setParameters', e); if (p) p.encSig = null; }
  }
  // The stream's sound: the mode's bitrate.
  for (const sender of pc.getSenders()) {
    if (!sender.track || sender.track.kind !== 'audio') continue;
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) continue;
    if (params.encodings[0].maxBitrate === STREAM_AUDIO_BPS[state.mode]) continue;
    params.encodings[0].maxBitrate = STREAM_AUDIO_BPS[state.mode];
    try { await sender.setParameters(params); } catch (e) { console.warn('stream sound params', e); }
  }
}

/* Stuck shares. A moment of congestion or a busy PC makes WebRTC shrink the
 * picture (it keeps the frame rate), and sometimes it never grows back, even
 * once the link is fine again (seen: 320×180 for minutes on a clean link;
 * reproduced in a test, where it stayed at 180p with 6 Mbps to spare).
 * Reopening the screen fixed it by hand, because a new call starts fresh.
 * So when a viewer gets far less than they asked for, for a while, on a link
 * that looks healthy, while the encoder isn't even using half the bitrate it
 * may (if it is, the picture is simply too busy for that bitrate and a smaller
 * size is the right call), the sharer fixes it by itself:
 *   1. nudge: briefly tell the encoder to keep the resolution, which drops the
 *      stuck shrink in place, with no gap at all for the viewer;
 *   2. if it gets stuck again soon: reopen the screen for that viewer
 *      (a second or two of "Reconnecting…");
 *   3. if even that doesn't hold, the link really is that slow: leave it be.
 * A busy PC (limit "cpu") gets the nudge but never a reopen, which wouldn't
 * make the PC any less busy. */
const STUCK = {
  ratio: 0.6,          // stuck: picture under 60% of the height the viewer asked for
  used: 0.5,           // ...while sending under half the bitrate it's allowed
  forMs: 20000,        // ...for this long, on a healthy link
  settleMs: 30000,     // a new call gets this long to ramp up first
  afterNudgeMs: 30000, // after a nudge, wait at least this long before the next step
  afterReopenMs: 120000,
  againMs: 300000,     // stuck again this soon after a fix counts as the fix not holding
  restMs: 600000       // then rest this long
};
const newStuckWatch = () => ({ since: 0, last: -1e12, next: 0, tries: 0, restUntil: 0, sig: null });

// One sample for one viewer. s: { h, wantH, healthy, sig, callAge, used, cpu }
// (used: sent bitrate / allowed bitrate, null if not known yet).
// Returns 'nudge', 'reopen', 'rest' (giving up for a while) or false.
function stuckStep(w, s, now) {
  if (w.sig !== s.sig) { w.sig = s.sig; w.since = 0; } // encoder settings changed: start over
  if (!s.h || !s.wantH || s.callAge < STUCK.settleMs || !s.healthy || s.h >= s.wantH * STUCK.ratio ||
      s.used == null || s.used >= STUCK.used) { w.since = 0; return false; }
  if (!w.since) { w.since = now; return false; }
  if (now - w.since < STUCK.forMs || now < w.next || now < w.restUntil) return false;
  w.tries = now - w.last < STUCK.againMs ? w.tries + 1 : 1;
  w.since = 0;
  w.last = now;
  if (w.tries === 1) { w.next = now + STUCK.afterNudgeMs; return 'nudge'; }
  if (w.tries === 2 && !s.cpu) { w.next = now + STUCK.afterReopenMs; return 'reopen'; }
  w.tries = 0;
  w.restUntil = now + STUCK.restMs;
  return 'rest';
}

// Drop a stuck shrink in place: a moment of "keep the resolution", then back.
async function nudgeEncoder(pc, p) {
  const set = async (pref) => {
    for (const sender of pc.getSenders()) {
      if (!sender.track || sender.track.kind !== 'video') continue;
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) continue;
      params.degradationPreference = pref;
      try { await sender.setParameters(params); } catch (e) { console.warn('nudge', e); }
    }
  };
  await set('maintain-resolution');
  await new Promise((r) => setTimeout(r, 1500));
  if (pc.connectionState === 'connected') await set((p && p.encWant && p.encWant.pref) || 'maintain-framerate');
}

/* Watching my own share (every few seconds, while sharing):
 *  - how many frames a second the capture delivers (for Stats). Nothing is
 *    added on top: the encoder gets the capture's frames, up to the quality
 *    preset's frame rate, and a frame that repeats the last one costs next
 *    to nothing;
 *  - in Video mode, whether the picture stands still (a paused film): the
 *    encoder then needs almost no bitrate, which is how it's noticed. While
 *    it does, the encoder is told to keep the picture sharp instead of the
 *    frame rate (see tuneSenders), and back once it moves again;
 *  - a browser window that stays black while its sound plays: a streaming
 *    site's copy protection, most likely. Say so once (see checkBlackShare);
 *  - how long the app's sound waits before it's sent, for the viewers' lip
 *    sync (see applyScreenBuffer). */
const share = { srcFps: null, lastSrc: null, still: false, probe: null, canvas: null, blackFor: 0, blackAt: 0, hinted: false, loudAt: 0 };
const STILL_BELOW_KBPS = 150, MOVING_ABOVE_KBPS = 400;

function resetShareWatch() {
  if (share.probe) { share.probe.srcObject = null; share.probe = null; }
  Object.assign(share, { srcFps: null, lastSrc: null, still: false, blackFor: 0, blackAt: 0, hinted: false, loudAt: 0 });
  closeNotice('drm');
}

async function watchShare() {
  if (!state.screen) return;
  const stream = state.screen;
  // One viewer's connection is enough: they all get the same capture.
  let src = null;
  for (const p of state.peers.values()) {
    const call = p.screenOut;
    const pc = call && call.peerConnection;
    if (!pc || pc.connectionState !== 'connected' || (p.encWant && !p.encWant.active)) continue;
    let frames = null, out = null;
    try {
      (await pc.getStats()).forEach((r) => {
        if (r.type === 'media-source' && r.kind === 'video') frames = r.frames || 0;
        if (r.type === 'outbound-rtp' && r.kind === 'video') out = r;
      });
    } catch { /* ignore */ }
    if (frames != null && out) { src = { call, frames, bytes: out.bytesSent || 0, t: out.timestamp, held: out.qualityLimitationReason === 'bandwidth' }; break; }
  }
  if (state.screen !== stream) return;
  const last = share.lastSrc;
  share.lastSrc = src;
  const dt = src && last && last.call === src.call ? src.t - last.t : 0;
  share.srcFps = dt > 1000 && src.frames >= last.frames ? ((src.frames - last.frames) * 1000) / dt : null;
  const kbps = dt > 1000 && src.bytes >= last.bytes ? ((src.bytes - last.bytes) * 8) / dt : null;
  if (state.mode === 'video' && kbps != null) {
    // (a starved connection also sends little: that's not a paused film)
    const still = share.still ? kbps < MOVING_ABOVE_KBPS : kbps < STILL_BELOW_KBPS && !src.held;
    if (still !== share.still) { share.still = still; retuneAll(); }
  } else if (kbps == null && share.still) { share.still = false; retuneAll(); }
  checkBlackShare();
  // Tell each viewer how long the sound waits here (when it changed by 5 ms or more).
  const st = appAudio.stat;
  const fresh = st && st.delayMs != null && performance.now() - st.at < 5000;
  if (st && st.peak > 0.003) share.loudAt = performance.now();
  const audioDelay = fresh && stream.getAudioTracks().length ? Math.round(st.delayMs / 5) * 5 : null;
  // (only once their screen call is up: the message travels faster than the call)
  for (const p of state.peers.values()) {
    const pc = p.screenOut && p.screenOut.peerConnection;
    if (!pc || pc.connectionState !== 'connected' || p.lost) continue;
    const sig = String(audioDelay);
    if (p.infoSig === sig) continue;
    p.infoSig = sig;
    send(p, { type: 'share-info', audioDelay });
  }
}

// A copy-protected video (Netflix, Prime Video, Disney+…) reaches screen
// capture as plain black. GameShare doesn't get around that; it only tells
// the sharer what's going on and which browser setting usually helps.
// Black = at least 80% of the picture pure black (the browser's own bars may
// still show), for a few checks in a row, in a browser window, while its
// sound is playing (when the sound is shared at all).
function isBrowserShare() {
  const app = (state.screenSound && state.screenSound.app) || '';
  return BROWSER_RE.test(state.shareName || '') || /^(chrome|msedge|firefox|opera|brave|vivaldi|chromium)(\.exe)?$/i.test(app);
}

function blackFraction(video) {
  if (!video || !video.videoWidth) return null;
  if (!share.canvas) { share.canvas = document.createElement('canvas'); share.canvas.width = 48; share.canvas.height = 27; }
  const g = share.canvas.getContext('2d', { willReadFrequently: true });
  try { g.drawImage(video, 0, 0, 48, 27); } catch { return null; }
  const d = g.getImageData(0, 0, 48, 27).data;
  let black = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] <= 3 && d[i + 1] <= 3 && d[i + 2] <= 3) black++;
  return black / (d.length / 4);
}

function checkBlackShare() {
  if (share.hinted || !state.screen || !isBrowserShare()) return;
  // My preview shows the capture; if I closed it, a hidden video does.
  const mine = tiles.get('me');
  if (!mine && !share.probe) {
    const v = document.createElement('video');
    v.muted = true;
    v.srcObject = new MediaStream(state.screen.getVideoTracks());
    v.play().catch(() => {});
    share.probe = v;
    return; // first picture by the next check
  }
  if (mine && share.probe) { share.probe.srcObject = null; share.probe = null; }
  const f = blackFraction(mine ? mine.video : share.probe);
  const now = performance.now();
  const hasSound = state.screen.getAudioTracks().length > 0;
  const playing = !hasSound || now - share.loudAt < 4000;
  if (f == null || f < 0.8 || !playing) { share.blackFor = 0; share.blackAt = now; return; }
  share.blackFor += now - (share.blackAt || now);
  share.blackAt = now;
  if (share.blackFor < 5000) return;
  share.hinted = true;
  note('my shared browser window is black: showed the protected-video hint');
  showNotice('drm', tr('Your shared window looks black'),
    tr('Streaming sites like Netflix, Prime Video and Disney+ protect their video, so a screen capture gets a black picture. What usually brings it back: in that browser’s settings, turn off “Use graphics acceleration when available” (hardware acceleration) and restart the browser. GameShare doesn’t get around the protection: if it stays black, that site can’t be shared.'));
}

async function checkStuckShares() {
  if (!state.screen) return;
  const track = state.screen.getVideoTracks()[0];
  const srcH = (track && track.getSettings().height) || QUALITY[state.quality].h;
  for (const p of state.peers.values()) {
    const call = p.screenOut;
    const pc = call && call.peerConnection;
    if (!p.stuck) p.stuck = newStuckWatch();
    if (!pc || pc.connectionState !== 'connected' || p.lost || !p.encWant || !p.encWant.active) { p.stuck.since = 0; continue; }
    let out = null, remote = null;
    try {
      (await pc.getStats()).forEach((r) => {
        if (r.type === 'outbound-rtp' && r.kind === 'video') out = r;
        if (r.type === 'remote-inbound-rtp' && r.kind === 'video') remote = r;
      });
    } catch { continue; }
    if (!out || p.screenOut !== call || !state.screen) continue;
    const now = performance.now();
    const wantH = Math.round(srcH / p.encWant.scale);
    // How much of its allowed bitrate the encoder is using (since the last look).
    const prev = p.stuck.bytes;
    p.stuck.bytes = { n: out.bytesSent || 0, t: now, call };
    let used = prev && prev.call === call && now - prev.t > 1000
      ? ((out.bytesSent - prev.n) * 8) / ((now - prev.t) / 1000) / p.encWant.bitrate : null;
    if (!Number.isFinite(used)) used = null;
    // Healthy: the viewer reports little loss and a sane round trip.
    const healthy = !!remote && (remote.fractionLost || 0) <= 0.02 && !(remote.roundTripTime > 0.25);
    const v = stuckStep(p.stuck, { h: out.frameHeight || 0, wantH, healthy, sig: p.encSig, callAge: now - (call.gsAt || 0),
                                   used, cpu: out.qualityLimitationReason === 'cpu' }, now);
    if (!v) continue;
    const why = `stuck at ${out.frameHeight}p (wanted ${wantH}p, using ${Math.round(used * 100)}% of its bitrate, limit: ${out.qualityLimitationReason || '?'}) on a healthy link`;
    if (v === 'nudge') {
      note(`my screen to ${p.name} ${why}: nudging the encoder`);
      nudgeEncoder(pc, p);
    } else if (v === 'reopen') {
      note(`my screen to ${p.name} ${why} again: reopening it`);
      sendScreenTo(p);
    } else {
      note(`my screen to ${p.name} keeps shrinking: leaving it alone for ${STUCK.restMs / 60000} min`);
    }
  }
}

// Video mode for my share (or, while not sharing, the mode the picker remembers).
const videoShare = () => (state.screen ? state.mode : prefs.shareMode) === 'video';
const autoBitrate = () => QUALITY[state.quality].bitrate * (videoShare() ? VIDEO_BITRATE_BOOST : 1);
// The most one friend can get from my screen (bits/s) before it's sized to
// how big they watch it: the bitrate picked in Settings, or the preset's.
function shareBitrate() {
  const kbps = Number(prefs.bitrate);
  if (BITRATES.includes(kbps)) return kbps * 1000;
  return autoBitrate();
}

// Settings → Bitrate: the Automatic choice says what it currently means.
function updateBitrateUi() {
  const sel = $('#bitrateSelect');
  if (!sel) return;
  const mbps = (autoBitrate() / 1e6).toLocaleString(i18n.current() === 'pt' ? 'pt-BR' : 'en', { maximumFractionDigits: 2 });
  sel.querySelector('option[value="auto"]').textContent = tr('Automatic ({n} Mbps)', { n: mbps });
  sel.value = String(prefs.bitrate);
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
    toast(tr('Couldn’t capture that. On a Mac, allow GameShare under System Settings › Privacy › Screen Recording.'), 'err');
    return;
  }

  const track = stream.getVideoTracks()[0];
  if (!track) { stream.getTracks().forEach((t) => t.stop()); return; }
  await applyCaptureQuality(track);
  track.addEventListener('ended', stopShare);

  state.mode = pick.mode === 'video' ? 'video' : 'game';
  state.shareName = pick.name || '';
  state.screenSound = { sound: 'none' };
  if (pick.audio) {
    try {
      stream.addTrack(await startAppAudioTrack(pick.id));
      state.screenSound = appAudio.info;
    } catch (e) {
      console.warn('app audio', e);
      stopAppAudioTrack();
      toast(tr('Sharing without sound: {why}.', { why: audioWhy(e.message) }), 'warn');
    }
  }

  state.screen = stream;
  updateBitrateUi();
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
  state.mode = 'game';
  resetShareWatch();
  updateBitrateUi();
  state.previewHidden = false;
  for (const p of state.peers.values()) {
    p.unwatched = false;
    p.stuck = null;
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
let pickerMode = 'game';
let thumbRound = 0;

// Game or Video: the sharer's choice, remembered. For a browser or a video
// player the picker only suggests Video.
function setShareMode(mode) {
  pickerMode = mode === 'video' ? 'video' : 'game';
  renderShareMode();
}

function renderShareMode() {
  document.querySelectorAll('#picker .mode').forEach((b) => {
    const on = b.dataset.mode === pickerMode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  });
  $('#modeText').textContent = pickerMode === 'video'
    ? tr('For films and videos: steady picture, richer sound. Friends see it about 1 s late.')
    : tr('For playing: the lowest delay.');
  const src = pickerSources.find((s) => s.id === pickerSelected);
  const suggest = pickerMode === 'game' && !!src && src.kind === 'window' && looksLikeVideo(src.name);
  $('#modeSuggest').classList.toggle('hidden', !suggest);
  $('#modeSuggest').textContent = tr('Watching a video? Use Video mode');
}

async function openPicker() {
  const modal = $('#picker');
  $('#audioOpt').classList.toggle('hidden', !appAudio.supported);
  $('#audioCheck').checked = !!prefs.shareSound;
  $('#pickerGo').disabled = true;
  pickerSelected = null;
  pickerSources = [];
  setShareMode(prefs.shareMode);
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
  $('#sourceGrid').replaceChildren(el('p', 'loading', tr('Finding windows…')));
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
  renderShareMode();

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
    ? `${tr('Share this app’s sound')} <small>${tr('Only the window you pick. Never your call.')}</small>`
    : `${tr('Share computer sound')} <small>${tr('Everything except GameShare, so friends never hear themselves.')}</small>`;
  const grid = $('#sourceGrid');
  grid.innerHTML = '';
  const list = pickerSources.filter((s) => s.kind === pickerKind);
  if (!list.length) {
    grid.appendChild(el('p', 'loading', pickerKind === 'window'
      ? tr('No windows found. Try the Screens tab.')
      : tr('No screens found. On a Mac, allow Screen Recording for GameShare and restart it.')));
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
      renderShareMode();
    });
    b.addEventListener('dblclick', () => { pickerSelected = s.id; goPicker(); });
    grid.appendChild(b);
  }
  const sel = grid.querySelector('.source.selected');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

function goPicker() {
  if (!pickerSelected) return;
  const src = pickerSources.find((s) => s.id === pickerSelected);
  prefs.lastSource = pickerSelected;
  prefs.shareMode = pickerMode;
  savePrefs();
  closePicker({ id: pickerSelected, audio: $('#audioCheck').checked && appAudio.supported, mode: pickerMode,
                name: src ? src.name : '', kind: src ? src.kind : 'window' });
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
  const who = () => (isMe ? tr('You') : (state.peers.get(id) || peer || {}).name || tr('Friend'));

  // Always-visible name chip (top left)
  const chip = el('div', 'tile-chip');
  tile.style.setProperty('--pc', colorOf(isMe ? 'me' : id));
  const nameEl = el('span', 'tile-name', who());
  chip.append(nameEl);
  const liveEl = isMe ? el('span', 'chip-live') : null;
  if (liveEl) chip.appendChild(liveEl);

  // Controls (bottom, on hover)
  const bar = el('div', 'tile-bar');
  const left = el('div', 'tile-left');
  const soundInfo = isMe ? state.screenSound : (peer || {}).screenSound;
  const hasAudio = stream.getAudioTracks().length > 0;
  const soundEl = el('span', 'tile-sound');
  left.appendChild(soundEl);
  const tools = el('div', 'tile-tools');

  let none = null, noneText = null, vol = null, sync = null, stop = null, stallText = null;
  if (!isMe && !hasAudio) {
    none = el('div', 'stream-vol disabled');
    noneText = el('span', 'stream-none');
    none.append(el('span', 'stream-mute off'), noneText);
    tools.appendChild(none);
  }
  if (!isMe && hasAudio) {
    const wrap = el('div', 'stream-vol');
    const snd = el('button', 'stream-mute');
    vol = el('input', 'stream-slider');
    vol.type = 'range'; vol.min = '0'; vol.max = '100';
    vol.value = String(Math.round((peer && peer.streamVolume != null ? peer.streamVolume : 1) * 100));
    sync = () => {
      const pr = state.peers.get(id);
      const off = !pr || pr.tileSoundOff || Number(vol.value) === 0;
      snd.classList.toggle('off', off);
      snd.title = pr && pr.tileSoundOff ? tr('Unmute stream sound') : tr('Mute stream sound');
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
  }
  if (isMe) {
    stop = el('button', 'tile-btn danger');
    stop.addEventListener('click', () => stopShare());
    tools.appendChild(stop);
  }
  // Stats: resolution, frame rate, bitrate… on every screen (one switch for all).
  const stats = el('button', 'tile-btn stats-btn');
  stats.setAttribute('aria-pressed', String(!!prefs.stats));
  stats.addEventListener('click', () => setStats(!prefs.stats));
  tools.appendChild(stats);
  // Cinema mode, on friends' screens: this screen fills the window, the rest hides.
  let cine = null;
  if (!isMe) {
    cine = el('button', 'tile-btn cinema-btn');
    cine.addEventListener('click', () => toggleCinema(id));
    tools.appendChild(cine);
  }
  const full = el('button', 'tile-btn icon full-btn');
  full.addEventListener('click', () => toggleFullscreen(tile));
  tools.appendChild(full);
  // Using the controls shouldn't enlarge or full-screen the tile.
  for (const type of ['click', 'dblclick', 'pointerdown']) bar.addEventListener(type, (e) => e.stopPropagation());
  bar.append(left, tools);

  const close = el('button', 'tile-close');
  close.addEventListener('click', (e) => { e.stopPropagation(); closeTile(id); });
  close.addEventListener('dblclick', (e) => e.stopPropagation());

  tile.append(video, chip, bar, close, el('div', 'tile-stats'));
  if (!isMe) {
    const stall = el('div', 'tile-stall');
    stallText = el('span');
    stall.append(el('i', 'spin'), stallText);
    tile.appendChild(stall);
  }

  // Every word on the tile, so a language switch can redo them in place.
  const relabel = () => {
    if (isMe) nameEl.textContent = tr('You');
    if (liveEl) liveEl.textContent = tr('LIVE');
    soundEl.textContent = soundLabel(soundInfo, hasAudio);
    if (none) {
      none.title = tr('{name} isn’t sharing sound', { name: who() });
      noneText.textContent = tr('No sound');
    }
    if (vol) {
      vol.title = tr('Stream volume');
      vol.setAttribute('aria-label', tr('{name}’s stream volume', { name: who() }));
      sync();
    }
    if (stop) stop.textContent = tr('Stop');
    if (cine) {
      const on = state.cinema === id;
      cine.textContent = tr('Cinema');
      cine.setAttribute('aria-pressed', String(on));
      cine.title = on ? tr('Leave cinema mode (Esc or Ctrl+Shift+C)') : tr('Cinema mode: only this screen, as big as the window (Ctrl+Shift+C)');
    }
    stats.textContent = tr('Stats');
    stats.title = isMe ? tr('Show what each friend is getting from you') : tr('Show stream numbers: resolution, frame rate, bitrate, delay');
    const fullOn = document.fullscreenElement === tile;
    full.title = fullOn ? tr('Exit full screen') : tr('Full screen');
    full.setAttribute('aria-label', full.title);
    close.title = isMe ? tr('Hide my preview (keeps sharing)') : tr('Close this screen');
    close.setAttribute('aria-label', close.title);
    if (stallText) stallText.textContent = tr('Reconnecting…');
  };
  relabel();
  tile.addEventListener('click', () => { if (!document.fullscreenElement && !state.cinema) toggleFocus(id); });
  tile.addEventListener('dblclick', () => toggleFullscreen(tile));
  // In full screen, controls and cursor hide after a moment without movement.
  // call: the screen call this picture comes from (a newer one = this one is stale).
  const entry = { tile, video, isMe, placed: !!prevStyle, idle: null, call: peer ? peer.screenIn : null, stalled: false, relabel };
  tile.addEventListener('mousemove', () => wake(entry));

  if (prevStyle) tile.setAttribute('style', prevStyle);
  if (state.cinema === id) tile.classList.add('cinema-tile'); // rebuilt (a track was added): still in cinema mode
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
  if (document.fullscreenElement !== entry.tile && !entry.tile.classList.contains('cinema-tile')) return;
  entry.tile.classList.add('awake');
  clearTimeout(entry.idle);
  entry.idle = setTimeout(() => entry.tile.classList.remove('awake'), 2500);
}

/* Cinema mode (Ctrl+Shift+C, or the Cinema button on a friend's screen): that
 * screen fills the GameShare window and everything else hides (the panel,
 * other screens, and after a moment the controls and the pointer). Voices
 * keep working. It also asks the sharer for the full picture whatever the
 * window's size, so small text and subtitles get every pixel there is.
 * Esc leaves. Full screen still works on top of it. */
function cinemaPick() {
  const stage = $('#stage');
  const friends = [...tiles.keys()].filter((id) => id !== 'me');
  if (!friends.length) return null;
  if (friends.includes(stage.dataset.focus)) return stage.dataset.focus; // the one I made big
  return friends.find((id) => isVideo(state.peers.get(id) || {})) || friends[0];
}

function setCinema(id) {
  const next = id && tiles.has(id) && id !== 'me' ? id : null;
  if (next === state.cinema) return;
  const prev = tiles.get(state.cinema);
  if (prev) { prev.tile.classList.remove('cinema-tile', 'awake'); clearTimeout(prev.idle); }
  state.cinema = next;
  document.body.classList.toggle('cinema', !!next);
  const t = tiles.get(next);
  if (t) { t.tile.classList.add('cinema-tile'); wake(t); }
  for (const x of tiles.values()) x.relabel();
  reportViews(); // cinema wants the full resolution
  layoutStage();
}

function toggleCinema(id) {
  if (state.cinema && (!id || id === state.cinema)) { setCinema(null); return; }
  const pick = id || cinemaPick();
  if (!pick) { toast(tr('Cinema mode needs a friend’s screen to watch.')); return; }
  setCinema(pick);
  if (!prefs.cinemaTip) {
    prefs.cinemaTip = true;
    savePrefs();
    toast(tr('Cinema mode. Press Esc or Ctrl+Shift+C to leave.'));
  }
}

function toggleFullscreen(tile) {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  } else {
    tile.requestFullscreen().catch((e) => {
      console.warn('fullscreen', e);
      toast(tr('Couldn’t go full screen.'), 'err');
    });
  }
}

document.addEventListener('fullscreenchange', () => {
  const fs = document.fullscreenElement;
  for (const t of tiles.values()) {
    const b = t.tile.querySelector('.full-btn');
    const on = fs === t.tile;
    b.title = on ? tr('Exit full screen') : tr('Full screen');
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
    toast(tr('Preview hidden. You’re still sharing.'));
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
  if (!hasAudio) return tr('no sound');
  if (!info) return tr('sound: unknown (they need to update GameShare)');
  if (info.sound === 'app') return tr('sound: {app} only', { app: info.app || tr('this app') });
  if (info.sound === 'system') return tr('sound: whole computer except GameShare');
  return tr('sound');
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
    if (state.cinema === id) setCinema(null); // the screen I was watching is gone
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
  if (state.cinema === id) return { h: VIEW_STEPS[VIEW_STEPS.length - 1], paused: false }; // every pixel there is
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
  r.name.textContent = d.me ? tr('{name} (you)', { name: d.name }) : d.name;
  r.name.title = r.name.textContent;
  r.host.title = tr('Host: can change the room size');
  if (!d.me) r.li.title = tr('Volume and options');
  r.host.classList.toggle('hidden', !d.host);
  r.li.classList.toggle('lost', !!d.lost);
  const sub = [];
  if (d.lost) sub.push(el('span', 'lost-tag', tr('Reconnecting…')));
  if (d.sharing) sub.push(el('span', 'live-tag', tr('Live')));
  if (d.deafened) sub.push(el('span', null, d.me ? tr('Voices muted') : tr('Can’t hear voices')));
  if (d.localMuted) sub.push(el('span', null, tr('Muted for you')));
  if (d.outdated) {
    const t = el('span', 'warn-tag', tr('Old version'));
    t.title = tr('{name} is running an older GameShare. Ask them to update so everything works the same for everyone.', { name: d.name });
    sub.push(t);
  }
  r.sub.replaceChildren(...sub);
  const showWatch = d.sharing && d.closed;
  r.watch.classList.toggle('hidden', !showWatch);
  r.watch.textContent = showWatch ? (d.me ? tr('Show my preview') : tr('Watch screen')) : '';
  r.mic.classList.toggle('hidden', !d.muted);
  r.mic.title = d.me ? tr('Your mic is off') : tr('{name}’s mic is off', { name: d.name });
  r.deaf.classList.toggle('hidden', !d.deafened);
  r.deaf.title = d.me ? tr('You muted everyone’s voice') : tr('{name} can’t hear voices right now', { name: d.name });
  r.li.classList.toggle('muted-for-me', !!d.localMuted);
  if (r.hear) {
    r.hear.className = 'hear-btn' + (d.localMuted ? ' off' : '');
    r.hear.title = d.localMuted ? tr('Unmute {name}’s voice for me', { name: d.name }) : tr('Mute {name}’s voice for me (their stream has its own volume)', { name: d.name });
    r.hear.setAttribute('aria-label', r.hear.title);
  }
  if (r.net) {
    const lvl = d.lost ? 'bad' : netLevel(d.net);
    r.net.className = 'net ' + lvl;
    r.net.title = d.lost ? tr('Connection lost. Reconnecting…') : netText(d.net);
  }
}

// L: the translator to use (the diagnostics report stays in English).
function netText(n, L = tr) {
  if (!n || n.rtt == null) return L('Connection: measuring…');
  const loss = n.loss == null ? '–' : n.loss.toFixed(n.loss < 1 ? 1 : 0);
  return n.relay ? L('Ping {rtt} ms, {loss}% lost, going through a relay server', { rtt: n.rtt, loss })
                 : L('Ping {rtt} ms, {loss}% lost, direct', { rtt: n.rtt, loss });
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
      m.nm.textContent = d.me ? tr('{name} (you)', { name: d.name }) : d.lost ? tr('{name} · reconnecting…', { name: d.name }) : d.name;
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
  if (p.lost) bits.push(tr('reconnecting…'));
  if (p.sharing) bits.push(tr('sharing their screen'));
  if (p.muted) bits.push(tr('mic off'));
  if (p.deafened) bits.push(tr('can’t hear voices'));
  const sub = bits.length ? bits.join(', ') : tr('in the room');
  m.querySelector('.pop-sub').textContent = sub.charAt(0).toUpperCase() + sub.slice(1);
  m.querySelector('.pop-mute').setAttribute('aria-checked', String(!!p.localMuted));
  const watch = m.querySelector('.pop-watch');
  watch.classList.toggle('hidden', !p.sharing);
  watch.textContent = p.hidden ? tr('Watch their screen') : tr('Close their screen');
  m.querySelector('.pop-net').textContent = p.net ? netText(p.net) : '';
}

function closePersonMenu() {
  menuKey = null;
  $('#personMenu').classList.add('hidden');
  for (const r of rows.values()) r.li.classList.remove('menu-open');
}

/* ------------------------------------------------------------ room size */

function holderName() {
  if (amHolder()) return tr('you');
  const id = state.doormanOwner || roomId();
  const p = state.peers.get(id);
  return p && p.greeted ? p.name : tr('the host');
}

function updateSizeControls() {
  const host = amHolder();
  const count = greetedCount();
  $('#sizeNow').textContent = String(state.maxPeople);
  $('#sizeStepper').classList.toggle('locked', !host);
  $('#sizeDown').disabled = !host || state.maxPeople <= Math.max(MIN_SIZE, count);
  $('#sizeUp').disabled = !host || state.maxPeople >= MAX_LIMIT;
  $('#sizeHint').textContent = host
    ? tr('How many players fit, up to {n}', { n: MAX_LIMIT })
    : tr('Only {name} can change it', { name: holderName() });
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
    b.title = i === 1 ? tr('You') : tr('{n} players', { n: i });
    b.setAttribute('aria-label', i === 1 ? tr('You') : tr('Room for {n} players', { n: i }));
    b.setAttribute('aria-pressed', String(i === prefs.roomSize));
    if (i > 1) b.addEventListener('click', () => { prefs.roomSize = i; savePrefs(); renderSizePicker(); });
    out.push(b);
  }
  box.replaceChildren(...out);
  $('#sizeValue').textContent = tr('{n} players', { n: prefs.roomSize });
}

function updateNetBadge() {
  if (!state.peer) return;
  const friends = [...state.peers.values()].filter((p) => p.greeted);
  const lost = friends.filter((p) => p.lost);
  if (lost.length && (state.peer.disconnected || (friends.length > 1 && lost.length === friends.length))) {
    setNet(tr('Your connection dropped. Reconnecting…'), 'warn');
  } else if (lost.length) {
    setNet(lost.length === 1 ? tr('Reconnecting to {name}…', { name: lost[0].name }) : tr('Reconnecting to {n} friends…', { n: lost.length }), 'warn');
  } else if (state.peer.disconnected) {
    // Only the matchmaking server: calls in progress keep working.
    setNet(tr('Reconnecting to the server…'), 'warn');
  } else {
    setNet(friends.length ? tr('Connected') : tr('Waiting for friends'), friends.length ? 'ok' : '');
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
  let rtp = null, pairId = null, snd = null;
  st.forEach((r) => {
    byId.set(r.id, r);
    if (r.type === (dir === 'in' ? 'inbound-rtp' : 'outbound-rtp') && r.kind === 'video') rtp = r;
    if (r.type === (dir === 'in' ? 'inbound-rtp' : 'outbound-rtp') && r.kind === 'audio') snd = r;
    if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
  });
  if (!rtp) return { state: pc.connectionState };
  const pair = pairId && byId.get(pairId);
  const codec = rtp.codecId && byId.get(rtp.codecId);
  const cand = (id) => byId.get(id) || {};
  const now = performance.now();
  const bytes = dir === 'in' ? rtp.bytesReceived : rtp.bytesSent;
  const prev = lastSample.get(call);
  const sndBytes = snd ? (dir === 'in' ? snd.bytesReceived : snd.bytesSent) || 0 : null;
  lastSample.set(call, { t: now, bytes, lost: rtp.packetsLost || 0, recv: rtp.packetsReceived || 0,
                         delay: rtp.jitterBufferDelay || 0, emitted: rtp.jitterBufferEmittedCount || 0, sndBytes });
  const dt = prev ? (now - prev.t) / 1000 : 0;
  const s = {
    state: pc.connectionState,
    w: rtp.frameWidth || 0, h: rtp.frameHeight || 0, fps: Math.round(rtp.framesPerSecond || 0),
    kbps: dt > 0.2 ? Math.max(0, Math.round(((bytes - prev.bytes) * 8) / dt / 1000)) : null,
    codec: codec && codec.mimeType ? codec.mimeType.split('/')[1] : '',
    rtt: pair && pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null,
    relay: !!pair && (cand(pair.localCandidateId).candidateType === 'relay' || cand(pair.remoteCandidateId).candidateType === 'relay'),
    // the stream's sound (null: this share has none)
    sndKbps: snd && dt > 0.2 && prev.sndBytes != null ? Math.max(0, Math.round(((sndBytes - prev.sndBytes) * 8) / dt / 1000)) : null
  };
  if (dir === 'in') {
    const lost = prev ? rtp.packetsLost - prev.lost : 0, got = prev ? rtp.packetsReceived - prev.recv : 0;
    s.loss = lost + got > 0 ? (100 * Math.max(0, lost)) / (lost + got) : 0;
    const emitted = prev ? rtp.jitterBufferEmittedCount - prev.emitted : 0;
    s.buffer = emitted > 0 ? Math.round(((rtp.jitterBufferDelay - prev.delay) / emitted) * 1000) : null;
    s.freezes = rtp.freezeCount || 0;
    // Lip sync: both tracks say which moment of the sharer's clock they are
    // playing right now. Positive = the sound is ahead of the picture.
    // (As WebRTC sees it; avSync() adds what the sharer reported.)
    s.sndAhead = snd && snd.estimatedPlayoutTimestamp && rtp.estimatedPlayoutTimestamp
      ? Math.round(snd.estimatedPlayoutTimestamp - rtp.estimatedPlayoutTimestamp) : null;
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
// what: 'decoding' or 'encoding'
const coder = (s, what, L = tr) => (s.hw == null ? (s.impl || '')
  : L(s.hw ? `hardware ${what}` : `software ${what}`) + (s.impl ? ` (${s.impl})` : ''));

// How far the stream's sound is from its picture for me, in ms (positive =
// the sound comes late), or null if unknown. What WebRTC measures between the
// two tracks, plus the wait on the sharer's side that WebRTC can't see.
function avSync(s, p) {
  if (!s || s.sndAhead == null) return null;
  return Math.round((p && p.audioDelay) || 0) - s.sndAhead;
}
function avSyncText(ms, L = tr) {
  if (ms == null) return '';
  if (Math.abs(ms) < 10) return L('sound in sync');
  return ms > 0 ? L('sound {n} ms late', { n: ms }) : L('sound {n} ms early', { n: -ms });
}

// compact: for small screens (a strip thumbnail, your own preview).
// p: the friend whose screen it is (for the mode and the lip-sync line).
function describeIn(s, compact, L = tr, p = null) {
  if (!s || !s.w) return s && s.state !== 'connected' ? L('not connected ({state})', { state: s.state }) : L('waiting for video…');
  const freezes = L(s.freezes === 1 ? '{n} freeze' : '{n} freezes', { n: s.freezes });
  const mode = p ? L(isVideo(p) ? 'Video mode' : 'Game mode') : '';
  if (compact) return `${s.h}p · ${s.fps} fps · ${mbps(s.kbps)}\n${s.buffer != null ? `${L('{n} ms buffer', { n: s.buffer })} · ` : ''}${freezes}${p && isVideo(p) ? ` · ${L('video')}` : ''}`;
  const target = p && p.screenBuffer ? ` (${L('aims for {n} ms', { n: p.screenBuffer })})` : '';
  return [
    `${s.w}×${s.h} · ${s.fps} fps · ${mbps(s.kbps)}`,
    [s.codec, coder(s, 'decoding', L)].filter(Boolean).join(' · '),
    `${s.buffer != null ? `${L('buffer {n} ms', { n: s.buffer })}${target} · ` : ''}${freezes} · ${L('{n}% lost', { n: s.loss.toFixed(1) })}`,
    [mode, s.sndKbps != null ? L('sound {n} kbps', { n: s.sndKbps }) : '', avSyncText(avSync(s, p), L)].filter(Boolean).join(' · '),
    `${s.relay ? L('via relay server') : L('direct')}${s.rtt != null ? ` · ping ${s.rtt} ms` : ''}`
  ].filter(Boolean).join('\n');
}

// My own share, for my preview's stats and the report: mode, the frame rate
// the shared window really produces, and the sound's bitrate and wait.
function describeShare(sndKbps, compact, L = tr) {
  const st = appAudio.stat;
  const hasSound = !!state.screen && state.screen.getAudioTracks().length > 0;
  if (compact) return state.mode === 'video' ? L('Video mode') : '';
  return [
    L(state.mode === 'video' ? 'Video mode' : 'Game mode'),
    share.srcFps != null ? L('source {n} fps', { n: Math.round(share.srcFps) }) + (share.still ? ` (${L('still: keeping it sharp')})` : '') : '',
    hasSound && sndKbps != null ? L('sound {n} kbps', { n: sndKbps }) : '',
    hasSound && st && st.delayMs != null ? L('sound waits {n} ms', { n: Math.round(st.delayMs) }) : ''
  ].filter(Boolean).join(' · ');
}

function describeOut(name, s, p, compact, L = tr) {
  if (!s || s.state !== 'connected') return `${name}: ${L('connecting…')}`;
  if (!s.active || (p.view && p.view.paused)) return `${name}: ${compact ? L('paused') : L('paused (they minimized GameShare)')}`;
  if (compact) return `${name}: ${s.h}p ${s.fps} fps ${mbps(s.kbps)}${s.limit === 'cpu' ? ' · CPU' : s.limit === 'bandwidth' ? ` · ${L('net')}` : ''}`;
  const why = s.limit === 'cpu' ? L('held back by your CPU') : s.limit === 'bandwidth' ? L('held back by the connection')
    : L('held back by {why}', { why: s.limit });
  return `${name}: ${s.w}×${s.h} · ${s.fps} fps · ${mbps(s.kbps)}${s.limit !== 'none' ? ` · ${why}` : ''}`;
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
      let enc = '', sndKbps = null;
      for (const p of state.peers.values()) {
        if (!p.greeted || !p.screenOut) continue;
        const s = await callStats(p.screenOut, 'out');
        if (s && s.sndKbps != null) sndKbps = s.sndKbps;
        lines.push(describeOut(p.name, s, p, compact));
        if (s && s.impl && !enc) enc = compact ? (s.hw == null ? '' : tr(s.hw ? 'hardware encoding' : 'software encoding')) : coder(s, 'encoding');
      }
      text = lines.length ? [...lines, enc, describeShare(sndKbps, compact)].filter(Boolean).join('\n')
        : [tr('Nobody is watching yet'), describeShare(null, compact)].filter(Boolean).join('\n');
    } else {
      const p = state.peers.get(id);
      text = p && p.screenIn ? describeIn(await callStats(p.screenIn, 'in'), compact, tr, p) : tr('reconnecting…');
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
  if (upd.info) {
    const u = upd.info;
    L.push(`Updates: running ${u.version}${u.usingUpdate ? ` (in-app update, installer ${u.bundledVersion})` : ' (installer)'} · auto check ${prefs.updateCheck === false ? 'off' : 'on'}${upd.result ? ` · last check ${upd.result.status}${upd.result.error ? ': ' + upd.result.error : ''}` : ''}`);
  }
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
  L.push(`Settings: quality ${state.quality} · bitrate ${prefs.bitrate === 'auto' ? 'auto' : prefs.bitrate + ' kbps'} (${Math.round(shareBitrate() / 1000)} kbps per friend) · sharing mode ${state.screen ? state.mode : prefs.shareMode + ' (not sharing)'} · headphones mode ${state.headphones ? 'on' : 'off'} · noise removal ${prefs.noiseRemoval === false ? 'off' : mic.failed ? 'failed, using the standard filter' : 'on'} · overlay ${prefs.overlay ? 'on' : 'off'} · in-game shortcuts ${prefs.globalKeys === false ? 'off' : 'on'}`);
  L.push(`Devices: microphone "${sel('#micSelect')}" · output "${sel('#outSelect')}"`);
  if (state.screen) {
    const st = appAudio.stat;
    L.push(`My share: ${describeShare(null, false, trEn)}${st ? ` · sound buffer: reserve ${Math.round(st.marginMs)} ms, ran dry ${st.dry}× in the last second${appAudio.direct ? '' : ' · sound through the page (no direct line)'}` : ''}`);
  }
  for (const p of state.peers.values()) {
    if (!p.greeted) continue;
    L.push('');
    L.push(`${p.name} (GameShare ${p.version || 'older than 1.2'}): ${p.lost ? `RECONNECTING for ${Math.round((performance.now() - p.lost) / 1000)} s` : 'connected'} · ${netText(p.net, trEn)}`);
    L.push(`  link ${health(p.conn)} · voice ${health(p.voice)}${p.localMuted ? ' (muted by me)' : ''}${p.muted ? ' · their mic is off' : ''}`);
    if (p.screenIn) L.push('  their screen: ' + describeIn(await callStats(p.screenIn, 'in'), false, trEn, p).replace(/\n/g, ' · ') + (p.audioDelay ? ` · their sound waits ${Math.round(p.audioDelay)} ms, played ${audioLead(p)} ms sooner` : ''));
    else if (p.sharing) L.push(`  their screen: ${p.hidden ? 'closed by me' : 'not received'}`);
    if (p.screenOut) {
      const s = await callStats(p.screenOut, 'out');
      L.push('  my screen to them: ' + describeOut('', s, p, false, trEn).replace(/^: /, '') + (s && s.impl ? ` · ${coder(s, 'encoding', trEn)}` : '') + (s && s.sndKbps != null ? ` · sound ${s.sndKbps} kbps` : ''));
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
  try { await navigator.clipboard.writeText(text); toast(tr('Report copied. Paste it to whoever is helping you.'), 'ok'); }
  catch { toast(tr('Couldn’t copy the report.'), 'err'); }
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
  await checkStuckShares();
  await watchShare();
  if (document.body.dataset.view === 'room') renderPeople();
}

function updateControls() {
  const micBtn = $('#micBtn');
  micBtn.classList.toggle('off', state.muted);
  micBtn.setAttribute('aria-pressed', String(state.muted));
  micBtn.querySelector('.ctrl-label').textContent = state.muted ? tr('Unmute') : tr('Mute');
  const deafBtn = $('#deafenBtn');
  deafBtn.classList.toggle('off', state.deafened);
  deafBtn.setAttribute('aria-pressed', String(state.deafened));
  deafBtn.querySelector('.ctrl-label').textContent = state.deafened ? tr('Voices off') : tr('Voices');
  micBtn.title = state.muted ? tr('Unmute your mic (Ctrl+Shift+M)') : tr('Mute your mic (Ctrl+Shift+M)');
  deafBtn.title = state.deafened ? tr('Hear everyone’s voice again (Ctrl+Shift+D)') : tr('Mute everyone’s voice for you. Streams keep playing (Ctrl+Shift+D)');
  $('#headphonesBtn').setAttribute('aria-checked', String(state.headphones));
  updateDuckUi();
  updateBitrateUi();
  $('#soundsBtn').setAttribute('aria-checked', String(!!prefs.sounds));
  $('#globalKeysBtn').setAttribute('aria-checked', String(prefs.globalKeys !== false));
  $('#noiseBtn').setAttribute('aria-checked', String(prefs.noiseRemoval !== false && !mic.failed));
  $('#overlayBtn').setAttribute('aria-checked', String(prefs.overlay === true));
  $('#overlayCornerRow').classList.toggle('hidden', prefs.overlay !== true);
  $('#overlayCorner').value = prefs.overlayCorner || 'top left';
  const shareBtn = $('#shareBtn');
  shareBtn.classList.toggle('live', !!state.screen);
  shareBtn.querySelector('.ctrl-label').textContent = state.screen ? tr('Stop sharing') : tr('Share screen');
}

/* ------------------------------------------------------------ language
 * Changes everything on screen right away, without leaving the room. */

function setLanguage(pref) {
  prefs.lang = pref;
  savePrefs();
  i18n.setLang(pref); // the fixed text of the page
  for (const s of document.querySelectorAll('.lang-select')) s.value = pref;
  // everything the app wrote itself
  for (const r of rows.values()) r.sig = '';
  for (const m of partyEls.values()) m.sig = '';
  for (const t of tiles.values()) t.relabel();
  renderSizePicker();
  updateControls();
  setPeoplePanel(!$('#room').classList.contains('collapsed'));
  if (document.body.dataset.view === 'room') {
    document.title = tr('GameShare · Room {code}', { code: state.code });
    renderPeople();
    updateNetBadge();
  }
  refreshDevices();
  renderUpdate();
  if (!$('#picker').classList.contains('hidden')) { renderSources(); renderShareMode(); }
  sbRender();
  if (prefs.stats) updateStats();
  pushOverlay();
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
          lobbyStatus(tr('No room with that code. Check it and try again.'), 'err');
        }
      }
      // in-room: someone left mid-connect, ignore
    } else if (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error') {
      setNet(tr('Reconnecting…'), 'warn');
    }
  });
}

async function prepare() {
  const name = $('#nameInput').value.trim();
  if (!name) { lobbyStatus(tr('Pick a name first.'), 'err'); $('#nameInput').focus(); return false; }
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
  lobbyStatus(r ? tr('Getting you back into room {code}…', { code: fixed }) : fixed ? tr('Room {code} was empty, opening it again…', { code: fixed }) : tr('Creating room…'));
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
      if (fixed && !r) toast(tr('Room {code} is open again. Friends can join with the same code.', { code }), 'ok');
      return true;
    } catch (e) {
      if (e && e.type === 'unavailable-id') continue;
      console.warn(e);
      cleanupMedia();
      setLobbyBusy(false);
      lobbyStatus(tr('Couldn’t reach the connection server. Check your internet and try again.'), 'err');
      return false;
    }
  }
  cleanupMedia();
  setLobbyBusy(false);
  lobbyStatus(fixed ? tr('Couldn’t reopen room {code} yet. Try again in a minute, or create a new room.', { code: fixed }) : tr('Couldn’t create a room right now. Try again.'), 'err');
  return false;
}

async function joinRoom(opts) {
  const code = $('#codeInput').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 6) { lobbyStatus(tr('Room codes are 6 characters.'), 'err'); $('#codeInput').focus(); return; }
  const r = state.resume;
  setLobbyBusy(true);
  lobbyStatus(r ? tr('Getting you back into room {code}…', { code }) : opts && opts.rejoin ? tr('Rejoining room {code}…', { code }) : tr('Joining…'));
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
    lobbyStatus(tr('Couldn’t reach the connection server. Check your internet and try again.'), 'err');
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
    lobbyStatus(tr('The room didn’t answer. Make sure your friend is still in it.'), 'err');
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
  document.title = tr('GameShare · Room {code}', { code: state.code });
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
  if (resumed) toast(tr('GameShare hit a problem and restarted. You’re back in the room.'), 'ok');
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
  sbStop();
  closeSounds();
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
  if (!silent) lobbyStatus(tr('You left the room.'));
}

function setPeoplePanel(show) {
  $('#room').classList.toggle('collapsed', !show);
  const b = $('#peopleToggle');
  b.setAttribute('aria-pressed', String(show));
  b.title = show ? tr('Collapse the panel (Ctrl+Shift+P)') : tr('Expand the panel (Ctrl+Shift+P)');
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
  const text = tr('Join me on GameShare! Room code: {code}', { code: state.code });
  try { await navigator.clipboard.writeText(text); toast(tr('Invite copied. Paste it to your friends.'), 'ok'); }
  catch { toast(tr('Room code: {code}', { code: state.code })); }
}

// System-wide mute shortcuts: only while in a room, and only if wanted.
function applyGlobalKeys() {
  const on = prefs.globalKeys !== false && document.body.dataset.view === 'room';
  window.gameshare.setShortcuts(on).then((ok) => { state.globalKeys = ok || []; }).catch(() => { state.globalKeys = []; });
}

/* ------------------------------------------------------------ settings menu */

function openSettings() {
  closePersonMenu();
  closeSounds();
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

/* ------------------------------------------------------------ updates
 * Optional in-app updates of GameShare's own code (see updater.js). We look
 * for a new version when the app opens (unless turned off in Settings) and
 * offer it on the start screen. Nothing downloads until you click Update,
 * and the new version starts the next time GameShare opens (or right away
 * with Restart now, never in the middle of a call). */

const upd = {
  info: null,        // { enabled, version, bundledVersion, usingUpdate, pending, page }
  result: null,      // last check: { status, version, notes, error }
  checking: false,
  downloading: false,
  progress: 0,
  dismissed: false,  // "Not now" for this session
  reverted: false,
  timer: null
};

async function checkForUpdate(manual = false) {
  if (upd.checking || upd.downloading) return;
  upd.checking = true;
  if (manual) upd.dismissed = false;
  renderUpdate();
  try {
    upd.result = await window.gameshare.checkUpdate();
    if (upd.result && upd.result.status === 'error') note(`update check failed: ${upd.result.error}`);
  } catch (e) {
    upd.result = { status: 'error', error: e.message };
  }
  upd.info = await window.gameshare.updateInfo().catch(() => upd.info);
  upd.checking = false;
  renderUpdate();
}

async function startUpdate() {
  const r = upd.result;
  if (!r || upd.downloading) return;
  if (r.status === 'install') { window.open(upd.info?.page || r.page, '_blank'); return; }
  if (r.status !== 'available') return;
  upd.downloading = true;
  upd.progress = 0;
  renderUpdate();
  const res = await window.gameshare.downloadUpdate().catch((e) => ({ ok: false, error: e.message }));
  upd.downloading = false;
  if (res && res.ok) {
    upd.result = { ...r, status: 'ready' };
    upd.reverted = false;
    if (document.body.dataset.view === 'room') toast(tr('GameShare {v} starts the next time you open GameShare.', { v: r.version }), 'ok');
  } else {
    toast(tr('Update failed: {error}', { error: (res && res.error) || '?' }), 'err');
  }
  upd.info = await window.gameshare.updateInfo().catch(() => upd.info);
  renderUpdate();
}

function renderUpdate() {
  const r = upd.result;
  const v = r && r.version;
  const inRoom = document.body.dataset.view === 'room';

  // Start screen card
  const card = $('#updateCard');
  const offer = r && ['available', 'install', 'ready'].includes(r.status);
  const skipped = offer && r.status !== 'ready' && prefs.skipUpdate === v;
  card.classList.toggle('hidden', !(offer || upd.downloading) || upd.dismissed || skipped);
  card.querySelector('.update-bar').classList.toggle('hidden', !upd.downloading);
  $('#updateBar').style.width = `${Math.round(upd.progress * 100)}%`;
  const go = $('#updateGo');
  const later = $('#updateLater');
  const skip = $('#updateSkip');
  go.disabled = false;
  if (upd.downloading) {
    $('#updateTitle').textContent = tr('Downloading GameShare {v}… {p}%', { v, p: Math.round(upd.progress * 100) });
    $('#updateNotes').textContent = '';
    for (const b of [go, later, skip]) b.classList.add('hidden');
  } else if (r && r.status === 'ready') {
    $('#updateTitle').textContent = tr('GameShare {v} is ready', { v });
    $('#updateNotes').textContent = tr('It starts the next time you open GameShare.');
    go.textContent = tr('Restart now');
    later.textContent = tr('Later');
    go.classList.remove('hidden'); later.classList.remove('hidden'); skip.classList.add('hidden');
  } else if (offer) {
    $('#updateTitle').textContent = tr('GameShare {v} is available', { v });
    $('#updateNotes').textContent = r.status === 'install'
      ? tr('This version needs a fresh install. Download it and run the installer.')
      : (r.notes || '');
    go.textContent = r.status === 'install' ? tr('Download') : tr('Update');
    later.textContent = tr('Not now');
    for (const b of [go, later, skip]) b.classList.remove('hidden');
  }

  // Settings → App
  $('#updateCheckSwitch').setAttribute('aria-checked', String(prefs.updateCheck !== false));
  const info = upd.info;
  const status = $('#updateStatus');
  const btn = $('#updateMenuBtn');
  btn.classList.remove('hidden');
  btn.disabled = false;
  btn.textContent = tr('Check now');
  let text = '';
  if (info && !info.enabled) {
    text = tr('Updates aren’t set up in this copy of GameShare.');
    btn.disabled = true;
  } else if (upd.checking) {
    text = tr('Checking…');
    btn.disabled = true;
  } else if (upd.downloading) {
    text = tr('Downloading… {p}%', { p: Math.round(upd.progress * 100) });
    btn.disabled = true;
  } else if ((r && r.status === 'ready') || (info && info.pending && !upd.reverted)) {
    text = tr('GameShare {v} starts the next time you open GameShare.', { v: v || info.pending });
    if (inRoom) btn.classList.add('hidden'); else btn.textContent = tr('Restart now');
  } else if (r && r.status === 'available') {
    text = tr('GameShare {v} is available', { v });
    btn.textContent = tr('Update');
  } else if (r && r.status === 'install') {
    text = tr('GameShare {v} needs a fresh install.', { v });
    btn.textContent = tr('Download');
  } else if (r && r.status === 'latest') {
    text = tr('You have the latest version.');
  } else if (r && r.status === 'error') {
    text = tr('Couldn’t check for updates ({error}).', { error: r.error });
  } else if (info) {
    text = tr('Version {v}', { v: info.version });
  }
  if (info && info.usingUpdate) {
    text += ' ' + (upd.reverted
      ? tr('Goes back to {v} the next time you open GameShare.', { v: info.bundledVersion })
      : tr('Installed version: {v}.', { v: info.bundledVersion }));
  }
  status.textContent = text.trim();
  const revert = $('#updateRevertBtn');
  revert.classList.toggle('hidden', !(info && info.usingUpdate) || upd.reverted);
  if (info) revert.textContent = tr('Back to {v}', { v: info.bundledVersion });
}

function onUpdateMenuBtn() {
  const r = upd.result;
  const info = upd.info;
  if ((r && r.status === 'ready') || (info && info.pending && !upd.reverted)) {
    window.gameshare.restartToUpdate();
  } else if (r && (r.status === 'available' || r.status === 'install')) {
    startUpdate();
  } else {
    checkForUpdate(true);
  }
}

function initUpdates() {
  window.gameshare.onUpdateProgress((p) => { upd.progress = Number(p) || 0; renderUpdate(); });
  $('#updateGo').addEventListener('click', () => {
    if (upd.result && upd.result.status === 'ready') window.gameshare.restartToUpdate();
    else startUpdate();
  });
  $('#updateLater').addEventListener('click', () => { upd.dismissed = true; renderUpdate(); });
  $('#updateSkip').addEventListener('click', () => {
    if (upd.result) prefs.skipUpdate = upd.result.version;
    savePrefs();
    renderUpdate();
  });
  $('#updateMenuBtn').addEventListener('click', onUpdateMenuBtn);
  $('#updateRevertBtn').addEventListener('click', async () => {
    const res = await window.gameshare.revertUpdate().catch(() => null);
    if (!res || !res.ok) return;
    upd.reverted = true;
    if (upd.result && upd.result.status === 'ready') upd.result = null;
    if (res.version) prefs.skipUpdate = res.version; // don't offer the same one again right away
    savePrefs();
    renderUpdate();
  });
  $('#updateCheckSwitch').addEventListener('click', () => {
    prefs.updateCheck = prefs.updateCheck === false;
    savePrefs();
    renderUpdate();
    setupUpdateTimer();
    if (prefs.updateCheck) checkForUpdate();
  });

  window.gameshare.updateInfo().then((info) => {
    upd.info = info;
    renderUpdate();
    if (info && info.enabled && prefs.updateCheck !== false) setTimeout(() => checkForUpdate(), 4000);
  }).catch(() => {});
  setupUpdateTimer();
}

function setupUpdateTimer() {
  clearInterval(upd.timer);
  if (prefs.updateCheck === false) return;
  // Long sessions: look again every 6 hours (just a small request).
  upd.timer = setInterval(() => { if (upd.info && upd.info.enabled) checkForUpdate(); }, 6 * 3600 * 1000);
}

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

  // Soundboard
  $('#sbBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    if ($('#soundMenu').classList.contains('hidden')) openSounds(); else closeSounds();
  });
  $('#soundMenu').addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', closeSounds);
  $('#sbAdd').addEventListener('click', () => $('#sbFile').click());
  $('#sbFile').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = ''; // so the same file can be picked again
    if (files.length) await sbAddFiles(files);
  });
  $('#sbVolume').addEventListener('input', (e) => {
    prefs.sbVolume = clamp(Number(e.target.value) || 60, 5, 100);
    savePrefs();
    e.target.style.setProperty('--fill', `${((prefs.sbVolume - 5) / 95) * 100}%`);
    if (sb.playing) sb.playing.gain.gain.value = prefs.sbVolume / 100;
  });
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
    if (prefs.overlay) toast(tr('Overlay on: it shows who’s talking while you’re in another window, like your game.'));
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
  for (const s of document.querySelectorAll('.lang-select')) {
    s.value = prefs.lang || 'auto';
    s.addEventListener('change', (e) => setLanguage(e.target.value));
  }
  $('#bitrateSelect').addEventListener('change', (e) => {
    prefs.bitrate = BITRATES.includes(Number(e.target.value)) ? Number(e.target.value) : 'auto';
    savePrefs();
    if (state.screen) {
      for (const p of state.peers.values()) p.encSig = null;
      retuneAll();
      toast(tr('Bitrate updated'));
    }
  });
  $('#qualitySelect').value = state.quality;
  $('#qualitySelect').addEventListener('change', async (e) => {
    state.quality = e.target.value;
    prefs.quality = state.quality;
    savePrefs();
    updateBitrateUi();
    if (state.screen) {
      const track = state.screen.getVideoTracks()[0];
      if (track) await applyCaptureQuality(track);
      for (const p of state.peers.values()) p.encSig = null;
      retuneAll();
      toast(tr('Quality updated'));
    }
  });
  $('#duckBtn').addEventListener('click', () => {
    prefs.duck = prefs.duck !== true;
    savePrefs();
    updateDuckUi();
    updateDuck();
  });
  $('#duckSlider').addEventListener('input', (e) => {
    prefs.duckTo = clamp(Number(e.target.value) || 40, 10, 80);
    savePrefs();
    updateDuckUi();
    updateDuck();
  });
  document.querySelectorAll('#picker .mode').forEach((b) => b.addEventListener('click', () => setShareMode(b.dataset.mode)));
  $('#modeSuggest').addEventListener('click', () => setShareMode('video'));
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
      const busy = pickerOpen || !$('#settingsMenu').classList.contains('hidden') || !$('#soundMenu').classList.contains('hidden');
      if (pickerOpen) closePicker(null);
      closeSettings();
      closeSounds();
      closePersonMenu();
      if (state.cinema && !busy && !document.fullscreenElement) setCinema(null);
    }
    if (e.key === 'Enter' && pickerOpen && pickerSelected && !e.repeat) { e.preventDefault(); goPicker(); }
    const inRoom = document.body.dataset.view === 'room';
    if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || !inRoom) return;
    const k = e.key.toLowerCase();
    // When registered system-wide these arrive through onShortcut instead.
    if (k === 'm' && !state.globalKeys.includes('mute')) { e.preventDefault(); toggleMute(); }
    if (k === 'd' && !state.globalKeys.includes('deafen')) { e.preventDefault(); toggleDeafen(); }
    if (k === 'p') { e.preventDefault(); setPeoplePanel($('#room').classList.contains('collapsed')); }
    if (k === 'c') { e.preventDefault(); toggleCinema(); }
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

  initUpdates();
  window.gameshare.ready(); // started fine: keeps an in-app update from being rolled back
}

init();
