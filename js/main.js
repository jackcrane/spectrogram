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

const MIN_ZOOM = 1;
const MAX_ZOOM = 6;

const view = { scale: 1, offsetX: 0, offsetY: 0 };
let gestureState = null;
let panState = null;
let wheelZoomTimer = null;
let isTransforming = false;
const activePointers = new Map();
let pointerDrawingId = null;

const isPanModifier = (event) =>
  event.shiftKey || event.ctrlKey || event.metaKey;

const updateTransformingFlag = () => {
  isTransforming = Boolean(gestureState || panState || wheelZoomTimer);
};

const resetViewTransform = () => {
  view.scale = 1;
  view.offsetX = 0;
  view.offsetY = 0;
};

const clampViewOffset = (rect) => {
  if (!spec || rect.width === 0 || rect.height === 0) return;
  const minX = rect.width - rect.width * view.scale;
  const minY = rect.height - rect.height * view.scale;
  view.offsetX = clamp(view.offsetX, minX, 0);
  view.offsetY = clamp(view.offsetY, minY, 0);
};

const specCoordFromCss = (cssValue, rectSize, specSize, axisOffset) => {
  if (rectSize === 0 || view.scale === 0) return 0;
  const base = (cssValue - axisOffset) / view.scale;
  return clamp((base / rectSize) * specSize, 0, specSize);
};

const getViewSourceRect = (rect) => {
  if (!spec || rect.width === 0 || rect.height === 0) {
    return {
      sx: 0,
      sy: 0,
      sw: spec?.frames || 0,
      sh: spec?.bins || 0,
    };
  }

  const left = specCoordFromCss(0, rect.width, spec.frames, view.offsetX);
  const right = specCoordFromCss(
    rect.width,
    rect.width,
    spec.frames,
    view.offsetX
  );
  const top = specCoordFromCss(0, rect.height, spec.bins, view.offsetY);
  const bottom = specCoordFromCss(
    rect.height,
    rect.height,
    spec.bins,
    view.offsetY
  );

  const leftClamped = clamp(left, 0, spec.frames);
  const rightClamped = clamp(right, 0, spec.frames);
  const topClamped = clamp(top, 0, spec.bins);
  const bottomClamped = clamp(bottom, 0, spec.bins);

  const sw = Math.max(1, rightClamped - leftClamped);
  const sh = Math.max(1, bottomClamped - topClamped);

  return {
    sx: Math.max(0, Math.min(leftClamped, spec.frames - sw)),
    sy: Math.max(0, Math.min(topClamped, spec.bins - sh)),
    sw,
    sh,
  };
};

const applyZoom = (newScale, focalX, focalY) => {
  if (!spec) return;
  const rect = els.canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;

  const clampedScale = clamp(newScale, MIN_ZOOM, MAX_ZOOM);
  const prevScale = view.scale;
  if (prevScale === 0) return;

  const baseX = (focalX - view.offsetX) / prevScale;
  const baseY = (focalY - view.offsetY) / prevScale;

  view.scale = clampedScale;
  view.offsetX = focalX - baseX * view.scale;
  view.offsetY = focalY - baseY * view.scale;

  clampViewOffset(rect);
};

const cancelActiveTransforms = () => {
  gestureState = null;
  panState = null;
  if (wheelZoomTimer) {
    clearTimeout(wheelZoomTimer);
    wheelZoomTimer = null;
  }
  updateTransformingFlag();
};

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
  if (!spec) return [0, 0];
  const rect = els.canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return [0, 0];

  const xCss = clientX - rect.left;
  const yCss = clientY - rect.top;

  const specX = clamp(
    Math.floor(
      specCoordFromCss(xCss, rect.width, spec.frames, view.offsetX)
    ),
    0,
    spec.frames - 1
  );
  const specYTop = clamp(
    Math.floor(
      specCoordFromCss(yCss, rect.height, spec.bins, view.offsetY)
    ),
    0,
    spec.bins - 1
  );
  const bin = spec.bins - 1 - specYTop;
  return [specX, bin];
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

const endDraw = () => {
  drawing = false;
  lastFx = null;
  lastBy = null;
  pointerDrawingId = null;
};

const endPan = () => {
  panState = null;
  updateTransformingFlag();
};

const endGesture = () => {
  gestureState = null;
  updateTransformingFlag();
};

const startDrawing = (event) => {
  drawing = true;
  pointerDrawingId = event.pointerId;
  drawValue = event.button === 2 ? 0 : 1;
  const [fx, by] = canvasToSpec(event.clientX, event.clientY);
  lastFx = fx;
  lastBy = by;
  paintCell(fx, by, drawValue);
};

const startPan = (event) => {
  panState = {
    pointerId: event.pointerId,
    clientX: event.clientX,
    clientY: event.clientY,
    offsetX: view.offsetX,
    offsetY: view.offsetY,
  };
  endDraw();
  endGesture();
  updateTransformingFlag();
};

const updatePan = (event) => {
  if (!panState || event.pointerId !== panState.pointerId) return;
  const rect = els.canvas.getBoundingClientRect();
  const deltaX = event.clientX - panState.clientX;
  const deltaY = event.clientY - panState.clientY;

  view.offsetX = panState.offsetX + deltaX;
  view.offsetY = panState.offsetY + deltaY;
  clampViewOffset(rect);
};

const startGesture = () => {
  if (activePointers.size < 2) return;
  const entries = Array.from(activePointers.entries()).slice(0, 2);
  if (entries.length < 2) return;
  const pointerIds = entries.map(([id]) => id);
  const positions = entries.map(([, pos]) => pos);
  if (positions.some((pos) => !pos)) return;

  const center = {
    x: (positions[0].clientX + positions[1].clientX) / 2,
    y: (positions[0].clientY + positions[1].clientY) / 2,
  };
  const distance = Math.max(
    1,
    Math.hypot(
      positions[1].clientX - positions[0].clientX,
      positions[1].clientY - positions[0].clientY
    )
  );

  endDraw();
  endPan();

  gestureState = {
    pointerIds,
    startCenter: center,
    startDistance: distance,
    startZoom: view.scale,
    startOffsetX: view.offsetX,
    startOffsetY: view.offsetY,
  };
  updateTransformingFlag();
};

const updateGesture = () => {
  if (!gestureState) return;
  const positions = gestureState.pointerIds
    .map((id) => activePointers.get(id))
    .filter(Boolean);
  if (positions.length < 2) {
    endGesture();
    return;
  }

  const center = {
    x: (positions[0].clientX + positions[1].clientX) / 2,
    y: (positions[0].clientY + positions[1].clientY) / 2,
  };
  const dx = positions[1].clientX - positions[0].clientX;
  const dy = positions[1].clientY - positions[0].clientY;
  const distance = Math.max(1, Math.hypot(dx, dy));

  const zoomFactor = distance / gestureState.startDistance;
  const targetScale = clamp(
    gestureState.startZoom * zoomFactor,
    MIN_ZOOM,
    MAX_ZOOM
  );

  const centerDeltaX = center.x - gestureState.startCenter.x;
  const centerDeltaY = center.y - gestureState.startCenter.y;
  const offsetAfterPanX = gestureState.startOffsetX + centerDeltaX;
  const offsetAfterPanY = gestureState.startOffsetY + centerDeltaY;
  const baseX = (center.x - offsetAfterPanX) / gestureState.startZoom;
  const baseY = (center.y - offsetAfterPanY) / gestureState.startZoom;

  view.scale = targetScale;
  view.offsetX = center.x - baseX * view.scale;
  view.offsetY = center.y - baseY * view.scale;

  const rect = els.canvas.getBoundingClientRect();
  clampViewOffset(rect);
};

const drawFrame = () => {
  const ctx = els.canvas.getContext("2d");
  const { w, h } = resizeCanvasToCSS(els.canvas);

  ctx.clearRect(0, 0, w, h);

  const rect = els.canvas.getBoundingClientRect();
  clampViewOffset(rect);
  const sourceRect = spec ? getViewSourceRect(rect) : null;

  if (bitmap) {
    ctx.imageSmoothingEnabled = false;
    if (sourceRect && spec) {
      ctx.drawImage(
        bitmap,
        sourceRect.sx,
        sourceRect.sy,
        sourceRect.sw,
        sourceRect.sh,
        0,
        0,
        w,
        h
      );
    } else {
      ctx.drawImage(bitmap, 0, 0, w, h);
    }
  }

  if (maskCanvas && sourceRect && spec) {
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = 1;
    ctx.drawImage(
      maskCanvas,
      sourceRect.sx,
      sourceRect.sy,
      sourceRect.sw,
      sourceRect.sh,
      0,
      0,
      w,
      h
    );
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
    cancelActiveTransforms();
    resetViewTransform();

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
  cancelActiveTransforms();
  resetViewTransform();

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

      resetViewTransform();
      cancelActiveTransforms();

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
  event.preventDefault();
  activePointers.set(event.pointerId, {
    clientX: event.clientX,
    clientY: event.clientY,
  });
  els.canvas.setPointerCapture(event.pointerId);

  if (!spec || !drawMask) return;

  if (!gestureState && activePointers.size >= 2) {
    startGesture();
    return;
  }

  if (isPanModifier(event)) {
    startPan(event);
    return;
  }

  if (!isTransforming) {
    startDrawing(event);
  }
});

els.canvas.addEventListener("pointermove", (event) => {
  if (activePointers.has(event.pointerId)) {
    activePointers.set(event.pointerId, {
      clientX: event.clientX,
      clientY: event.clientY,
    });
  }

  if (!spec || !drawMask) return;

  if (gestureState) {
    updateGesture();
    return;
  }

  if (panState && event.pointerId === panState.pointerId) {
    updatePan(event);
    return;
  }

  if (
    drawing &&
    pointerDrawingId === event.pointerId &&
    !isTransforming
  ) {
    const [fx, by] = canvasToSpec(event.clientX, event.clientY);
    if (lastFx !== null) {
      paintLine(lastFx, lastBy, fx, by, drawValue);
    }
    lastFx = fx;
    lastBy = by;
  }
});

const handlePointerEnd = (event) => {
  activePointers.delete(event.pointerId);
  if (gestureState && activePointers.size < 2) {
    endGesture();
  }
  if (panState && panState.pointerId === event.pointerId) {
    endPan();
  }
  if (pointerDrawingId === event.pointerId) {
    endDraw();
  }
  els.canvas.releasePointerCapture(event.pointerId);
};

els.canvas.addEventListener("pointerup", handlePointerEnd);
els.canvas.addEventListener("pointercancel", handlePointerEnd);
els.canvas.addEventListener("pointerleave", endDraw);

els.canvas.addEventListener("wheel", (event) => {
  if (!spec) return;
  event.preventDefault();
  const zoomAmount = Math.pow(1.0015, -event.deltaY);
  applyZoom(view.scale * zoomAmount, event.clientX, event.clientY);

  if (wheelZoomTimer) clearTimeout(wheelZoomTimer);
  wheelZoomTimer = setTimeout(() => {
    wheelZoomTimer = null;
    updateTransformingFlag();
  }, 220);
  updateTransformingFlag();
});

setStatus("load an audio file");
setButtons(false);
