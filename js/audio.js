import { clamp } from "./utils.js";
import { hann, fftInPlace } from "./fft.js";

export class AudioPlayer {
  constructor() {
    this.ctx = null;
    this.buffer = null;
    this.source = null;
    this.gain = null;
    this.startedAt = 0;
    this.offsetSec = 0;
    this.state = "stopped";
  }

  async ensureContext() {
    if (!this.ctx)
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === "suspended") await this.ctx.resume();
    if (!this.gain) {
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 1.0;
      this.gain.connect(this.ctx.destination);
    }
  }

  setBuffer(buffer) {
    this.buffer = buffer;
    this.stop();
  }

  _makeSource() {
    const s = this.ctx.createBufferSource();
    s.buffer = this.buffer;
    s.connect(this.gain);
    s.onended = () => {
      if (
        this.state === "playing" &&
        this.currentTimeSec() >= this.durationSec() - 0.02
      ) {
        this.state = "stopped";
        this.offsetSec = 0;
      }
    };
    return s;
  }

  durationSec() {
    return this.buffer ? this.buffer.duration : 0;
  }

  currentTimeSec() {
    if (!this.ctx) return 0;
    if (this.state === "playing") {
      return clamp(
        this.offsetSec + (this.ctx.currentTime - this.startedAt),
        0,
        this.durationSec()
      );
    }
    return clamp(this.offsetSec, 0, this.durationSec());
  }

  async play() {
    if (!this.buffer) return;
    await this.ensureContext();
    if (this.state === "playing") return;

    this.source = this._makeSource();
    this.startedAt = this.ctx.currentTime;
    this.source.start(0, this.offsetSec);
    this.state = "playing";
  }

  pause() {
    if (this.state !== "playing") return;
    this.offsetSec = this.currentTimeSec();
    this._stopSourceOnly();
    this.state = "paused";
  }

  stop() {
    this.offsetSec = 0;
    this._stopSourceOnly();
    this.state = "stopped";
  }

  _stopSourceOnly() {
    if (!this.source) return;
    try {
      this.source.onended = null;
      this.source.stop();
    } catch {}
    try {
      this.source.disconnect();
    } catch {}
    this.source = null;
  }
}

export const decodeAudioFile = async (file) => {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const buffer = await ctx.decodeAudioData(await file.arrayBuffer());

  const mono = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) mono[i] += d[i] / buffer.numberOfChannels;
  }

  return { buffer, mono, sampleRate: buffer.sampleRate };
};

export const resynthesizeMasked = async ({
  player,
  decoded,
  spec,
  drawMask,
  winSize,
  hopSize,
}) => {
  if (!decoded || !spec || !drawMask) return null;

  await player.ensureContext();

  const { mono, sampleRate } = decoded;
  const outBuf = player.ctx.createBuffer(1, mono.length, sampleRate);
  const out = outBuf.getChannelData(0);

  const window = hann(winSize);
  const norm = new Float32Array(out.length);

  const re = new Float32Array(winSize);
  const im = new Float32Array(winSize);

  for (let f = 0; f < spec.frames; f++) {
    const start = f * hopSize;

    re.fill(0);
    im.fill(0);

    for (let i = 0; i < winSize; i++) {
      re[i] = (mono[start + i] || 0) * window[i];
    }

    fftInPlace(re, im, false);

    const maxBin = spec.bins;

    for (let b = 0; b <= winSize / 2; b++) {
      const m = b < maxBin ? drawMask[f][b] : 0;
      re[b] *= m;
      im[b] *= m;

      if (b !== 0 && b !== winSize / 2) {
        const mb = winSize - b;
        re[mb] *= m;
        im[mb] *= m;
      }
    }

    fftInPlace(re, im, true);

    for (let i = 0; i < winSize; i++) {
      const idx = start + i;
      if (idx >= out.length) break;
      const w = window[i];
      out[idx] += re[i] * w;
      norm[idx] += w * w;
    }
  }

  for (let i = 0; i < out.length; i++) {
    const n = norm[i];
    out[i] = n > 1e-8 ? out[i] / n : 0;
  }

  return outBuf;
};
