import { clamp, formatSec, resizeCanvasToCSS, nextFrame } from "./utils.js";
import { computeSpectrogram, makeSpectrogramBitmap } from "./spectrogram.js";
import {
  AudioPlayer,
  decodeAudioFile,
  resynthesizeMasked,
} from "./audio.js";

const els = {
  file: document.getElementById("file"),
  samples: document.getElementById("samples"),
  maxfreq: document.getElementById("maxfreq"),
  render: document.getElementById("render"),
  play: document.getElementById("play"),
  pause: document.getElementById("pause"),
  stop: document.getElementById("stop"),
  clear: document.getElementById("clear"),
  status: document.getElementById("status"),
  time: document.getElementById("time"),
  canvas: document.getElementById("canvas"),
};

const player = new AudioPlayer();

let decoded = null;
let spec = null;
let bitmap = null;
let drawMask = null;
let maskCanvas = null;
let maskCtx = null;

const WIN_SIZE = 4096;
const HOP_SIZE = 512;
const DB_RANGE = 80;
let maxFreqHz = Number(els.maxfreq.value);

let lastFx = null;
let lastBy = null;
let drawing = false;
let drawValue = 1; // 1 draw, 0 erase

const setStatus = (text) => {
  els.status.textContent = text;
};

const setButtons = (ready) => {
  els.render.disabled = !ready;
  els.play.disabled = !ready;
  els.pause.disabled = !ready;
  els.stop.disabled = !ready;
  els.clear.disabled = !ready;
};

const initMask = (newSpec) => {
  drawMask = Array.from({ length: newSpec.frames }, () =>
    new Float32Array(newSpec.bins).fill(0)
  );

  maskCanvas = document.createElement("canvas");
  maskCanvas.width = newSpec.frames;
  maskCanvas.height = newSpec.bins;
  maskCtx = maskCanvas.getContext("2d", { willReadFrequently: false });
  maskCtx.imageSmoothingEnabled = false;
  maskCtx.clearRect(0, 0, newSpec.frames, newSpec.bins);
};

const clearMask = () => {
  if (!drawMask || !maskCtx || !spec) return;
  for (let x = 0; x < spec.frames; x++) drawMask[x].fill(0);
  maskCtx.clearRect(0, 0, spec.frames, spec.bins);
};

const canvasToSpec = (clientX, clientY) => {
  const rect = els.canvas.getBoundingClientRect();
  const xCss = clientX - rect.left;
  const yCss = clientY - rect.top;

  const fx = clamp(
    Math.floor((xCss / rect.width) * spec.frames),
    0,
    spec.frames - 1
  );
  const byTop = clamp(
    Math.floor((yCss / rect.height) * spec.bins),
    0,
    spec.bins - 1
  );
  const bin = spec.bins - 1 - byTop;
  return [fx, bin];
};

const paintCell = (frameX, binY, value01) => {
  if (!drawMask || !maskCtx || !spec) return;

  drawMask[frameX][binY] = value01;
  const cy = spec.bins - 1 - binY;
  if (value01 >= 0.5) {
    maskCtx.fillStyle = "rgba(255,0,0,1)";
    maskCtx.fillRect(frameX, cy, 1, 1);
  } else {
    maskCtx.clearRect(frameX, cy, 1, 1);
  }
};

const paintLine = (x0, y0, x1, y1, value01) => {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;

  let x = x0;
  let y = y0;

  while (true) {
    paintCell(x, y, value01);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
};

const drawFrame = () => {
  const ctx = els.canvas.getContext("2d");
  const { w, h } = resizeCanvasToCSS(els.canvas);

  ctx.clearRect(0, 0, w, h);

  if (bitmap) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bitmap, 0, 0, w, h);
  }

  if (maskCanvas) {
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = 1;
    ctx.drawImage(maskCanvas, 0, 0, w, h);
    ctx.restore();
  }

  if (spec && player.state === "playing") {
    const t = player.currentTimeSec();
    const x = (t / spec.durationSec) * w;

    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = Math.max(1, Math.floor(window.devicePixelRatio || 1));
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.restore();
  }

  if (spec) {
    const current = player.currentTimeSec();
    els.time.textContent = `${formatSec(current)} / ${formatSec(
      spec.durationSec
    )}`;
  } else {
    els.time.textContent = "";
  }
};

const tick = () => {
  drawFrame();
  requestAnimationFrame(tick);
};

requestAnimationFrame(tick);
window.addEventListener("resize", () => drawFrame(), { passive: true });

els.maxfreq.addEventListener("change", () => {
  maxFreqHz = Number(els.maxfreq.value);
  setStatus("max frequency changed – re-render required");
  setButtons(false);
  els.render.disabled = false;
});

els.samples.addEventListener("change", async () => {
  const name = els.samples.value;
  if (!name) return;

  setStatus("loading sample…");
  setButtons(false);

  try {
    const res = await fetch(name);
    const blob = await res.blob();
    const file = new File([blob], name, { type: blob.type });

    decoded = await decodeAudioFile(file);

    spec = null;
    bitmap = null;
    drawMask = null;
    maskCanvas = null;
    maskCtx = null;
    player.stop();

    setStatus(
      `ready (${decoded.sampleRate} Hz, ${formatSec(decoded.buffer.duration)})`
    );
    els.render.disabled = false;
  } catch (error) {
    console.error(error);
    setStatus("sample load failed");
  }
});

els.file.addEventListener("change", async () => {
  const file = els.file.files?.[0];
  if (!file) return;

  setStatus("decoding…");
  setButtons(false);

  spec = null;
  bitmap = null;
  decoded = null;
  drawMask = null;
  maskCanvas = null;
  maskCtx = null;

  player.stop();

  try {
    decoded = await decodeAudioFile(file);
    setStatus(
      `ready (${decoded.sampleRate} Hz, ${formatSec(decoded.buffer.duration)})`
    );
    els.render.disabled = false;
  } catch (error) {
    console.error(error);
    setStatus("decode failed");
  }
});

els.render.addEventListener("click", async () => {
  if (!decoded) return;

  setStatus("rendering spectrogram…");
  els.render.disabled = true;
  setButtons(false);

  player.stop();
  bitmap = null;
  spec = null;
  drawMask = null;
  maskCanvas = null;
  maskCtx = null;

  await nextFrame();

  try {
    spec = computeSpectrogram({
      samples: decoded.mono,
      sampleRate: decoded.sampleRate,
      winSize: WIN_SIZE,
      hopSize: HOP_SIZE,
      maxFreqHz,
      dbRange: DB_RANGE,
    });

    bitmap = makeSpectrogramBitmap(spec);
    initMask(spec);

    setStatus("spectrogram ready (draw RED to hear; erase to remove)");
    setButtons(true);
  } catch (error) {
    console.error(error);
    setStatus("render failed");
    setButtons(false);
  } finally {
    els.render.disabled = false;
  }
});

els.clear.addEventListener("click", () => {
  clearMask();
  setStatus("cleared");
});

els.play.addEventListener("click", async () => {
  if (!decoded || !spec || !drawMask) return;

  setStatus("building audio from drawing…");
  els.play.disabled = true;

  try {
    const maskedBuffer = await resynthesizeMasked({
      player,
      decoded,
      spec,
      drawMask,
      winSize: WIN_SIZE,
      hopSize: HOP_SIZE,
    });
    if (!maskedBuffer) {
      setStatus("failed to build audio");
      return;
    }

    player.setBuffer(maskedBuffer);
    setStatus("playing");
    await player.play();
  } catch (error) {
    console.error(error);
    setStatus("play failed");
  } finally {
    els.play.disabled = false;
  }
});

els.pause.addEventListener("click", () => {
  player.pause();
  setStatus("paused");
  drawFrame();
});

els.stop.addEventListener("click", () => {
  player.stop();
  setStatus("stopped");
  drawFrame();
});

els.canvas.addEventListener("contextmenu", (event) => event.preventDefault());

els.canvas.addEventListener("pointerdown", (event) => {
  if (!spec || !drawMask) return;
  drawing = true;
  drawValue = event.button === 2 ? 0 : 1;
  els.canvas.setPointerCapture(event.pointerId);

  const [fx, by] = canvasToSpec(event.clientX, event.clientY);
  lastFx = fx;
  lastBy = by;
  paintCell(fx, by, drawValue);
});

els.canvas.addEventListener("pointermove", (event) => {
  if (!drawing || !spec || !drawMask) return;
  const [fx, by] = canvasToSpec(event.clientX, event.clientY);

  if (lastFx !== null) {
    paintLine(lastFx, lastBy, fx, by, drawValue);
  }

  lastFx = fx;
  lastBy = by;
});

const endDraw = () => {
  drawing = false;
  lastFx = null;
  lastBy = null;
};

els.canvas.addEventListener("pointerup", endDraw);
els.canvas.addEventListener("pointercancel", endDraw);
els.canvas.addEventListener("pointerleave", endDraw);

setStatus("load an audio file");
setButtons(false);
