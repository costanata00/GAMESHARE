// Turns raw PCM chunks (48 kHz, 16-bit, stereo, interleaved) from the
// app-audio helper into a continuous audio stream.
//
// Whatever sits in this buffer is delay that the picture doesn't have, so
// friends hear the stream that much after they see it (lip sync). The buffer
// is therefore kept as small as the chunks' arrival allows, and steady:
//  - it watches how low the level gets (chunks never arrive perfectly evenly)
//    and aims to have a small reserve left at the lowest point of the last
//    ten seconds. Uneven arrival means a bigger buffer, even arrival a
//    smaller one, without waiting for the sound to actually run dry;
//  - to get there it plays a hair faster or slower (0.5% for 20 ms off,
//    never more than 1%: far too little to hear), instead of letting up to
//    200 ms build up and cutting it. That also absorbs the capture and
//    playback clocks drifting apart;
//  - if the sound does run dry, the reserve grows, and shrinks back slowly.
// Once a second it reports how long sound waits in here, for the Stats panel.
const RATE = 48000;
const MS = RATE / 1000;

class PcmFeed extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cap = RATE;                  // 1 s ring buffer
    this.L = new Float32Array(this.cap);
    this.R = new Float32Array(this.cap);
    this.wr = 0;                      // samples written so far
    this.rd = 0;                      // read position (fractional while adjusting speed)
    this.primed = false;
    this.MIN_MARGIN = 10 * MS;        // never plan for less than this in reserve
    this.MAX_MARGIN = 120 * MS;
    this.margin = 10 * MS;            // reserve kept in the buffer at its lowest
    this.lows = [];                   // lowest level of each of the last seconds (see steer())
    this.adj = 0;                     // samples removed (+) or added (-) by speed changes so far
    this.CHUNK = 10 * MS;             // the helper sends about this much at a time
    this.HARD_MAX = 250 * MS;         // way too much (a long stall, then a burst): skip ahead
    this.ratio = 1;                   // playback speed right now (1 = untouched)
    this.want = 1;                    // speed asked for by steer()
    this.low = Infinity;              // lowest level seen in the current window
    this.winLeft = RATE;              // samples until the window ends (1 s)
    this.dryFor = 0;                  // samples of silence played since it ran dry
    this.calm = 0;                    // windows without running dry
    this.sum = 0; this.cnt = 0;       // for the average level
    this.dry = 0;                     // times it ran dry mid-sound (since the last report)
    this.peak = 0;                    // loudest sample since the last report
    this.repLeft = RATE;
    this.port.onmessage = (e) => {
      const d = e.data;
      // A direct line from the main process (skips the page, whose own work
      // would make chunks arrive in bursts).
      if (d && d.feed) { d.feed.onmessage = (m) => this.push(m.data); return; }
      this.push(d);
    };
  }

  push(data) {
    let s;
    if (data instanceof ArrayBuffer) s = new Int16Array(data, 0, data.byteLength >> 1);
    else if (ArrayBuffer.isView(data)) {
      // (a Node Buffer may start at an odd offset inside its ArrayBuffer)
      const b = data.byteOffset % 2 ? data.slice() : data;
      s = new Int16Array(b.buffer, b.byteOffset, b.byteLength >> 1);
    } else return;
    for (let i = 0; i + 1 < s.length; i += 2) {
      const at = this.wr % this.cap;
      this.L[at] = s[i] / 32768;
      this.R[at] = s[i + 1] / 32768;
      this.wr++;
    }
    // Overflow or a big pile-up: drop the oldest, keep the margin plus a chunk.
    if (this.wr - this.rd > this.HARD_MAX) { this.rd = this.wr - Math.round(this.margin + this.CHUNK); this.ratio = this.want = 1; this.lows.length = 0; this.adj = 0; }
  }

  // Sample at fractional position `pos` (4-point Hermite; exact at whole positions).
  at(buf, pos) {
    const i = Math.floor(pos), f = pos - i, c = this.cap;
    const x0 = buf[i % c];
    if (f === 0) return x0;
    const xm = buf[(i - 1 + c) % c], x1 = buf[(i + 1) % c], x2 = buf[(i + 2) % c];
    const a = (3 * (x0 - x1) - xm + x2) / 2, b = 2 * x1 + xm - (5 * x0 + x2) / 2, d = (x1 - xm) / 2;
    return ((a * f + b) * f + d) * f + x0;
  }

  // Once a second: steer the speed so the lowest level of the last ten
  // seconds sits at the margin. (Each second's low is stored as it would be
  // without the speed changes made since, so a correction isn't counted twice.)
  steer() {
    if (this.low !== Infinity) {
      this.lows.push(this.low + this.adj);
      if (this.lows.length > 10) this.lows.shift();
      const err = Math.min(...this.lows) - this.adj - this.margin;
      // Within 3 ms: leave the sound untouched. Otherwise close the gap over ~4 s.
      this.want = Math.abs(err) < 3 * MS ? 1 : 1 + Math.max(-0.01, Math.min(0.01, err / (4 * RATE)));
      if (this.want !== 1) this.ratio = this.want; // (back to 1: see process())
      // Ten calm seconds, then the reserve shrinks by 1 ms every other second.
      if (++this.calm >= 10 && this.margin > this.MIN_MARGIN) { this.margin = Math.max(this.MIN_MARGIN, this.margin - MS); this.calm = 8; }
    }
    this.low = Infinity;
    this.winLeft = RATE;
  }

  report() {
    this.port.postMessage({
      delayMs: this.cnt ? this.sum / this.cnt / MS : null, // how long sound waits in here, on average
      marginMs: this.margin / MS, ratio: this.ratio, dry: this.dry, peak: this.peak
    });
    this.sum = 0; this.cnt = 0; this.dry = 0; this.peak = 0; this.repLeft = RATE;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const l = out[0], r = out[1] || out[0];
    const n = l.length;
    let level = this.wr - this.rd;
    if (!this.primed) {
      // Start (or start again after silence) once the margin and a chunk are in.
      if (level >= this.margin + this.CHUNK) {
        // It ran dry and sound came straight back: chunks are arriving in
        // bursts, not the app going quiet. Keep more in reserve.
        if (this.dryFor > 0 && this.dryFor < 150 * MS) {
          this.margin = Math.min(this.MAX_MARGIN, this.margin + 10 * MS);
          this.dry++; this.calm = 0;
        }
        this.primed = true; this.dryFor = 0; this.ratio = this.want = 1; this.low = Infinity; this.winLeft = RATE;
        this.lows.length = 0; this.adj = 0;
        // Nothing is playing yet, so anything beyond the reserve can simply be skipped.
        this.rd = level > this.margin + 2 * this.CHUNK ? this.wr - Math.round(this.margin + this.CHUNK) : Math.ceil(this.rd);
      } else {
        l.fill(0); if (r !== l) r.fill(0);
        if (this.dryFor > 0) this.dryFor += n;
        if ((this.repLeft -= n) <= 0) this.report();
        return true;
      }
    }
    if (level < this.low) this.low = level;
    this.sum += level; this.cnt++;
    let i = 0;
    for (; i < n; i++) {
      // (the interpolation looks two samples ahead)
      if (this.wr - this.rd < (this.ratio === 1 ? 1 : 3)) break;
      const a = this.at(this.L, this.rd), b = this.at(this.R, this.rd);
      l[i] = a; if (r !== l) r[i] = b;
      const m = a < 0 ? -a : a; if (m > this.peak) this.peak = m;
      const next = this.rd + this.ratio;
      this.adj += this.ratio - 1;
      if (this.ratio !== 1 && this.want === 1) {
        // Going back to normal speed: do it the moment the position passes a
        // whole sample, so from then on the sound goes through untouched.
        const f = this.rd - Math.floor(this.rd);
        if (this.ratio > 1 ? f + this.ratio - 1 >= 1 : f < 1 - this.ratio) {
          this.rd = this.ratio > 1 ? Math.floor(next) : Math.ceil(next);
          this.ratio = 1;
          continue;
        }
      }
      this.rd = next;
    }
    if (i < n) {
      // Ran dry: silence until enough is back.
      for (; i < n; i++) { l[i] = 0; if (r !== l) r[i] = 0; }
      this.primed = false; this.dryFor = 1; this.rd = this.wr;
    }
    if ((this.winLeft -= n) <= 0 && this.primed) this.steer();
    if ((this.repLeft -= n) <= 0) this.report();
    return true;
  }
}
registerProcessor('gs-pcm-feed', PcmFeed);
