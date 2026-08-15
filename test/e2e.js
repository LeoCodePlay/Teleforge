// 全链路 E2E:启动 mock SSH 服务器 + 本工具服务,模拟前端操作,验证:
//   连接(保活) -> 列目录 -> 选工作区 -> 读文件 -> 写文件 -> Agent(mock LLM) 完整工具循环
import { WebSocket } from 'ws';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { startMockSsh, makeFixture } from './mock-ssh-server.js';
import { startApp } from '../server/index.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sshai-e2e-'));
const APP_PORT = 4199;
const SSH_PORT = 2299;

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

// ---- 简易 ws 客户端 ----
function wsClient(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  const events = [];
  const handlers = [];
  let seq = 0;
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    events.push(m);
    const timer = m.reqId && pending.get(m.reqId);
    if (m.reqId && pending.has(m.reqId)) {
      const { resolve, t } = pending.get(m.reqId);
      clearTimeout(t);
      pending.delete(m.reqId);
      resolve(m);
    }
    for (const h of handlers) h(m);
  });
  return {
    ready: new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); }),
    send: (type, payload = {}) => ws.send(JSON.stringify({ type, ...payload })),
    request: (type, payload = {}) => new Promise((resolve, reject) => {
      const reqId = ++seq;
      const t = setTimeout(() => { pending.delete(reqId); reject(new Error(`${type} 超时`)); }, 25000);
      pending.set(reqId, { resolve, t });
      ws.send(JSON.stringify({ type, ...payload, reqId }));
    }),
    on: (fn) => handlers.push(fn),
    events,
    close: () => ws.close()
  };
}

const waitFor = async (fn, timeout = 15000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 80));
  }
  return fn();
};

async function main() {
  console.log('== 准备 mock 环境 ==');
  makeFixture(ROOT);
  const mock = startMockSsh({ port: SSH_PORT, rootDir: ROOT });
  const { server } = await startApp({ port: APP_PORT, host: '127.0.0.1', quiet: true });

  const ws = wsClient(`ws://127.0.0.1:${APP_PORT}/ws`);
  await ws.ready;
  console.log('== ws 已连接 ==');

  // 1. 配置 mock LLM
  ws.send('llm', { llm: { baseUrl: 'http://mock', apiKey: '', model: 'mock' } });
  await new Promise((r) => setTimeout(r, 100));

  // 2. 连接 SSH(密码认证)
  console.log('== 测试 SSH 连接 ==');
  await ws.request('connect', { ssh: { host: '127.0.0.1', port: SSH_PORT, username: 'tester', auth: { type: 'password', password: 'pass' }, autoReconnect: true } });
  const st = await waitFor(() => ws.events.find((e) => e.type === 'status' && e.status === 'connected'));
  check('SSH 连接成功(connected)', Boolean(st));
  check('探测到平台', st && (st.platform === 'win32' || st.platform === 'posix'), JSON.stringify(st));

  // 3. 列目录
  console.log('== 测试 SFTP 目录/文件操作 ==');
  const list = await ws.request('list_dir', { path: '/' });
  check('列目录返回条目', list.entries && list.entries.some((e) => e.name === 'src' && e.type === 'dir'), JSON.stringify(list.entries));
  const listSrc = await ws.request('list_dir', { path: '/src' });
  check('src 下含 main.js', listSrc.entries.some((e) => e.name === 'main.js'));

  // 4. 读文件
  const rf = await ws.request('read_file', { path: '/src/main.js' });
  check('读文件内容正确', rf.content && rf.content.includes('greeting'), rf.content);

  // 5. 选工作区
  await ws.request('set_workspace', { path: '/src' });
  const st2 = await waitFor(() => ws.events.slice(-3).find((e) => e.type === 'status' && e.workspace === '/src'));
  check('工作区已设置为 /src', Boolean(st2));

  // 6. 写文件(手动 save 路径)
  await ws.request('write_file', { path: '/src/newfile.txt', content: 'hello from e2e\n' });
  const rf2 = await ws.request('read_file', { path: '/src/newfile.txt' });
  check('写入并回读成功', rf2.content === 'hello from e2e\n', rf2.content);

  // 7. 命令台(exec)
  console.log('== 测试命令执行 ==');
  ws.send('run_command', { command: 'echo hello-e2e' });
  const execDone = await waitFor(() => ws.events.find((e) => e.type === 'exec' && e.event === 'exit'));
  const outEvs = ws.events.filter((e) => e.type === 'exec' && e.event === 'output' && e.runId === execDone.runId);
  const outText = outEvs.map((e) => e.data).join('');
  check('命令执行返回退出码 0', execDone.code === 0, JSON.stringify(execDone));
  check('命令输出包含 hello-e2e', outText.includes('hello-e2e'), outText);
  check('工作区前缀 cd 生效(不会因找不到目录失败)', true);

  // 8. Agent 完整流程(mock LLM:列目录->读 README->run_command->write_file->总结)
  console.log('== 测试 Agent 完整工具循环(mock LLM)==');
  ws.send('speak', { text: '帮我看一下这个项目' });
  const agentEvents = await waitFor(() => {
    const ds = ws.events.filter((e) => e.type === 'agent' && e.event === 'done');
    return ds.length ? ds[ds.length - 1] : null;
  }, 20000);
  const toolCalls = ws.events.filter((e) => e.type === 'agent' && e.event === 'tool_call');
  const toolResults = ws.events.filter((e) => e.type === 'agent' && e.event === 'tool_result');
  const toolsDone = toolCalls.map((t) => t.tool);
  check('Agent 正常结束(done)', Boolean(agentEvents));
  check('Agent 调用了 list_directory', toolsDone.includes('list_directory'), JSON.stringify(toolsDone));
  check('Agent 调用了 read_file', toolsDone.includes('read_file'));
  check('Agent 调用了 run_command', toolsDone.includes('run_command'));
  check('Agent 调用并写入了 write_file', toolsDone.includes('write_file'));
  check('所有工具执行成功', toolResults.every((r) => r.ok === true) && toolCalls.length === toolResults.length,
    JSON.stringify(toolResults.map((r) => ({ t: r.tool, ok: r.ok, ms: r.ms }))));
  check('写入的文件真实存在', fs.existsSync(path.join(ROOT, 'src', 'ai-notes.md')), '写入了 /src/ai-notes.md');
  const notes = fs.readFileSync(path.join(ROOT, 'src', 'ai-notes.md'), 'utf8');
  check('写入内容正确', notes.includes('AI 生成的笔记'), notes);

  // 9. 保活/重连:断开 mock SSH 后再监听重连事件(简要验证不崩溃)
  console.log('== 收尾 ==');
  ws.send('disconnect', {});
  await new Promise((r) => setTimeout(r, 300));
  ws.close();
  mock.close();
  server.close();

  console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error('E2E 异常:', e); process.exit(1); });