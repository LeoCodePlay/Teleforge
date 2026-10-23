// 内置预览后端 v2 回归:快照(影子 DOM / 跨域子框架)、批处理、子框架内点击、动作原语。
// 需要系统 Chrome/Edge;没有就整段跳过。
import http from 'node:http';
import { browserManager } from '../server/core/browser-manager.ts';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) pass++; else fail++; console.log(`  ${c ? '✓' : '✗'} ${n} ${e}`); };

function serve(html) {
  return new Promise((resolve) => {
    const hits = [];
    const srv = http.createServer((req, res) => {
      hits.push(String(req.url || ''));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    srv.hits = hits;
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

const srvB = await serve(`<!doctype html><title>B</title>
  <button id="cross" onclick="location.search='?clicked=1'">跨域按钮</button>`);
const portB = srvB.address().port;
const srvA = await serve(`<!doctype html><html><head><title>预览 v2 测试</title></head><body>
  <h1>工具条</h1>
  <button id="inc">加一</button><span id="count">0</span>
  <input id="name" placeholder="名字">
  <my-box></my-box>
  <iframe id="same" srcdoc="&lt;button id='sbtn'&gt;同源框架按钮&lt;/button&gt;"></iframe>
  <iframe id="cross" src="http://127.0.0.1:${portB}/"></iframe>
  <script>
    document.getElementById('inc').onclick = () => {
      console.log('clicked inc');
      const c = document.getElementById('count');
      c.textContent = String(Number(c.textContent) + 1);
    };
    customElements.define('my-box', class extends HTMLElement {
      connectedCallback() {
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML = '<button id="sh">影子按钮</button>';
      }
    });
  </script>
</body></html>`);
const portA = srvA.address().port;

const ID = 's_pv2:1';
const SID = 's_pv2';
let opened = false;

try {
  const st = await browserManager.open({ id: ID, url: `http://127.0.0.1:${portA}/`, ownerSid: SID, width: 900, height: 700 });
  if (st.error) {
    console.log(`  跳过:预览引擎起不来(${st.error})`);
    srvA.close(); srvB.close();
    process.exit(0);
  }
  opened = true;
  await new Promise((r) => setTimeout(r, 500));

  const snap = await browserManager.snapshot(ID, SID, { scope: 'full_page' });
  check('快照是 v2 文本', snap.includes('页面结构'), snap.slice(0, 100));
  check('识别主文档按钮', snap.includes('加一'));
  check('穿透 shadow DOM', snap.includes('影子按钮'));
  check('同源子框架有 fN: 前缀的 ref', /f\d+:\w+\s+button\s+"同源框架按钮"/.test(snap), snap.split('\n').filter((l) => l.includes('框架')).join(' | '));
  check('跨域子框架内容也能读到', snap.includes('跨域按钮'), snap.slice(0, 200));

  // 主文档点击
  const ref = /(\w+)\s+button\s+"加一"/.exec(snap)?.[1];
  check('拿到「加一」的 ref', !!ref, String(ref));
  await browserManager.click(ID, { ref }, SID);
  check('点击生效', (await browserManager.evaluate(ID, `document.getElementById('count').textContent`, SID)) === '"1"');

  // 子框架内点击(Playwright 原生支持跨域 frame 定位,这是预览相对扩展的优势)
  const frameRef = /f(\d+):(\w+)\s+button\s+"跨域按钮"/.exec(snap);
  check('拿到跨域框架按钮的 ref', !!frameRef, String(frameRef));
  if (frameRef) {
    await browserManager.click(ID, { ref: `f${frameRef[1]}:${frameRef[2]}` }, SID);
    await new Promise((r) => setTimeout(r, 600));
    check('跨域框架里的点击真的落地了', srvB.hits.some((u) => u.includes('clicked=1')), JSON.stringify(srvB.hits));
  }

  // 批处理
  const batch = await browserManager.batch(ID, [
    { op: 'click', ref },
    { op: 'type', selector: '#name', text: '张三' },
    { op: 'assert', text: '工具条' }
  ], SID, { stopOnError: true });
  check('批处理全部成功', batch.ok === true, JSON.stringify(batch.steps.map((s) => s.ok)));
  check('批处理后的页面状态生效', String(await browserManager.evaluate(ID, `document.getElementById('name').value`, SID)).includes('张三'));

  const bad = await browserManager.batch(ID, [
    { op: 'click', ref },
    { op: 'assert', text: '不可能存在的文字' },
    { op: 'click', ref }
  ], SID, { stopOnError: true });
  check('批处理遇错即停', bad.ok === false && bad.failedAt === 2, JSON.stringify(bad.steps));

  // 中文输入:第一次就要对(历史上会被吞/乱码)
  await browserManager.fill(ID, { selector: '#name', text: '你好,世界' }, SID);
  const cnVal = await browserManager.evaluate(ID, `document.getElementById('name').value`, SID);
  check('预览后端中文一次输入即正确', String(cnVal).includes('你好,世界'), String(cnVal));

  // 动作原语
  await browserManager.hover(ID, { ref }, SID);
  const logs = await browserManager.logs(ID, SID);
  check('console 采集到了点击日志', logs.includes('clicked inc'), logs.slice(0, 120));
  const dlg = await browserManager.dialog(ID, { policy: 'dismiss' }, SID);
  check('弹窗策略可查询/设置', dlg.includes('自动关闭'), dlg);
  const text = await browserManager.pageText(ID, { max: 100 }, SID);
  check('按需读正文', text.includes('工具条'), text.slice(0, 60));
  const shot = await browserManager.screenshot(ID, {}, SID);
  check('截图返回 PNG buffer', Buffer.isBuffer(shot) && shot.length > 100);
} catch (e) {
  fail++;
  console.log(`  ✗ 异常:${(e && e.stack) || e}`);
} finally {
  if (opened) {
    try { await browserManager.close(ID, SID); } catch { /* 忽略 */ }
    try { await browserManager.closeAll(); } catch { /* 忽略 */ }
  }
  srvA.close(); srvB.close();
}

console.log(`\n预览后端 v2 测试:${pass} 通过,${fail} 失败`);
process.exit(fail ? 1 : 0);
