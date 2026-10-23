// ego(lite) 后端回归:用假 ego-browser(实现 nodejs 脚本契约)验证整条接入链路。
//
// 覆盖:CLI 发现/探测、脚本 stdin 投递、__TF__ 结果解析、快照 ref→loc 映射跨调用可用、
// 批处理一次进程跑完、工具层 target=ego 路由、未安装时的明确降级提示。
import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'tf-ego-'));
const STATE = join(DIR, 'state.json');
process.env.FAKE_EGO_STATE = STATE;
process.env.EGO_BROWSER_BIN = resolve('test/fixtures/fake-ego.mjs');

const { egoProbe, resetEgoProbe } = await import('../server/core/ego-browser.ts');
const { egoOps } = await import('../server/agent/ego-backend.ts');
const { browserToolDefs } = await import('../server/agent/browser-tools.ts');

let pass = 0, fail = 0;
const log = (...a) => console.log(...a);
const check = (n, c, e = '') => { if (c) { pass++; log(`  ✓ ${n}`); } else { fail++; log(`  ✗ ${n} ${e}`); } };
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } };
const tool = (name) => browserToolDefs.find((d) => d.name === name);
const ctx = (sid) => ({ sid, emit: () => {} });

try {
  // ---------- 1. 探测 ----------
  const probe = await egoProbe();
  check('能发现 ego-browser 并识别新版 API', probe.ok && probe.info.api === 'page-v2', JSON.stringify(probe));

  // ---------- 2. 打开 + 快照 + ref 映射 ----------
  const sid = 's_ego_test';
  const ops = egoOps({ sid });
  const st = await ops.openUrl('http://demo.example/inbox');
  check('openUrl 打开页面', st.url === 'http://demo.example/inbox' && st.title.includes('demo.example'), JSON.stringify(st));

  const snap = await ops.snapshot({ scope: 'full_page' });
  check('快照是结构化文本', snap.includes('页面结构') && snap.includes('提交'), snap.slice(0, 120));
  const m = /\[ref=(e[a-z0-9]+), loc=css:#submit\]/.exec(snap);
  check('ego 的数字 ref 被换成本端稳定 ref,并保留 loc', !!m, snap.split('\n').find((l) => l.includes('提交')));

  const ref = m?.[1];
  await ops.click({ ref });
  check('按 ref 点击:翻译成 loc 后由 ego 执行', readState().clicks?.some((c) => c.name === '提交'), JSON.stringify(readState().clicks));

  await ops.fill({ ref: undefined, selector: '#name', text: '你好,ego' });
  check('按 selector 输入中文', readState().value === '你好,ego', String(readState().value));

  // 不稳定定位的元素:ref 依然给出,但动作时明确报错,而不是瞎点
  const unstableRef = /\[ref=(e[a-z0-9]+), loc=unstable\]/.exec(snap)?.[1];
  let unstableErr = '';
  try { await ops.click({ ref: unstableRef }); } catch (e) { unstableErr = String(e?.message || e); }
  check('unstable 的 ref 给出明确说明', /没有可跨调用的稳定定位/.test(unstableErr), unstableErr.slice(0, 120));

  // ---------- 3. 批处理:一次进程跑完 ----------
  const before = readState().clicks?.length || 0;
  const batch = await ops.batch([
    { op: 'click', ref },
    { op: 'fill', selector: '#name', text: '批量输入' },
    { op: 'wait', text: '正文' },
    { op: 'assert', text: '正文' }
  ], { stopOnError: true, snapshot: 'on_error' });
  check('批处理全部成功', batch.ok === true && batch.steps.length === 4, JSON.stringify(batch.steps));
  check('批处理里点击也生效', (readState().clicks?.length || 0) > before, JSON.stringify(readState().clicks));
  check('成功时默认不附快照', !batch.snapshot, String(batch.snapshot).slice(0, 60));

  const bad = await ops.batch([
    { op: 'click', ref },
    { op: 'assert', text: '绝对不会出现的文字' },
    { op: 'click', ref }
  ], { stopOnError: true, snapshot: 'on_error' });
  check('批处理遇错即停', bad.ok === false && bad.failedAt === 2, JSON.stringify(bad.steps));
  check('失败时附快照', !!bad.snapshot && bad.snapshot.includes('页面结构'), String(bad.snapshot).slice(0, 80));

  // ---------- 4. 其余原语 ----------
  await ops.act('hover', { selector: '#submit' });
  check('hover 生效', readState().hovered === '#submit', String(readState().hovered));
  const evaled = await ops.evaluate('document.body.innerText');
  check('evaluate 回值', evaled.includes('正文'), evaled.slice(0, 60));
  const shot = await ops.screenshot({});
  check('截图返回 PNG 字节', Buffer.isBuffer(shot) && shot[0] === 0x89, String(shot?.length));

  // ---------- 5. 工具层 target=ego ----------
  const opened = await tool('browser_open').run({ url: 'http://demo.example/orders', target: 'ego' }, ctx(sid));
  check('browser_open(target=ego) 走 ego 后端', opened.meta.backend === 'ego', JSON.stringify(opened.meta).slice(0, 120));
  check('browser_open 结果带快照', String(opened.content).includes('页面结构'), String(opened.content).slice(0, 120));

  const snapTool = await tool('browser_snapshot').run({ target: 'ego' }, ctx(sid));
  const toolRef = /\[ref=(e[a-z0-9]+), loc=css:#cancel\]/.exec(String(snapTool.content))?.[1];
  check('browser_snapshot(target=ego) 给出可复用 ref', !!toolRef, String(snapTool.content).slice(0, 160));

  const clicked = await tool('browser_click').run({ target: 'ego', ref: toolRef }, ctx(sid));
  check('browser_click(target=ego) 按 ref 执行', String(clicked.content).includes('已点击'), String(clicked.content).slice(0, 120));
  check('点击确实落到取消按钮', readState().clicks?.some((c) => c.name === '取消'), JSON.stringify(readState().clicks?.slice(-2)));

  const batchTool = await tool('browser_batch').run({
    target: 'ego',
    steps: [{ op: 'click', selector: '#submit' }, { op: 'assert', text: '正文' }],
    snapshot: 'never'
  }, ctx(sid));
  check('browser_batch(target=ego) 可用', String(batchTool.content).includes('批处理完成'), String(batchTool.content).slice(0, 120));

  await ops.close();
  check('close 结束 ego 任务空间', readState().finished === true, JSON.stringify(readState().finished));

  // ---------- 6. 未安装时的降级 ----------
  resetEgoProbe();
  process.env.EGO_BROWSER_BIN = join(DIR, 'not-installed-ego-browser.mjs');
  const miss = await egoProbe(true);
  check('没有 ego-browser 时探测失败并给说明', miss.ok === false && /没有找到 ego-browser/.test(String(miss.error)), String(miss.error));
  let openErr = '';
  try {
    await tool('browser_open').run({ url: 'http://x.example/', target: 'ego' }, ctx(sid));
  } catch (e) { openErr = String(e?.message || e); }
  check('target=ego 未安装时报可操作错误', /ego-browser/.test(openErr), openErr.slice(0, 160));
} catch (e) {
  fail++;
  log(`  ✗ 异常:${(e && e.stack) || e}`);
} finally {
  try { rmSync(DIR, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

console.log(`\n ego 后端测试:${pass} 通过,${fail} 失败`);
process.exit(fail ? 1 : 0);
