// Turns raw PCM chunks (48 kHz, 16-bit, stereo, interleaved) from the
// app-audio helper into a continuous audio stream, with a small buffer to
// absorb timing differences between the capture and playback clocks.
class PcmFeed extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cap = 48000;               // 1 s ring buffer
    this.L = new Float32Array(this.cap);
    this.R = new Float32Array(this.cap);
    this.rd = 0; this.wr = 0; this.n = 0;
    this.primed = false;
    this.START = 1920;              // wait for 40 ms before playing
    this.MAX = 9600;                // never let it drift past 200 ms
    this.TRIM = 2880;               // ...trim back to 60 ms if it does
    this.port.onmessage = (e) => {
      const s = new Int16Array(e.data);
      for (let i = 0; i + 1 < s.length; i += 2) {
        this.L[this.wr] = s[i] / 32768;
        this.R[this.wr] = s[i + 1] / 32768;
        this.wr = (this.wr + 1) % this.cap;
        if (this.n < this.cap) this.n++; else this.rd = (this.rd + 1) % this.cap;
      }
      if (this.n > this.MAX) {
        const drop = this.n - this.TRIM;
        this.rd = (this.rd + drop) % this.cap;
        this.n -= drop;
      }
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0];
    const l = out[0], r = out[1] || out[0];
    if (!this.primed) {
      if (this.n < this.START) { l.fill(0); r.fill(0); return true; }
      this.primed = true;
    }
    for (let i = 0; i < l.length; i++) {
      if (this.n > 0) {
        l[i] = this.L[this.rd]; r[i] = this.R[this.rd];
        this.rd = (this.rd + 1) % this.cap; this.n--;
      } else {
        l[i] = 0; r[i] = 0; this.primed = false;
      }
    }
    return true;
  }
}
registerProcessor('gs-pcm-feed', PcmFeed);
