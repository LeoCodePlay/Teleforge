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
// browser_id 的参数说明必须讲清"省略 = 本会话自己的预览"(模型据此不需要记 id)
const idDesc = String(browserToolDefs.find((t) => t.name === 'browser_snapshot').parameters.properties.browser_id.description || '');
check('browser_id 说明写明默认本会话预览', idDesc.includes('本会话自己的预览'), idDesc.slice(0, 40));

const rpc = createRpcRouter({ send() {}, emitStatus() {}, syncAgentScope() {} });
check('browser_open RPC 已注册', rpc.types().includes('browser_open'));
check('browser_close RPC 已注册', rpc.types().includes('browser_close'));

// ---------- 2.5 回环地址该走隧道还是直连(远程预览打不开的经典坑) ----------
// 用真实本机端口 + 真实的 sshManager 未连接分支,不依赖任何外部服务器。
const { resolvePreviewUrl, isLocalPortListening } = await import('../server/core/port-tunnel.ts');
const { sshManager } = await import('../server/core/ssh-manager.ts');

check('非回环地址原样直连(局域网 IP)',
  (await resolvePreviewUrl('http://192.168.1.9:8080/')).url === 'http://192.168.1.9:8080/');
{
  // 未连 SSH:回环地址当然直连本机,不应该被"隧道"改写
  const r = await resolvePreviewUrl('http://localhost:5173/');
  check('未连 SSH 时回环地址直连', r.url === 'http://localhost:5173/' && r.tunneled === false, JSON.stringify(r));
}
{
  // 本机端口探测:这是"本机预览服务必须直连"的前提判断
  const srv = http.createServer((_q, res) => res.end('ok'));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  check('本机端口探测:有服务 → true', (await isLocalPortListening(port)) === true);
  await new Promise((r) => srv.close(r));
  check('本机端口探测:没人监听 → false', (await isLocalPortListening(port)) === false);
}
{
  // 关键回归:连着 SSH,但远程该端口没人监听(forwardOut 报 Connection refused)时,
  // 不能再把地址换成隧道端口让浏览器收到 ERR_EMPTY_RESPONSE —— 必须直接给出可操作的诊断。
  // client.forwardOut 一律回错,等价于远程"没有服务在监听"。
  const fakeConn = { connected: true, client: { forwardOut: (_a, _b, _c, _d, cb) => cb(new Error('(SSH) Channel open failure: Connection refused'), undefined) } };
  const port = 59991;
  const both = await sshManager.runWithConn(fakeConn, () => resolvePreviewUrl(`http://localhost:${port}/`).catch((e) => e));
  check('远程没监听且本机也没监听 → 给出可操作错误(不再静默隧道)',
    both instanceof Error && /都没有服务监听/.test(both.message), String(both?.message || both).slice(0, 90));
  check('错误里带上"后台启动"的处理建议', both instanceof Error && /nohup/.test(both.message));

  // 本机在监听同一个端口:应当回退直连本机,而不是送去远程凑一个空响应
  const srv = http.createServer((_q, res) => res.end('local'));
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  const fallback = await sshManager.runWithConn(fakeConn, () => resolvePreviewUrl(`http://localhost:${port}/`));
  await new Promise((r) => srv.close(r));
  check('远程没监听但本机有服务 → 回退直连本机', fallback.tunneled === false && fallback.url === `http://localhost:${port}/`, JSON.stringify(fallback));
  check('回退时给出提示说明(为什么没走隧道)', typeof fallback.note === 'string' && /本机/.test(fallback.note || ''), String(fallback.note || ''));
}

{
  // 反向确认:远程确实有服务时,照旧隧道(探测返回 true → 不改行为)
  const fakeConn = { connected: true, client: { forwardOut: (_a, _b, _c, _d, cb) => cb(undefined, { close() {} }) } };
  const open = await sshManager.runWithConn(fakeConn, () => resolvePreviewUrl('http://localhost:60011/'));
  check('远程有服务时仍然走隧道(行为不变)', open.tunneled === true && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(open.url), JSON.stringify(open));
}

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

  // ---------- 归属隔离:一个预览浏览器只服务一个对话 ----------
  const url = `http://127.0.0.1:${port}/`;
  const A = 's_aaa111';
  const B = 's_bbb222';

  const a1 = await browserManager.open({ id: `${A}:1`, url, ownerSid: A });
  const a2 = await browserManager.open({ id: `${A}:2`, url, ownerSid: A });
  const b1 = await browserManager.open({ id: `${B}:1`, url, ownerSid: B });
  check('同一会话可开多个预览(各自独立)', a1.id === `${A}:1` && a2.id === `${A}:2` && a1.id !== a2.id);
  check('预览状态里带归属会话', a1.ownerSid === A && b1.ownerSid === B, `${a1.ownerSid}/${b1.ownerSid}`);
  check('listFor 只列本会话的预览', browserManager.listFor(A).length === 2 && browserManager.listFor(B).length === 1);

  // 归属会话可以操作自己的预览
  await browserManager.click(`${A}:1`, { text: '点我' }, A);
  const aOut = await browserManager.evaluate(`${A}:1`, "document.getElementById('out').textContent", A);
  check('归属会话能操控自己的预览', aOut === '"clicked-1"', aOut);

  // 别的会话:B 的工具与鼠标输入都必须被拒(不是静默无效,而是明确报错)
  const denyClick = await browserManager.click(`${A}:1`, { text: '点我' }, B).catch((e) => e);
  check('非归属会话点击被拒', denyClick instanceof Error && /另一个会话/.test(denyClick.message), String(denyClick?.message || '').slice(0, 60));
  const denySnap = await browserManager.snapshot(`${A}:1`, B).catch((e) => e);
  check('非归属会话读快照被拒', denySnap instanceof Error && /无权操作/.test(denySnap.message));
  const denyInput = await browserManager.input(`${A}:1`, { kind: 'text', text: 'x' }, B).catch((e) => e);
  check('非归属会话的前端输入被拒', denyInput instanceof Error && /另一个会话/.test(denyInput.message));
  const denyEval = await browserManager.evaluate(`${A}:1`, '1+1', B).catch((e) => e);
  check('非归属会话执行页面脚本被拒', denyEval instanceof Error);

  // 跨会话的输入被拒后,目标页面状态不许被改动
  const untouched = await browserManager.evaluate(`${A}:1`, "document.getElementById('out').textContent", A);
  check('被拒的输入没有改动目标页面', untouched === '"clicked-1"', untouched);

  // 打开一个已被别的会话占用的 id:直接拒绝,不"就近复用"
  const steal = await browserManager.open({ id: `${A}:1`, url, ownerSid: B }).catch((e) => e);
  check('用别的会话的预览 id 打开被拒', steal instanceof Error && /另一个会话/.test(steal.message));

  // 无归属的共享预览(旧版 main):任何会话都能用,第一次带会话打开时被认领,之后独占
  const shared = await browserManager.open({ id: 'main', url });
  check('无归属预览可用(旧版兼容)', !!shared && shared.ownerSid === null, String(shared?.ownerSid));
  const claimed = await browserManager.open({ id: 'main', url, ownerSid: A });
  check('无归属预览被首次使用的会话认领', claimed.ownerSid === A);
  const stealShared = await browserManager.open({ id: 'main', url, ownerSid: B }).catch((e) => e);
  check('认领后别的会话不能再抢', stealShared instanceof Error && /另一个会话/.test(stealShared.message));

  // 草稿会话(d_…)改名继承:新会话里先开预览、再发第一条消息时不能变成孤儿
  const DRAFT = 'd_zzz999';
  const SESSION = 's_new555';
  const renamed = [];
  const onRenamed = (o) => renamed.push(o);
  browserManager.on('renamed', onRenamed);
  await browserManager.open({ id: `${DRAFT}:1`, url, ownerSid: DRAFT });
  const moved = browserManager.transferOwner(DRAFT, SESSION);
  browserManager.off('renamed', onRenamed);
  const stMoved = browserManager.state(`${SESSION}:1`);
  check('草稿预览改名继承到真实会话', moved === 1 && !!stMoved && stMoved.ownerSid === SESSION, JSON.stringify([moved, stMoved?.ownerSid]));
  check('继承后 id 与归属一致(不再是草稿 id)', !!stMoved && stMoved.id === `${SESSION}:1`, String(stMoved?.id));
  check('旧草稿 id 不再存在(避免重复 id 两处可操作)', browserManager.state(`${DRAFT}:1`) === null);
  check('改名事件通知了前端改订阅', renamed.length === 1 && renamed[0].from === `${DRAFT}:1` && renamed[0].to === `${SESSION}:1`, JSON.stringify(renamed));
  check('继承后归属会话可正常操作', !browserManager.denyReason(`${SESSION}:1`, SESSION));
  const n = await browserManager.closeFor(SESSION);
  check('关闭会话名下的预览(会话删除时清理)', n === 1 && browserManager.state(`${SESSION}:1`) === null);

  await browserManager.closeFor(A);
  await browserManager.closeFor(B);
  check('按会话清理后 listFor 为空', browserManager.listFor(A).length === 0 && browserManager.listFor(B).length === 0);

  // ---------- AI 工具侧:按调用会话自动认领本会话的预览 ----------
  const tool = (n) => browserToolDefs.find((t) => t.name === n);
  const ctx = (sid) => ({ sid, emit: () => {} });

  const opened = await tool('browser_open').run({ url }, ctx(A));
  check('browser_open 按会话自动分配预览 id', String(opened.meta.browserId).startsWith(`${A}:`), String(opened.meta.browserId));
  check('browser_open 结果带上本会话的预览清单', Array.isArray(opened.meta.previews) && opened.meta.previews.length === 1 && opened.meta.ownerSid === A);

  const snapA = await tool('browser_snapshot').run({}, ctx(A));
  check('browser_snapshot 不传 id 即作用于本会话预览', snapA.content.includes('Hello 预览'), snapA.meta.browserId);
  check('快照结果回带预览清单(模型每步都知道自己有哪些预览)', Array.isArray(snapA.meta.previews) && snapA.meta.previews.length === 1);

  const foreign = await tool('browser_snapshot').run({ browser_id: `${B}:9` }, ctx(A)).catch((e) => e);
  check('工具传别的会话的 browser_id → 明确拒绝', foreign instanceof Error && /另一个会话/.test(foreign.message));

  // 第二个会话:自动分配自己的预览,不碰 A 的
  const openedB = await tool('browser_open').run({ url }, ctx(B));
  check('另一个会话拿到自己的预览 id', String(openedB.meta.browserId).startsWith(`${B}:`), String(openedB.meta.browserId));
  check('两个会话的预览互不干扰', opened.meta.browserId !== openedB.meta.browserId
    && browserManager.listFor(A).length === 1 && browserManager.listFor(B).length === 1);

  // 预览清单注入:让 AI 知道"我有一个预览浏览器、用哪个 id、别的会话的碰不得"。
  // 位置是 runtime_context user 快照,不是 system——system 必须逐字节稳定,
  // 否则页面标题/加载态一变就换掉请求前缀,提供方前缀缓存整段失效。
  const { agent } = await import('../server/agent/agent.ts');
  const block = agent._browserPreviewSection(A);
  check('AI 能在上下文里看到本会话预览', block.includes('<browser_preview>') && block.includes(String(opened.meta.browserId)), block.slice(0, 120));
  check('注入内容说明归属规则', block.includes('只属于它所在的对话'), block.slice(-160));
  check('没有预览的会话不注入', agent._browserPreviewSection('s_none999') === '');
  check('预览走 runtime_context 快照', agent._buildRuntimeContext(undefined, A).includes('<browser_preview>'));
  check('预览不进 system(前缀缓存不失效)', !agent._systemPrompt('default').includes('<browser_preview>')
    && !agent._systemPrompt('off').includes('<browser_preview>'));

  const closed = await tool('browser_close').run({}, ctx(A));
  check('browser_close 不传 id 关闭本会话预览', closed.meta.closed === true && browserManager.listFor(A).length === 0);
  await browserManager.closeFor(B);

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
// 必须显式退出:本测试起过 WS 服务/浏览器连接,事件循环里仍有句柄(浏览器进程、定时器),
// 只靠 "没有 pending work 就自然退出" 会永远挂着 —— 成功时进程不退出会卡死整条 npm test 链
// (后面的 preview-url / command-card-merge 永远跑不到),也会在系统里留下僵死的 node 进程。
process.exit(fail ? 1 : 0);
