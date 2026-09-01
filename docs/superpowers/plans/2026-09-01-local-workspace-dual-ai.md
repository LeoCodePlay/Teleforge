# 本地文件工作区 + AI 双工作区 + 技能边界统一 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给这个 SSH 远程 AI 工具新增「本地文件工作区」子系统：本地文件面板、本地↔远程双向快捷传输、AI 双工作区（本机+远程均可读写/执行命令），并修复技能边界，让 Agent 在无 SSH 连接时也能发现并加载本机/内置技能。

**Architecture:** 新增 `local-fs.js`（Node `fs`/`path` 适配层）与 `local-exec.js`（本地命令），与现有 `ssh-manager.js`（SFTP）平行，对上层暴露同一套方法签名。Agent 工具、WS 协议、前端文件面板、双向传输均复用同一 `localFs.workspace` 状态；技能系统新增 `local-workspace` 来源并去掉 `ssh.workspace` 门控。

**Tech Stack:** Node ≥18.17（`fs/promises`、`path`、`child_process`）、ssh2（SFTP）、ws、React 18 + TypeScript。无新增 npm 依赖。测试为纯 Node 脚本 + 自写 `check()` 断言。

**Spec:** `docs/superpowers/specs/2026-09-01-local-workspace-dual-ai-design.md`

## Global Constraints

- Node 引擎 `>=18.17`；模块体系为 ESM（`"type": "module"`），用 `import`/`export`。
- **不新增任何 npm 依赖**（`local-fs`/`local-exec` 只允许 `node:` 内置模块）。
- 本地路径一律用 Node `path` 模块（`path.resolve`/`path.join`），**不得复用** `normalizeRemote`（那是 POSIX 语义，会破坏 `C:\` 盘符与 UNC）。
- 服务端继续仅监听 `127.0.0.1`（保持现状，不做外网暴露）。
- AI 本地工具限制在本地工作区内（`resolveInLocalWorkspace` 越界守卫）；本地 UI 文件面板可自由浏览（与远程 FileManager 一致）。
- 本地 `run_local_command` 必须复用危险命令正则守卫（`rm -rf /`、`mkfs`、`dd of=/dev/`、`chmod -R 777 /`）。
- 测试沿用现有约定：纯 Node 脚本、自写 `check(name, cond, extra)` 断言、`process.exit(fail?1:0)`，经 `node test/<name>.test.js` 直跑。
- 提交信息用中文 + `feat:`/`fix:`/`test:` 前缀（对齐仓库历史）。
- 技能覆盖优先级（低→高）：`builtin < local-user < user < local-project < local-workspace < project`。

---

## 文件结构总览

**新增：**
- `server/local-fs.js` — 本地 FS 适配（LocalFs 类 + `localFs` 单例 + `resolveInLocalWorkspace`）
- `server/local-exec.js` — 本地命令执行（`execLocal`）
- `server/transfer.js` — 本地↔远程双向传输（`localToRemote` / `remoteToLocal`）
- `web/src/components/LocalFileManager.tsx` — 本地文件面板
- `web/src/components/LocalDirBrowser.tsx` — 本地工作区选择弹窗
- `test/local-fs.test.js`、`test/local-exec.test.js`、`test/transfer.test.js`、`test/agent-local.test.js`、`test/skills-catalog.test.js`

**修改：**
- `server/config.js` — 加 `LOCAL_EXEC` 常量
- `server/ws.js` — 本地浏览/读写 case + 双向传输 case + status 加 `localWorkspace`
- `server/agent/tools.js` — 本地工具集 + 守卫 + 技能门控修复 + `local-workspace` 来源
- `server/agent/agent.js` — 双工作区 system prompt + 本地环境快照
- `web/src/types.ts` — `ServerStatus` 加 `localWorkspace`
- `web/src/App.tsx` — 本地工作区状态 + cwd 双向共享
- `web/src/components/WorkspacePanel.tsx` — 本地/远程 Tab
- `web/src/components/FileManager.tsx` — 加「传到本地当前目录」按钮 + `onCwdChange`
- `web/src/components/SkillsPanel.tsx` — 显示 `local-workspace` 来源
- `web/src/styles.scss` — 面板 Tab 样式
- `package.json` — test script 追加新测试

---

## Track A — 本地文件工作区

### Task 1: `server/local-fs.js` 本地 FS 适配层

**Files:**
- Create: `server/local-fs.js`
- Test: `test/local-fs.test.js`

**Interfaces:**
- Consumes: `FILE`（来自 `server/config.js`，`READ_MAX_BYTES`/`WRITE_MAX_BYTES`/`DISCARD_BYTES`）
- Produces:
  - `class LocalFs`，实例 `localFs`，字段 `localFs.workspace`（字符串或 null）
  - 方法：`listDir(p)` → `Promise<{name,type:'dir'|'file'|'link',size,mtime}[]>`；`stat(p)` → `fs.Stats|null`；`readFileChunk(p,{maxBytes,offset})` → `Promise<{buffer,size,truncated}>`；`writeFile(p,content,{maxBytes,mkdir})` → `Promise<number>`；`mkdirp(p)`；`rmdirRecursive(p,onProgress)`；`copyPath(src,dst,{overwrite})`；`atype(p)` → `'dir'|'file'|'link'|null`；`isProbablyBinary(buf)` → `boolean`；`get home()` → `os.homedir()`
  - `resolveInLocalWorkspace(p,{allowRoot})` → 绝对路径字符串（越界/未设工作区抛错）

- [ ] **Step 1: 写失败测试**

创建 `test/local-fs.test.js`（遵循现有 `check()` 约定，用 `mkdtempSync` 隔离临时目录）：

```js
// 本地 FS 适配层测试:listDir/readFileChunk/writeFile/mkdirp/rmdirRecursive/copyPath
// 与 resolveInLocalWorkspace 越界守卫
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const { localFs, resolveInLocalWorkspace } = await import('../server/local-fs.js');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) pass++; else fail++; console.log(`  ${c ? '✓' : '✗'} ${n} ${e}`); };

const root = mkdtempSync(path.join(tmpdir(), 'sshai-lfs-'));
const ws = path.join(root, 'ws');
mkdirSync(path.join(ws, 'sub', 'deep'), { recursive: true });
writeFileSync(path.join(ws, 'a.txt'), 'hello');
writeFileSync(path.join(ws, 'sub', 'b.md'), 'nested');
localFs.workspace = ws;

// listDir:先目录后文件、含 size/mtime
const list = await localFs.listDir(ws);
check('listDir 目录在前', list.map(e => e.name).join(',') === 'sub,a.txt' || (list[0].type === 'dir' && list[1].name === 'a.txt'), JSON.stringify(list));
check('listDir 识别目录类型', list.find(e => e.name === 'sub')?.type === 'dir');
check('listDir 识别文件 size', list.find(e => e.name === 'a.txt')?.size === 5);

// readFileChunk 分片 + offset
const r = await localFs.readFileChunk(path.join(ws, 'a.txt'), { maxBytes: 3 });
check('readFileChunk 截断读取', r.buffer.toString('utf8') === 'hel' && r.truncated === true && r.size === 5, JSON.stringify(r));
const r2 = await localFs.readFileChunk(path.join(ws, 'a.txt'), { maxBytes: 100, offset: 1 });
check('readFileChunk offset 生效', r2.buffer.toString('utf8') === 'ello' && r2.truncated === false);

// writeFile 自动建父目录 + 覆盖写
const w = await localFs.writeFile(path.join(ws, 'new', 'x.txt'), 'data');
check('writeFile 自动建父目录', existsSync(path.join(ws, 'new', 'x.txt')) && readFileSync(path.join(ws, 'new', 'x.txt'), 'utf8') === 'data');
check('writeFile 返回字节数', w === 4);

// resolveInLocalWorkspace:相对路径、越界、未设工作区
check('resolveInLocalWorkspace 相对路径解析到工作区内', resolveInLocalWorkspace('sub/b.md') === path.join(ws, 'sub', 'b.md'), resolveInLocalWorkspace('sub/b.md'));
check('resolveInLocalWorkspace 工作区根', resolveInLocalWorkspace('.') === ws);
let threw = false; try { resolveInLocalWorkspace('../outside.txt'); } catch { threw = true; }
check('resolveInLocalWorkspace 越界被拒', threw);
const saved = localFs.workspace; localFs.workspace = null;
let threw2 = false; try { resolveInLocalWorkspace('x'); } catch { threw2 = true; }
check('resolveInLocalWorkspace 未设工作区抛错', threw2);
localFs.workspace = saved;

// copyPath:文件复制 + 目录递归 + 越界(复制到自身内部)
await localFs.copyPath(path.join(ws, 'a.txt'), path.join(ws, 'a-copy.txt'));
check('copyPath 复制文件', readFileSync(path.join(ws, 'a-copy.txt'), 'utf8') === 'hello');
await localFs.copyPath(path.join(ws, 'sub'), path.join(ws, 'sub-copy'));
check('copyPath 复制目录递归', readFileSync(path.join(ws, 'sub-copy', 'deep', 'b.md'), 'utf8') === 'nested' || readFileSync(path.join(ws, 'sub-copy', 'b.md'), 'utf8') === 'nested');
let threw3 = false; try { await localFs.copyPath(path.join(ws, 'sub'), path.join(ws, 'sub', 'inner')); } catch { threw3 = true; }
check('copyPath 复制到自身内部被拒', threw3);

// rmdirRecursive:递归删除 + onProgress 计数
let cnt = 0;
await localFs.rmdirRecursive(path.join(ws, 'sub-copy'), () => { cnt++; });
check('rmdirRecursive 递归删除', !existsSync(path.join(ws, 'sub-copy')) && cnt > 0, `cnt=${cnt}`);

// isProbablyBinary
check('isProbablyBinary 检测 NUL 字节', localFs.isProbablyBinary(Buffer.from([0, 1, 2])) === true);
check('isProbablyBinary 纯文本为 false', localFs.isProbablyBinary(Buffer.from('abc')) === false);

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
if (fail) process.exit(1);
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/local-fs.test.js`
Expected: FAIL（`Cannot find module '../server/local-fs.js'`）

- [ ] **Step 3: 实现 `server/local-fs.js`**

```js
// 本地文件系统适配层:与 ssh-manager 的 SFTP 方法签名对齐,底层用 Node fs/path。
// 供 Agent 本地工具、WS 本地浏览/读写、双向传输共用;持有 localWorkspace 状态。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { FILE } from './config.js';

export class LocalFs {
  constructor() { this.workspace = null; } // 用户选择的本地工作区绝对路径(可空)
  get home() { return os.homedir(); }

  async listDir(p) {
    const abs = path.resolve(p || this.workspace || this.home || '.');
    const dirents = await fsp.readdir(abs, { withFileTypes: true });
    const entries = [];
    for (const d of dirents) {
      const full = path.join(abs, d.name);
      let st; try { st = await fsp.lstat(full); } catch { continue; }
      const type = d.isDirectory() ? 'dir' : d.isSymbolicLink() ? 'link' : 'file';
      entries.push({ name: d.name, type, size: st.size || 0, mtime: st.mtimeMs || 0 });
    }
    return entries.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
  }

  async stat(p) {
    try { return await fsp.stat(path.resolve(p)); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }

  async readFileChunk(p, { maxBytes = FILE.READ_MAX_BYTES, offset = 0 } = {}) {
    const abs = path.resolve(p);
    const st = await this.stat(abs);
    if (!st) throw new Error(`文件不存在: ${abs}`);
    if (st.isDirectory()) throw new Error(`是目录: ${abs}`);
    const fh = await fsp.open(abs, 'r');
    try {
      const want = Math.min(maxBytes, Math.max(0, st.size - offset));
      const buf = Buffer.alloc(want);
      const { bytesRead } = await fh.read(buf, 0, want, offset);
      return { buffer: buf.subarray(0, bytesRead), size: st.size, truncated: offset + bytesRead < st.size };
    } finally { await fh.close(); }
  }

  async writeFile(p, content, { maxBytes = FILE.WRITE_MAX_BYTES, mkdir = true } = {}) {
    const abs = path.resolve(p);
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    if (maxBytes && buf.length > maxBytes) throw new Error(`文件过大(>${Math.round(maxBytes / 1024 / 1024)}MB): ${abs}`);
    if (mkdir) await this.mkdirp(path.dirname(abs));
    await fsp.writeFile(abs, buf);
    return buf.length;
  }

  async mkdirp(p) { await fsp.mkdir(path.resolve(p), { recursive: true }); }

  async rmdirRecursive(p, onProgress) {
    p = path.resolve(p);
    const type = await this.atype(p);
    if (!type) return;
    if (type === 'file' || type === 'link') { await fsp.rm(p, { force: true }); onProgress?.(p); return; }
    const entries = await fsp.readdir(p, { withFileTypes: true });
    for (const e of entries) await this.rmdirRecursive(path.join(p, e.name), onProgress);
    await fsp.rmdir(p);
    onProgress?.(p);
  }

  async copyPath(src, dst, { overwrite = false } = {}) {
    src = path.resolve(src); dst = path.resolve(dst);
    if (src === dst) throw new Error('源与目标相同');
    if (dst.startsWith(src + path.sep)) throw new Error('不能复制到自身内部');
    const type = await this.atype(src);
    if (!type) throw new Error(`源不存在: ${src}`);
    const dstType = await this.atype(dst);
    if (dstType) {
      if (!overwrite) throw new Error(`目标已存在: ${dst}`);
      await this.rmdirRecursive(dst);
    }
    if (type === 'dir') { await fsp.mkdir(dst, { recursive: true }); await this._copyDir(src, dst); }
    else { await fsp.mkdir(path.dirname(dst), { recursive: true }); await fsp.copyFile(src, dst); }
    return { src, dst };
  }
  async _copyDir(src, dst) {
    for (const e of await this.listDir(src)) {
      const sp = path.join(src, e.name), dp = path.join(dst, e.name);
      if (e.type === 'dir') { await fsp.mkdir(dp, { recursive: true }); await this._copyDir(sp, dp); }
      else await fsp.copyFile(sp, dp);
    }
  }

  async atype(p) {
    try {
      const a = await fsp.lstat(path.resolve(p));
      return a.isDirectory() ? 'dir' : a.isSymbolicLink() ? 'link' : 'file';
    } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }

  isProbablyBinary(buf) {
    if (!buf) return false;
    const n = Math.min(buf.length, FILE.DISCARD_BYTES);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
    return false;
  }
}

export const localFs = new LocalFs();

// 把路径解析到本地工作区内;越界/未设工作区报错(与远程 resolveInWorkspace 对称)
export function resolveInLocalWorkspace(p, { allowRoot = true } = {}) {
  const ws = localFs.workspace;
  if (!ws) throw new Error('尚未选择本地工作区,请先在界面中选择本地目录作为本地工作区');
  const wsAbs = path.resolve(ws);
  const raw = String(p || '.').trim();
  const abs = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(wsAbs, raw);
  if (abs === wsAbs) return wsAbs;
  if (abs.startsWith(wsAbs + path.sep)) return abs;
  throw new Error(`路径超出本地工作区,被拒绝: ${p}`);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/local-fs.test.js`
Expected: PASS（所有 `✓`，`==== 结果: N 通过, 0 失败 ====`，退出码 0）

- [ ] **Step 5: Commit**

```bash
git add server/local-fs.js test/local-fs.test.js
git commit -m "feat: 新增本地文件系统适配层 local-fs(与 SFTP 签名对齐,含越界守卫)"
```

---

### Task 2: `server/local-exec.js` 本地命令执行

**Files:**
- Create: `server/local-exec.js`
- Modify: `server/config.js`（加 `LOCAL_EXEC` 常量）
- Test: `test/local-exec.test.js`

**Interfaces:**
- Consumes: `LOCAL_EXEC`（`DEFAULT_TIMEOUT_MS`/`MAX_TIMEOUT_MS`/`MAX_OUTPUT_CHARS`，本任务在 config.js 定义）
- Produces: `execLocal(command, {cwd, timeout, maxOutput})` → `Promise<{code, signal, stdout, stderr, timedOut}>`

- [ ] **Step 1: 在 `server/config.js` 加常量**

在 `EXEC` 常量块后新增：

```js
export const LOCAL_EXEC = {
  DEFAULT_TIMEOUT_MS: 300_000,
  MAX_TIMEOUT_MS: 600_000,
  MAX_OUTPUT_CHARS: 100_000
};
```

- [ ] **Step 2: 写失败测试 `test/local-exec.test.js`**

```js
import { execLocal } from '../server/local-exec.js';
let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) pass++; else fail++; console.log(`  ${c ? '✓' : '✗'} ${n} ${e}`); };

const out = await execLocal('echo local-exec-ok', { cwd: process.cwd() });
check('execLocal 执行成功退出码 0', out.code === 0 && out.stdout.trim() === 'local-exec-ok', JSON.stringify(out));

const err = await execLocal('node -e "console.error(\'boom\');process.exit(3)"');
check('execLocal 非零退出码透传', err.code === 3 && err.stderr.includes('boom'), JSON.stringify(err));

const noOut = await execLocal('echo x && echo y && echo z');
check('execLocal 多行输出合并到 stdout', noOut.stdout.split('\n').filter(Boolean).length === 3);

const t0 = Date.now();
const timed = await execLocal('node -e "setTimeout(()=>{},5000)"', { timeout: 500 });
check('execLocal 超时终止', timed.timedOut === true && (Date.now() - t0) < 4000, JSON.stringify(timed));

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
if (fail) process.exit(1);
```

- [ ] **Step 3: 跑测试确认失败**

Run: `node test/local-exec.test.js`
Expected: FAIL（`Cannot find module '../server/local-exec.js'`）

- [ ] **Step 4: 实现 `server/local-exec.js`**

```js
// 本地命令执行:child_process.exec,输出截断 + 超时;供 Agent run_local_command 工具使用。
import { exec as cpExec } from 'node:child_process';
import { LOCAL_EXEC } from './config.js';

function truncate(text, chr) {
  if (!text || text.length <= chr) return text || '';
  const keep = Math.floor(chr * 0.6), tail = chr - keep;
  return text.slice(0, keep) + '\n…[输出过长,已截断,省略 ' + (text.length - chr) + ' 字符]…\n' + text.slice(text.length - tail);
}

export function execLocal(command, { cwd, timeout = LOCAL_EXEC.DEFAULT_TIMEOUT_MS, maxOutput = LOCAL_EXEC.MAX_OUTPUT_CHARS } = {}) {
  return new Promise((resolve) => {
    const t = Math.min(timeout, LOCAL_EXEC.MAX_TIMEOUT_MS);
    const proc = cpExec(command, { windowsHide: true, cwd, maxBuffer: 64 * 1024 * 1024, timeout: t }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
        signal: error?.signal || null,
        stdout: truncate(stdout || '', maxOutput),
        stderr: truncate(stderr || '', maxOutput),
        timedOut: error?.killed === true
      });
    });
    proc.on('error', () => {}); // 错误经回调返回,避免未处理 error 事件抛出
  });
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node test/local-exec.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/local-exec.js server/config.js test/local-exec.test.js
git commit -m "feat: 新增本地命令执行 local-exec(child_process.exec + 超时 + 截断)"
```

---

### Task 3: WS 本地浏览/读写 + 本地工作区选择

**Files:**
- Modify: `server/ws.js:34-64`（`emitStatus` 加 `localWorkspace`）、`server/ws.js:138-198`（新增本地 case）
- Test: 扩展 `test/e2e.js`（本任务末尾追加本地浏览/读写断言）

**Interfaces:**
- Consumes: `localFs`、`resolveInLocalWorkspace`（Task 1）；`clearLocalEnvInfo`（Task 8 才定义，本任务 WS 里先不调用，或改为 `import` 兜底 —— 见 Step 2 说明）
- Produces: WS 消息类型 `list_local_dir`/`read_local_file`/`write_local_file`/`create_local_dir`/`local_delete`/`local_copy`/`set_local_workspace`；回复类型 `local_dir_list`/`local_file_content`/`local_file_saved`/`local_dir_created`/`local_deleted`/`local_copied`/`local_workspace`；进度事件 `local_delete_progress`；status 事件新增字段 `localWorkspace`

- [ ] **Step 1: 在 `server/ws.js` 顶部 import 并改造 `emitStatus`**

```js
import { localFs } from './local-fs.js';
```

`emitStatus`（约 53-61 行）在 `workspace: ssh.workspace,` 后追加：

```js
    localWorkspace: localFs.workspace,
```

- [ ] **Step 2: 在 `ws.on('message')` 的 switch 里加本地 case**

插在现有 `case 'list_dir':` 之前（本地 case 与远程 case 同结构，仅换 `localFs`）。`set_local_workspace` 里暂时不调用 `clearLocalEnvInfo`（该函数 Task 8 才加），改为直接 `emitStatus()`：

```js
          case 'list_local_dir': {
            const entries = await localFs.listDir(msg.path || localFs.workspace || localFs.home || '.');
            reply({ type: 'local_dir_list', path: msg.path || localFs.workspace || localFs.home || '.', entries });
            break;
          }
          case 'read_local_file': {
            const { buffer, size, truncated } = await localFs.readFileChunk(msg.path, { maxBytes: msg.maxBytes });
            if (localFs.isProbablyBinary(buffer)) reply({ type: 'local_file_content', path: msg.path, binary: true, size, truncated });
            else reply({ type: 'local_file_content', path: msg.path, content: buffer.toString('utf8'), size, truncated });
            break;
          }
          case 'write_local_file': {
            const bytes = await localFs.writeFile(msg.path, msg.content);
            reply({ type: 'local_file_saved', path: msg.path, size: bytes });
            break;
          }
          case 'create_local_dir': {
            await localFs.mkdirp(msg.path);
            reply({ type: 'local_dir_created', path: msg.path });
            break;
          }
          case 'local_delete': {
            const type = await localFs.atype(msg.path);
            if (!type) throw new Error(`路径不存在: ${msg.path}`);
            let done = 0, lastEmit = 0;
            const onProgress = (p) => { done++; const now = Date.now(); if (now - lastEmit >= 120) { lastEmit = now; send({ type: 'local_delete_progress', reqId, path: msg.path, done, current: p }); } };
            await localFs.rmdirRecursive(msg.path, onProgress);
            send({ type: 'local_delete_progress', reqId, path: msg.path, done, final: true, current: msg.path });
            reply({ type: 'local_deleted', path: msg.path });
            break;
          }
          case 'local_copy': {
            if (!msg.src || !msg.dst) throw new Error('缺少 src 或 dst');
            const r = await localFs.copyPath(msg.src, msg.dst, { overwrite: msg.overwrite });
            reply({ type: 'local_copied', ...r });
            break;
          }
          case 'set_local_workspace': {
            const st = await localFs.stat(msg.path);
            if (!st) throw new Error(`目录不存在: ${msg.path}`);
            if (!st.isDirectory()) throw new Error(`不是目录: ${msg.path}`);
            localFs.workspace = msg.path;
            reply({ type: 'local_workspace', path: msg.path });
            emitStatus();
            break;
          }
```

- [ ] **Step 3: 扩展 `test/e2e.js` 加本地浏览/读写断言**

在 e2e 主函数里，`// 6.7 删除` 之前插入一段（本地操作不需要 SSH，直接在宿主机临时目录上验证）：

```js
  // 6.65 本地文件浏览/读写/工作区(服务端 fs 直读写,无需 SSH)
  console.log('== 测试本地文件操作 ==');
  {
    const lws = path.join(ROOT, 'localws');
    fs.mkdtempSync  // 注意:ROOT 已由 makeFixture 建好,这里手动建子目录
    // (补一行) fs 已有 mkdtempSync/writeFileSync;直接 mkdir + 写文件
    // —— 此处按 e2e 顶部已解构的 fs 对象,用 writeFileSync/mkdirSync
    const { mkdirSync } = await import('node:fs');
    mkdirSync(path.join(lws, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(lws, 'hello.txt'), 'local-e2e');
    await ws.request('set_local_workspace', { path: lws });
    const ll = await ws.request('list_local_dir', { path: lws });
    check('本地列目录返回条目', ll.entries && ll.entries.some((e) => e.name === 'hello.txt' && e.type === 'file'), JSON.stringify(ll.entries));
    const lr = await ws.request('read_local_file', { path: path.join(lws, 'hello.txt') });
    check('本地读文件内容正确', lr.content === 'local-e2e', lr.content);
    await ws.request('write_local_file', { path: path.join(lws, 'out.txt'), content: 'from-e2e' });
    const lr2 = await ws.request('read_local_file', { path: path.join(lws, 'out.txt') });
    check('本地写后回读成功', lr2.content === 'from-e2e', lr2.content);
    await ws.request('local_delete', { path: path.join(lws, 'out.txt') });
    check('本地删除生效', !fs.existsSync(path.join(lws, 'out.txt')));
  }
```

> 注意：e2e 顶部已 `import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'` 并解构进 `fs` 对象，但没有 `mkdirSync`。Step 3 里用动态 `import('node:fs')` 取 `mkdirSync`，避免改动顶部解构。

- [ ] **Step 4: 跑 e2e 确认通过**

Run: `node test/e2e.js`
Expected: PASS（新增的本地断言全 `✓`，且原有断言不回归）

- [ ] **Step 5: Commit**

```bash
git add server/ws.js test/e2e.js
git commit -m "feat: WS 新增本地浏览/读写/工作区选择 case"
```

---

### Task 4: 前端本地文件面板 + 工作区选择 + Tab 组织

**Files:**
- Create: `web/src/components/LocalFileManager.tsx`
- Create: `web/src/components/LocalDirBrowser.tsx`
- Modify: `web/src/components/WorkspacePanel.tsx`
- Modify: `web/src/App.tsx`（本地工作区状态 + cwd 双向共享 + status 类型）
- Modify: `web/src/types.ts`（`ServerStatus` 加 `localWorkspace: string | null`）
- Modify: `web/src/styles.scss`（`.fm-tabs` / `.fm-tab` 样式）

**Interfaces:**
- Consumes: WS `list_local_dir`/`read_local_file`/`write_local_file`/`create_local_dir`/`local_delete`/`local_copy`/`set_local_workspace`（Task 3）
- Produces:
  - `<LocalFileManager workspace home remoteCwd onCwdChange onOpenLocalFile />`（`remoteCwd` = 远程面板当前目录，用于「传到远程」）
  - `<LocalDirBrowser initial home onClose onPick />`（`onPick(path)` 回调设置本地工作区）
  - `<WorkspacePanel ... localWorkspace onSetLocalWorkspace />` 新 props

- [ ] **Step 1: 改 `web/src/types.ts`**

`ServerStatus` 接口加一行（在 `workspace` 后）：

```ts
  localWorkspace: string | null;
```

- [ ] **Step 2: 创建 `web/src/components/LocalDirBrowser.tsx`**

镜像 `DirBrowser.tsx`，只改三点：标题「选择本地工作区」、数据源 `api.request('list_local_dir', ...)`、底部按钮文案「以此目录为本地工作区」。完整代码：

```tsx
// 本地目录浏览弹窗:用于选择本地工作区(镜像 DirBrowser,数据源走 list_local_dir)
import React, { useState } from 'react';
import { api } from '../api';
import type { DirEntry } from '../types';

interface LocalDirBrowserProps {
  initial?: string;
  home?: string | null;
  onClose: () => void;
  onPick: (path: string) => void;
}

export default function LocalDirBrowser({ initial, home, onClose, onPick }: LocalDirBrowserProps) {
  const [path, setPath] = useState(initial || home || '.');
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = async (p: string) => {
    setLoadingPath(p); setError('');
    try {
      const r = await api.request('list_local_dir', { path: p }, 20000);
      setPath(p); setEntries(r.entries || []);
    } catch (e) { setError((e as Error).message); }
    finally { setLoadingPath(null); }
  };

  const mounted = React.useRef(false);
  React.useEffect(() => {
    if (mounted.current) return;
    mounted.current = true;
    load(path);
  }, []);

  const up = () => { if (path !== path.slice(0, path.lastIndexOf('\\') || path.lastIndexOf('/') || 0)) load(upDir(path)); };
  const upDir = (p: string) => {
    const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
    return i <= 0 ? p : p.slice(0, i);
  };
  const dir = (name: string) => (path.endsWith('\\') || path.endsWith('/') || path === '' ? path + name : path + (path.includes('\\') ? '\\' : '/') + name);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><span>选择本地工作区</span><button className="ghost" onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <div className="row gap">
            <button className="ghost" onClick={up} disabled={path === upDir(path) || path === ''}>⬆ 上级</button>
            <input className="grow" value={path} onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') load(path); }} />
            <button onClick={() => load(path)} disabled={loadingPath !== null}>{loadingPath === path ? '…' : '跳转'}</button>
          </div>
          {home && <button className="link" onClick={() => load(home)}>🏠 家目录 {home}</button>}
          {error && <div className="error">✕ {error}</div>}
          <div className="dirlist">
            {!loadingPath && entries.length === 0 && <div className="muted">(空目录)</div>}
            {entries.filter((e) => e.type === 'dir').map((e) => {
              const fp = dir(e.name);
              return (
                <div key={e.name} className="dirlink"
                  onMouseDown={(ev) => { if (ev.detail > 1) ev.preventDefault(); }}
                  onDoubleClick={() => load(fp)}>
                  <span>📁 {e.name}</span>
                  {loadingPath === fp && <span className="spinner-inline" />}
                </div>
              );
            })}
            {entries.filter((e) => e.type !== 'dir').slice(0, 50).map((e) => (
              <div key={e.name} className="dirlink muted2 disabled">📄 {e.name}</div>
            ))}
          </div>
        </div>
        <div className="modal-foot"><button className="primary grow" onClick={() => onPick(path)}>以此目录为本地工作区</button></div>
      </div>
    </div>
  );
}
```

> 注意本地路径分隔符可能是 `\`（Windows）或 `/`（POSIX），`upDir`/`dir` 用「取最后出现的任一分隔符」处理，简单且跨平台。

- [ ] **Step 3: 创建 `web/src/components/LocalFileManager.tsx`**

以 `FileManager.tsx` 为模板复制后做以下替换（逐项）：

1. `api.request('list_dir', ...)` → `api.request('list_local_dir', ...)`（在 `load` 里）。
2. 路径拼接 helper `entryPath(name)` 改为本地风格：`path === '/' ? ...` 改为用 `sep`（`path.includes('\\') ? '\\' : '/'`）拼接；`norm()` 去除尾部 `/` 与 `\`。
3. 顶部工具栏 `home` 按钮、`up` 按钮用本地根判断（`path !== 根`）。
4. 打开文件回调改名为 `onOpenLocalFile`，本地文件内容用 `api.request('read_local_file')` 读取（FileViewer 已支持通用 file_content，但本地需新增本地读取入口 —— 本任务先复用 `onOpenLocalFile` 直接走 FileViewer，读文件逻辑在 FileViewer 里按「local:」前缀分流，见 Step 4 说明）。
5. 加一个「传到远程当前目录」按钮，点击对选中项调用 `api.request('local_to_remote', { paths: opPaths, dir: remoteCwd }, ...)`（`local_to_remote` 在 Task 5 才实现，本任务按钮先 `disabled` + 提示「传输通道待接入」，或直接占位调用并在 catch 里显示错误）。
6. 保留现有上传/下载按钮，但下载按钮改为「传到本地当前目录」（`remote_to_local`，Task 5 接入，本任务占位）。
7. 顶部标题由「远程文件」改为「本地文件」。

由于本组件体量大，关键差异以「复制 FileManager 后逐点替换」方式落地；组件签名：

```tsx
interface LocalFileManagerProps {
  workspace?: string | null;
  home?: string | null;
  remoteCwd?: string;               // 远程面板当前目录(传到远程的目标)
  onCwdChange?: (p: string) => void; // 当前目录变化时上报
  onOpenLocalFile: (path: string) => void;
}
export default function LocalFileManager({ workspace, home, remoteCwd, onCwdChange, onOpenLocalFile }: LocalFileManagerProps) { ... }
```

`load` 成功时额外调用 `onCwdChange?.(target)`。

- [ ] **Step 4: 改 `web/src/components/FileManager.tsx` 加「传到本地」+ `onCwdChange`**

在 `FileManagerProps` 加两个字段并接住：

```tsx
interface FileManagerProps {
  workspace?: string | null;
  home?: string | null;
  localCwd?: string;                 // 本地面板当前目录(传到本地的目标)
  onCwdChange?: (p: string) => void;
  onOpenFile: (path: string) => void;
}
```

在 `load` 成功后 `onCwdChange?.(target)`；工具栏加按钮：

```tsx
<button className="ghost sm" disabled={opCount === 0 || !localCwd}
  onClick={() => { api.request('remote_to_local', { paths: opPaths, dir: localCwd }, 600000).then(() => flash('⬇ 已传到本地当前目录')).catch((e) => setError((e as Error).message)); }}
  title="把选中项传到本地当前目录">⬇ 传到本地</button>
```

（`remote_to_local` 在 Task 5 接入；本任务按钮可先保留但调用会得到「未知消息类型」错误，属可接受的中间态，Task 5 完成后自然可用。）

- [ ] **Step 5: 改 `web/src/components/WorkspacePanel.tsx` 组织本地/远程 Tab**

```tsx
import React, { useState } from 'react';
import FileManager from './FileManager';
import LocalFileManager from './LocalFileManager';
import LocalDirBrowser from './LocalDirBrowser';

interface WorkspacePanelProps {
  connected: boolean;
  workspace: string | null;
  home: string | null;
  localWorkspace: string | null;
  localHome: string | null;
  localCwd: string;
  remoteCwd: string;
  onLocalCwdChange: (p: string) => void;
  onRemoteCwdChange: (p: string) => void;
  onSetLocalWorkspace: (p: string) => void;
  onOpenFile: (path: string) => void;
  onOpenLocalFile: (path: string) => void;
}

export default function WorkspacePanel(props: WorkspacePanelProps) {
  const [tab, setTab] = useState<'local' | 'remote'>('remote');
  const [pickLocal, setPickLocal] = useState(false);
  return (
    <div className="panel">
      <div className="panel-title row">
        <button className={`fm-tab ${tab === 'remote' ? 'on' : ''}`} onClick={() => setTab('remote')}>远程文件</button>
        <button className={`fm-tab ${tab === 'local' ? 'on' : ''}`} onClick={() => setTab('local')}>本地文件</button>
        <span className="grow" />
        {tab === 'local' && <button className="ghost sm" onClick={() => setPickLocal(true)}>选择本地工作区</button>}
      </div>
      {tab === 'remote' ? (
        !props.connected ? <div className="muted">连接服务器后即可浏览远程目录</div>
        : <FileManager workspace={props.workspace} home={props.home} localCwd={props.localCwd} onCwdChange={props.onRemoteCwdChange} onOpenFile={props.onOpenFile} />
      ) : (
        !props.localWorkspace ? (
          <div className="muted">尚未选择本地工作区。<button className="link" onClick={() => setPickLocal(true)}>现在选择</button></div>
        ) : (
          <LocalFileManager workspace={props.localWorkspace} home={props.localHome} remoteCwd={props.remoteCwd} onCwdChange={props.onLocalCwdChange} onOpenLocalFile={props.onOpenLocalFile} />
        )
      )}
      {pickLocal && <LocalDirBrowser home={props.localHome} onClose={() => setPickLocal(false)} onPick={(p) => { props.onSetLocalWorkspace(p); setPickLocal(false); }} />}
    </div>
  );
}
```

- [ ] **Step 6: 改 `web/src/App.tsx` 接线本地状态**

新增状态与处理器，并把 props 传给 `WorkspacePanel`：

```tsx
  const [localCwd, setLocalCwd] = useState('');   // 本地面板当前目录
  const [remoteCwd, setRemoteCwd] = useState(''); // 远程面板当前目录
  const handleOpenLocalFile = (path: string) => {
    const name = path.split(/[\\/]/).filter(Boolean).pop() || path;
    setViewer({ path: `local:${path}`, name });   // 本地文件用 local: 前缀区分
  };
  const onSetLocalWorkspace = (p: string) => api.request('set_local_workspace', { path: p }, 20000).then(() => setStatus((s) => ({ ...s, localWorkspace: p }))).catch(() => {});
```

`WorkspacePanel` 调用处（约 185-190 行）改为传入新 props：

```tsx
          <WorkspacePanel
            connected={connected}
            workspace={status.workspace}
            home={status.home}
            localWorkspace={status.localWorkspace}
            localHome={localHome}              // localHome 见下
            localCwd={localCwd}
            remoteCwd={remoteCwd}
            onLocalCwdChange={setLocalCwd}
            onRemoteCwdChange={setRemoteCwd}
            onSetLocalWorkspace={onSetLocalWorkspace}
            onOpenFile={handleOpenFile}
            onOpenLocalFile={handleOpenLocalFile}
          />
```

`localHome`：在 App 顶部加常量（浏览器拿不到真实家目录，用一个默认起点）：

```tsx
  const localHome = '~';
```

（本地面板首次浏览默认从 `localWorkspace` 起步；`localHome` 仅作为回退显示，`list_local_dir` 缺省 path 时服务端回退 `localFs.home`，见 Task 3。）

- [ ] **Step 7: FileViewer 本地读取分流**

`web/src/components/FileViewer.tsx` 里读文件处，判断 `path.startsWith('local:')`：

```tsx
  const isLocal = viewer.path.startsWith('local:');
  const realPath = isLocal ? viewer.path.slice('local:'.length) : viewer.path;
  // 读文件:
  const r = isLocal ? await api.request('read_local_file', { path: realPath, maxBytes: ... })
                    : await api.request('read_file', { path: realPath, maxBytes: ... });
  // 保存:
  if (isLocal) await api.request('write_local_file', { path: realPath, content });
  else await api.request('write_file', { path: realPath, content });
```

（若 FileViewer 当前实现差异较大，以「在读取/保存两处按 `isLocal` 分支」为准，其余 UI 不变。）

- [ ] **Step 8: `web/src/styles.scss` 加 Tab 样式**

```scss
.fm-tab { border: 1px solid transparent; background: transparent; padding: 2px 10px; border-radius: 6px; cursor: pointer; font-size: 13px; color: var(--muted, #888); }
.fm-tab.on { color: var(--fg, #e6e6e6); background: var(--panel2, #26262b); border-color: var(--border, #3a3a40); }
```

- [ ] **Step 9: 跑 typecheck + 构建确认**

Run: `npm run typecheck` 与 `npm run build`
Expected: 无 TS 错误、构建成功

- [ ] **Step 10: Commit**

```bash
git add web/src/components/LocalFileManager.tsx web/src/components/LocalDirBrowser.tsx web/src/components/WorkspacePanel.tsx web/src/components/FileManager.tsx web/src/components/FileViewer.tsx web/src/App.tsx web/src/types.ts web/src/styles.scss
git commit -m "feat: 前端本地文件面板 + 本地工作区选择 + 本地/远程 Tab"
```

---

### Task 5: 双向传输 `server/transfer.js` + WS case

**Files:**
- Create: `server/transfer.js`
- Modify: `server/ws.js`（加 `local_to_remote` / `remote_to_local` case）
- Test: `test/transfer.test.js`

**Interfaces:**
- Consumes: `localFs`（Task 1）、`sshManager as ssh`（`listDir`/`readFileChunk`/`writeRemoteFile`/`mkdirp`/`stat`/`atype`）、`normalizeRemote`/`joinRemote`（ssh-manager）
- Produces:
  - `localToRemote(paths, remoteDir, {onProgress})` → `{uploaded, failed, bytes, errors}`
  - `remoteToLocal(paths, localDir, {onProgress})` → `{downloaded, failed, bytes, errors}`
  - WS 消息 `local_to_remote`/`remote_to_local` → 回复 `transfer_done`，进度事件 `transfer_progress`

- [ ] **Step 1: 写失败测试 `test/transfer.test.js`**

用临时目录模拟「本机 fs」与「远程（fake ssh）」双向搬移：

```js
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const { localFs } = await import('../server/local-fs.js');
const { sshManager: ssh } = await import('../server/ssh-manager.js');
const { localToRemote, remoteToLocal } = await import('../server/transfer.js');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) pass++; else fail++; console.log(`  ${c ? '✓' : '✗'} ${n} ${e}`); };

const root = mkdtempSync(path.join(tmpdir(), 'sshai-xfer-'));
const localDir = path.join(root, 'local'); mkdirSync(localDir, { recursive: true });
writeFileSync(path.join(localDir, 'a.txt'), 'AAA');
mkdirSync(path.join(localDir, 'sub'), { recursive: true });
writeFileSync(path.join(localDir, 'sub', 'b.txt'), 'BBB');

// fake 远程:用一个内存对象记录写入(不真连 SSH)
const remoteFs = new Map();
ssh.writeRemoteFile = async (p, buf) => { remoteFs.set(p, Buffer.from(buf).toString('utf8')); return Buffer.from(buf).length; };
ssh.mkdirp = async () => {};
ssh.listDir = async (p) => [{ name: 'x.txt', type: 'file', size: 3 }];
ssh.readFileChunk = async (p) => ({ buffer: Buffer.from('XYZ'), size: 3, truncated: false });
ssh.atype = async (p) => 'file';
ssh.stat = async (p) => ({ isDirectory: () => false, size: 3 });

// local -> remote
const r1 = await localToRemote([path.join(localDir, 'a.txt'), path.join(localDir, 'sub')], '/rem', { onProgress: () => {} });
check('localToRemote 单文件+目录均上传', r1.uploaded === 2 && remoteFs.has('/rem/a.txt') && remoteFs.has('/rem/sub/b.txt'), JSON.stringify([...remoteFs.keys()]));
check('localToRemote 内容正确', remoteFs.get('/rem/a.txt') === 'AAA' && remoteFs.get('/rem/sub/b.txt') === 'BBB');

// remote -> local
const r2 = await remoteToLocal(['/x/x.txt'], path.join(root, 'dl'), { onProgress: () => {} });
check('remoteToLocal 下载写入本地', r2.downloaded === 1 && readFileSync(path.join(root, 'dl', 'x.txt'), 'utf8') === 'XYZ', JSON.stringify(r2));

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
if (fail) process.exit(1);
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/transfer.test.js`
Expected: FAIL（`Cannot find module '../server/transfer.js'`）

- [ ] **Step 3: 实现 `server/transfer.js`**

```js
// 本地↔远程双向传输:复用 local-fs 与 ssh-manager,带逐项进度回调。
import path from 'node:path';
import { localFs } from './local-fs.js';
import { sshManager as ssh, normalizeRemote, joinRemote } from './ssh-manager.js';

// 递归枚举本地路径 -> [{rel, abs, type, size}]
async function collectLocalPaths(roots, baseDir) {
  const out = [];
  const walk = async (dir, rel) => {
    for (const e of await localFs.listDir(dir)) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.type === 'dir') { out.push({ rel: relPath + '/', abs, type: 'dir', size: 0 }); await walk(abs, relPath); }
      else out.push({ rel: relPath, abs, type: 'file', size: e.size || 0 });
    }
  };
  for (const root of roots) {
    const abs = path.resolve(root);
    const type = await localFs.atype(abs);
    if (!type) continue;
    const rel = path.basename(abs);
    if (type === 'dir') { out.push({ rel: rel + '/', abs, type: 'dir', size: 0 }); await walk(abs, rel); }
    else out.push({ rel, abs, type: 'file', size: (await localFs.stat(abs))?.size || 0 });
  }
  return out;
}

// 本地 -> 远程
export async function localToRemote(paths, remoteDir, { onProgress } = {}) {
  const base = normalizeRemote(remoteDir || ssh.workspace || '');
  if (!base) throw new Error('请先选择远程工作区或指定目标目录');
  const entries = await collectLocalPaths(paths);
  // 为每个文件预建其远程父目录(去重后按深度从小到大排,避免逐文件重复探测)
  const parentDirs = new Set();
  for (const e of entries) {
    if (e.type === 'file') {
      const target = joinRemote(base, e.rel);
      parentDirs.add(target.slice(0, target.lastIndexOf('/')) || '/');
    }
  }
  for (const d of [...parentDirs].sort((a, b) => a.split('/').length - b.split('/').length)) await ssh.mkdirp(d);
  let uploaded = 0, bytes = 0; const errors = [];
  const total = entries.filter((e) => e.type === 'file').length;
  for (const e of entries) {
    if (e.type === 'dir') continue;
    const target = joinRemote(base, e.rel);
    try {
      const buf = (await localFs.readFileChunk(e.abs, { maxBytes: 0 })).buffer;
      await ssh.writeRemoteFile(target, buf, { maxBytes: 0, mkdir: false });
      uploaded++; bytes += buf.length;
    } catch (err) { errors.push(`${e.rel}: ${err.message}`); }
    onProgress?.({ done: uploaded, total, current: e.rel });
  }
  return { uploaded, failed: errors.length, bytes, errors: errors.slice(0, 20) };
}

// 远程 -> 本地
export async function remoteToLocal(paths, localDir, { onProgress } = {}) {
  const base = path.resolve(localDir || localFs.workspace || '.');
  await localFs.mkdirp(base);
  let downloaded = 0, bytes = 0; const errors = [];
  const walkRemote = async (remotePath, rel) => {
    const type = await ssh.atype(remotePath);
    if (!type) { errors.push(`${remotePath}: 不存在`); return; }
    if (type === 'dir') {
      const target = path.join(base, rel);
      await localFs.mkdirp(target);
      const list = await ssh.listDir(remotePath);
      for (const e of list) await walkRemote(joinRemote(remotePath, e.name), path.join(rel, e.name));
    } else {
      const { buffer } = await ssh.readFileChunk(remotePath, { maxBytes: 0 });
      const target = path.join(base, rel);
      await localFs.writeFile(target, buffer, { maxBytes: 0 });
      downloaded++; bytes += buffer.length;
      onProgress?.({ done: downloaded, total: 1, current: rel });
    }
  };
  for (const p of paths) {
    const name = normalizeRemote(p).split('/').filter(Boolean).pop() || 'item';
    await walkRemote(normalizeRemote(p), name);
  }
  return { downloaded, failed: errors.length, bytes, errors: errors.slice(0, 20) };
}
```

> 说明：`remoteToLocal` 的 `total` 在递归下难以预知，进度事件用 `done` 累加 + `total:1`（前端据此显示「已下载 N 项」而非百分比）；`localToRemote` 预枚举后 `total` 已知，走百分比。两者都有 `errors` 汇总，命名冲突（同名覆盖/跳过）在 Task 6 前端做。

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/transfer.test.js`
Expected: PASS

- [ ] **Step 5: 在 `server/ws.js` 加传输 case**

在 `case 'local_copy':` 后追加：

```js
          case 'local_to_remote': {
            const paths = (Array.isArray(msg.paths) ? msg.paths : [msg.paths]).filter(Boolean);
            if (!paths.length) throw new Error('缺少本地路径');
            const r = await localToRemote(paths, msg.dir, {
              onProgress: (p) => send({ type: 'transfer_progress', reqId, ...p })
            });
            reply({ type: 'transfer_done', ...r });
            break;
          }
          case 'remote_to_local': {
            const paths = (Array.isArray(msg.paths) ? msg.paths : [msg.paths]).filter(Boolean);
            if (!paths.length) throw new Error('缺少远程路径');
            const r = await remoteToLocal(paths, msg.dir, {
              onProgress: (p) => send({ type: 'transfer_progress', reqId, ...p })
            });
            reply({ type: 'transfer_done', ...r });
            break;
          }
```

顶部 import 加 `import { localToRemote, remoteToLocal } from './transfer.js';`

- [ ] **Step 6: Commit**

```bash
git add server/transfer.js server/ws.js test/transfer.test.js
git commit -m "feat: 本地↔远程双向传输(transfer + WS case + 进度事件)"
```

---

### Task 6: 前端传输按钮接通 + 进度/冲突 UI

**Files:**
- Modify: `web/src/components/FileManager.tsx`（「传到本地」真正调 `remote_to_local` + 进度）
- Modify: `web/src/components/LocalFileManager.tsx`（「传到远程」调 `local_to_remote` + 进度）

**Interfaces:**
- Consumes: WS `local_to_remote`/`remote_to_local` + `transfer_progress` 事件（Task 5）

- [ ] **Step 1: FileManager「传到本地」接入进度**

订阅 `transfer_progress` 事件，复用现有 `wrState` 进度条；`doLocalTransfer` 函数：

```tsx
  const doLocalTransfer = async () => {
    if (opCount === 0 || !localCwd) return;
    setWrState(null); setError('');
    try {
      const r = await api.request('remote_to_local', { paths: opPaths, dir: localCwd }, 600000, 'transfer_done');
      refresh();
      if (r.failed > 0) setError(`⬇ 已传 ${r.downloaded} 项,${r.failed} 项失败: ${(r.errors || []).slice(0, 5).join('; ')}`);
      else flash(`⬇ 已传到本地 ${localCwd}(共 ${r.downloaded} 项)`);
    } catch (e) { setError((e as Error).message); }
    finally { setWrState(null); }
  };
```

（`transfer_progress` 进度事件：在 FileManager 里已有 `api.on('delete_progress')` 订阅，再并列加一个 `api.on('transfer_progress', m => setWrState({ done: m.done, total: m.total }))`，进度条复用现有渲染。）

- [ ] **Step 2: LocalFileManager「传到远程」接入进度**

对称实现 `doRemoteTransfer`，调 `api.request('local_to_remote', { paths: opPaths, dir: remoteCwd }, 600000, 'transfer_done')`，订阅同一个 `transfer_progress` 事件。

- [ ] **Step 3: 冲突处理**

后端 `transfer.js` 目前同名直接覆盖（`writeRemoteFile` 默认覆盖 / 本地 `writeFile` 覆盖）。在本任务给两处按钮加「覆盖确认」：

```tsx
  if (!confirm(`将把 ${opCount} 项传到目标目录,同名文件将被覆盖。继续?`)) return;
```

（更细的「覆盖/跳过/改名」逐项策略留到后续，见 spec §7.3 的「默认询问」，此处 confirm 即满足。）

- [ ] **Step 4: 跑 typecheck + build**

Run: `npm run typecheck` 与 `npm run build`
Expected: 无错误

- [ ] **Step 5: Commit**

```bash
git add web/src/components/FileManager.tsx web/src/components/LocalFileManager.tsx
git commit -m "feat: 前端双向传输按钮接通 + 进度 + 覆盖确认"
```

---

### Task 7: Agent 本地工具集 + 守卫

**Files:**
- Modify: `server/agent/tools.js`（加本地工具 + `dangerGuard` 覆盖 `run_local_command` + 注册）
- Test: `test/agent-local.test.js`

**Interfaces:**
- Consumes: `localFs`、`resolveInLocalWorkspace`（Task 1）、`execLocal`（Task 2）
- Produces: 工具 `list_local_dir`/`read_local_file`/`write_local_file`/`edit_local_file`/`create_local_dir`/`delete_local_path`/`search_local_code`/`run_local_command`/`get_local_info`（注册进 registry）；`getLocalEnvInfo`/`clearLocalEnvInfo`（Task 8 用）

- [ ] **Step 1: 写失败测试 `test/agent-local.test.js`**

用假 LLM 驱动本地工具链（参考 `agent-history.test.js` 的 `makeFakeLlm`），断言本地工具被调用且结果正确：

```js
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sshai-al-'));
const { Agent } = await import('../server/agent/agent.js');
const { localFs } = await import('../server/local-fs.js');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) pass++; else fail++; console.log(`  ${c ? '✓' : '✗'} ${n} ${e}`); };

const root = mkdtempSync(path.join(tmpdir(), 'sshai-al-ws-'));
localFs.workspace = root;
writeFileSync(path.join(root, 'note.txt'), 'local content');

const agent = new Agent({ emit: () => {} });
let calls = 0;
agent.configureLlm({ baseUrl: 'http://x', apiKey: 'k', model: 'fake' });
agent.llm = {
  isMock: false,
  async chat({ messages, tools }) {
    calls++;
    if (calls === 1) return { content: '', toolCalls: [{ id: 'c1', name: 'read_local_file', arguments: JSON.stringify({ path: path.join(root, 'note.txt') }) }] };
    if (calls === 2) return { content: '', toolCalls: [{ id: 'c2', name: 'write_local_file', arguments: JSON.stringify({ path: 'out.txt', content: 'written' }) }] };
    return { content: '完成', toolCalls: [] };
  }
};
await agent.run('读本地文件再写一个');
check('本地工具链完成', calls === 3, `calls=${calls}`);
check('write_local_file 写入了工作区相对路径', require('node:fs').existsSync(path.join(root, 'out.txt')));

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
if (fail) process.exit(1);
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/agent-local.test.js`
Expected: FAIL（本地工具未注册，`read_local_file` 未知工具报错，最终 calls<3 或抛错）

- [ ] **Step 3: 在 `server/agent/tools.js` 加本地工具**

顶部 import 加：

```js
import { localFs, resolveInLocalWorkspace } from '../local-fs.js';
import { execLocal } from '../local-exec.js';
```

在 `toolDefs` 数组后新增 `localToolDefs`（与远程工具一一对应，读/列自由、写/改/删走 `resolveInLocalWorkspace`）：

```js
const localToolDefs = [
  {
    name: 'list_local_dir',
    description: '列出本机(本地工作区)目录内容,用于探索本机文件系统',
    parameters: { type: 'object', properties: { path: { type: 'string', description: '本机绝对路径,缺省为本地工作区' } }, required: [] },
    async run({ path }) {
      const p = path || localFs.workspace || localFs.home || '.';
      const entries = await localFs.listDir(p);
      const lines = entries.map((e) => `${e.type === 'dir' ? '[目录]' : e.type === 'link' ? '[链接]' : '      '} ${e.name}${e.type === 'file' ? ' ' + formatSize(e.size) : ''}`);
      return `目录 ${p} 共 ${entries.length} 项:\n${lines.join('\n') || '(空)'}`;
    }
  },
  {
    name: 'read_local_file',
    description: '读取本机文本文件指定片段(offset/maxBytes),二进制会报错',
    parameters: { type: 'object', properties: { path: { type: 'string', description: '本机绝对路径' }, offset: { type: 'integer' }, maxBytes: { type: 'integer' } }, required: ['path'] },
    async run({ path, offset = 0, maxBytes }) {
      const mb = Math.min(maxBytes || 30000, 100000);
      const { buffer, size, truncated } = await localFs.readFileChunk(path, { maxBytes: mb, offset });
      if (localFs.isProbablyBinary(buffer)) return `文件 ${path} 是二进制文件,已拒绝读取`;
      const snippet = buffer.toString('utf8');
      return `文件 ${path}(共 ${size} 字节${truncated ? `,本次读到 ${buffer.length} 字节` : ''}):\n${snippet}${truncated ? `\n…[如需继续用 offset=${offset + buffer.length} 读取]…` : ''}`;
    }
  },
  {
    name: 'write_local_file',
    description: '在本机本地工作区内创建或覆盖文本文件(自动建父目录)',
    parameters: { type: 'object', properties: { path: { type: 'string', description: '本机路径(本地工作区内,支持相对路径)' }, content: { type: 'string' } }, required: ['path', 'content'] },
    async run({ path: p, content }) {
      const abs = resolveInLocalWorkspace(p);
      if ((await localFs.atype(abs)) === 'dir') throw new Error('目标路径已存在且是目录');
      const bytes = await localFs.writeFile(abs, content);
      return `已写入 ${abs}(${bytes} 字节)`;
    }
  },
  {
    name: 'edit_local_file',
    description: '在本机文件里做精确文本替换(old_string -> new_string);默认只替换首次,多次需 replace_all=true',
    parameters: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['path', 'old_string', 'new_string'] },
    async run({ path: p, old_string, new_string, replace_all }) {
      const abs = resolveInLocalWorkspace(p);
      const { buffer, size } = await localFs.readFileChunk(abs, { maxBytes: 2 * 1024 * 1024 });
      if (size > buffer.length) throw new Error('文件超过 2MB,建议用 write_local_file 整体重写');
      const text = buffer.toString('utf8');
      const count = text.split(old_string).length - 1;
      if (count === 0) throw new Error(`未找到要替换的原文(在 ${abs} 中)。请用 read_local_file 先确认准确内容`);
      if (count > 1 && !replace_all) throw new Error(`"${old_string.slice(0, 60)}" 在文件中出现 ${count} 次,请设置 replace_all=true`);
      const next = replace_all ? text.split(old_string).join(new_string) : text.replace(old_string, new_string);
      const bytes = await localFs.writeFile(abs, next);
      return `已在 ${abs} 完成编辑:${replace_all ? `替换全部 ${count} 处` : '替换 1 处'}(${bytes} 字节)`;
    }
  },
  {
    name: 'create_local_dir',
    description: '在本机本地工作区内递归创建目录',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    async run({ path: p }) { const abs = resolveInLocalWorkspace(p); await localFs.mkdirp(abs); return `目录已就绪: ${abs}`; }
  },
  {
    name: 'delete_local_path',
    description: '删除本机本地工作区内的文件或目录(递归)。危险!绝不能删除本地工作区根目录',
    parameters: { type: 'object', properties: { path: { type: 'string' }, recursive: { type: 'boolean' } }, required: ['path'] },
    async run({ path: p, recursive }) {
      const abs = resolveInLocalWorkspace(p);
      if (abs === path.resolve(localFs.workspace)) throw new Error('禁止删除本地工作区根目录');
      const type = await localFs.atype(abs);
      if (!type) throw new Error(`路径不存在: ${abs}`);
      if (type === 'dir' && !recursive) throw new Error('是目录,如需删除请加 recursive=true');
      await localFs.rmdirRecursive(abs);
      return `已删除: ${abs}`;
    }
  },
  {
    name: 'search_local_code',
    description: '在本机目录中搜索文本/正则(优先 ripgrep,回退 findstr/grep)',
    parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, include: { type: 'string' } }, required: ['pattern'] },
    async run({ pattern, path: p, include }) {
      const base = p || localFs.workspace || localFs.home || '.';
      const isWin = process.platform === 'win32';
      const probeRg = await execLocal(isWin ? 'where rg' : 'command -v rg', { cwd: localFs.home });
      let cmd;
      if (probeRg.code === 0 && probeRg.stdout.trim()) {
        cmd = `rg -n --no-heading ${include ? `-g "${include}"` : ''} "${pattern.replace(/"/g, '\\"')}" "${base}"`;
      } else if (isWin) {
        cmd = `findstr /s /n /c:"${pattern}" "${base}\\*"`;
      } else {
        cmd = `grep -rn ${include ? `--include="${include}"` : ''} "${pattern.replace(/"/g, '\\"')}" "${base}"`;
      }
      const r = await execLocal(cmd, { cwd: localFs.home });
      if (r.code !== 0 && !r.stdout) return `无匹配(退出码 ${r.code})`;
      return capText(`匹配结果:\n${r.stdout}`);
    }
  },
  {
    name: 'run_local_command',
    description: '在本机执行 shell 命令(默认 cwd=本地工作区),返回 stdout/stderr 与退出码',
    parameters: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'integer' }, description: { type: 'string' } }, required: ['command', 'description'] },
    timeoutMs: 660_000,
    async run({ command, timeout, description }) {
      if (!command) throw new Error('命令为空');
      const res = await execLocal(command, { cwd: localFs.workspace || undefined, timeout: (timeout || 300) * 1000 });
      const parts = [`[退出码 ${res.code}${res.timedOut ? ' 超时' : ''}${res.signal ? `, 信号 ${res.signal}` : ''}]`];
      if (res.stdout.trim()) parts.push('--- stdout ---\n' + res.stdout);
      if (res.stderr.trim()) parts.push('--- stderr ---\n' + res.stderr);
      if (!res.stdout.trim() && !res.stderr.trim()) parts.push('(无输出)');
      return capText(parts.join('\n'));
    }
  },
  {
    name: 'get_local_info',
    description: '获取本地工作区与本机环境信息(平台、磁盘、工具版本),任务开始前建议先调用',
    parameters: { type: 'object', properties: {}, required: [] },
    async run() {
      const info = { workspace: localFs.workspace || null, platform: process.platform, home: localFs.home };
      const probe = async (cmd) => { try { const r = await execLocal(cmd, { cwd: localFs.home, timeout: 8000 }); return r.code === 0 && r.stdout.trim() ? r.stdout.trim().split('\n')[0] : null; } catch { return null; } };
      const [node, git] = await Promise.all([probe('node --version'), probe('git --version')]);
      info.toolVersions = { node, git };
      if (localFs.workspace) {
        try { info.tree = localTreeLines(localFs.workspace, 0); } catch {}
      }
      localEnvCache = { workspace: info.workspace, summary: safeJson(info) };
      return safeJson(info);
    }
  }
];
```

并在文件顶部加本地树与本地环境缓存（`DEPTH_LIMIT` 已存在，复用）：

```js
function localTreeLines(p, depth) {
  if (depth > DEPTH_LIMIT) return ['…(更深层略去)'];
  // listDir 是 async,树骨架用同步 fs.readdirSync(与远程 treeLines 用 listDirSync 同理)
  const { readdirSync } = fs; let names;
  try { names = readdirSync(p, { withFileTypes: true }); } catch { return ['(无法读取)']; }
  const out = [];
  for (const d of names) {
    if (d.isDirectory()) { out.push(`${d.name}/`); if (depth < DEPTH_LIMIT) out.push(...localTreeLines(path.join(p, d.name), depth + 1)); }
    else if (d.isFile()) out.push(d.name);
  }
  return out;
}
let localEnvCache = null;
export function getLocalEnvInfo() { return localEnvCache; }
export function clearLocalEnvInfo() { localEnvCache = null; }
```

（`fs`/`path` 已在 tools.js 顶部第 6-8 行 import（`fs`、`os`、`path`、`fileURLToPath`），无需新增。）

- [ ] **Step 4: 扩展 `dangerGuard` 与 `registerTools`**

`dangerGuard`（约 311 行）改为同时匹配 `run_command` 与 `run_local_command`：

```js
function dangerGuard(name, args) {
  if (name !== 'run_command' && name !== 'run_local_command') return undefined;
  ...
}
```

`registerTools`（约 323 行）注册本地工具：

```js
export function registerTools(registry) {
  for (const def of toolDefs) registry.register(def);
  for (const def of localToolDefs) registry.register(def);
  registry.guard(() => (ssh.connected ? undefined : 'SSH 连接已断开'));
  registry.guard(dangerGuard);
}
```

> 注意：现有守卫 `registry.guard(() => (ssh.connected ? undefined : 'SSH 连接已断开'))`（tools.js:457）是零参闭包，会**误伤本地工具**（本地工具不需要 SSH）。已核实 `registry.guard(fn)` 回调签名为 `(name, parsed)`（见 `server/agent/registry.js:90-94`，`reason = guard(name, parsed)`）。故守卫 1 必须改为按工具名区分：

```js
  // 守卫 1:仅远程工具需要 SSH 连接;本地工具无需连接
  const REMOTE_TOOLS = new Set(toolDefs.map((d) => d.name));
  registry.guard((name) => (REMOTE_TOOLS.has(name) && !ssh.connected ? 'SSH 连接已断开' : undefined));
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node test/agent-local.test.js` 与回归 `node test/agent-history.test.js`
Expected: PASS（本地工具链通过，且远程既有测试不回归）

- [ ] **Step 6: Commit**

```bash
git add server/agent/tools.js test/agent-local.test.js
git commit -m "feat: Agent 本地工具集(list/read/write/edit/del/search/run_command/get_info)+ 守卫区分本地/远程"
```

---

### Task 8: 双工作区 system prompt + 本地环境快照

**Files:**
- Modify: `server/agent/agent.js`（`_systemPrompt` 加本地工作区 + 本地快照注入）
- Modify: `server/ws.js`（`set_local_workspace` 调用 `clearLocalEnvInfo`）
- Test: 扩展 `test/agent-local.test.js`（断言 system prompt 含本地工作区）

**Interfaces:**
- Consumes: `localFs`（Task 1）、`getLocalEnvInfo`/`clearLocalEnvInfo`（Task 7）
- Produces: system prompt 含「本地工作区: X」与本地工具使用规则

- [ ] **Step 1: 在 `server/agent/agent.js` 顶部 import 并改 `_systemPrompt`**

```js
import { registerTools, getEnvInfo, getLocalEnvInfo, refreshSkillsCatalog, skillsCatalogStale, getSkillsCatalog, renderSkillCatalog, getSkillFull } from './tools.js';
import { localFs } from '../local-fs.js';
```

`_systemPrompt` 的 `lines` 数组（约 616-632 行）改为：

```js
    const lws = localFs.workspace || '(未设置,请提示用户在界面中选择本地工作区)';
    const lines = [
      '你是 AI 编程助手,可同时操作两台"工作区":远程 ssh 服务器与本机(本地)。',
      `远程平台: ${ssh.platform || '未知'}`,
      `远程工作区: ${ws}`,
      `本地平台: ${process.platform}`,
      `本地工作区: ${lws}`,
      '',
      '规则:',
      '1. 所有文件读写、命令执行都必须通过工具完成,严禁编造内容或输出;看不到的结果就再查。',
      '2. 操作**远程**文件/命令用原工具(read_file/write_file/run_command/...);操作**本机**文件/命令用 `*_local` 工具(read_local_file/write_local_file/run_local_command/...)。不要在本地工具里传远程路径,反之亦然。',
      '3. 命令默认在对应工作区目录下执行;若需切换目录,请在命令开头显式写 cd。',
      '4. 大文件用 read_file/read_local_file 的 offset/maxBytes 分片;修改文件优先 edit_file/edit_local_file 精确替换。',
      '5. 写/改/删仅限对应工作区内;绝不能删除工作区根目录;破坏性命令(rm -rf、drop table 等)必须三思。',
      '6. 重要:对话历史里已有的环境信息与目录结构可直接复用,不要重复探测;只有任务涉及变化时才重新调用。',
      '7. 回答使用用户的提问语言(默认中文)。',
      thinkingRule,
      '8. 任务规划:开始复杂多步任务前先用 todo_write 建计划,每完成一项立即标记 completed;简单单步任务可跳过。',
      '',
      '当用户指令不明确、或工作区缺乏必要信息时,主动调用工具检查,而不是猜测。'
    ];
```

> 注意：原第 7 条 thinkingRule 的编号改为 7 前的位置（保持 `thinkingRule` 作为一条规则插入）。此处 `thinkingRule` 变量保持原样（它本身以 `7. 输出格式` 起头，会有重复编号 7，改为用独立序号 `9.` 承载 thinkingRule 更稳妥 —— 见 Step 2 统一调整，确保 1-9 不重复）。

- [ ] **Step 2: 调整规则编号避免冲突**

将 `thinkingRule` 内嵌的「7. 输出格式」前缀改为「9. 输出格式」（`_systemPrompt` 里 `thinkingRule` 三处赋值字符串中的 `7.` 改为 `9.`），使最终规则 1-9 唯一。

- [ ] **Step 3: 注入本地环境快照**

在 `_systemPrompt` 末尾（现有 `getEnvInfo()` 注入块之后）追加：

```js
    const lenv = getLocalEnvInfo();
    if (lenv && lenv.workspace === localFs.workspace) {
      lines.push('', '已知本地环境信息(来自最近一次探测,若无变化直接使用,无需重复调用 get_local_info):');
      lines.push(lenv.summary);
    }
```

- [ ] **Step 4: `server/ws.js` 的 `set_local_workspace` 补 `clearLocalEnvInfo`**

把 Task 3 里 `set_local_workspace` case 的 `localFs.workspace = msg.path;` 后加一行 `clearLocalEnvInfo();`，顶部 import 加 `clearLocalEnvInfo`（来自 `./agent/tools.js`，与已有 `clearEnvInfo` 并列）。

- [ ] **Step 5: 扩展 `test/agent-local.test.js` 断言 system prompt**

在测试末尾追加：

```js
const sys = agent._systemPrompt();
check('system prompt 含本地工作区', sys.includes('本地工作区') && sys.includes(root), sys.slice(0, 200));
check('system prompt 含本地工具规则', sys.includes('run_local_command') || sys.includes('*_local'), '');
```

- [ ] **Step 6: 跑测试 + typecheck**

Run: `node test/agent-local.test.js` 与 `npm run typecheck`
Expected: PASS / 无错误

- [ ] **Step 7: Commit**

```bash
git add server/agent/agent.js server/ws.js test/agent-local.test.js
git commit -m "feat: 双工作区 system prompt + 本地环境快照注入"
```

---

## Track B — 技能边界统一

### Task 9: 修复技能门控（无 SSH 时也发现/加载技能）

**Files:**
- Modify: `server/agent/tools.js`（`getSkillsCatalog` / `skillsCatalogStale` / `loadSkillContent`）
- Test: `test/skills-catalog.test.js`

**Interfaces:**
- Consumes: 现有 `refreshSkillsCatalog` / `scanBuiltin` / `scanLocalSkillRoot`
- Produces: `getSkillsCatalog()` 在无 SSH/无工作区时仍返回内置+本机技能；`loadSkillContent(name)` 无 SSH 时能加载本地/内置技能正文

- [ ] **Step 1: 写失败测试 `test/skills-catalog.test.js`**

```js
// 技能目录门控修复:未连 SSH、未选远程工作区时,内置+本机技能仍可发现与加载
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sshai-sk-'));
// 在 import 前用本机技能根目录指向临时目录(避免污染真实 ~/.agents/skills)
process.env.LOCAL_USER_SKILLS = mkdtempSync(path.join(tmpdir(), 'sshai-lu-'));
writeFileSync(path.join(process.env.LOCAL_USER_SKILLS, 'my-local-skill.md'), '---\nname: my-local-skill\ndescription: 测试本地技能\n---\n\n# 正文\n这是本地技能指令。\n');
const { refreshSkillsCatalog, getSkillsCatalog } = await import('../server/agent/tools.js');
const { sshManager: ssh } = await import('../server/ssh-manager.js');
const { localFs } = await import('../server/local-fs.js');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) pass++; else fail++; console.log(`  ${c ? '✓' : '✗'} ${n} ${e}`); };

// 关键:无 SSH、无远程工作区
ssh.status = 'disconnected';
ssh.workspace = null;
ssh.home = null;
localFs.workspace = null;

const catalog = await refreshSkillsCatalog();
check('无 SSH 时目录含内置技能', catalog.some((s) => s.source === 'builtin'), '');
check('无 SSH 时目录含本机用户技能', catalog.some((s) => s.name === 'my-local-skill'), JSON.stringify(catalog.map((s) => s.name)));
const got = getSkillsCatalog();
check('getSkillsCatalog 无工作区不再返回空', got.length > 0, `len=${got.length}`);
check('getSkillsCatalog 含本机技能', got.some((s) => s.name === 'my-local-skill'));

// 加载正文(无 SSH)
const { loadSkillContent } = await import('../server/agent/tools.js');
// loadSkillContent 未导出,改为通过 skill 工具间接验证?—— 见 Step 3 说明;此处先测目录
console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
if (fail) process.exit(1);
```

> 说明：`loadSkillContent` 当前是模块私有函数（未 export）。Step 3 会把它 `export`，测试里 `const { loadSkillContent } = await import(...)` 即可直接断言其无 SSH 下返回正文。

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/skills-catalog.test.js`
Expected: FAIL（`getSkillsCatalog()` 返回空数组，`got.length > 0` 断言失败）

- [ ] **Step 3: 修 `server/agent/tools.js`**

把 `getSkillsCatalog` / `skillsCatalogStale` / `loadSkillContent` 改为复合键，并 export `loadSkillContent`：

```js
// 技能目录缓存 key:本地根(不变)+ 远程工作区 + 远程家目录 + 本地工作区
function skillContextKey() {
  return [ssh.workspace || '', ssh.home || '', localFs.workspace || ''].join('::');
}

export async function refreshSkillsCatalog() {
  const ws = ssh.workspace;
  const [builtin, localUser, localProject, localWorkspace] = await Promise.all([
    scanBuiltin(),
    scanLocalSkillRoot(LOCAL_USER_SKILLS, 'local-user'),
    scanLocalSkillRoot(LOCAL_PROJECT_SKILLS, 'local-project'),
    localFs.workspace ? scanLocalSkillRoot(path.join(localFs.workspace, '.agents', 'skills'), 'local-workspace') : Promise.resolve([])
  ]);
  let user = [], project = [];
  if (ws && ssh.connected && ssh.home) {
    try {
      [project, user] = await Promise.all([
        scanSkillRoot(`${ws.replace(/\/+$/, '')}/.agents/skills`, 'project'),
        scanSkillRoot(`${ssh.home.replace(/\/+$/, '')}/.agents/skills`, 'user')
      ]);
    } catch {}
  }
  const byName = new Map();
  for (const s of [...builtin, ...localUser, ...user, ...localProject, ...localWorkspace, ...project]) byName.set(s.name, s);
  skillsCache = { key: skillContextKey(), at: Date.now(), skills: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)) };
  return skillsCache.skills;
}

export function getSkillsCatalog() {
  if (skillsCache.key !== skillContextKey()) return [];
  return skillsCache.skills;
}

export function skillsCatalogStale() {
  return skillsCache.key !== skillContextKey() || Date.now() - skillsCache.at > SKILLS_TTL_MS;
}

export async function loadSkillContent(name) {
  let catalog = getSkillsCatalog();
  let hit = catalog.find((s) => s.name === name);
  if (!hit) { catalog = await refreshSkillsCatalog(); hit = catalog.find((s) => s.name === name); }
  if (!hit) return null;
  const r = await readSkillText(hit.file, SKILL_BODY_MAX_BYTES);
  if (!r) return null;
  const text = r.buffer.toString('utf8');
  const { body } = splitFrontmatter(text);
  return { name: hit.name, content: body.trim(), baseDir: hit.baseDir };
}
```

同时把 `skillsCache` 初始化改为 `let skillsCache = { key: null, at: 0, skills: [] };`（约 599 行）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/skills-catalog.test.js`
Expected: PASS

- [ ] **Step 5: 补 `loadSkillContent` 无 SSH 断言**

在 `test/skills-catalog.test.js` 末尾追加：

```js
const loaded = await loadSkillContent('my-local-skill');
check('无 SSH 时 loadSkillContent 加载本机技能正文', loaded && loaded.content.includes('这是本地技能指令'), JSON.stringify(loaded));
```

重跑 `node test/skills-catalog.test.js` 确认 PASS。

- [ ] **Step 6: Commit**

```bash
git add server/agent/tools.js test/skills-catalog.test.js
git commit -m "fix: 技能目录去掉 ssh.workspace 门控,无 SSH 也能发现/加载内置+本机技能"
```

---

### Task 10: 技能 `local-workspace` 来源 + 前端显示 + skill 工具回归

**Files:**
- Modify: `server/agent/tools.js`（`skillRoots` 加 `local-workspace` 根、`saveSkill`/`deleteSkill`/`copyBuiltinToRemote` 兼容新来源）
- Modify: `web/src/components/SkillsPanel.tsx`（来源标签 + target 选项加 `local-workspace`）
- Test: 扩展 `test/skills-catalog.test.js`（断言 `local-workspace` 来源被扫描 + 覆盖优先级）

**Interfaces:**
- Consumes: `localFs.workspace`（Task 1）、Task 9 的复合键缓存
- Produces: 技能来源 `local-workspace`（`<本地工作区>/.agents/skills`），前端可显示与选择

- [ ] **Step 1: `server/agent/tools.js` 的 `skillRoots()` 加本地工作区根**

在 `skillRoots()`（约 689 行）里，`local-project` 之后加：

```js
  if (localFs.workspace) roots.push({ root: path.join(localFs.workspace, '.agents', 'skills'), source: 'local-workspace', local: true });
```

优先级已在 Task 9 的 `refreshSkillsCatalog` 里体现（`localWorkspace` 排在 `localProject` 之后、`project` 之前）。`skillRoots` 用于 `saveSkill`/`deleteSkill` 的目标定位与越权校验，`isLocalSkillFile`/`skillFsPath` 对 `local://` 前缀的处理已覆盖新根（无需改）。`saveSkill` 的 `target` 允许值需加入 `local-workspace`（若前端传 `target:'local-workspace'`）。

- [ ] **Step 2: `web/src/components/SkillsPanel.tsx` 来源显示**

`SRC_LABEL`（约 22 行）加一行：

```tsx
  'local-workspace': '工作区·本机',
```

`counts.local`（约 95 行）与 `shown` 的 local 过滤（约 100 行）加 `local-workspace`：

```tsx
    local: skills.filter((s) => s.source === 'local-project' || s.source === 'local-user' || s.source === 'local-workspace').length,
    ...
    : filter === 'local' ? skills.filter((s) => s.source === 'local-project' || s.source === 'local-user' || s.source === 'local-workspace')
```

`SkillModal` 的保存位置下拉（约 254-259 行）加一个选项：

```tsx
                    { value: 'local-workspace', label: '工作区 · 本机 <本地工作区>/.agents/skills(需先选择本地工作区)' },
```

- [ ] **Step 3: 扩展 `test/skills-catalog.test.js` 断言 local-workspace 来源**

在测试里设 `localFs.workspace` 为一个临时目录并写一个技能文件，断言刷新后出现 `source === 'local-workspace'` 且优先级覆盖（与远程 project 同名时 project 胜、与 local-project 同名时 local-workspace 胜）：

```js
localFs.workspace = mkdtempSync(path.join(tmpdir(), 'sshai-lws-'));
mkdirSync(path.join(localFs.workspace, '.agents', 'skills'), { recursive: true });
writeFileSync(path.join(localFs.workspace, '.agents', 'skills', 'my-local-skill.md'), '---\nname: my-local-skill\ndescription: 本地工作区技能\n---\n\n# 正文\n工作区级指令。\n');
const catalog2 = await refreshSkillsCatalog();
const wsSkill = catalog2.find((s) => s.name === 'my-local-skill');
check('local-workspace 来源被扫描', wsSkill && wsSkill.source === 'local-workspace', JSON.stringify(wsSkill));
```

（同名 `my-local-skill` 原本在 `local-user`，现在 `local-workspace` 优先级更高，覆盖后 `source` 应为 `local-workspace` —— 同时验证了优先级。）

- [ ] **Step 4: 跑测试 + typecheck + build**

Run: `node test/skills-catalog.test.js`、`npm run typecheck`、`npm run build`
Expected: 全部通过

- [ ] **Step 5: 更新 `package.json` test script**

```json
    "test": "node test/agent-history.test.js && node test/compact.test.js && node test/local-fs.test.js && node test/local-exec.test.js && node test/transfer.test.js && node test/agent-local.test.js && node test/skills-catalog.test.js && node test/e2e.js"
```

- [ ] **Step 6: 全量跑测试**

Run: `npm test`
Expected: 全部脚本 PASS，退出码 0

- [ ] **Step 7: Commit**

```bash
git add server/agent/tools.js web/src/components/SkillsPanel.tsx test/skills-catalog.test.js package.json
git commit -m "feat: 技能新增 local-workspace 来源(与远程 project 对称)+ 前端显示"
```

---

## 自检清单（写完后自查）

- [ ] 每个 spec 要求（§5.1–§5.6、§6、§7、§8、§13.2–§13.4）都有对应 Task 覆盖。
- [ ] 无 TBD/TODO/占位符；每步含可执行代码或精确 diff。
- [ ] 类型/签名一致：`localFs` 方法、`resolveInLocalWorkspace`、`execLocal`、`localToRemote`/`remoteToLocal`、WS 消息名、工具名在前后任务一致。
- [ ] `registry.guard` 的真实签名（读 `server/agent/registry.js` 确认）在 Task 7 Step 4 使用前核实。
- [ ] `loadSkillContent` 已改为 export（Task 9），测试可直接 import。
