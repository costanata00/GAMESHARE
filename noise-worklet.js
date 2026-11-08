// Removes background noise from the microphone (keyboard, fans, game sound
// from speakers) with RNNoise, a small neural network made for voice.
// RNNoise works on 10 ms frames (480 samples at 48 kHz), so this adds 10 ms
// of delay. Send {on:false} to pass the sound through untouched.
import createRNNWasmModuleSync from './vendor/rnnoise-sync.js';

const FRAME = 480;
const SCALE = 32768; // RNNoise expects 16-bit sample values

class NoiseRemover extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = true;
    this.ok = false;
    try {
      this.m = createRNNWasmModuleSync();
      this.st = this.m._rnnoise_create();
      this.inPtr = this.m._malloc(FRAME * 4);
      this.outPtr = this.m._malloc(FRAME * 4);
      this.ok = !!this.st;
    } catch (e) {
      this.port.postMessage({ error: String(e && e.message || e) });
    }
    this.inQ = new Float32Array(FRAME + 256);
    this.inN = 0;
    this.outQ = new Float32Array(FRAME * 3);
    this.outN = FRAME; // starts with 10 ms of silence: the processing delay
    this.port.onmessage = (e) => { if (e.data && 'on' in e.data) this.on = !!e.data.on; };
    if (this.ok) this.port.postMessage({ ready: true });
  }

  process(inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    const inp = inputs[0] && inputs[0][0];
    if (!inp) { out.fill(0); return true; }
    if (!this.ok || !this.on) { out.set(inp); return true; }

    this.inQ.set(inp, this.inN);
    this.inN += inp.length;
    while (this.inN >= FRAME) {
      let heap = this.m.HEAPF32;
      const ip = this.inPtr >> 2, op = this.outPtr >> 2;
      for (let i = 0; i < FRAME; i++) heap[ip + i] = this.inQ[i] * SCALE;
      this.m._rnnoise_process_frame(this.st, this.outPtr, this.inPtr);
      heap = this.m.HEAPF32; // the heap view changes if wasm memory grew
      for (let i = 0; i < FRAME; i++) this.outQ[this.outN + i] = heap[op + i] / SCALE;
      this.outN += FRAME;
      this.inQ.copyWithin(0, FRAME, this.inN);
      this.inN -= FRAME;
    }
    const n = Math.min(out.length, this.outN);
    out.set(this.outQ.subarray(0, n));
    if (n < out.length) out.fill(0, n);
    this.outQ.copyWithin(0, n, this.outN);
    this.outN -= n;
    return true;
  }
}

registerProcessor('gs-noise', NoiseRemover);
