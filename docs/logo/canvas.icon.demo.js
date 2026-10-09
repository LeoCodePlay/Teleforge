/**
 * Teleforge 标识的 Canvas 绘制 + 动效起步模板
 *
 * 什么时候用它(而不是 SVG / <img src="*.svg">):
 *   - 同一形状每帧都在重绘:连接脉冲、轨道旋转、火花明灭、加载态;
 *   - 需要离屏合成 / 发光叠加 / 像素级处理。
 * 静态图标、favicon、导航栏一律用 SVG(见 icon.sprite.svg 与 concepts/),
 * 不要为了「统一」把静态图标也搬到 Canvas —— 那样会丢掉换色与矢量缩放的好处。
 *
 * 这套几何常量与 docs/logo/build-logos.mjs 里"双向 T"的 SVG 几何逐值对应
 * (64 网格 / 描边 6 / 全圆角端点 / 光学方框 46),两边不会走形。
 *
 * 用法:
 *   import { drawMark, mountAnimatedIcon } from './canvas.icon.demo.js';
 *   drawMark(document.querySelector('canvas').getContext('2d'), 128);            // 静态一帧
 *   const stop = mountAnimatedIcon(document.getElementById('hero'), { size: 192 }); // 带动效,返回停止函数
 */

/** 64 网格下的几何常量(与 SVG 同源;改这里就要同步改 build-logos.mjs) */
export const MARK = {
  grid: 64,
  optical: 46,
  stroke: 6,
  bar: { x1: 22, x2: 42, y: 21.5 },
  headL: [[20, 14.5], [13, 21.5], [20, 28.5]],
  headR: [[44, 14.5], [51, 21.5], [44, 28.5]],
  stem: { x: 32, y1: 21.5, y2: 40 },
  node: { cx: 32, cy: 47, r: 5.5 }
};

const DEFAULT_COLORS = { accent: '#5b8cff', fg: '#e7eaf0', green: '#3fb26f' };

/** 连接脉冲:沿竖杆上下走一个点,相位由 time(秒)驱动 */
function drawPulse(ctx, colors, time) {
  const cycle = 2; // 秒 / 一次来回
  const p = (time % cycle) / cycle;
  const t = p < 0.5 ? p * 2 : (1 - p) * 2; // 0→1→0
  const y = MARK.stem.y1 + (MARK.stem.y2 - MARK.stem.y1 - 6) * t + 3;
  ctx.globalAlpha = 0.25 + 0.75 * Math.sin(t * Math.PI);
  ctx.beginPath();
  ctx.arc(MARK.stem.x, y, 3.2, 0, Math.PI * 2);
  ctx.fillStyle = colors.accent;
  ctx.fill();
  ctx.globalAlpha = 1;
}

/**
 * 把标识画进 2D 上下文。
 * 默认会把画布的像素尺寸对齐成 size×size(否则画布比 size 大时,标识只会缩在左上角一小块),
 * 想自己管画布尺寸就传 `fit: false`。
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} size 目标边长(像素);fit 生效时它会成为画布的像素尺寸
 * @param {{accent?:string,fg?:string,green?:string,time?:number,animate?:boolean,background?:string,fit?:boolean}} [opts]
 */
export function drawMark(ctx, size, opts = {}) {
  const colors = {
    accent: opts.accent || DEFAULT_COLORS.accent,
    fg: opts.fg || DEFAULT_COLORS.fg,
    green: opts.green || DEFAULT_COLORS.green
  };
  const time = opts.time || 0;
  const px = Math.round(size);
  const canvas = ctx.canvas;
  if (canvas && opts.fit !== false && (canvas.width !== px || canvas.height !== px)) {
    canvas.width = canvas.height = px; // 注意:改画布尺寸会清空画布
  }
  const s = px / MARK.grid;

  ctx.save();
  ctx.setTransform(s, 0, 0, s, 0, 0);
  ctx.clearRect(0, 0, MARK.grid, MARK.grid);
  if (opts.background) {
    ctx.fillStyle = opts.background;
    ctx.fillRect(0, 0, MARK.grid, MARK.grid);
  }
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = MARK.stroke;

  // 顶部双向箭头:远程 ↔ 本地
  ctx.strokeStyle = colors.accent;
  ctx.beginPath();
  ctx.moveTo(MARK.bar.x1, MARK.bar.y);
  ctx.lineTo(MARK.bar.x2, MARK.bar.y);
  ctx.stroke();
  for (const pts of [MARK.headL, MARK.headR]) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
  }

  // 竖杆:SSH 隧道
  ctx.strokeStyle = colors.fg;
  ctx.beginPath();
  ctx.moveTo(MARK.stem.x, MARK.stem.y1);
  ctx.lineTo(MARK.stem.x, MARK.stem.y2);
  ctx.stroke();

  if (opts.animate) drawPulse(ctx, colors, time);

  // 连接活点:已连上
  const breathe = opts.animate ? 0.86 + 0.14 * Math.sin(time * Math.PI) : 1;
  ctx.beginPath();
  ctx.arc(MARK.node.cx, MARK.node.cy, MARK.node.r * breathe, 0, Math.PI * 2);
  ctx.fillStyle = colors.green;
  ctx.fill();

  ctx.restore();
}

/**
 * 把一个 <canvas> 挂成动效标识;按 devicePixelRatio 放大,高清屏不糊。
 * @param {HTMLCanvasElement} canvas
 * @param {{size?:number,reduceMotion?:boolean}} [opts]
 * @returns {() => void} 停止函数(组件卸载时调用)
 */
export function mountAnimatedIcon(canvas, opts = {}) {
  const size = opts.size || 128;
  const dpr = window.devicePixelRatio || 1;
  const px = Math.round(size * dpr);
  canvas.width = px;
  canvas.height = px;
  canvas.style.width = canvas.style.height = size + 'px';
  const ctx = canvas.getContext('2d');
  // drawMark 内部按 64 网格重设变换,所以这里传「后端像素尺寸」即可自动适配高清屏;
  // 画布尺寸已在此处定好,drawMark 的 fit 不会重复清空画布。
  const reduce = opts.reduceMotion ?? window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) {
    drawMark(ctx, px, { background: opts.background });
    return () => {};
  }

  let raf = 0;
  const t0 = performance.now();
  const loop = (now) => {
    drawMark(ctx, px, { time: (now - t0) / 1000, animate: true, background: opts.background });
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  return () => cancelAnimationFrame(raf);
}

/** 导出各平台尺寸的 PNG(桌面端图标 / favicon 走这条) */
export function exportPng(sizes = [16, 32, 48, 256]) {
  return sizes.map((size) => {
    const canvas = document.createElement('canvas');
    const dpr = Math.min(4, window.devicePixelRatio || 1);
    canvas.width = canvas.height = Math.round(size * dpr);
    drawMark(canvas.getContext('2d'), canvas.width);
    return { size, dataUrl: canvas.toDataURL('image/png') };
  });
}
