#!/usr/bin/env node
/**
 * Teleforge LOGO 生成器(单一事实源 / SSOT)
 *
 *   运行:node docs/logo/build-logos.mjs
 *
 * 为什么用生成器而不是手搓一堆 SVG:
 *   6 个方案 × (深底 / 浅底 / 圆角应用图标 / 字标组合)仍在同一套几何、
 *   同一套描边与端点规则下,只换调色板;以后要调描边粗细或加一个方案,
 *   改这里一处即可全量重出,不会出现「改了深色忘了浅色」的漂移。
 *
 * 产出(全部落在 docs/logo/ 下):
 *   concepts/<slug>.svg + <slug>-light.svg   裸标(透明底,64 网格)
 *   tiles/<slug>-tile.svg                    圆角方形应用图标(桌面端 / favicon)
 *   lockups/<slug>-lockup.svg(+ -light)      横版:标 + 字标 Teleforge
 *   icon.sprite.svg                          全部标做成 symbol,供页面 <use> 复用
 *   icon.manifest.json                       方案清单 / 分类 / 技术建议
 *   canvas.icon.demo.js                      Canvas 绘制 + 动效起步模板(按需)
 *   index.html                               预览看板(离线可用,几何内联)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ---------------------------------------------------------------- 调色板
   取值来自项目主题(web/src/theme/themes.ts「墨黑」/「纸白」预设):
   标记本体只用「实色」,不叠渐变、不加投影 —— 与产品的实色界面风格一致;
   渐变只出现在应用图标底板上(底板不是标的一部分)。 */
const DARK = { bg: '#0d0f13', fg: '#e7eaf0', accent: '#5b8cff', green: '#3fb26f' };
const LIGHT = { bg: '#f6f8fa', fg: '#1f2328', accent: '#0969da', green: '#1a7f37' };
/** 页面内联时走 CSS 变量:同一份几何在深/浅两种底色下都自动正确 */
const VARS = {
  bg: 'var(--c-bg, #0d0f13)',
  fg: 'var(--c-fg, #e7eaf0)',
  accent: 'var(--c-accent, #5b8cff)',
  green: 'var(--c-green, #3fb26f)'
};
/** sprite 里:结构用 currentColor,品牌色可用 --tf-accent / --tf-green 覆盖 */
const SPRITE = {
  bg: 'var(--c-bg, #0d0f13)',
  fg: 'currentColor',
  accent: 'var(--tf-accent, #5b8cff)',
  green: 'var(--tf-green, #3fb26f)'
};

/** 端点/拐角一律圆角,全系统统一 */
const R = 'stroke-linecap="round" stroke-linejoin="round"';
/* 光学方框:6 个方案(连描边算)都收敛到 64 网格里的 46×46、居中于 (32,32)。
   这就是「图标系统」和「六个随手画的图」的区别 —— 并排、缩小、放进圆角底板时,
   视觉重量一致,不需要逐个手工补偿。任何方案改几何都要守住这条。 */
const OPTICAL = 46;
/** 把标体按光学方框缩到 target,并保持居中 */
const scaleTo = (target) => {
  const s = target / OPTICAL;
  return `translate(${(32 - 32 * s).toFixed(3)} ${(32 - 32 * s).toFixed(3)}) scale(${s.toFixed(4)})`;
};

/* ---------------------------------------------------------------- 6 个方案
   geo(p) 返回 64×64 网格内的一组图元;所有方案共用同一套规则:
   描边宽度 5~6(64 网格)、stroke-linecap/linejoin 全圆角、平涂实色、无渐变无阴影。 */
const CONCEPTS = [
  {
    slug: 'dual-arrow-t',
    name: '双向 T',
    en: 'Dual-Arrow T',
    tag: '推荐主案',
    metaphor:
      '首字母 T 的骨架:顶部一条双向箭头 = 远程 ↔ 本地 双向同步;竖杆是 SSH 隧道;下端一颗绿点 = 连接保持的活口。',
    pros: ['唯一的字母骨架,缩到 16px 仍是清晰的字母形', '命中产品核心:远程与本地一套工具', '单色场景只换两色即可用'],
    cons: ['元素稍多,极小尺寸(16px)下箭头会糊成短线'],
    best: '桌面端图标 / 网页 favicon / 主视觉',
    geo: (p) => `
  <g fill="none" ${R}>
    <path d="M22 21.5 H42" stroke="${p.accent}" stroke-width="6"/>
    <path d="M20 14.5 L13 21.5 L20 28.5" stroke="${p.accent}" stroke-width="6"/>
    <path d="M44 14.5 L51 21.5 L44 28.5" stroke="${p.accent}" stroke-width="6"/>
    <path d="M32 21.5 V40" stroke="${p.fg}" stroke-width="6"/>
  </g>
  <circle cx="32" cy="47" r="5.5" fill="${p.green}"/>`
  },
  {
    slug: 'portal-bracket',
    name: '隧道门',
    en: 'Portal Bracket',
    tag: '终端感最强',
    metaphor: '一对括号 = 本地与远程两台机器;门内一个 >_ 提示符 = AI 在门那侧真实执行命令。',
    pros: ['开发者一眼认得出是终端 / SSH 语境', '方括号外轮廓硬朗,和实色界面很搭'],
    cons: ['等于「终端图标」的常见做法,辨识度靠配色和圆角撑'],
    best: '导航栏 / 图标系统 / 命令行入口',
    geo: (p) => `
  <g fill="none" ${R}>
    <path d="M22 11 H17.5 A5.5 5.5 0 0 0 12 16.5 V47.5 A5.5 5.5 0 0 0 17.5 52.5 H22" stroke="${p.accent}" stroke-width="5"/>
    <path d="M42 11 H46.5 A5.5 5.5 0 0 1 52 16.5 V47.5 A5.5 5.5 0 0 1 46.5 52.5 H42" stroke="${p.accent}" stroke-width="5"/>
    <path d="M26 25 L34 32 L26 39" stroke="${p.fg}" stroke-width="5"/>
    <path d="M38.5 39 H45.5" stroke="${p.fg}" stroke-width="5"/>
  </g>`
  },
  {
    slug: 'key-flame',
    name: '密钥熔炉',
    en: 'Key Flame',
    tag: '叙事最完整',
    metaphor: '钥匙 = SSH 私钥认证;钥匙柄是一簇熔炉火 = Forge(锻造)。合起来是「用密钥点着火」。',
    pros: ['把「安全接入 + 锻造」两层意思都装进一个形状', '轮廓修长,适合做竖版启动页 / 加载动画'],
    cons: ['火苗+齿纹细节多,24px 以下齿纹会基本消失'],
    best: '启动页 / 关于页 / 品牌插画',
    geo: (p) => `
  <path fill-rule="evenodd" fill="${p.accent}" d="M32 10 C36 17 44 21 44 29 A12 12 0 0 1 20 29 C20 21 28 17 32 10 Z M32 20 C34 24 37 26 37 29 A5 5 0 0 1 27 29 C27 26 30 24 32 20 Z"/>
  <g fill="none" ${R} stroke="${p.fg}" stroke-width="5.5">
    <path d="M32 39 V52"/>
    <path d="M32 43.5 H43.5"/>
    <path d="M32 51 H38.5"/>
  </g>`
  },
  {
    slug: 'node-orbit',
    name: '远程节点',
    en: 'Node Orbit',
    tag: '最抽象',
    metaphor:
      '实心圆 = 你面前的本地;环绕的弧 = 网络路径;弧上留出的缺口里坐着绿点 = 已经连上的远程服务器(连接保持)。',
    pros: ['三笔构成,缩到 16px 依然稳', '缺口 + 绿点把「已连接」讲清楚,天然适合做状态指示', '留白大,好排进各种界面'],
    cons: ['偏抽象,单看不像编程工具,需要配字标'],
    best: '图标系统 / 状态指示 / 动效场景(轨道可转)',
    geo: (p) => `
  <path d="M51.02 25.82 A20 20 0 1 1 38.84 13.21" fill="none" stroke="${p.accent}" stroke-width="5" ${R}/>
  <circle cx="32" cy="32" r="7" fill="${p.fg}"/>
  <circle cx="46.39" cy="18.11" r="5.5" fill="${p.green}"/>`
  },
  {
    slug: 'bridged-rings',
    name: '双环互通',
    en: 'Bridged Rings',
    tag: '主张最直白',
    metaphor: '实线环 = 本地,虚线环 = 远程,两环相交 = 远程与本地共用同一套界面与工具。',
    pros: ['图形极简,任何尺寸都成立', '蓝(本地)+ 绿(远程)双色即品牌记忆点'],
    cons: ['两圆相交是常见结构,需要靠虚实线区分开'],
    best: 'favicon / 白皮书与文档头图 / 双色场景',
    geo: (p) => `
  <circle cx="24.5" cy="32" r="12.5" fill="none" stroke="${p.accent}" stroke-width="5"/>
  <circle cx="39.5" cy="32" r="12.5" fill="none" stroke="${p.green}" stroke-width="5" stroke-dasharray="7 6" ${R}/>`
  },
  {
    slug: 'forge-spark',
    name: '锻造火花',
    en: 'Forge Spark',
    tag: '最小记号',
    metaphor: '锻造溅出的一点火花 = AI 这把工具,下面一根终端光标 = 命令正在执行。',
    pros: ['只有两笔,16px 依旧锐利,做 favicon 最保险', '对称构图,放哪都不歪'],
    cons: ['四角星被不少 AI 产品用过,单色时容易撞脸'],
    best: 'favicon / 加载态 / 与字标并排的小尺寸位',
    geo: (p) => `
  <path fill="${p.accent}" d="M32 9 C34.5 19 36.5 21 48 24.5 C36.5 28 34.5 30 32 40 C29.5 30 27.5 28 16 24.5 C27.5 21 29.5 19 32 9 Z"/>
  <rect x="23" y="48.5" width="18" height="6.5" rx="3.25" fill="${p.green}"/>`
  }
];

/* ---------------------------------------------------------------- 组装工具 */
const FONT =
  "'Segoe UI Variable Display','Segoe UI',-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif";

const markSvg = (c, p, size = 512) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" role="img" aria-label="Teleforge ${c.name}">${c.geo(p)}</svg>\n`;

const tileSvg = (c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="512" height="512" role="img" aria-label="Teleforge ${c.name} 应用图标">
  <defs>
    <linearGradient id="tile-${c.slug}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1e2533"/>
      <stop offset="1" stop-color="#0b0d11"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="14" fill="url(#tile-${c.slug})"/>
  <rect x="0.6" y="0.6" width="62.8" height="62.8" rx="13.4" fill="none" stroke="#ffffff" stroke-opacity="0.08" stroke-width="1.2"/>
  <g transform="${scaleTo(40)}">${c.geo(DARK)}</g>
</svg>
`;

const lockupSvg = (c, p) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 250 80" width="500" height="160" role="img" aria-label="Teleforge">
  <g transform="translate(8 8)"><g transform="${scaleTo(42)}">${c.geo(p)}</g></g>
  <text x="80" y="54" font-family="${FONT}" font-size="38" font-weight="600" letter-spacing="-0.9" fill="${p.fg}">Teleforge</text>
</svg>
`;

const spriteSvg = () => `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true">
${CONCEPTS.map(
  (c) => `  <!-- ${c.name} / ${c.en} -->
  <symbol id="logo-${c.slug}" viewBox="0 0 64 64">${c.geo(SPRITE)}</symbol>`
).join('\n')}
</svg>
`;

const manifest = {
  name: 'Teleforge',
  kind: 'logo-system',
  version: '0.1.0',
  generatedBy: 'docs/logo/build-logos.mjs',
  product: 'SSH 远程 ↔ 本地互通的 AI 编程工具',
  grid: { viewBox: '0 0 64 64', opticalBox: '46×46 居中于 (32,32),含描边', strokeWidth: [5, 5.5, 6], strokeLinecap: 'round', strokeLinejoin: 'round', cornerRadius: 14 },
  palette: {
    dark: DARK,
    light: LIGHT,
    rule: '标体只用实色(不叠渐变/阴影),渐变仅用于应用图标底板'
  },
  concepts: CONCEPTS.map((c) => ({
    id: c.slug,
    name: c.name,
    nameEn: c.en,
    tag: c.tag,
    metaphor: c.metaphor,
    best: c.best,
    pros: c.pros,
    cons: c.cons,
    tech: c.slug === 'node-orbit' ? 'svg (动效场景可交 Canvas)' : 'svg',
    files: {
      markDark: `docs/logo/concepts/${c.slug}.svg`,
      markLight: `docs/logo/concepts/${c.slug}-light.svg`,
      tile: `docs/logo/tiles/${c.slug}-tile.svg`,
      lockup: `docs/logo/lockups/${c.slug}-lockup.svg`,
      lockupLight: `docs/logo/lockups/${c.slug}-lockup-light.svg`
    },
    spriteId: `logo-${c.slug}`,
    minSize: 16
  })),
  recommendation: {
    primary: 'dual-arrow-t',
    alternates: ['forge-spark', 'portal-bracket'],
    reason: '主案同时承载「T 字标」与「远程↔本地双向」两层语义,16px 仍是清晰字形;forge-spark 作为 favicon 兜底,portal-bracket 用于终端语境。'
  },
  techNotes: [
    '静态图标/界面控件一律 SVG:sprite 里换色只需 --tf-accent / currentColor,体积远小于位图。',
    '需要「轨道转动 / 链路脉冲 / 逐帧重绘」等动效时交给 Canvas,见 canvas.icon.demo.js;它绘制的是同一套几何常量,和 SVG 不会走形。',
    '桌面端打包图标由 SVG 导出 PNG 后交给 `npm run desktop:icon`(tauri icon)生成各平台尺寸,不要直接提交矢量进 icons 目录。'
  ]
};

/* ---------------------------------------------------------------- 写文件 */
const dirs = ['concepts', 'tiles', 'lockups'];
dirs.forEach((d) => fs.mkdirSync(path.join(HERE, d), { recursive: true }));

for (const c of CONCEPTS) {
  fs.writeFileSync(path.join(HERE, 'concepts', `${c.slug}.svg`), markSvg(c, DARK));
  fs.writeFileSync(path.join(HERE, 'concepts', `${c.slug}-light.svg`), markSvg(c, LIGHT));
  fs.writeFileSync(path.join(HERE, 'tiles', `${c.slug}-tile.svg`), tileSvg(c));
  fs.writeFileSync(path.join(HERE, 'lockups', `${c.slug}-lockup.svg`), lockupSvg(c, DARK));
  fs.writeFileSync(path.join(HERE, 'lockups', `${c.slug}-lockup-light.svg`), lockupSvg(c, LIGHT));
}
fs.writeFileSync(path.join(HERE, 'icon.sprite.svg'), spriteSvg());
fs.writeFileSync(path.join(HERE, 'icon.manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

/* ---------------------------------------------------------------- 预览看板 */
const inline = (c, cls, px) =>
  `<svg class="${cls}" viewBox="0 0 64 64" width="${px}" height="${px}" aria-label="${c.name}">${c.geo(VARS)}</svg>`;

const card = (c, i) => `
  <section class="card" id="${c.slug}">
    <header class="card-hd">
      <div class="idx">${String(i + 1).padStart(2, '0')}</div>
      <div class="ttl">
        <h3>${c.name}<span class="en">${c.en}</span></h3>
        <p class="meta">${c.tag} · 主要用途:${c.best}</p>
      </div>
      <button class="copy" data-slug="${c.slug}" type="button">复制 SVG</button>
    </header>

    <div class="stages">
      <div class="stage ctx-dark">
        <span class="stage-tag">深色底</span>
        ${inline(c, 'mark', 132)}
      </div>
      <div class="stage ctx-light">
        <span class="stage-tag">浅色底</span>
        ${inline(c, 'mark', 132)}
      </div>
      <div class="stage ctx-tile">
        <span class="stage-tag">应用图标</span>
        <div class="tile ctx-dark">${inline(c, 'mark', 80)}</div>
      </div>
      <div class="stage ctx-dark">
        <span class="stage-tag">小尺寸 48 / 32 / 24 / 16</span>
        <div class="sizes">
          ${inline(c, 'mark', 48)}${inline(c, 'mark', 32)}${inline(c, 'mark', 24)}${inline(c, 'mark', 16)}
        </div>
      </div>
      <div class="stage ctx-dark wide">
        <span class="stage-tag">横版组合(标 + 字标)</span>
        <div class="lockup">${inline(c, 'mark', 40)}<b>Teleforge</b></div>
      </div>
    </div>

    <div class="notes">
      <p class="metaphor">${c.metaphor}</p>
      <ul class="pros">${c.pros.map((x) => `<li>${x}</li>`).join('')}</ul>
      <ul class="cons">${c.cons.map((x) => `<li>${x}</li>`).join('')}</ul>
    </div>
  </section>`;

const tree = [
  'docs/logo/',
  '├─ index.html                ← 本预览看板(离线可开)',
  '├─ build-logos.mjs           ← 几何与调色板的单一事实源',
  '├─ icon.sprite.svg           ← 6 个 symbol,页面里 &lt;use&gt; 复用',
  '├─ icon.manifest.json        ← 方案清单 / 技术建议',
  '├─ icon.spec.md              ← 图标系统规范(尺寸、描边、命名、用法)',
  '├─ canvas.icon.demo.js       ← Canvas 绘制 + 动效起步模板',
  '├─ concepts/                 ← 裸标(透明底,含 -light 浅底版)',
  '├─ tiles/                    ← 圆角方形应用图标',
  '└─ lockups/                  ← 横版标 + 字标组合'
].join('\n');

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Teleforge LOGO 方案预览(6 版)</title>
<style>
  /* 看板两个记号:① 深/浅底色是「使用场景」,每张卡片里都成对出现,不受看板主题影响;
     ② 看板自身的深/浅主题只置于 .page 上,切换时不动场景面板。 */
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--page-bg, #0b0d11); color: var(--page-fg, #e7eaf0);
    font-family: ${FONT}; font-size: 14px; line-height: 1.6;
  }
  body.light { color-scheme: light; --page-bg: #f2f4f7; --page-fg: #1f2328; --page-line: #d8dee7; --page-card: #ffffff; --page-mut: #5c6570; }
  body.dark { color-scheme: dark; --page-line: #232a36; --page-card: #12151b; --page-mut: #98a2b3; }
  /* 场景面板只认这三组色,标体几何全部走 var() —— 一份几何两种底色自动正确 */
  .ctx-dark { --c-bg: #0d0f13; --c-fg: #e7eaf0; --c-accent: #5b8cff; --c-green: #3fb26f; background: #0d0f13; color: #e7eaf0; }
  .ctx-light { --c-bg: #ffffff; --c-fg: #1f2328; --c-accent: #0969da; --c-green: #1a7f37; background: #ffffff; color: #1f2328; }

  .wrap { max-width: 1180px; margin: 0 auto; padding: 40px 24px 80px; }
  .top { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; flex-wrap: wrap; margin-bottom: 8px; }
  .brandline { display: flex; align-items: center; gap: 14px; }
  .brandline h1 { font-size: 26px; margin: 0; letter-spacing: -0.4px; }
  .brandline .sub { color: var(--page-mut, #98a2b3); font-size: 13px; margin: 2px 0 0; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 12px;
    border: 1px solid var(--page-line, #232a36); color: var(--page-mut, #98a2b3); }
  .toggle { display: flex; gap: 6px; }
  .toggle button { padding: 7px 14px; border-radius: 8px; cursor: pointer; font: inherit; font-size: 13px;
    background: transparent; color: inherit; border: 1px solid var(--page-line, #232a36); }
  .toggle button[aria-pressed="true"] { background: var(--c-accent, #5b8cff); border-color: transparent; color: #fff; }

  .lede { color: var(--page-mut, #98a2b3); max-width: 78ch; margin: 10px 0 22px; }

  .palette { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 26px; }
  .sw { display: flex; align-items: center; gap: 8px; padding: 6px 12px 6px 8px; border-radius: 10px;
    border: 1px solid var(--page-line, #232a36); font-size: 12px; }
  .sw i { width: 16px; height: 16px; border-radius: 5px; display: inline-block; }

  .overview { border: 1px solid var(--page-line, #232a36); border-radius: 14px; padding: 18px; margin-bottom: 30px; }
  .overview h2 { font-size: 14px; margin: 0 0 14px; letter-spacing: .4px; color: var(--page-mut, #98a2b3); font-weight: 600; }
  .strip { display: flex; gap: 22px; flex-wrap: wrap; }
  .strip .cell { display: flex; flex-direction: column; align-items: center; gap: 8px; font-size: 12px; }
  .strip .cell span { color: var(--page-mut, #98a2b3); }
  .pick { display: inline-flex; align-items: center; gap: 6px; margin-top: 16px; padding: 8px 14px; border-radius: 10px;
    background: color-mix(in srgb, #5b8cff 16%, transparent); border: 1px solid #5b8cff55; font-size: 13px; }

  .card { border: 1px solid var(--page-line, #232a36); border-radius: 16px; padding: 20px; margin-bottom: 24px;
    background: var(--page-card, #12151b); }
  .card-hd { display: flex; align-items: center; gap: 14px; margin-bottom: 18px; }
  .idx { font-family: ui-monospace, Consolas, monospace; font-size: 13px; color: var(--page-mut, #98a2b3);
    border: 1px solid var(--page-line, #232a36); border-radius: 8px; padding: 4px 9px; }
  .card-hd h3 { margin: 0; font-size: 17px; display: flex; align-items: baseline; gap: 10px; }
  .card-hd .en { font-size: 12px; font-weight: 400; color: var(--page-mut, #98a2b3); letter-spacing: .3px; }
  .meta { margin: 2px 0 0; font-size: 12.5px; color: var(--page-mut, #98a2b3); }
  .copy { margin-left: auto; padding: 7px 13px; border-radius: 8px; cursor: pointer; font: inherit; font-size: 12.5px;
    background: transparent; color: inherit; border: 1px solid var(--page-line, #232a36); }
  .copy:hover { border-color: var(--c-accent, #5b8cff); }

  .stages { display: grid; grid-template-columns: repeat(auto-fit, minmax(178px, 1fr)); gap: 12px; }
  .stage { position: relative; border-radius: 12px; padding: 26px 16px 18px; display: flex;
    align-items: center; justify-content: center; min-height: 176px; border: 1px solid var(--page-line, #232a36); }
  .stage.wide { grid-column: span 2; }
  .stage-tag { position: absolute; top: 8px; left: 12px; font-size: 11px; opacity: .62; letter-spacing: .2px; }
  .tile { border-radius: 22px; padding: 6px; display: flex;
    background: linear-gradient(180deg, #1e2533, #0b0d11); border: 1px solid #ffffff14; }
  .sizes { display: flex; align-items: flex-end; gap: 14px; flex-wrap: wrap; justify-content: center; }
  .lockup { display: flex; align-items: center; gap: 10px; }
  .lockup b { font-size: 21px; font-weight: 600; letter-spacing: -0.5px; }

  .notes { display: grid; grid-template-columns: 1.4fr 1fr 1fr; gap: 16px; margin-top: 18px; }
  @media (max-width: 860px) { .notes { grid-template-columns: 1fr; } .stage.wide { grid-column: span 1; } }
  .metaphor { margin: 0; font-size: 13px; color: var(--page-mut, #98a2b3); }
  .pros, .cons { margin: 0; padding-left: 18px; font-size: 12.5px; color: var(--page-mut, #98a2b3); }
  .pros li { color: #3fb26f; }
  .cons li { color: #e3a343; }

  .mock { margin-top: 34px; border: 1px solid var(--page-line, #232a36); border-radius: 14px; overflow: hidden; }
  .mock .bar { display: flex; align-items: center; gap: 10px; padding: 10px 14px; background: #0d0f13; color: #e7eaf0; }
  .mock .bar b { font-size: 14px; font-weight: 600; }
  .mock .bar .dot { width: 7px; height: 7px; border-radius: 999px; background: #3fb26f; }
  .mock .bar small { margin-left: auto; color: #98a2b3; font-size: 12px; }
  .mock .body { padding: 16px; font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; color: #9aa4b2; background: #12151b; }

  footer { margin-top: 34px; color: var(--page-mut, #98a2b3); font-size: 12.5px; }
  footer pre { background: var(--page-card, #12151b); border: 1px solid var(--page-line, #232a36);
    border-radius: 10px; padding: 14px; overflow-x: auto; font-size: 12px; line-height: 1.7; }
  footer code { font-family: ui-monospace, Consolas, monospace; }
</style>
</head>
<body class="dark">
<div class="wrap">

  <div class="top">
    <div class="brandline">
      ${inline(CONCEPTS[0], 'mark', 52)}
      <div>
        <h1>Teleforge LOGO 方案</h1>
        <p class="sub">6 个版本 · 同一套几何规则(64 网格 / 光学方框 46 / 描边 5–6 / 全圆角端点)· 深底与浅底成对给出</p>
      </div>
    </div>
    <div class="toggle">
      <button id="btn-dark" aria-pressed="true" type="button">深色看板</button>
      <button id="btn-light" aria-pressed="false" type="button">浅色看板</button>
    </div>
  </div>

  <p class="lede">
    产品是「SSH 远程 ↔ 本地互通的 AI 编程工具」,所以每个方案都在讲同一件事:两端之间有一条保持住的连接,
    并且 AI 在那头真实干活。选型只看两点——<b>16px 还认不认得出</b>,以及<b>和实色界面放一起像不像一家人</b>。
    六个方案(连描边算)都收敛在 64 网格里同一个 <b>46×46 光学方框</b>、居中于 (32,32),并排与缩小时视觉重量一致。
  </p>

  <div class="palette">
    <span class="sw"><i style="background:#0d0f13"></i>底 #0d0f13</span>
    <span class="sw"><i style="background:#16191f"></i>面 #16191f</span>
    <span class="sw"><i style="background:#e7eaf0"></i>标体 #e7eaf0</span>
    <span class="sw"><i style="background:#5b8cff"></i>主色 #5b8cff</span>
    <span class="sw"><i style="background:#3fb26f"></i>连接 #3fb26f</span>
  </div>

  <div class="overview">
    <h2>一眼对比(48px)</h2>
    <div class="strip ctx-dark">
      ${CONCEPTS.map(
        (c, i) => `<div class="cell">${inline(c, 'mark', 48)}<span>${String(i + 1).padStart(2, '0')} ${c.name}</span></div>`
      ).join('\n      ')}
    </div>
    <div class="pick">推荐主案:<b>01 双向 T</b> —— 有字母骨架、有双向语义,16px 仍成立;${manifest.recommendation.reason}</div>
  </div>

  ${CONCEPTS.map((c, i) => card(c, i)).join('\n')}

  <div class="mock">
    <div class="bar">${inline(CONCEPTS[0], 'mark', 22)}<b>Teleforge</b><span class="dot"></span><small>已连接 · ssh://prod-web-01</small></div>
    <div class="body">$ npm run dev<br>$ AI Agent 在远程工作区读写文件、执行命令…</div>
  </div>

  <footer>
    <p>产物清单(全部由 <code>build-logos.mjs</code> 生成,改几何只需改这一处):</p>
    <pre>${tree}</pre>
    <p>导出 PNG(桌面端图标走 Tauri 自己的流程):<br>
      <code>npx sharp-cli -i docs/logo/tiles/dual-arrow-t-tile.svg -o /tmp/tile-1024.png resize 1024 1024</code><br>
      或直接 <code>npm run desktop:icon</code>(会读 <code>web/public/logo.png</code>)—— 选定方案后我再把成品同步到 <code>web/public/</code> 与 <code>src-tauri/icons/</code>。</p>
  </footer>
</div>

<script>
  var body = document.body;
  var bd = document.getElementById('btn-dark'), bl = document.getElementById('btn-light');
  function setTheme(light) {
    body.classList.toggle('light', light);
    body.classList.toggle('dark', !light);
    bd.setAttribute('aria-pressed', String(!light));
    bl.setAttribute('aria-pressed', String(light));
  }
  bd.onclick = function () { setTheme(false); };
  bl.onclick = function () { setTheme(true); };

  // 复制某个方案在深色底下的裸标 SVG 源码,方便直接贴进代码库
  Array.prototype.forEach.call(document.querySelectorAll('.copy'), function (btn) {
    btn.onclick = function () {
      var card = btn.closest('.card');
      var svg = card.querySelector('.ctx-dark .mark');
      var src = '<?xml version="1.0" encoding="UTF-8"?>\\n' + svg.outerHTML.replace(/class="mark" /, '');
      var done = function () { btn.textContent = '已复制'; setTimeout(function () { btn.textContent = '复制 SVG'; }, 1200); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(src).then(done, done);
      } else { done(); }
    };
  });
</script>
</body>
</html>
`;

fs.writeFileSync(path.join(HERE, 'index.html'), html);

/* ---------------------------------------------------------------- 生成汇总 */
const files = fs
  .readdirSync(HERE, { recursive: true })
  .filter((f) => fs.statSync(path.join(HERE, f)).isFile());
console.log('已生成 ' + files.length + ' 个文件 → docs/logo/');
console.log(files.sort().join('\n'));
