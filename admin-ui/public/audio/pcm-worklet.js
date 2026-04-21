// PCM16LE downsampler worklet.
//
// Input: 128-sample Float32 frames at the AudioContext native rate (typically
// 48000 Hz; 44100 on some hardware). Output: Int16 PCM buffers at a target
// rate (default 16000 Hz), posted to the main thread every ~30 ms.
//
// Simple integer-ratio averaging decimation is used because it's zero-dep and
// perfectly adequate for 16 kHz voice STT. A polyphase resampler would be
// overkill here and would pull in a DSP library.

const TARGET_RATE = 16000;
const FRAME_MS = 30;

class PcmWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(0);
    this._ratio = Math.max(1, sampleRate / TARGET_RATE);
    this._intRatio = Math.round(this._ratio);
    this._isIntegerRatio =
      Math.abs(this._ratio - this._intRatio) < 1e-6 && this._intRatio >= 1;
    this._emitSamples = Math.max(
      1,
      Math.floor((TARGET_RATE * FRAME_MS) / 1000),
    );
    this._phase = 0;
  }

  _append(chunk) {
    const merged = new Float32Array(this._buffer.length + chunk.length);
    merged.set(this._buffer, 0);
    merged.set(chunk, this._buffer.length);
    this._buffer = merged;
  }

  _downsampleInteger(input) {
    const ratio = this._intRatio;
    const outLen = Math.floor(input.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      let acc = 0;
      const base = i * ratio;
      for (let j = 0; j < ratio; j++) acc += input[base + j];
      out[i] = acc / ratio;
    }
    return { out, consumed: outLen * ratio };
  }

  _downsampleLinear(input) {
    const ratio = this._ratio;
    const outLen = Math.floor((input.length - this._phase) / ratio);
    if (outLen <= 0) {
      return { out: new Float32Array(0), consumed: 0 };
    }
    const out = new Float32Array(outLen);
    let pos = this._phase;
    for (let i = 0; i < outLen; i++) {
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const a = input[idx] || 0;
      const b = input[idx + 1] !== undefined ? input[idx + 1] : a;
      out[i] = a + (b - a) * frac;
      pos += ratio;
    }
    const consumed = Math.floor(pos);
    this._phase = pos - consumed;
    return { out, consumed };
  }

  _flush() {
    if (this._buffer.length === 0) return;
    const { out, consumed } =
      this._isIntegerRatio
        ? this._downsampleInteger(this._buffer)
        : this._downsampleLinear(this._buffer);
    if (consumed > 0) {
      this._buffer = this._buffer.slice(consumed);
    }
    if (out.length === 0) return;
    const pcm = new Int16Array(out.length);
    for (let i = 0; i < out.length; i++) {
      const s = Math.max(-1, Math.min(1, out[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this.port.postMessage(pcm.buffer, [pcm.buffer]);
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel) return true;
    this._append(channel);
    const required = Math.ceil(this._emitSamples * this._ratio) + 4;
    if (this._buffer.length >= required) {
      this._flush();
    }
    return true;
  }
}

registerProcessor('pcm-worklet', PcmWorklet);
