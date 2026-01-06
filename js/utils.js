export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

export const formatSec = (s) => {
  if (!Number.isFinite(s)) return "—";
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(2).padStart(5, "0")}`;
};

const colorStops = [
  [0.0, [0, 0, 0]],
  [0.25, [32, 0, 64]],
  [0.5, [0, 120, 200]],
  [0.75, [240, 220, 80]],
  [1.0, [255, 255, 255]],
];

export const colorMap = (t) => {
  t = clamp(t, 0, 1);
  for (let i = 0; i < colorStops.length - 1; i++) {
    const [t0, c0] = colorStops[i];
    const [t1, c1] = colorStops[i + 1];
    if (t >= t0 && t <= t1) {
      const u = (t - t0) / (t1 - t0);
      return c0.map((v, j) => Math.round(v + (c1[j] - v) * u));
    }
  }
  return [0, 0, 0];
};

export const resizeCanvasToCSS = (canvas) => {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  return { dpr, w, h };
};

export const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 0));
