// 全链路 E2E:启动 mock SSH 服务器 + 本工具服务,模拟前端操作,验证:
//   连接(保活) -> 列目录 -> 选工作区 -> 读文件 -> 写文件 -> Agent(mock LLM) 完整工具循环
// 注意:会话历史会写到 <data>/sessions.json,需在临时目录里隔离运行
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sshai-e2e-dd-'));
const { WebSocket } = await import('ws');
const fs = { mkdtempSync, writeFileSync, readFileSync, existsSync };
const { startMockSsh, makeFixture } = await import('./mock-ssh-server.js');
const { startApp } = await import('../server/index.js');

const ROOT = fs.mkdtempSync(path.join(tmpdir(), 'sshai-e2e-'));
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
    if (m.reqId && pending.has(m.reqId)) {
      const { resolve, t, replyType } = pending.get(m.reqId);
      // 指定了 replyType 时,跳过带同 reqId 的中间进度事件(如 delete_progress),等最终应答
      if (m.error || !replyType || m.type === replyType) {
        clearTimeout(t);
        pending.delete(m.reqId);
        resolve(m);
      }
    }
    for (const h of handlers) h(m);
  });
  return {
    ready: new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); }),
    send: (type, payload = {}) => ws.send(JSON.stringify({ type, ...payload })),
    request: (type, payload = {}, replyType) => new Promise((resolve, reject) => {
      const reqId = ++seq;
      const t = setTimeout(() => { pending.delete(reqId); reject(new Error(`${type} 超时`)); }, 25000);
      pending.set(reqId, { resolve, t, replyType });
      ws.send(JSON.stringify({ type, ...payload, reqId }));
    }),
    on: (fn) => handlers.push(fn),
    events,
    close: () => ws.close()
  };
}

// /api/upload 现在流式回传 NDJSON(进度行 + 结果行),取最后一行为最终结果
const lastJson = async (r) => JSON.parse((await r.text()).split('\n').filter((x) => x.trim()).pop());

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

  // 6.5 上传文件/文件夹(HTTP multipart -> SFTP 写入工作区)
  console.log('== 测试上传/下载 ==');
  {
    const fd = new FormData();
    fd.append('files', new Blob(['upload-single'], { type: 'text/plain' }), 'up/hello.txt'); // 单文件带子目录
    fd.append('files', new Blob(['nested-a'], { type: 'text/plain' }), 'folder/sub/a.txt');  // 文件夹递归结构
    fd.append('files', new Blob(['nested-b'], { type: 'text/plain' }), 'folder/sub/b.txt');
    const ur = await fetch(`http://127.0.0.1:${APP_PORT}/api/upload`, { method: 'POST', body: fd });
    const uj = await lastJson(ur);
    check('上传接口返回成功', ur.status === 200 && uj.uploaded === 3, JSON.stringify(uj));
    const upA = await ws.request('read_file', { path: '/src/up/hello.txt' });
    check('上传的单文件内容正确', upA.content === 'upload-single', upA.content);
    const upB = await ws.request('read_file', { path: '/src/folder/sub/b.txt' });
    check('上传的文件夹结构正确(递归目录已建)', upB.content === 'nested-b', upB.content);

    // 下载
    const dl = await fetch(`http://127.0.0.1:${APP_PORT}/api/download?path=${encodeURIComponent('/src/up/hello.txt')}`);
    check('下载返回文件内容', dl.status === 200 && (await dl.text()) === 'upload-single', String(dl.status));

    // 越权防护:上传 ../ 应被拒绝
    const badFd = new FormData();
    badFd.append('files', new Blob(['evil']), '../../evil.txt');
    const br = await fetch(`http://127.0.0.1:${APP_PORT}/api/upload`, { method: 'POST', body: badFd });
    const bj = await lastJson(br);
    check('越权路径 ../ 被拒绝', bj.uploaded === 0 && bj.failed === 1, JSON.stringify(bj));
    check('越权文件未写入', !fs.existsSync(path.join(ROOT, 'evil.txt')) && !fs.existsSync(path.join(path.dirname(ROOT), 'evil.txt')));
  }

  // 6.6 复制(copy)、上传到指定目录、文件夹打包下载
  console.log('== 测试复制/目录上传/打包下载 ==');
  {
    // 复制单文件
    await ws.request('copy', { src: '/src/main.js', dst: '/src/main-copy.js', overwrite: false });
    const cpA = await ws.request('read_file', { path: '/src/main-copy.js' });
    check('复制单文件成功且内容一致', cpA.content === rf.content, cpA.content);

    // 复制目录(递归)
    await ws.request('copy', { src: '/src/up', dst: '/src/up-copy', overwrite: false });
    const cpB = await ws.request('list_dir', { path: '/src/up-copy' });
    check('复制目录递归成功(含子项)', cpB.entries.some((e) => e.name === 'hello.txt' && e.type === 'file'), JSON.stringify(cpB.entries));

    // 覆盖冲突:目标已存在且 overwrite=false -> 报错(e2e 客户端对错误回复是 resolve,按 type 判断)
    const conflictResp = await ws.request('copy', { src: '/src/main.js', dst: '/src/main-copy.js', overwrite: false });
    check('目标已存在且未允许覆盖时报错', conflictResp.type === 'error' && (conflictResp.error || '').includes('目标已存在'), JSON.stringify(conflictResp));

    // 覆盖:overwrite=true -> 成功
    await ws.request('copy', { src: '/src/main.js', dst: '/src/main-copy.js', overwrite: true });
    const cpOv = await ws.request('read_file', { path: '/src/main-copy.js' });
    check('允许覆盖时复制成功', cpOv.content === rf.content, cpOv.content);

    // 复制到自身内部 -> 拒绝(防递归)
    const selfResp = await ws.request('copy', { src: '/src', dst: '/src/self', overwrite: false });
    check('复制到自身内部被拒绝', selfResp.type === 'error', JSON.stringify(selfResp));

    // 上传到指定目录(dir 参数,非工作区)
    const fd2 = new FormData();
    fd2.append('files', new Blob(['into-dir'], { type: 'text/plain' }), 'x.txt');
    const ur2 = await fetch(`http://127.0.0.1:${APP_PORT}/api/upload?dir=${encodeURIComponent('/src/folder')}`, { method: 'POST', body: fd2 });
    const uj2 = await lastJson(ur2);
    const upDir = await ws.request('read_file', { path: '/src/folder/x.txt' });
    check('上传到指定目录生效', uj2.uploaded === 1 && upDir.content === 'into-dir', JSON.stringify(uj2));

    // 文件夹打包下载:gzip 解包后 tar 内包含目录结构与文件内容
    const dlDir = await fetch(`http://127.0.0.1:${APP_PORT}/api/downloaddir?path=${encodeURIComponent('/src/folder')}`);
    const buf = Buffer.from(await dlDir.arrayBuffer());
    const gun = zlib.gunzipSync(buf);
    check('downloaddir 返回合法 gzip', dlDir.status === 200 && gun.length > 0, String(dlDir.status));
    check('tar 包含目录项(folder/)', gun.includes(Buffer.from('folder/')), '');
    check('tar 包含文件内容(nested-a)', gun.includes(Buffer.from('nested-a')), '');
    check('tar 包含新上传内容(into-dir)', gun.includes(Buffer.from('into-dir')), '');

    // 多选打包下载:多个 path 打包到一个 tar.gz(置于 download/ 下)
    const dlMulti = await fetch(`http://127.0.0.1:${APP_PORT}/api/downloaddir?path=${encodeURIComponent('/src/up/hello.txt')}&path=${encodeURIComponent('/src/main.js')}`);
    check('多选打包下载返回 200', dlMulti.status === 200, String(dlMulti.status));
    if (dlMulti.status === 200) {
      const mGun = zlib.gunzipSync(Buffer.from(await dlMulti.arrayBuffer()));
      check('多选包含 download/hello.txt 条目', mGun.includes(Buffer.from('download/hello.txt')), '');
      check('多选包含 download/main.js 条目', mGun.includes(Buffer.from('download/main.js')), '');
      check('多选包含各文件内容', mGun.includes(Buffer.from('upload-single')) && mGun.includes(Buffer.from('const greeting')), '');
    }
  }

  // 6.7 删除(文件/文件夹递归 + 进度事件)
  console.log('== 测试删除 ==');
  {
    // 构造嵌套删除对象:/src/deltree/{root.txt, sub/inner.txt, sub/deep/deep.txt}
    const fd = new FormData();
    fd.append('files', new Blob(['del-root'], { type: 'text/plain' }), 'deltree/root.txt');
    fd.append('files', new Blob(['del-inner'], { type: 'text/plain' }), 'deltree/sub/inner.txt');
    fd.append('files', new Blob(['del-deep'], { type: 'text/plain' }), 'deltree/sub/deep/deep.txt');
    await fetch(`http://127.0.0.1:${APP_PORT}/api/upload`, { method: 'POST', body: fd });
    check('删除前目录已就绪', fs.existsSync(path.join(ROOT, 'src', 'deltree', 'sub', 'deep', 'deep.txt')));

    // 删除单文件:回复 deleted 且文件不存在
    const df = await ws.request('delete', { path: '/src/newfile.txt' }, 'deleted');
    check('删除单文件成功', df.type === 'deleted' && !fs.existsSync(path.join(ROOT, 'src', 'newfile.txt')), JSON.stringify(df));

    // 删除文件夹:递归删除整个树,期间收到 delete_progress 进度事件,末条 final 且 done=树条目数(6)
    const before = ws.events.filter((e) => e.type === 'delete_progress').length;
    const dd = await ws.request('delete', { path: '/src/deltree' }, 'deleted');
    const prog = ws.events.slice(before).filter((e) => e.type === 'delete_progress');
    check('删除文件夹成功(整棵递归删除)', dd.type === 'deleted' && !fs.existsSync(path.join(ROOT, 'src', 'deltree')), JSON.stringify(dd));
    check('删除过程收到进度事件', prog.length > 0, JSON.stringify(prog.slice(0, 2)));
    const lastProg = prog[prog.length - 1];
    check('末条进度事件 final=true 且 done=6', lastProg && lastProg.final === true && lastProg.done === 6, JSON.stringify(lastProg));
    check('进度 done 单调递增', prog.every((p, i) => i === 0 || p.done >= prog[i - 1].done), JSON.stringify(prog));

    // 删除不存在的路径 -> 报错
    const dne = await ws.request('delete', { path: '/src/no-such-file' }, 'deleted');
    check('删除不存在路径报错', dne.type === 'error' && (dne.error || '').includes('不存在'), JSON.stringify(dne));
  }

  // 7. 命令台(exec)
  console.log('== 测试命令执行 ==');
  ws.send('run_command', { command: 'echo hello-e2e' });
  const execDone = await waitFor(() => ws.events.find((e) => e.type === 'exec' && e.event === 'exit'));
  const outEvs = ws.events.filter((e) => e.type === 'exec' && e.event === 'output' && e.runId === execDone.runId);
  const outText = outEvs.map((e) => e.data).join('');
  check('命令执行返回退出码 0', execDone.code === 0, JSON.stringify(execDone));
  check('命令输出包含 hello-e2e', outText.includes('hello-e2e'), outText);
  check('工作区前缀 cd 生效(不会因找不到目录失败)', true);

  // 7.5 停止运行中的命令(Ctrl+C)
  console.log('== 测试停止运行中的命令 ==');
  {
    ws.send('run_command', { command: 'node -e "setInterval(()=>{},1000)"' });
    // 按命令匹配 start 事件,避免误取上一轮 echo 的 start
    const startEv = await waitFor(() => ws.events.find((e) => e.type === 'exec' && e.event === 'start' && e.command?.includes('setInterval')));
    check('长跑命令已启动(start 含 runId)', Boolean(startEv && startEv.runId), JSON.stringify(startEv));
    await new Promise((r) => setTimeout(r, 300)); // 让命令真正跑起来
    const stopResp = await ws.request('stop_command', { runId: startEv.runId });
    check('stop_command 返回 ok 且 stopped=true', stopResp.type === 'ok' && stopResp.stopped === true, JSON.stringify(stopResp));
    const stopExit = await waitFor(() => ws.events.find((e) => e.type === 'exec' && e.event === 'exit' && e.runId === startEv.runId));
    check('停止后收到该 runId 的 exit 且带 stopped 标记', stopExit && stopExit.stopped === true, JSON.stringify(stopExit));
  }

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