// Agent 工具集:定义(JSON Schema) + 实现(基于 SshManager)
import { AGENT } from '../config.js';
import { joinRemote, normalizeRemote, sshManager as ssh } from '../ssh-manager.js';

// ---------------- 安全辅助 ----------------

// 将路径解析为工作区内的绝对远程路径;越界或不存在工作区时报错
function resolveInWorkspace(p, { allowRoot = true } = {}) {
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

function capText(s, max = AGENT.TOOL_RESULT_MAX_CHARS) {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, Math.floor(max * 0.6)) + `\n…[结果过长,已截断,剩余 ${s.length - max} 字符,可缩小范围重试]…\n` + s.slice(s.length - Math.floor(max * 0.4));
}

function safeJson(v) { return JSON.stringify(v, null, 2).slice(0, 60000); }

function shQuotePosix(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }
function shQuoteWin(s) { return `"${String(s).replace(/"/g, '\\"')}"`; }
function shQuote(s) { return ssh.platform === 'win32' ? shQuoteWin(s) : shQuotePosix(s); }

// ---------------- 工具实现 ----------------

const tools = {
  list_directory: {
    description: '列出远程目录内容(文件与子目录),用于探索文件系统',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '远程绝对路径,缺省为工作区' } },
      required: []
    },
    async run({ path }) {
      const p = normalizeRemote(path || ssh.workspace || '/');
      const entries = await ssh.listDir(p);
      const lines = entries.map((e) => {
        const icon = e.type === 'dir' ? '[目录]' : e.type === 'link' ? '[链接]' : '      ';
        const size = e.type === 'file' ? ` ${formatSize(e.size)}` : '';
        return `${icon} ${e.name}${size}`;
      });
      return `目录 ${p} 共 ${entries.length} 项:\n${lines.join('\n') || '(空)'}`;
    }
  },

  read_file: {
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

  write_file: {
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

  edit_file: {
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

  run_command: {
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
    async run({ command, timeout, description }) {
      if (!command) throw new Error('命令为空');
      const res = await ssh.exec(ssh.cdCommand(command), { timeout: (timeout || 300) * 1000 });
      if (res.error) throw new Error(res.stderr || '命令执行失败');
      const parts = [`[退出码 ${res.code === -1 ? '超时/终止' : res.code}${res.signal ? `, 信号 ${res.signal}` : ''}]`];
      if (res.stdout.trim()) parts.push('--- stdout ---\n' + res.stdout);
      if (res.stderr.trim()) parts.push('--- stderr ---\n' + res.stderr);
      if (!res.stdout.trim() && !res.stderr.trim()) parts.push('(无输出)');
      return capText(parts.join('\n'));
    }
  },

  create_directory: {
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

  delete_path: {
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

  search_code: {
    description: '在远程目录中搜索文本/正则(优先 ripgrep,回退 grep),适合找函数定义、引用等',
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
      const engine = await detectSearchEngine();
      if (!engine) throw new Error('远程无 rg/grep,无法搜索(可先 run_command 安装 ripgrep)');
      let cmd;
      if (engine === 'rg') {
        const opts = ['-n', '--no-heading', '-g', '!.git', '-g', '!node_modules'];
        if (include) opts.push('-g', include.replace(/^\.?\*/g, '*'));
        cmd = ['rg', ...opts, '--', pattern, p].join(' ');
      } else {
        const excl = ssh.platform === 'win32' ? '' : ' --exclude-dir=.git --exclude-dir=node_modules';
        cmd = `grep -rn ${include ? `--include=${shQuote(include)}` : ''} ${shQuote(pattern)} ${shQuote(p)}${excl}`;
      }
      const res = await ssh.exec(cmd, { timeout: 60_000 });
      if (res.code !== 0 && res.stderr.toLowerCase().includes('no such')) throw new Error(`路径不存在: ${p}`);
      if (res.code !== 0 && !res.stdout) return `无匹配(退出码 ${res.code})`;
      return capText(`匹配结果(${res.stdout.split('\n').filter(Boolean).length} 行):\n${res.stdout}`);
    }
  },

  get_workspace_info: {
    description: '获取工作区与远程环境信息(平台、磁盘、常用工具版本),任务开始前建议先调用',
    parameters: { type: 'object', properties: {}, required: [] },
    async run() {
      const info = {
        workspace: ssh.workspace || null,
        platform: ssh.platform,
        home: ssh.home
      };
      const probe = async (cmd) => {
        try {
          const r = await ssh.exec(cmd, { timeout: 8000 });
          return r.code === 0 && r.stdout.trim() ? r.stdout.trim().split('\n')[0] : null;
        } catch { return null; }
      };
      const [disk, node, python, git, npm] = await Promise.all([
        ssh.platform === 'win32'
          ? Promise.resolve(null)
          : probe(`df -h ${shQuote(ssh.workspace || '.')} | tail -1`),
        probe('node --version'), probe('python3 --version'), probe('git --version'), probe('npm --version')
      ]);
      if (disk) info.workspaceDisk = disk;
      info.toolVersions = { node, python3, git, npm };
      const text = safeJson(info);
      // 缓存环境快照,供下一轮 system prompt 注入,避免重复探测
      envCache = { workspace: info.workspace, summary: text };
      return text;
    }
  }
};

// ---------------- 环境快照缓存(供 system prompt 复用) ----------------
let envCache = null;
export function getEnvInfo() { return envCache; }
export function clearEnvInfo() { envCache = null; }

// ---------------- 引擎探测(带缓存) ----------------
let engineCache = null;
let engineProbe = null;
async function detectSearchEngine() {
  if (engineCache !== null) return engineCache;
  if (engineProbe) return engineProbe;
  const probe = (async () => {
    const check = (cmd) => ssh.exec(cmd, { timeout: 8000 })
      .then((r) => r.code === 0 && r.stdout.trim().length > 0)
      .catch(() => false);
    const hasRg = await check(ssh.platform === 'win32' ? 'where rg' : 'command -v rg');
    const hasGrep = await check(ssh.platform === 'win32' ? 'where findstr' : 'command -v grep');
    engineCache = hasRg ? 'rg' : hasGrep ? 'grep' : null;
    return engineCache;
  })();
  engineProbe = probe;
  try { return await probe; } finally { engineProbe = null; }
}

function formatSize(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

// ---------------- 定义与调度 ----------------
export const toolDefinitions = Object.entries(tools).map(([name, t]) => ({
  type: 'function',
  function: { name, description: t.description, parameters: t.parameters }
}));

export async function runTool(name, rawArgs) {
  const t = tools[name];
  if (!t) return { ok: false, result: `未知工具: ${name}` };
  const started = Date.now();
  try {
    if (!ssh.connected) throw new Error('SSH 连接已断开');
    const args = typeof rawArgs === 'string' ? parseArgs(rawArgs) : (rawArgs || {});
    let result;
    // 若 Agent 在连接断开后触发了重连,等待恢复
    if (!ssh.connected) throw new Error('SSH 未连接');
    result = await t.run(args);
    return { ok: true, result: capText(String(result)), ms: Date.now() - started };
  } catch (e) {
    return { ok: false, result: `工具执行错误: ${e.message}`, ms: Date.now() - started };
  }
}

function parseArgs(s) {
  try { return JSON.parse(s); }
  catch { throw new Error(`工具参数不是合法 JSON: ${String(s).slice(0, 200)}`); }
}