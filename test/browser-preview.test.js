// 浏览器预览测试:地址识别(纯函数,始终运行)+ Playwright 引擎联调(无可用浏览器时自动跳过)
//
// 引擎部分需要系统 Chrome/Edge(或 BROWSER_PREVIEW_EXECUTABLE 指定的浏览器);
// CI 若两者都没有,则整段跳过并仍算通过 —— 缺浏览器是环境问题,不是代码回归。
import http from 'node:http';
import { browserManager, normalizePreviewUrl, extractPreviewUrls, describeNavError } from '../server/core/browser-manager.ts';
import { browserToolDefs } from '../server/agent/browser-tools.ts';
import { createRpcRouter } from '../server/api/rpc/router.ts';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) pass++; else fail++; console.log(`  ${c ? '✓' : '✗'} ${n} ${e}`); };

// ---------- 1. 地址识别与清洗(纯函数) ----------
check('localhost:5173 补 http://', normalizePreviewUrl('localhost:5173') === 'http://localhost:5173');
check('http://127.0.0.1:3000 原样保留', normalizePreviewUrl('http://127.0.0.1:3000') === 'http://127.0.0.1:3000');
check('带尖括号/句末标点的地址被清洗', normalizePreviewUrl('<http://localhost:8080/a>.') === 'http://localhost:8080/a');
check('普通文本不当地址', normalizePreviewUrl('hello world') === null);
check('完整 http(s) 地址原样接受(地址栏可预览任意站点)', normalizePreviewUrl('https://example.com') === 'https://example.com');

const found = extractPreviewUrls('  VITE ready\n  ➜  Local:   http://localhost:5173/\n  ➜  Network: http://192.168.1.5:5173/');
check('命令输出里提取到本地地址', found.includes('http://localhost:5173/') && found.includes('http://192.168.1.5:5173/'), JSON.stringify(found));
check('普通外链不被识别为预览地址', extractPreviewUrls('see https://example.com/docs').length === 0);

const dup = extractPreviewUrls('http://localhost:3000 http://localhost:3000');
check('重复地址去重', dup.length === 1, JSON.stringify(dup));

// 导航失败诊断:把 Chromium 原始错误翻成可操作的中文说明
const refused = describeNavError(
  { message: 'page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:5175/\nCall log:\n  - navigating' },
  'http://127.0.0.1:5175/'
);
check('拒绝连接 → 说明端口没服务在监听', refused.includes('没有服务在监听') && refused.includes('http://127.0.0.1:5175/'), refused);
check('回环地址且未连 SSH → 提示远程项目要先连 SSH', refused.includes('连接 SSH'), refused);
check('连接被中断 → 提示 IPv6/隧道', describeNavError({ message: 'net::ERR_EMPTY_RESPONSE' }, 'http://localhost:3000/').includes('被中断'));
check('加载超时 → 提示首次编译/服务卡住', describeNavError({ message: 'page.goto: Timeout 45000ms exceeded.' }, 'http://localhost:3000/').includes('加载超时'));
check('非回环地址不误报 SSH 提示', !describeNavError({ message: 'net::ERR_CONNECTION_REFUSED' }, 'http://10.0.0.9:8080/').includes('连接 SSH'));

// ---------- 2. 工具定义与 RPC 注册 ----------
const names = browserToolDefs.map((t) => t.name);
for (const n of ['browser_open', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_screenshot']) {
  check(`工具定义存在:${n}`, names.includes(n));
}
const schema = JSON.parse(JSON.stringify(browserToolDefs[0].parameters));
check('browser_open 参数含 url', !!schema?.properties?.url);
check('工具未打 remote 标记(本地/远程都可预览)', browserToolDefs.every((t) => !t.remote));

const rpc = createRpcRouter({ send() {}, emitStatus() {}, syncAgentScope() {} });
check('browser_open RPC 已注册', rpc.types().includes('browser_open'));
check('browser_close RPC 已注册', rpc.types().includes('browser_close'));

// ---------- 3. Playwright 引擎联调(可用时) ----------
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>预览冒烟</title></head><body>
<h1>Hello 预览</h1>
<button id="b1">点我</button>
<input id="t1" placeholder="你的名字" />
<div id="out">init</div>
<script>
  window.__n = 0;
  document.getElementById('b1').addEventListener('click', () => {
    window.__n += 1;
    document.getElementById('out').textContent = 'clicked-' + window.__n;
  });
</script>
</body></html>`;

async function engineTest() {
  let server;
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  try {
    // 用真实 http 地址探测浏览器是否可启动(启动失败 = 环境缺浏览器,整段跳过)
    await browserManager.open({ id: 'test', url: `http://127.0.0.1:${port}/`, width: 900, height: 600 });
  } catch (e) {
    console.log(`  ! 跳过引擎联调(无可用浏览器:${String(e.message).split('\n')[0]})`);
    server.close();
    return;
  }

  const st = await browserManager.open({ id: 'test', url: `http://127.0.0.1:${port}/`, width: 900, height: 600 });
  check('打开本地页面成功', st.url.startsWith(`http://127.0.0.1:${port}`), st.url);

  // CDP screencast 应产出至少一帧(有观看者时才推流)
  await browserManager.setViewer('test', true);
  const frame = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 8000);
    const onFrame = (f) => { if (f.id !== 'test') return; clearTimeout(t); browserManager.off('frame', onFrame); resolve(f); };
    browserManager.on('frame', onFrame);
  });
  check('收到实时画面帧', !!frame && frame.data.length > 500, frame ? `${frame.data.length}B` : '无帧');
  await browserManager.setViewer('test', false);

  const snap = await browserManager.snapshot('test');
  check('快照包含页面标题', snap.includes('预览冒烟'), snap.split('\n')[0]);
  check('快照包含可交互元素与 ref', /\[e\d+\] <button>/.test(snap) && /\[e\d+\] <input>/.test(snap));
  check('页面文本进入快照', snap.includes('Hello 预览'));

  // 用文本点击 → 页面 JS 生效
  await browserManager.click('test', { text: '点我' });
  const out = await browserManager.evaluate('test', "document.getElementById('out').textContent");
  check('点击按钮触发页面逻辑', out === '"clicked-1"', out);

  // ref 定位输入
  const snap2 = await browserManager.snapshot('test');
  const ref = /\[(e\d+)\] <input>/.exec(snap2)?.[1];
  check('快照给出 input 的 ref', !!ref, ref || '');
  if (ref) {
    await browserManager.fill('test', { ref, text: '张三' });
    const val = await browserManager.evaluate('test', "document.getElementById('t1').value");
    check('按 ref 输入生效', val === '"张三"', val);
    // 焦点仍在输入框:验证键盘/输入法文本回传(insertText 路径)
    await browserManager.input('test', { kind: 'text', text: '阿' });
    const val2 = await browserManager.evaluate('test', "document.getElementById('t1').value");
    check('文本输入回传生效', String(val2).includes('阿'), val2);
  }

  const shot = await browserManager.screenshot('test', {});
  check('截图返回 PNG 字节', shot.length > 1000 && shot[0] === 0x89, `${shot.length}B`);

  // 画面坐标 → 输入回传(前端预览就是这样把鼠标事件转发给页面的)
  const pos = JSON.parse(await browserManager.evaluate('test',
    "(()=>{const r=document.getElementById('b1').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()"));
  const vp = browserManager.state('test').viewport;
  const nx = pos.x / vp.width, ny = pos.y / vp.height;
  await browserManager.input('test', { kind: 'mouse', action: 'move', nx, ny });
  await browserManager.input('test', { kind: 'mouse', action: 'down', nx, ny, button: 'left', clickCount: 1 });
  await browserManager.input('test', { kind: 'mouse', action: 'up', nx, ny, button: 'left', clickCount: 1 });
  await new Promise((r) => setTimeout(r, 250));
  const out2 = await browserManager.evaluate('test', "document.getElementById('out').textContent");
  check('归一化鼠标输入回传后点击生效', out2 === '"clicked-2"', out2);

  await browserManager.close('test');
  check('关闭后会话状态为空', browserManager.state('test') === null);

  // 没人监听的端口:重试仍失败,但要给出可操作的中文诊断(而不是裸的 Chromium 报错)
  const netMod = await import('node:net');
  const probeSrv = netMod.createServer();
  await new Promise((r) => probeSrv.listen(0, '127.0.0.1', r));
  const deadPort = probeSrv.address().port;
  await new Promise((r) => probeSrv.close(r)); // 端口随即释放:大概率没人监听
  const dead = await browserManager.open({ id: 'dead', url: `http://127.0.0.1:${deadPort}/` }).catch((e) => e);
  check('无人监听端口 → 自动重试后给出诊断', !!dead?.error && /没有服务在监听/.test(dead.error), String(dead?.error || '').slice(0, 80));
  await browserManager.close('dead');

  if (server) server.close();
}

try {
  await engineTest();
} catch (e) {
  check('引擎联调无异常', false, e?.message || String(e));
} finally {
  await browserManager.closeAll().catch(() => {});
}

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
if (fail) process.exit(1);
