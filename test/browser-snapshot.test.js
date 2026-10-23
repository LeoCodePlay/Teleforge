// 快照 v2 回归:在真实 Chromium 里验证「ref 稳定 / 穿透 shadow DOM / scope / 文本按需 / 渲染格式」。
//
// 引擎部分需要系统 Chrome/Edge(或 BROWSER_PREVIEW_EXECUTABLE);没有就整段跳过并算通过 ——
// 缺浏览器是环境问题,不是代码回归(与 browser-preview.test.js 的约定一致)。
import { SNAPSHOT_SCRIPT, formatSnapshot } from '../server/core/browser-snapshot.ts';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) pass++; else fail++; console.log(`  ${c ? '✓' : '✗'} ${n} ${e}`); };

async function launch() {
  const { chromium } = await import('playwright-core');
  const tries = [
    ...(process.env.BROWSER_PREVIEW_EXECUTABLE ? [{ executablePath: process.env.BROWSER_PREVIEW_EXECUTABLE }] : []),
    { channel: 'chrome' },
    { channel: 'msedge' },
    {}
  ];
  for (const opts of tries) {
    try { return await chromium.launch({ headless: true, ...opts }); } catch { /* 换下一个 */ }
  }
  return null;
}

const browser = await launch();
if (!browser) {
  console.log('  跳过:本机没有可用的 Chrome/Edge,快照引擎测试未运行');
  process.exit(0);
}

try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.setContent(`<!doctype html><html><head><title>快照测试</title></head><body>
    <h1>订单管理</h1>
    <div id="toolbar">
      <button id="save">保存</button>
      <a href="/orders/1024">订单 ORD-1024</a>
      <label><input type="checkbox" id="paid"> 已开票</label>
      <input id="pw" type="password" value="secret123" placeholder="密码">
    </div>
    <h2>最近订单</h2>
    <div id="rows">
      <button class="row">第一行</button>
      <button class="row">第二行</button>
    </div>
    <my-widget id="w1"></my-widget>
    <div style="height:3000px"></div>
    <button id="far" style="position:absolute;top:2600px;left:0">页面底部的按钮</button>
    <script>
      customElements.define('my-widget', class extends HTMLElement {
        connectedCallback() {
          const root = this.attachShadow({ mode: 'open' });
          root.innerHTML = '<button id="inner">影子里的按钮</button><input aria-label="影子输入框">';
        }
      });
    </script>
  </body></html>`);

  // ---------- 1. 基本结构 ----------
  const snap1 = await page.evaluate(SNAPSHOT_SCRIPT, {});
  check('脚本返回 v2 结构', snap1?.v === 2 && Array.isArray(snap1.nodes), JSON.stringify(snap1).slice(0, 120));
  check('标题/地址齐全', snap1.title === '快照测试' && String(snap1.url).startsWith('about:'), `${snap1.title} ${snap1.url}`);

  const byName = (s, name) => (s.nodes || []).find((n) => n.name.includes(name));
  const save = byName(snap1, '保存');
  check('按钮被识别为 button 且有 ref', save?.role === 'button' && /^e/.test(save.ref || ''), JSON.stringify(save));
  check('id 元素给出 #id 形式的 loc', save?.loc === '#save', save?.loc);
  check('链接带 href', byName(snap1, '订单 ORD-1024')?.href === '/orders/1024');

  const pw = snap1.nodes.find((n) => n.tag === 'input' && n.loc === '#pw');
  check('密码框的值被打码', pw?.value === '***', JSON.stringify(pw));

  // ---------- 2. shadow DOM ----------
  const shadowBtn = byName(snap1, '影子里的按钮');
  check('读到 shadow DOM 里的按钮', shadowBtn?.role === 'button', JSON.stringify(shadowBtn));
  check('shadow 里的输入框按 aria-label 命名', !!snap1.nodes.find((n) => n.name === '影子输入框'));

  // ---------- 3. scope ----------
  const full = await page.evaluate(SNAPSHOT_SCRIPT, { scope: 'full_page' });
  const hasFar = (s) => !!byName(s, '页面底部的按钮');
  check('默认 viewport 不含屏幕外元素', !hasFar(snap1));
  check('full_page 含屏幕外元素', hasFar(full), JSON.stringify(full.nodes.map((n) => n.name)).slice(0, 200));

  const sub = await page.evaluate(SNAPSHOT_SCRIPT, { scope: 'subtree', root: '#rows' });
  check('subtree 只看指定子树', sub.nodes.length === 2 && sub.nodes.every((n) => n.name.includes('行')), JSON.stringify(sub.nodes));

  // ---------- 4. 文本按需 ----------
  check('默认不带正文', !snap1.text);
  const withText = await page.evaluate(SNAPSHOT_SCRIPT, { text: 200 });
  check('要正文时才带', typeof withText.text === 'string' && withText.text.includes('订单管理'));

  // ---------- 5. ref 稳定:上面插入一个元素,原有 ref 不变 ----------
  await page.evaluate(() => {
    const b = document.createElement('button');
    b.textContent = '新插入的按钮';
    document.getElementById('toolbar').prepend(b);
  });
  const snap2 = await page.evaluate(SNAPSHOT_SCRIPT, {});
  const save2 = byName(snap2, '保存');
  check('DOM 变化后 ref 仍稳定', !!save2 && save2.ref === save?.ref, `${save?.ref} → ${save2?.ref}`);
  const shadow2 = byName(snap2, '影子里的按钮');
  check('shadow 里的 ref 也稳定', !!shadow2 && shadow2.ref === shadowBtn?.ref, `${shadowBtn?.ref} → ${shadow2?.ref}`);

  // ---------- 6. 文本渲染 ----------
  const text = formatSnapshot(snap1);
  check('渲染出页面结构段落', text.includes('页面结构') && text.includes('button'));
  check('渲染出 loc', text.includes('loc=#save'));
  check('渲染能省略 loc', !formatSnapshot(snap1, { showLoc: false }).includes('loc='));
  check('v1 数据仍能渲染(老扩展兼容)', formatSnapshot({ title: 't', items: ['e1 button "确定"'], heads: [] }).includes('e1 button "确定"'));

  // ---------- 7. 子框架(同源 + 跨域各一次) ----------
  const frame = page.frames().find((f) => f.parentFrame() === null);
  await page.evaluate(() => {
    const f = document.createElement('iframe');
    f.id = 'same';
    f.srcdoc = '<button id="in-frame">框架内按钮</button>';
    document.body.appendChild(f);
  });
  await page.waitForTimeout(300);
  const child = page.frames().find((f) => f !== frame);
  check('同源 iframe 里也能跑同一份脚本', !!child);
  if (child) {
    const fs = await child.evaluate(SNAPSHOT_SCRIPT, {});
    check('框架内按钮被识别', !!fs.nodes.find((n) => n.name === '框架内按钮'), JSON.stringify(fs.nodes));
  }
} finally {
  await browser.close();
}

console.log(`\n快照测试:${pass} 通过,${fail} 失败`);
process.exit(fail ? 1 : 0);
