import { hann, fftInPlace } from "./fft.js";
import { colorMap } from "./utils.js";

export const computeSpectrogram = ({
  samples,
  sampleRate,
  winSize,
  hopSize,
  maxFreqHz,
  dbRange,
}) => {
  const window = hann(winSize);
  const nyquist = sampleRate / 2;
  const maxBin = Math.min(
    winSize / 2,
    Math.floor((maxFreqHz / nyquist) * (winSize / 2))
  );

  const frames = Math.max(
    0,
    Math.floor((samples.length - winSize) / hopSize) + 1
  );

  const data = new Array(frames);
  let maxDb = -Infinity;

  const re = new Float32Array(winSize);
  const im = new Float32Array(winSize);

  for (let f = 0; f < frames; f++) {
    const start = f * hopSize;

    re.fill(0);
    im.fill(0);

    for (let i = 0; i < winSize; i++) {
      re[i] = (samples[start + i] || 0) * window[i];
    }

    fftInPlace(re, im, false);

    const row = new Float32Array(maxBin);
    for (let b = 0; b < maxBin; b++) {
      const mag = Math.hypot(re[b], im[b]);
      const db = 20 * Math.log10(mag / winSize + 1e-12);
      row[b] = db;
      if (db > maxDb) maxDb = db;
    }
    data[f] = row;
  }

  const floorDb = maxDb - dbRange;

  return {
    data,
    frames,
    bins: maxBin,
    maxDb,
    floorDb,
    sampleRate,
    hopSize,
    winSize,
    durationSec: samples.length / sampleRate,
  };
};

export const makeSpectrogramBitmap = (spec) => {
  const { data, frames, bins, maxDb, floorDb } = spec;
  const img = new ImageData(frames, bins);
  const out = img.data;

  for (let x = 0; x < frames; x++) {
    const col = data[x];
    for (let y = 0; y < bins; y++) {
      const db = col[bins - 1 - y];
      const t = (db - floorDb) / (maxDb - floorDb);
      const [r, g, b] = colorMap(t);
      const i = (y * frames + x) * 4;
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
      out[i + 3] = 255;
    }
  }

  const off = document.createElement("canvas");
  off.width = frames;
  off.height = bins;
  off.getContext("2d").putImageData(img, 0, 0);
  return off;
};
