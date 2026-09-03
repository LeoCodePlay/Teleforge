// Agent 工具集:工具定义(name/description/parameters + run)+ 注册与守卫。
// 定义 的 ToolDefinition:模型可见字段(name/description/parameters)
// 与宿主执行细节(run/timeoutMs)分离,由 registry.schemas() 白名单投影进模型请求;
// 执行统一走 registry.execute() 管线(守卫 -> 超时 -> 结构化结果)。
import { AGENT } from '../config.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { joinRemote, normalizeRemote, sshManager as ssh } from '../core/ssh-manager.ts';
import { localFs, resolveInLocalWorkspace } from '../core/local-fs.ts';
import type { FsEntry } from '../core/local-fs.ts';
import { execLocal } from '../core/local-exec.ts';
import { askUserQuestion } from './ask-user.ts';
import { webSearch, renderSearchResult } from './web-search.ts';
import type { ToolDef, ToolRegistry } from './registry.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 内置技能库
const BUILTIN_SKILLS_DIR = process.env.BUILTIN_SKILLS_DIR || path.join(__dirname, '..', 'skills');
// 本机技能根目录(无需 SSH,随本机文件系统管理):
//   local-project:   工具运行目录(process.cwd())下的 .agents/skills   —— 随本机当前项目
//   local-user:      本机用户主目录下的 .agents/skills                 —— 跨项目共享,优先级高于内置
//   local-workspace: <本地工作区>/.agents/skills                       —— 随本地工作区,优先级高于本机项目级
const LOCAL_PROJECT_SKILLS = process.env.LOCAL_PROJECT_SKILLS || path.join(process.cwd(), '.agents', 'skills');
const LOCAL_USER_SKILLS = process.env.LOCAL_USER_SKILLS || path.join(os.homedir(), '.agents', 'skills');
const LOCAL_SKILL_PREFIX = 'local://';

// ---------------- 安全辅助 ----------------

// 将路径解析为工作区内的绝对远程路径;越界或不存在工作区时报错
function resolveInWorkspace(p: string, { allowRoot = true }: { allowRoot?: boolean } = {}) {
  const ws = normalizeRemote(ssh.workspace || '');
  if (!ws) throw new Error('尚未选择工作区,请先在界面中选择远程目录作为工作区');
  const norm = normalizeRemote(p || '.');
  const joined = norm === '/' ? ws : norm.startsWith(ws + '/') || norm === ws ? norm : joinRemote(ws, norm.replace(/^\.\.\/+/g, ''));
  // 重新计算相对路径(处理 ../ 越界)
  const parts = [];
  for (const seg of joined.split('/').filter(Boolean)) {
    if (seg === '.') continue;
    if (seg === '..') { if (parts.length > 1) parts.pop(); }
    else parts.push(seg);
  }
  const abs = '/' + parts.join('/');
  if (parts.length === 0 || abs === ws) return allowRoot ? ws : ws;
  if (abs === ws || abs.startsWith(ws + '/')) return abs;
  throw new Error(`路径超出工作区,被拒绝: ${p}`);
}

const TEXT_TRUNCATION_HINT = '\n[结果过长已截断:中段内容被省略。若需中段/尾部细节,可用 read_file(offset/limit) 或 run_command 缩小范围再取,不要重复相同调用]';
function capText(s: string, max: number = AGENT.TOOL_RESULT_MAX_CHARS): string {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, Math.floor(max * 0.6)) + `\n…[结果过长,已截断,剩余 ${s.length - max} 字符]…\n` + s.slice(s.length - Math.floor(max * 0.4)) + TEXT_TRUNCATION_HINT;
}

function safeJson(v: any): string { return JSON.stringify(v, null, 2).slice(0, 60000); }

function shQuotePosix(s: string): string { return `'${String(s).replace(/'/g, `'\\''`)}'`; }
function shQuoteWin(s: string): string { return `"${String(s).replace(/"/g, '\\"')}"`; }
function shQuote(s: string): string { return ssh.platform === 'win32' ? shQuoteWin(s) : shQuotePosix(s); }

// 深度可达目录数,避免探测目录结构时失控
const DEPTH_LIMIT = 4;

// 递归格式化目录树(限制深度,dir 后带 /),用于环境快照的目录骨架
function treeLines(p: string, depth: number): string[] {
  if (depth > DEPTH_LIMIT) return ['…(更深层略去)'];
  let entries;
  try {
    entries = (ssh as any).listDirSync ? (ssh as any).listDirSync(p) : null;
  } catch { return ['(无法读取)']; }
  if (!entries || entries.length === 0) return [];
  const out = [];
  for (const e of entries) {
    if (e.type === 'dir') {
      out.push(`${e.name}/`);
      if (depth < DEPTH_LIMIT) out.push(...treeLines(`${p}/${e.name}`, depth + 1));
    } else if (e.type === 'file') out.push(e.name);
  }
  return out;
}

// 递归格式化本地目录树(与 treeLines 同构,同步 fs 直读;本机环境快照用)
function localTreeLines(p: string, depth: number): string[] {
  if (depth > DEPTH_LIMIT) return ['…(更深层略去)'];
  let names;
  try { names = fs.readdirSync(p, { withFileTypes: true }); } catch { return ['(无法读取)']; }
  const out = [];
  for (const d of names) {
    if (d.isDirectory()) { out.push(`${d.name}/`); if (depth < DEPTH_LIMIT) out.push(...localTreeLines(path.join(p, d.name), depth + 1)); }
    else if (d.isFile()) out.push(d.name);
  }
  return out;
}

// 本地环境快照缓存(供 system prompt 注入,避免每轮重复 get_local_info 探测)
let localEnvCache: any = null;
export function getLocalEnvInfo() { return localEnvCache; }
export function clearLocalEnvInfo() { localEnvCache = null; }

// ---------------- 工具定义 ----------------
// 每个工具:name/description/parameters(模型可见)+ run(执行)+ timeoutMs(可选,注册表超时依据)

const toolDefs: ToolDef[] = [
  {
    name: 'list_directory',
    description: '列出远程目录内容(文件与子目录),用于探索文件系统',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '远程绝对路径,缺省为工作区' } },
      required: []
    },
    async run({ path }) {
      const p = normalizeRemote(path || ssh.workspace || '/');
      const entries = await ssh.listDir(p);
      const lines = entries.map((e: FsEntry) => {
        const icon = e.type === 'dir' ? '[目录]' : e.type === 'link' ? '[链接]' : '      ';
        const size = e.type === 'file' ? ` ${formatSize(e.size)}` : '';
        return `${icon} ${e.name}${size}`;
      });
      return `目录 ${p} 共 ${entries.length} 项:\n${lines.join('\n') || '(空)'}`;
    }
  },

  {
    name: 'read_file',
    description: '读取远程文本文件的指定片段(offset/maxBytes),二进制文件会报错',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '远程绝对路径' },
        offset: { type: 'integer', description: '起始字节偏移,单位字节' },
        maxBytes: { type: 'integer', description: '最多读取字节数,默认 30000,最大 100000' }
      },
      required: ['path']
    },
    async run({ path, offset = 0, maxBytes }) {
      const mb = Math.min(maxBytes || 30000, 100000);
      const { buffer, size, truncated } = await ssh.readFileChunk(path, { maxBytes: mb, offset });
      if (ssh.isProbablyBinary(buffer)) return `文件 ${path} 是二进制文件,已拒绝读取(可先 run_command 查看)`;
      const snippet = buffer.toString('utf8');
      const head = `文件 ${path}(共 ${size} 字节${truncated ? `,本次读到 ${buffer.length} 字节` : ''}):\n`;
      const tail = truncated ? `\n…[内容来自字节 ${offset}~${offset + buffer.length},如需继续用 offset=${offset + buffer.length} 读取]…` : '';
      return head + snippet + tail;
    }
  },

  {
    name: 'write_file',
    description: '在远程工作区内创建或整体覆盖一个文本文件(自动创建父目录)',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '远程路径(工作区内,支持相对路径)' },
        content: { type: 'string', description: '完整文件内容' }
      },
      required: ['path', 'content']
    },
    async run({ path, content }) {
      const abs = resolveInWorkspace(path);
      if ((await ssh.atype(abs)) === 'dir') throw new Error('目标路径已存在且是目录');
      const bytes = await ssh.writeRemoteFile(abs, content);
      return `已写入 ${abs}(${bytes} 字节)`;
    }
  },

  {
    name: 'edit_file',
    description: '在远程文件里做精确文本替换(old_string -> new_string);默认只替换首次出现,出现多次需 replace_all=true',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string', description: '要被替换的原文,必须与文件内容完全一致(含缩进/换行)' },
        new_string: { type: 'string', description: '替换后的新文本' },
        replace_all: { type: 'boolean', description: '是否替换所有出现,缺省 false' }
      },
      required: ['path', 'old_string', 'new_string']
    },
    async run({ path, old_string, new_string, replace_all }) {
      const abs = resolveInWorkspace(path);
      const { buffer, size } = await ssh.readFileChunk(abs, { maxBytes: 2 * 1024 * 1024 });
      if (size > buffer.length) throw new Error('文件超过 2MB,不适宜逐文本编辑,建议用 write_file 整体重写');
      const text = buffer.toString('utf8');
      const count = text.split(old_string).length - 1;
      if (count === 0) {
        const ctx = text.slice(0, 300);
        throw new Error(`未找到要替换的原文(在 ${abs} 中)。文件开头 300 字符:\n${ctx}\n…请用 read_file 先确认准确内容,注意缩进与换行完全一致`);
      }
      if (count > 1 && !replace_all) throw new Error(`"${old_string.slice(0, 60)}" 在文件中出现 ${count} 次,请设置 replace_all=true 或让 old_string 更具体`);
      const next = replace_all ? text.split(old_string).join(new_string) : text.replace(old_string, new_string);
      const bytes = await ssh.writeRemoteFile(abs, next);
      return `已在 ${abs} 完成编辑:${replace_all ? `替换全部 ${count} 处` : '替换 1 处'}(${bytes} 字节)`;
    }
  },

  {
    name: 'run_command',
    description: '在远程服务器上执行 shell 命令(默认已 cd 到工作区;若要切换目录请在命令开头显式 cd),返回 stdout/stderr 与退出码',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令,可用 && 串联' },
        timeout: { type: 'integer', description: '超时秒数,默认 300,最大 600' },
        description: { type: 'string', description: '用一句话说明为什么执行此命令' }
      },
      required: ['command', 'description']
    },
    timeoutMs: 660_000, // 注册表兜底超时:比工具自身最大 600s 再宽一档
    async run({ command, timeout, description }) {
      if (!command) throw new Error('命令为空');
      // concurrent:true 绕过串行队列,走 ssh2 多路 exec 通道——agent 一次发起
      // 多条 run_command 时可并行执行互不阻塞(串行模式下同一时刻仅一条,行为不变)
      const res = await ssh.exec(ssh.cdCommand(command), { timeout: (timeout || 300) * 1000, concurrent: true });
      if (res.error) throw new Error(res.stderr || '命令执行失败');
      const parts = [`[退出码 ${res.code === -1 ? '超时/终止' : res.code}${res.signal ? `, 信号 ${res.signal}` : ''}]`];
      if (res.stdout.trim()) parts.push('--- stdout ---\n' + res.stdout);
      if (res.stderr.trim()) parts.push('--- stderr ---\n' + res.stderr);
      if (!res.stdout.trim() && !res.stderr.trim()) parts.push('(无输出)');
      // meta:结构化终端卡数据(命令/工作目录/退出码/信号/超时),供前端 TerminalRow 忠实呈现
      return {
        content: capText(parts.join('\n')),
        meta: { card: 'terminal', command, cwd: ssh.workspace || '', exitCode: res.code, signal: res.signal || null, timedOut: res.code === -1 }
      };
    }
  },

  {
    name: 'create_directory',
    description: '在工作区内递归创建目录',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path']
    },
    async run({ path }) {
      const abs = resolveInWorkspace(path);
      await ssh.mkdirp(abs);
      const st = await ssh.stat(abs);
      return st ? `目录已就绪: ${abs}` : `目录创建失败: ${abs}`;
    }
  },

  {
    name: 'delete_path',
    description: '删除工作区内的文件或目录(递归)。危险操作!绝不能删除工作区根目录',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        recursive: { type: 'boolean', description: '删除目录需 true' }
      },
      required: ['path']
    },
    async run({ path, recursive }) {
      const ws = normalizeRemote(ssh.workspace || '');
      const abs = resolveInWorkspace(path);
      if (abs === ws) throw new Error('禁止删除工作区根目录');
      const type = await ssh.atype(abs);
      if (!type) throw new Error(`路径不存在: ${abs}`);
      if (type === 'dir' && !recursive) throw new Error('是目录,如需删除请加 recursive=true');
      await ssh.rmdirRecursive(abs);
      return `已删除: ${abs}`;
    }
  },

  {
    name: 'search_code',
    description: '在远程目录中搜索文本/正则(优先 ripgrep,依次回退 grep/python/busybox),适合找函数定义、引用等',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则或普通文本' },
        path: { type: 'string', description: '搜索起点,缺省为工作区' },
        include: { type: 'string', description: '文件通配,如 "*.js"' }
      },
      required: ['pattern']
    },
    async run({ pattern, path, include }) {
      const p = normalizeRemote(path || ssh.workspace || '.');
      let engine = await detectSearchEngine();
      if (!engine) {
        // 兜底:先自动安装缺失的搜索工具,再重新探测一次(连接时也做过一轮,这里覆盖"安装未生效"的场景)
        const ensured = await ensureSearchTools().catch(() => null);
        // 工具已就绪(原本就有或刚装好)时强制刷新探测缓存,避免命中首次探测失败遗留的 null 缓存
        if (ensured && ensured.ok) clearSearchEngine();
        engine = await detectSearchEngine();
      }
      if (!engine) throw new Error('远程未找到可用搜索工具(rg/grep/python/busybox),自动安装未生效;请 run_command 手动安装 ripgrep 或 grep(需 root 或免密 sudo)');
      const cmd = buildSearchCommand(engine, pattern, p, include);
      const res = await ssh.exec(cmd, { timeout: 60_000 });
      const err = (res.stderr || '').trim();
      if (res.code !== 0 && err.toLowerCase().includes('no such')) throw new Error(`路径不存在: ${p}`);
      if (res.code !== 0 && !res.stdout) {
        return err ? `搜索失败(退出码 ${res.code}): ${err}` : `无匹配(退出码 ${res.code})`;
      }
      return capText(`匹配结果(${res.stdout.split('\n').filter(Boolean).length} 行):\n${res.stdout}`);
    }
  },

  {
    // 任务计划工具:整表替换语义。
    // 模型按任务难度自主决定是否建表(描述里明确"简单单步任务跳过"),
    // 每完成一项立即标 completed;写入会话事件日志 todo/write 供前端面板渲染。
    name: 'todo_write',
    description: 'Record and update a structured task list for the current work. Send the ENTIRE '
      + 'list every call — it REPLACES the previous list (there are no partial updates, '
      + 'no per-item edits). Use it to plan multi-step work and show progress: add one '
      + 'todo per concrete step before you start. '
      + 'Keep AT MOST ONE todo `in_progress` at a time; while work remains, exactly one active '
      + 'task should be `in_progress`. '
      + 'Mark a todo `completed` the moment it is done (do not batch completions), and allow no '
      + '`in_progress` item only once all work is complete. Skip the list for trivial '
      + 'single-step tasks. Statuses: `pending` (not started), `in_progress` (being '
      + 'worked on now), `completed` (finished).',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The COMPLETE task list, replacing any previous list.',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'What the task is — a short imperative line.' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'pending (not started) | in_progress (now) | completed (done).' }
            },
            required: ['content', 'status']
          }
        }
      },
      required: ['todos']
    },
    // invokeCtx 由 agent 执行时注入:{ sid, session, emit }
    run({ todos: raw }, { session, emit, sid }: any = {}) {
      if (!session) throw new Error('todo_write 需要所属会话(缺少调用上下文)');
      if (!Array.isArray(raw)) throw new Error('todo_write: todos 必须是数组');
      const items: Array<{ content: string; status: string }> = [];
      const seen = new Set();
      let active = 0;
      for (const it of raw) {
        const content = String(it?.content || '').trim();
        const status = String(it?.status || '');
        if (!content) throw new Error('todo_write: content 必须是非空字符串');
        if (seen.has(content)) throw new Error(`todo_write: 任务内容重复 ${JSON.stringify(content)}`);
        if (!['pending', 'in_progress', 'completed'].includes(status)) {
          throw new Error(`todo_write: 非法 status "${status}"(应为 pending/in_progress/completed)`);
        }
        seen.add(content);
        if (status === 'in_progress') active++;
        items.push({ content, status });
      }
      if (active > 1) throw new Error(`todo_write: 同一时刻最多一项 in_progress(当前 ${active})`);
      session.append('todo/write', { todos: items });
      emit?.('agent', { event: 'todo_update', todos: items, sid });
      const count = (s: string) => items.filter((t) => t.status === s).length;
      return `已更新任务列表:${count('pending')} 待办 · ${count('in_progress')} 进行中 · ${count('completed')} 已完成`;
    }
  },

  {
    // 技能加载工具:模型侧唯一入口。
    // 技能来自远程 <workspace>/.agents/skills/ 与 ~/.agents/skills/,
    // 目录(名称+描述)由 system prompt 注入;本工具按名加载完整指令正文。
    name: 'skill',
    description: 'Load the full instructions for an available skill. Call this with the exact skill '
      + 'name from the session skill catalog before acting on a task that names or clearly '
      + 'matches that skill.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能目录(available_skills 列表)中列出的确切技能名。' }
      },
      required: ['name']
    },
    timeoutMs: 60_000,
    async run({ name }) {
      const skill = await loadSkillContent(String(name || ''));
      if (!skill) throw new Error(`技能 "${name}" 不存在或不可用(以会话技能目录为准)`);
      // 渲染为 harness 的 <skill_content> 形状:资源提示 + 指令正文
      return [
        `<skill_content name="${skill.name}">`,
        '<skill_resources>',
        `Base directory for this skill: ${skill.baseDir}`,
        'Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.',
        '</skill_resources>',
        '',
        '<skill_instructions>',
        skill.content,
        '</skill_instructions>',
        '</skill_content>'
      ].join('\n');
    }
  },

  {
    // 从内置技能库复制一个技能到远程(项目级/用户级),方便用户在远程工作区持久化
    // 内置技能只随工具分发(本地),复制后用户可编辑、可被子级/用户级覆盖
    name: 'skill_copy_builtin',
    description: 'Copy a builtin skill from the bundled skill library to a skill directory (local project, local user, local workspace, remote project or remote user), making it editable.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The builtin skill name to copy.' },
        target: { type: 'string', enum: ['project', 'user', 'local-project', 'local-user', 'local-workspace'], description: 'Destination: project (remote workspace), user (remote home), local-project (local tool dir), local-user (local home) or local-workspace (local workspace).' }
      },
      required: ['name', 'target']
    },
    timeoutMs: 60_000,
    async run({ name, target }) {
      const builtin = (await scanBuiltin()).find((s) => s.name === String(name || '').toLowerCase());
      if (!builtin) throw new Error(`内置技能不存在: ${name}`);
      const copied = await copyBuiltinToRemote(builtin, target === 'user' ? 'user' : target === 'local-project' || target === 'local-user' || target === 'local-workspace' ? target : 'project');
      return `已把内置技能 ${name} 复制到${copied.where}(${copied.file}),现在可编辑并可被保存覆盖`;
    }
  },

  {
    name: 'get_workspace_info',
    description: '获取工作区与远程环境信息(平台、磁盘、常用工具版本),任务开始前建议先调用',
    parameters: { type: 'object', properties: {}, required: [] },
    async run() {
      const info: any = {
        workspace: ssh.workspace || null,
        platform: ssh.platform,
        home: ssh.home
      };
      const probe = async (cmd: string) => {
        try {
          const r = await ssh.exec(cmd, { timeout: 8000 });
          return r.code === 0 && r.stdout.trim() ? r.stdout.trim().split('\n')[0] : null;
        } catch { return null; }
      };
      // 磁盘探测以家目录为基准:未选工作区时不会回落到裸 cwd;
      // 远程缺少 df(或权限不足)时静默跳过,不再让整个工具失败。
      const wsProbe = ssh.workspace || ssh.home || '.';
      const probeDisk = ssh.platform === 'win32'
        ? Promise.resolve(null)
        : probe(`df -h ${shQuote(wsProbe)} | tail -1`);
      const [disk, node, python, git, npm] = await Promise.all([
        probeDisk,
        probe('node --version'), probe('python3 --version'), probe('git --version'), probe('npm --version')
      ]);
      if (disk) info.workspaceDisk = disk;
      info.toolVersions = { node, python3: python, git, npm };
      // 透传第一个探测到的工具版本,避免磁盘探测失败时整条 toolVersions 全空、模型无从判断环境
      if (!node && !python && !git && !npm) {
        const fallback = await probe(ssh.platform === 'win32' ? 'ver' : 'uname -r');
        if (fallback) info.system = fallback;
      }
      // 工作区目录骨架(带深度限制),让历史快照在第二轮开始立即可用,
      // 避免模型为"看结构"而重复调用 list_directory。
      if (ssh.workspace) {
        try {
          info.tree = treeLines(normalizeRemote(ssh.workspace), 0);
        } catch { /* 目录读取失败时省略骨架,不影响整体信息 */ }
      }
      const text = safeJson(info);
      // 缓存环境快照,供下一轮 system prompt 注入,避免重复探测
      envCache = { workspace: info.workspace, summary: text };
      return text;
    }
  },

  {
    // 网络搜索工具(DuckDuckGo 免 key,机制对齐 ddgs):连接 SSH 时在服务器上执行
    // (Python 标准库脚本,零安装),否则在本机用 fetch 直抓;无需 API Key,不依赖 SSH
    // (本地模式也能用),也不进 SSH_ONLY_TOOLS 守卫集。
    name: 'web_search',
    description: 'Search the web for up-to-date information and return cited sources (title, snippet, url). Use when the answer needs current or real-world facts beyond the workspace: news, docs, package versions, prices, incidents, and so on. Free, no API key required. When an SSH server is connected the search runs on the server; otherwise it runs locally.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要搜索的问题或关键词,越具体越好' }
      },
      required: ['query']
    },
    timeoutMs: 240_000, // 首次搜索可能触发远端 ddgs 的 pip 安装(最长 180s)+ 搜索 30s;安装有缓存,之后秒级
    async run({ query }, { signal }: any = {}) {
      const q = String(query || '').trim();
      if (!q) throw new Error('查询词为空');
      const outcome = await webSearch({ query: q, signal });
      // meta:结构化来源列表,供前端 WebSearchRow 卡片忠实呈现(标题/摘要/链接)
      return { content: renderSearchResult(outcome), meta: { card: 'web_search', sources: outcome.sources } };
    }
  }
];

// ---------------- 本地工具定义 ----------------
// 与远程工具一一对应的本机工具:走 localFs(SFTP 签名对齐)与 execLocal(child_process)。
// 读/列自由(本机任意路径可探),写/改/删一律经 resolveInLocalWorkspace 锁在本地工作区内;
// 不需要 SSH 连接,守卫按工具名区分本地/远程。

const localToolDefs: ToolDef[] = [
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
      if (abs === path.resolve(localFs.workspace!)) throw new Error('禁止删除本地工作区根目录');
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
      return {
        content: capText(parts.join('\n')),
        meta: { card: 'terminal', command, cwd: localFs.workspace || '', exitCode: res.code, signal: res.signal || null, timedOut: !!res.timedOut }
      };
    }
  },
  {
    name: 'get_local_info',
    description: '获取本地工作区与本机环境信息(平台、磁盘、工具版本),任务开始前建议先调用',
    parameters: { type: 'object', properties: {}, required: [] },
    async run() {
      const info: any = { workspace: localFs.workspace || null, platform: process.platform, home: localFs.home };
      const probe = async (cmd: string) => { try { const r = await execLocal(cmd, { cwd: localFs.home, timeout: 8000 }); return r.code === 0 && r.stdout.trim() ? r.stdout.trim().split('\n')[0] : null; } catch { return null; } };
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

// ---------------- 交互类工具定义 ----------------
// 不依赖 SSH 连接(本地/远程模式都能用),也不进 REMOTE_TOOLS 守卫集:
// 模型需要用户确认、选择或补充关键信息时调用,工具会暂停等待用户在界面上作答。

const interactionToolDefs: ToolDef[] = [
  {
    name: 'ask_user_question',
    description: '当你需要用户确认、在选项中做选择、或缺少关键信息才能继续时,向用户提出一个或多个问题并等待回答。每题可带候选选项(单选/多选),用户也可填写"其它"自定义答案;在你得到回答前会暂停等待。回答以 JSON 返回:{"answers":[{"id":"问题id","selected":["选中的选项label"],"custom":"自定义文本"}]}。只在确实需要用户决策时使用,不要在没有歧义时滥用。',
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: '要向用户提出的问题列表(可一次问多道,界面支持逐道作答)',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '问题稳定 id,会在回答中回显' },
              question: { type: 'string', description: '要问用户的具体问题' },
              header: { type: 'string', description: '可选的短标题,例如"确认"或"选择模式"' },
              options: {
                type: 'array',
                description: '可选的候选答案;若你推荐某项,把它放第一位并在 label 末尾追加"(推荐)"',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', description: '用户可见的选项文本' },
                    description: { type: 'string', description: '用一句话说明该选项的取舍或影响' }
                  },
                  required: ['label']
                }
              },
              multi_select: { type: 'boolean', description: '是否允许多选,默认 false(单选)' }
            },
            required: ['id', 'question']
          }
        }
      },
      required: ['questions']
    },
    async run(args, { sid, signal, emit }) {
      const answers = await askUserQuestion({ questions: args.questions, sid, signal, emit });
      return safeJson({ answers });
    }
  }
];

// ---------------- 内置守卫(pre-execute,只能拒绝不能放行) ----------------

// 高危命令拦截:毁灭性命令直接拒绝(工具自身的越界检查之外的最后防线)
const DANGEROUS_COMMANDS: Array<[RegExp, string]> = [
  [/\brm\s+(-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*)\s+(\/|\$HOME|~)(\s|\/|$)/, 'rm 递归删除根目录/家目录'],
  [/\bmkfs(\.\w+)?\b/, '格式化磁盘(mkfs)'],
  [/\bdd\b[^|;&>]*of=\/dev\//, 'dd 直写块设备'],
  [/\bchmod\s+-R\s+777\s+\/(\s|$)/, '对根目录递归 chmod 777']
];

function dangerGuard(name: string, args: any) {
  if (name !== 'run_command' && name !== 'run_local_command') return undefined;
  const cmd = String(args?.command || '');
  for (const [re, why] of DANGEROUS_COMMANDS) {
    if (re.test(cmd)) return why;
  }
  return undefined;
}

// ---------------- 注册入口 ----------------

// 真正依赖 SSH 连接的远程工具(未连接时不可用,本地模式下从模型可见工具集剔除)。
// 注意:todo_write / skill / skill_copy_builtin 虽然与远程工具同组定义,但本身并不依赖
// SSH,绝不能纳入此集——否则未连接时加载技能、写任务清单会被误伤报"SSH 连接已断开"。
const SSH_ONLY_TOOLS = new Set([
  'list_directory', 'read_file', 'write_file', 'edit_file', 'run_command',
  'create_directory', 'delete_path', 'search_code', 'get_workspace_info'
]);

/** 把全部内置工具与守卫注册到注册表(由 agent 启动时调用一次) */
export function registerTools(registry: ToolRegistry) {
  // 依赖 SSH 的工具打 remote 标记,供本地模式(未连接)下 schemas() 过滤用
  for (const def of toolDefs) registry.register(SSH_ONLY_TOOLS.has(def.name) ? { ...def, remote: true } : def);
  for (const def of interactionToolDefs) registry.register(def);
  for (const def of localToolDefs) registry.register(def);
  // 守卫 1:SSH 连接状态 —— 仅真正依赖 SSH 的远程工具需要连接;本地工具(local_*)、
  // 交互工具与技能/任务清单等非远程工具不受影响,连接断开时绝不误伤本机工具链
  registry.guard((name: string) => (SSH_ONLY_TOOLS.has(name) && !ssh.connected ? 'SSH 连接已断开' : undefined));
  // 守卫 2:高危命令拦截(远程 run_command 与本机 run_local_command 都拦)
  registry.guard(dangerGuard);
}

// ---------------- 环境快照缓存(供 system prompt 复用) ----------------
let envCache: any = null;
export function getEnvInfo() { return envCache; }
export function clearEnvInfo() { envCache = null; }

// ---------------- 技能(skills)发现与目录 ----------------
// 照搬 的本地技能发现,扩展为六级来源(高优先级覆盖低优先级):
//   1. builtin          内置技能库
//   2. local-user       本机 <用户主目录>/.agents/skills                 本机用户技能(跨项目共享)
//   3. user             远程 <家目录>/.agents/skills                    远程用户技能(跨工作区)
//   4. local-project    本机 <工具运行目录>/.agents/skills               本机项目技能(随本机项目)
//   5. local-workspace  本机 <本地工作区>/.agents/skills                 工作区级本机技能(随本地工作区)
//   6. project          远程 <工作区>/.agents/skills                    远程项目技能(随工作区,最高优先)
// 技能形态(与 harness 一致):
//   <name>/SKILL.md              目录包(frontmatter: name/description)
//   <name>.md                    平铺文件(frontmatter 同上)
// 名称规则 ^[a-z0-9]+(?:-[a-z0-9]+)*$;目录只暴露 name+description,
// 完整正文由 skill 工具按需加载(单一事实源,不给模型臆测空间)。

const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILL_HEAD_BYTES = 4096;     // 目录扫描只读头部,解析 frontmatter 足够
const SKILL_BODY_MAX_BYTES = 100_000;
const SKILLS_TTL_MS = 60_000;      // 目录缓存 TTL:每轮至多全量扫描一次
const SKILL_DESC_MAX = 500;        // 目录中 description 截断长度(对齐 harness)

// 解析 Markdown 头部 frontmatter(--- 包围的 key: value 行)与正文
function splitFrontmatter(text: string): { meta: Record<string, any>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, any> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: m[2] };
}

// 读取一个本机技能文件的原始文本(fs 直读,无需 SSH)
function readLocalFile(file: string) {
  if (!String(file).startsWith(LOCAL_SKILL_PREFIX)) return null;
  const local = path.resolve(String(file).slice(LOCAL_SKILL_PREFIX.length));
  if (!fs.existsSync(local)) return null;
  const buf = fs.readFileSync(local);
  return { buffer: buf, size: buf.length };
}

// 统一读取技能源文本:
//   builtin:// → 内置库本地文件;local:// → 本机技能目录文件;其他(远程绝对路径) → SFTP
async function readSkillText(file: string, maxBytes: number) {
  if (String(file).startsWith('builtin://')) {
    const local = path.join(BUILTIN_SKILLS_DIR, String(file).slice('builtin://'.length));
    if (!fs.existsSync(local)) return null;
    const buf = fs.readFileSync(local);
    return { buffer: buf, size: buf.length };
  }
  const local = readLocalFile(file);
  if (local) return local;
  try {
    return await ssh.readFileChunk(file, { maxBytes });
  } catch { return null; }
}

export interface SkillEntry {
  name: string;
  description: string;
  file: string;
  baseDir: string;
  source: string;
}

// 读取一个技能文件头部,产出 {name, description, file, baseDir, source};非法/缺失返回 null
async function readSkillHead(file: string, baseDir: string, fallbackName: string, source: string): Promise<SkillEntry | null> {
  const r = await readSkillText(file, SKILL_HEAD_BYTES);
  if (!r || ssh.isProbablyBinary?.(r.buffer)) return null;
  const text = r.buffer.toString('utf8');
  const { meta, body } = splitFrontmatter(text);
  const name = String(meta.name || fallbackName || '').toLowerCase();
  const descRaw = String(meta.description || body.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '');
  const description = descRaw.replaceAll(/\s+/g, ' ').trim().slice(0, SKILL_DESC_MAX);
  if (!SKILL_NAME_RE.test(name) || !description) return null;
  return { name, description, file, baseDir, source };
}

// 扫描内置技能库(本地目录):<name>/SKILL.md 或 <name>.md
async function scanBuiltin(): Promise<SkillEntry[]> {
  let names: string[] = [];
  try { names = fs.readdirSync(BUILTIN_SKILLS_DIR); } catch { return []; }
  const out: SkillEntry[] = [];
  for (const n of names) {
    if (n.startsWith('.')) continue;
    const dir = path.join(BUILTIN_SKILLS_DIR, n);
    let st;
    try { st = fs.statSync(dir); } catch { continue; }
    const fallback = n.toLowerCase().replace(/\.md$/, '');
    let s;
    if (st.isDirectory()) {
      s = await readSkillHead(`builtin://${n}/SKILL.md`, `builtin://${n}`, fallback, 'builtin');
    } else if (st.isFile() && n.endsWith('.md')) {
      s = await readSkillHead(`builtin://${n}`, 'builtin://', fallback, 'builtin');
    }
    if (s) out.push(s);
  }
  return out;
}

// 扫描本机技能根目录(fs 直读,无需 SSH):<name>/SKILL.md 或 <name>.md
async function scanLocalSkillRoot(root: string, source: string): Promise<SkillEntry[]> {
  let names: string[] = [];
  try { names = fs.readdirSync(root); } catch { return []; }
  const out: SkillEntry[] = [];
  for (const n of names) {
    if (n.startsWith('.')) continue;
    const full = path.join(root, n);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    const fallback = n.toLowerCase().replace(/\.md$/, '');
    let s;
    if (st.isDirectory()) {
      s = await readSkillHead(`${LOCAL_SKILL_PREFIX}${full}/SKILL.md`, `${LOCAL_SKILL_PREFIX}${full}`, fallback, source);
    } else if (st.isFile() && n.endsWith('.md')) {
      s = await readSkillHead(`${LOCAL_SKILL_PREFIX}${full}`, `${LOCAL_SKILL_PREFIX}${path.dirname(full)}`, fallback, source);
    }
    if (s) out.push(s);
  }
  return out;
}

// 扫描一个技能根目录:目录包(<name>/SKILL.md)与平铺文件(<name>.md)
async function scanSkillRoot(root: string, source: string): Promise<SkillEntry[]> {
  let entries: FsEntry[] = [];
  try { entries = await ssh.listDir(root); } catch { return []; }
  const out: SkillEntry[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.agents') continue;
    if (e.type === 'dir') {
      const s = await readSkillHead(`${root}/${e.name}/SKILL.md`, `${root}/${e.name}`, e.name, source);
      if (s) out.push(s);
    } else if (e.type === 'file' && e.name.endsWith('.md')) {
      const s = await readSkillHead(`${root}/${e.name}`, root, e.name.slice(0, -3), source);
      if (s) out.push(s);
    }
  }
  return out;
}

// 技能目录缓存 key:本地根(不变)+ 远程工作区 + 远程家目录 + 本地工作区;
// 任一变化即失效,TTL 内复用,避免每步重复扫描目录
function skillContextKey() {
  return [ssh.workspace || '', ssh.home || '', localFs.workspace || ''].join('::');
}

let skillsCache: { key: string | null; at: number; skills: SkillEntry[] } = { key: null, at: 0, skills: [] };

/**
 * 全量扫描技能目录并刷新缓存(每轮 turn 开始时按需调用)。
 * 六级来源合并(从低到高):builtin < local-user < user < local-project < local-workspace < project;
 * 同名技能高优先级来源覆盖低优先级(远程项目级最终胜出)。
 * 未连接 SSH 时,内置库 + 本机技能(local-user/local-project/local-workspace)始终可用并返回。
 */
export async function refreshSkillsCatalog() {
  const ws = ssh.workspace;
  const [builtin, localUser, localProject, localWorkspace] = await Promise.all([
    scanBuiltin(),
    scanLocalSkillRoot(LOCAL_USER_SKILLS, 'local-user'),
    scanLocalSkillRoot(LOCAL_PROJECT_SKILLS, 'local-project'),
    localFs.workspace ? scanLocalSkillRoot(path.join(localFs.workspace, '.agents', 'skills'), 'local-workspace') : Promise.resolve([])
  ]);
  // 远程两级只有连接后才有:其余情况只返回内置 + 本机技能
  let user: SkillEntry[] = [], project: SkillEntry[] = [];
  if (ws && ssh.connected && ssh.home) {
    try {
      [project, user] = await Promise.all([
        scanSkillRoot(`${ws.replace(/\/+$/, '')}/.agents/skills`, 'project'),
        scanSkillRoot(`${ssh.home.replace(/\/+$/, '')}/.agents/skills`, 'user')
      ]);
    } catch { /* 远程扫描失败:退回内置 + 本机技能 */ }
  }
  // 优先级:builtin < local-user < user < local-project < local-workspace < project;同名时后写入者覆盖先写入者
  const byName = new Map();
  for (const s of [...builtin, ...localUser, ...user, ...localProject, ...localWorkspace, ...project]) byName.set(s.name, s);
  skillsCache = { key: skillContextKey(), at: Date.now(), skills: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)) };
  return skillsCache.skills;
}

/** 当前上下文的技能目录(缓存未命中/上下文不符时为空数组,调用方应 refresh 后再取) */
export function getSkillsCatalog() {
  if (skillsCache.key !== skillContextKey()) return [];
  return skillsCache.skills;
}

/** 缓存是否过期(上下文变化或超过 TTL) */
export function skillsCatalogStale() {
  return skillsCache.key !== skillContextKey() || Date.now() - skillsCache.at > SKILLS_TTL_MS;
}

/** 按名加载技能完整正文(目录未命中时先重扫一次);返回 {name, content, baseDir} 或 null */
export async function loadSkillContent(name: string) {
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

/**
 * 渲染模型可见的技能目录(照搬 harness tool-skill 的 catalog 消息形状):
 * <system-reminder> + <available_skills> 列表,无技能时返回空串。
 */
export function renderSkillCatalog(skills: SkillEntry[]) {
  if (!skills || skills.length === 0) return '';
  const lines = skills.map((s) => `- \`${s.name}\`: ${s.description}`);
  return [
    '<system-reminder>',
    '技能(skill)是一组可复用的任务专用指令。本次会话可用以下技能:',
    '',
    '<available_skills>',
    ...lines,
    '</available_skills>',
    '',
    '如果用户提到了某个技能,或任务明显匹配某技能的描述,请先调用 skill 工具加载其完整指令再行动;本目录仅含摘要,未加载前不要臆测或遵循技能的具体指令。',
    '</system-reminder>'
  ].join('\n');
}

// ---------------- 技能管理(设置 → 技能:增查改删,本机+远程文件) ----------------
// 管理即文件(照搬 harness 的本地技能形态):新增/编辑 = 写 <root>/<name>.md
// (带 frontmatter),删除 = 删文件/目录;所有路径都从技能根目录推导并校验,
// 绝不接受前端传入的任意路径,防止越权删除。
// 五类技能根目录:
//   project          远程 <工作区>/.agents/skills       (需 SSH)
//   user             远程 <家目录>/.agents/skills        (需 SSH)
//   local-project    本机 <工具运行目录>/.agents/skills  (无需 SSH)
//   local-user       本机 <用户主目录>/.agents/skills    (无需 SSH)
//   local-workspace  本机 <本地工作区>/.agents/skills    (无需 SSH,随本地工作区)

// 技能根目录;本地根 resolve 为绝对路径,远程根保留服务器风格路径
function skillRoots() {
  const roots = [];
  if (ssh.workspace) roots.push({ root: ssh.workspace.replace(/\/+$/, '') + '/.agents/skills', source: 'project' });
  if (ssh.home) roots.push({ root: ssh.home.replace(/\/+$/, '') + '/.agents/skills', source: 'user' });
  roots.push({ root: path.resolve(LOCAL_PROJECT_SKILLS), source: 'local-project', local: true });
  roots.push({ root: path.resolve(LOCAL_USER_SKILLS), source: 'local-user', local: true });
  if (localFs.workspace) roots.push({ root: path.resolve(localFs.workspace, '.agents', 'skills'), source: 'local-workspace', local: true });
  return roots;
}

// 是否本机技能文件(local:// 协议)
function isLocalSkillFile(file: string): boolean {
  return String(file || '').startsWith(LOCAL_SKILL_PREFIX);
}

// 去掉 local:// 协议前缀得本机绝对路径;远程路径原样返回
function skillFsPath(file: string) {
  const f = String(file || '');
  return isLocalSkillFile(f) ? path.resolve(f.slice(LOCAL_SKILL_PREFIX.length)) : f;
}

// 校验 file 恰好是某个技能根目录下的直接子项(不含更深嵌套)
function skillRootOf(file: string) {
  const isLocal = isLocalSkillFile(file);
  const p = skillFsPath(file);
  if (isLocal) {
    const parent = path.dirname(p);
    return skillRoots().find((r) => r.local && path.resolve(parent) === path.resolve(r.root));
  }
  const t = String(p).replace(/\/+$/, '');
  return skillRoots().find((r) => {
    if (r.local) return false;
    const parent = t.replace(/\/[^/]+$/, '');
    return parent === r.root;
  });
}

// 校验目标 file 在技能根目录内:
// 平铺文件(父 = 根)与目录包 SKILL.md(祖父 = 根)均合法,不许更深嵌套或越界
function skillInRoot(file: string) {
  const isLocal = isLocalSkillFile(file);
  const p = skillFsPath(file);
  const roots = skillRoots();
  if (isLocal) {
    return roots.some((r) => {
      if (!r.local) return false;
      const parent = path.dirname(p);
      if (path.resolve(parent) === path.resolve(r.root)) return true;        // <root>/<name>.md
      const grand = path.dirname(parent);
      if (path.basename(p) === 'SKILL.md' && path.resolve(grand) === path.resolve(r.root)) return true; // <root>/<name>/SKILL.md
      return false;
    });
  }
  const t = String(p).replace(/\/+$/, '');
  return roots.some((r) => {
    if (r.local) return false;
    const parent = t.replace(/\/[^/]+$/, '');
    if (parent === r.root) return true;                    // <root>/<name>.md
    const grand = parent.replace(/\/[^/]+$/, '');
    if (t.endsWith('/SKILL.md') && grand === r.root) return true; // <root>/<name>/SKILL.md
    return false;
  });
}

// 写技能文本:本机走 fs,远程走 SFTP
function writeSkillText(file: string, body: string) {
  if (isLocalSkillFile(file)) {
    const abs = skillFsPath(file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
    return Buffer.byteLength(body);
  }
  return ssh.writeRemoteFile(file, body);
}

// 删除技能文件:本机走 fs,远程走 SFTP(目录包 handle 由调用方决定)
function unlinkSkillText(file: string) {
  if (isLocalSkillFile(file)) {
    fs.unlinkSync(skillFsPath(file));
    return;
  }
  return new Promise<void>((res, rej) => ssh.sftp!.unlink(file, (e) => (e ? rej(e) : res())));
}

// 递归删除技能目录:本机走 fs,远程走 SFTP
async function rmdirSkillText(dir: string) {
  if (isLocalSkillFile(dir)) {
    fs.rmSync(skillFsPath(dir), { recursive: true, force: true });
    return;
  }
  return ssh.rmdirRecursive(dir);
}

/**
 * 读取一个技能的完整定义(编辑表单回填用)。
 * @returns {{name, description, content, file, source}} 或 null
 */
export async function getSkillFull(name: string) {
  const catalog = getSkillsCatalog().length ? getSkillsCatalog() : await refreshSkillsCatalog();
  const hit = catalog.find((s) => s.name === String(name || '').toLowerCase());
  if (!hit) return null;
  const r = await readSkillText(hit.file, SKILL_BODY_MAX_BYTES);
  if (!r) return null;
  const text = r.buffer.toString('utf8');
  const { body } = splitFrontmatter(text);
  return { name: hit.name, description: hit.description, content: body.trim(), file: hit.file, source: hit.source };
}

/**
 * 新建/更新一个技能并刷新目录缓存。
 * - 编辑(同名已存在且 target 匹配其级别):覆写原文件(目录包写回 SKILL.md,平铺写回原 .md)
 * - 新建:按 target 写到项目根(<工作区>/.agents/skills)、用户根(~/.agents/skills)或本机两级
 * - 同名已存在于另一级别时报错,避免静默覆写造成"换级别保存"的歧义
 * @param {{name: string, description: string, content: string, target?: 'project'|'user'|'local-project'|'local-user'}} draft
 * @returns {Promise<{file: string, skills: Array}>} 写入的文件与刷新后的完整目录
 */
export async function saveSkill(draft: any) {
  const name = String(draft?.name || '').trim().toLowerCase();
  const description = String(draft?.description || '').replaceAll(/\s+/g, ' ').trim();
  const content = String(draft?.content || '').trim();
  if (!SKILL_NAME_RE.test(name)) throw new Error(`技能名需为 kebab-case(小写字母/数字/连字符): ${name || '(空)'}`);
  if (!description) throw new Error('请填写技能描述(模型据此判断何时使用该技能)');
  if (!content) throw new Error('请填写技能指令正文');

  const catalog = getSkillsCatalog().length ? getSkillsCatalog() : await refreshSkillsCatalog();
  const hit = catalog.find((s) => s.name === name);
  const TARGETS = ['project', 'user', 'local-project', 'local-user', 'local-workspace'];
  // 目标文件:
  // - 编辑(同名已存在于某级):覆写原文件(目录包写回 SKILL.md,平铺写回原 .md)
  // - builtin(内置库)同名:不可直接覆写内置文件,按 target 写到目标目录作副本覆盖(优先级高于内置)
  // - 全新的名字:按 target 写到对应技能根
  let file;
  if (hit && hit.source !== 'builtin') {
    if (draft?.target && draft.target !== hit.source) {
      const lvl = LEVEL_LABEL[hit.source] || hit.source;
      throw new Error(`技能 ${name} 已存在于${lvl}(${hit.file});请直接编辑该技能,或先删除后重建`);
    }
    file = hit.file;
  } else {
    const target = TARGETS.includes(draft?.target) ? draft.target : 'project';
    const root = skillRoots().find((r) => r.source === target);
    if (!root) throw new Error(target === 'user' ? '无法确定远程家目录' : target === 'local-user'
      ? '无法确定本机用户主目录' : target === 'local-workspace' ? '请先选择本地工作区' : target === 'project' ? '请先选择远程工作区' : '无法确定本机运行目录');
    if (!root.local && !ssh.connected) throw new Error('SSH 未连接,无法写入远程技能目录');
    file = root.local ? `${LOCAL_SKILL_PREFIX}${path.join(root.root, `${name}.md`)}` : `${root.root}/${name}.md`;
  }
  if (!skillInRoot(file)) throw new Error('目标路径不在技能目录内,已拒绝');

  const body = [
    '---',
    `name: ${name}`,
    `description: ${description.replace(/\n/g, ' ')}`,
    '---',
    '',
    content,
    ''
  ].join('\n');
  const bytes = await writeSkillText(file, body);
  if (!bytes) throw new Error('写入技能文件失败');
  const skills = await refreshSkillsCatalog(); // 立即刷新,新技能即刻进入目录
  if (!skills.some((s) => s.name === name)) throw new Error('已写入但目录扫描未识别到该技能,请检查文件内容格式');
  return { file, skills };
}

/**
 * 删除一个技能(仅允许删除技能根目录下的直接子项)。
 * 目录包删整个 <root>/<name> 目录;平铺文件只删 <root>/<name>.md。
 */
export async function deleteSkill(name: string) {
  const catalog = getSkillsCatalog().length ? getSkillsCatalog() : await refreshSkillsCatalog();
  const hit = catalog.find((s) => s.name === String(name || '').toLowerCase());
  if (!hit) throw new Error(`技能不存在: ${name}`);
  if (hit.source === 'builtin') throw new Error('内置技能不可删除');
  if (!isLocalSkillFile(hit.file) && !ssh.connected) throw new Error('SSH 未连接');
  const fsPath = skillFsPath(hit.file);
  const isDir = path.basename(fsPath) === 'SKILL.md';
  if (isDir) {
    // 目录包:删技能目录本身,父目录必须是技能根
    const dir = hit.file.replace(/\/+$/, '').replace(/\/SKILL\.md$/, '');
    if (!skillRootOf(dir)) throw new Error('目录包路径校验失败,已拒绝删除');
    await rmdirSkillText(dir);
  } else {
    // 平铺文件:直接子项校验后删除
    if (!skillRootOf(hit.file)) throw new Error('文件路径校验失败,已拒绝删除');
    await unlinkSkillText(hit.file);
  }
  return refreshSkillsCatalog();
}

/**
 * 把内置技能复制到目标技能目录(project/user/local-project/local-user/local-workspace)。
 * 内置技能文件是本地目录(<name>/SKILL.md 或 <name>.md),复制时保留原文件名:
 * 目录包 -> <root>/<name>/SKILL.md;平铺文件 -> <root>/<name>.md。
 * @param {{name:string, file:string}} builtin 内置技能条目(file 为 builtin:// 协议路径)
 * @param {'project'|'user'|'local-project'|'local-user'|'local-workspace'} target 目标级别
 * @returns {Promise<{file:string, where:string}>}
 */
export async function copyBuiltinToRemote(builtin: any, target = 'project') {
  const name = String(builtin?.name || '');
  if (!name) throw new Error('缺少技能名');
  const root = skillRoots().find((r) => r.source === target);
  if (!root) throw new Error(target === 'user' ? '无法确定远程家目录' : target === 'local-user'
    ? '无法确定本机用户主目录' : target === 'local-workspace' ? '请先选择本地工作区' : target === 'project' ? '请先选择远程工作区' : '无法确定本机运行目录');
  if (!root.local && !ssh.connected) throw new Error('SSH 未连接');
  const rel = String(builtin.file || '').replace('builtin://', '');
  const isDir = rel.endsWith('/SKILL.md');
  const dest = root.local
    ? `${LOCAL_SKILL_PREFIX}${path.join(root.root, isDir ? `${name}/SKILL.md` : `${name}.md`)}`
    : isDir ? `${root.root}/${name}/SKILL.md` : `${root.root}/${name}.md`;
  if (!skillInRoot(dest)) throw new Error('目标路径不在技能目录内,已拒绝');
  const r = await readSkillText(builtin.file, SKILL_BODY_MAX_BYTES);
  if (!r) throw new Error(`读取内置技能失败: ${name}`);
  const bytes = await writeSkillText(dest, r.buffer.toString('utf8'));
  if (!bytes) throw new Error('写入技能文件失败');
  await refreshSkillsCatalog();
  return { file: dest, where: LEVEL_LABEL[target] || target };
}

// 级别 -> 中文标签(管理接口返回用)
const LEVEL_LABEL: Record<string, string> = {
  project: '项目级(远程)',
  user: '用户级(远程)',
  'local-project': '项目级(本机)',
  'local-user': '用户级(本机)',
  'local-workspace': '工作区级(本机)',
  builtin: '内置'
};

// ---------------- 引擎探测(带缓存) ----------------
// 探测结果:{ kind: 'rg'|'grep'|'findstr'|'python'|'busybox', bin: 实际可执行名 } 或 null(全无)。
// 缓存用 undefined 作"未探测"哨兵,这样 null(探测过但全无)也能被缓存,避免每次搜索重复探测。
let engineCache: any;
let engineProbe: any = null;
async function detectSearchEngine() {
  if (engineCache !== undefined) return engineCache;
  if (engineProbe) return engineProbe;
  const probe = (async () => {
    const win = ssh.platform === 'win32';
    const check = (cmd: string) => ssh.exec(cmd, { timeout: 8000 })
      .then((r: any) => r.code === 0 && r.stdout.trim().length > 0)
      .catch(() => false);
    const which = (bin: string) => (win ? `where ${bin}` : `command -v ${bin}`);
    if (await check(which('rg'))) return { kind: 'rg', bin: 'rg' };
    if (!win) {
      if (await check(which('grep'))) return { kind: 'grep', bin: 'grep' };
      if (await check(which('python3'))) return { kind: 'python', bin: 'python3' };
      if (await check(which('python'))) return { kind: 'python', bin: 'python' };
      if (await check(which('busybox'))) return { kind: 'busybox', bin: 'busybox' };
      return null;
    }
    if (await check(which('findstr'))) return { kind: 'findstr', bin: 'findstr' };
    return null;
  })();
  engineProbe = probe;
  try { engineCache = await probe; return engineCache; }
  finally { engineProbe = null; }
}

// 切换服务器/重连后,上一台的探测结果失效,清掉缓存重新探测
export function clearSearchEngine() {
  engineCache = undefined;
  engineProbe = null;
}

// ---------------- 搜索工具自动安装(连接后自检 / 搜索失败兜底) ----------------
// 连接服务器后确保远程具备基础搜索工具(rg/grep/python/busybox):
// 缺失时按系统包管理器自动安装(rg 优先,失败再装 grep,仍缺则装 python3 兜底)。
// 无包管理器 / 非 root 且无免密 sudo / 安装失败时仅记录日志,绝不影响连接与 agent 任务。
// 并发安全:同一时刻只跑一轮,其余调用复用同一 Promise;结果按服务器 + TTL 缓存,避免反复尝试。

// 待装工具与包名(各主流发行版 ripgrep 包名统一为 ripgrep)
const INSTALL_TOOLS = [
  { tool: 'rg', pkg: 'ripgrep' },
  { tool: 'grep', pkg: 'grep' },
  { tool: 'python3', pkg: 'python3' }
];

// 包管理器探测与安装命令;sudo 前缀由调用方按权限决定
const PACKAGE_MANAGERS = [
  { name: 'apt',    probe: 'command -v apt-get', install: (sudo: string, pkg: string) => `${sudo}apt-get update -qq >/dev/null 2>&1 || true; ${sudo}apt-get install -y ${pkg}` },
  { name: 'dnf',    probe: 'command -v dnf',     install: (sudo: string, pkg: string) => `${sudo}dnf install -y ${pkg}` },
  { name: 'yum',    probe: 'command -v yum',     install: (sudo: string, pkg: string) => `${sudo}yum install -y ${pkg}` },
  { name: 'apk',    probe: 'command -v apk',     install: (sudo: string, pkg: string) => `${sudo}apk add --no-cache ${pkg}` },
  { name: 'pacman', probe: 'command -v pacman',  install: (sudo: string, pkg: string) => `${sudo}pacman -S --noconfirm --needed ${pkg}` },
  { name: 'zypper', probe: 'command -v zypper',  install: (sudo: string, pkg: string) => `${sudo}zypper -n install ${pkg}` }
];

const ENSURE_TTL_MS = 5 * 60_000; // 同一服务器 5 分钟内不重复安装尝试(避免每轮搜索都重试)
let ensureToolsPromise: any = null;    // 在途安装(并发调用合并)
let ensureCache: any = null;           // { key, at, result }

function ensureConnKey() {
  const hi: any = ssh.hostInfo || {};
  return hi.host ? `${hi.username}@${hi.host}:${hi.port}` : 'local';
}

/**
 * 确保远程具备基础搜索工具;缺失时自动安装。
 * @param {{force?: boolean}} [opts] force=true 时忽略缓存强制重新探测(连接成功后调用)
 * @returns {Promise<{ok:boolean, reason?:string, installed?:string[], failed?:string[]}>}
 */
export function ensureSearchTools({ force = false } = {}) {
  const key = ensureConnKey();
  if (!force && ensureCache && ensureCache.key === key && Date.now() - ensureCache.at < ENSURE_TTL_MS) {
    return Promise.resolve(ensureCache.result);
  }
  if (!ensureToolsPromise) {
    ensureToolsPromise = doEnsureSearchTools()
      .then((result) => { ensureCache = { key, at: Date.now(), result }; return result; })
      .catch((e) => ({ ok: false, reason: 'error', message: e.message }))
      .finally(() => { ensureToolsPromise = null; });
  }
  return ensureToolsPromise;
}

async function doEnsureSearchTools() {
  if (!ssh.connected) return { ok: false, reason: 'not-connected' };
  if (ssh.platform === 'win32') return { ok: true, platform: 'win32', installed: [] }; // findstr 原生存在,无需安装
  const log = (level: string, message: string) => { try { ssh.emit('log', level, `[环境自检] ${message}`); } catch {} };
  const targetKey = ensureConnKey(); // 连接中途被切换时停止安装,避免装到别的服务器上

  // 全部走后台队列:探测快、安装可长达 180s,都不能占用 agent 的主命令队列
  const probe = async (cmd: string) => {
    try {
      const r = await ssh.execBackground(cmd, { timeout: 8000 });
      return r.code === 0 && r.stdout.trim().length > 0;
    } catch { return false; }
  };
  const which = (bin: string) => `command -v ${bin}`;

  const present: Record<string, boolean> = {};
  for (const bin of ['rg', 'grep', 'python3', 'python', 'busybox']) present[bin] = await probe(which(bin));
  log('info', `搜索工具: rg=${present.rg ? '✓' : '—'} grep=${present.grep ? '✓' : '—'} python=${present.python3 || present.python ? '✓' : '—'} busybox=${present.busybox ? '✓' : '—'}`);
  // 已有任一可用搜索工具(rg 最优,其次 grep/python/busybox)即满足搜索链路,无需安装。
  // 同时刷新探测缓存:否则首次探测失败的 null 会被永久缓存,即使远程其实有工具,
  // search_code 兜底调用本函数也因"未安装任何东西"不清缓存,导致一直误报"未找到搜索工具"。
  if (present.rg || present.grep || present.python3 || present.python || present.busybox) {
    clearSearchEngine();
    return { ok: true, installed: [] };
  }

  // 权限:root 直接装;非 root 需免密 sudo(-n 不交互,避免安装卡在密码输入)
  const uid = await ssh.execBackground('id -u', { timeout: 8000 });
  const isRoot = uid.code === 0 && String(uid.stdout || '').trim() === '0';
  let sudo = '';
  if (!isRoot) {
    if (!(await probe('sudo -n true'))) {
      log('warn', '缺少搜索工具,且当前用户非 root、无免密 sudo,无法自动安装;可 run_command 手动安装 ripgrep 或 grep');
      return { ok: false, reason: 'no-permission' };
    }
    sudo = 'sudo -n ';
  }

  let pm = null;
  for (const m of PACKAGE_MANAGERS) {
    if (await probe(m.probe)) { pm = m; break; }
  }
  if (!pm) {
    log('warn', '未识别到包管理器(apt/dnf/yum/apk/pacman/zypper),跳过自动安装;可 run_command 手动安装 ripgrep 或 grep');
    return { ok: false, reason: 'no-package-manager' };
  }

  const installed: string[] = [];
  const failed = [];
  for (const { tool, pkg } of INSTALL_TOOLS) {
    if (ensureConnKey() !== targetKey || !ssh.connected) { log('warn', '连接已切换或断开,取消剩余安装'); break; }
    if (tool !== 'rg' && installed.includes('rg')) break; // rg 装好即满足,不再装 grep/python3
    log('info', `正在安装 ${pkg}(${pm.name})...`);
    const r = await ssh.execBackground(pm.install(sudo, pkg), { timeout: 180_000 });
    if (r.code === 0 && !r.timedOut) {
      installed.push(tool);
      log('info', `已安装 ${tool}`);
    } else {
      failed.push(tool);
      log('warn', `安装 ${pkg} 失败(退出码 ${r.code}${r.timedOut ? ', 超时' : ''}): ${(r.stderr || '').slice(0, 200)}`);
    }
  }
  if (installed.length) clearSearchEngine(); // 安装成功后清缓存,下次搜索重新探测到新工具
  log(installed.length ? 'info' : 'warn', `搜索工具就绪${installed.length ? `:已安装 ${installed.join(', ')}` : '（无需新增）'}${failed.length ? `,失败: ${failed.join(', ')}` : ''}`);
  return { ok: installed.length > 0, installed, failed };
}

// Python 递归搜索脚本(无 rg/grep 时的兜底):os.walk 遍历,逐行正则匹配,
// 输出 grep -n 风格的 `file:line:content`。用 String.raw 保留源码里的 \n 字面量,
// 且全程只用双引号,便于被 shQuotePosix 单引号整段包裹而不破坏 shell 引号。
const PYTHON_SEARCH_SOURCE = String.raw`
import sys, os, re, fnmatch, io
pat = sys.argv[1]
root = sys.argv[2]
inc = sys.argv[3] if len(sys.argv) > 3 else ""
if not os.path.isdir(root):
    sys.stderr.write("no such directory: %s\n" % root)
    sys.exit(2)
try:
    rx = re.compile(pat)
except Exception as e:
    sys.stderr.write("invalid pattern: %s\n" % e)
    sys.exit(2)
skip = {".git", "node_modules", "__pycache__", ".venv", "venv", ".svn", ".hg", "dist", "build", ".next", ".cache", ".tox"}
found = 0
for dp, dn, fn in os.walk(root):
    dn[:] = [d for d in dn if d not in skip]
    for f in fn:
        if inc and not fnmatch.fnmatch(f, inc):
            continue
        fp = os.path.join(dp, f)
        try:
            if os.path.getsize(fp) > 5242880:
                continue
            with io.open(fp, "r", encoding="utf-8", errors="ignore") as fh:
                for i, line in enumerate(fh, 1):
                    if rx.search(line):
                        sys.stdout.write("%s:%d:%s\n" % (fp, i, line.rstrip("\n")))
                        found += 1
        except (OSError, IOError):
            pass
sys.exit(0 if found else 1)
`;

// 依探测到的引擎拼出搜索命令。pattern/path 一律经 shQuote 单引号包裹,
// 修复原先 rg 分支 pattern/path 未加引号导致 `|`/空格被 shell 当成管道/分词的问题。
function buildSearchCommand(engine: any, pattern: string, p: string, include?: string) {
  const q = shQuote;
  switch (engine.kind) {
    case 'rg': {
      const opts = ['-n', '--no-heading', '-g', '!.git', '-g', '!node_modules'];
      if (include) opts.push('-g', include.replace(/^\.?\*/g, '*'));
      return ['rg', ...opts, '--', q(pattern), q(p)].join(' ');
    }
    case 'grep':
      return `grep -rn ${include ? `--include=${q(include)}` : ''} ${q(pattern)} ${q(p)} --exclude-dir=.git --exclude-dir=node_modules`;
    case 'busybox':
      return `busybox grep -rn ${include ? `--include=${q(include)}` : ''} ${q(pattern)} ${q(p)} --exclude-dir=.git --exclude-dir=node_modules`;
    case 'findstr': {
      // 远端 Windows:findstr 仅字面/基础匹配,不支持 --include 通配(与本机 search_local_code 对齐)
      const base = p.replace(/[\\/]+$/, '');
      return `findstr /s /n /c:${shQuoteWin(pattern)} ${shQuoteWin(base + '\\*')}`;
    }
    case 'python':
      return `${engine.bin} -c ${q(PYTHON_SEARCH_SOURCE)} ${q(pattern)} ${q(p)} ${q(include || '')}`;
    default:
      throw new Error('未知搜索引擎: ' + engine.kind);
  }
}

function formatSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}
