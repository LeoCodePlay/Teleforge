// MCP 服务接入面板(设置左侧菜单「MCP 服务」)。
//
// 一条配置 = 一个外部 MCP server(stdio 本机子进程,或 streamable-http 远端服务),
// 接入后它的工具以 `mcp__<serverName>__<工具名>` 进入模型的工具列表,
// 另有三个共享资源工具(list_mcp_resources / list_mcp_resource_templates / read_mcp_resource)。
//
// 版式取舍(这是一块"设置面板",不是营销页):
// - 等权的服务器列表用**细分隔线**分组,不用一张张描边卡片:卡片边框只该用在真正承担层级的地方;
// - 每行只留"能让人做决定"的信息(名字 / 连接状态 / 工具数);传输方式与完整命令交给悬停提示,
//   它们已经写在下面的 JSON 里,常驻显示只是噪声;
// - 常驻按钮只留一个主操作,`格式化` `放弃修改` 仅在改动后才出现;`插入示例` 只在空列表时出现
//   (空态本来就要给出"怎么开始"的下一步),不留任何"永远灰着"的按钮;
// - 字段参考折成 3 组、去掉逐行边框:10 行带分隔线的规格表是最偷懒的排法,分组后更好扫。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import './McpPanel.scss';

interface McpConfig {
  serverName: string;
  enabled: boolean;
  transport: 'stdio' | 'streamable-http';
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  url: string;
  headers: Record<string, string>;
  toolCallTimeoutMs: number;
  failOnStartupError: boolean;
  maxInstructionBytes: number;
  reconnect: { enabled?: boolean; initialDelayMs?: number; maxDelayMs?: number; maxAttempts?: number };
}

interface McpStatus {
  serverName: string;
  connected: boolean;
  toolCount: number;
  tools: string[];
  givenUp: boolean;
  error: string | null;
  hasInstructions: boolean;
}

interface McpView { config: McpConfig; status: McpStatus }

/** 「插入示例」用的模板:只写必填项,顺带说明其余字段都可省略(有默认值)。 */
const TEMPLATE = [
  {
    serverName: 'fs',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\']
  }
];

/** 字段参考:分 3 组,比 10 行逐行描边的规格表好扫。 */
const FIELD_GROUPS: Array<{ title: string; rows: Array<[string, string, string]> }> = [
  {
    title: '连接与标识',
    rows: [
      ['serverName', '必填', '工具名前缀,唯一;只允许字母、数字、下划线、连字符,最长 32 位'],
      ['transport', 'stdio', 'stdio 或 streamable-http']
    ]
  },
  {
    title: '进程与请求',
    rows: [
      ['command / args', '无 / []', 'stdio:可执行文件与参数,不经 shell 插值'],
      ['env / cwd', '{} / ""', 'stdio:额外环境变量与工作目录'],
      ['url / headers', '无 / {}', 'streamable-http:端点地址与附加请求头'],
      ['toolCallTimeoutMs', '60000', '单次工具调用或资源请求的超时(毫秒)']
    ]
  },
  {
    title: '行为与重连',
    rows: [
      ['enabled', 'true', '设为 false 就保留配置但不连接'],
      ['failOnStartupError', 'false', '初次连接失败是否按错误级别记录'],
      ['maxInstructionBytes', '32768', '服务器 instructions 的字节上限,超限拒绝该次连接'],
      ['reconnect', '{}', 'enabled、initialDelayMs、maxDelayMs、maxAttempts;默认 500 / 30000 / 10']
    ]
  }
];

/** 状态文案与色档。 */
function statusOf(view: McpView): { text: string; tone: 'ok' | 'warn' | 'idle' } {
  const { config, status } = view;
  if (config.enabled === false) return { text: '已停用', tone: 'idle' };
  if (status.connected) return { text: '已连接', tone: 'ok' };
  if (status.givenUp) return { text: '已放弃重连', tone: 'warn' };
  if (status.error) return { text: '连接失败,重连中', tone: 'warn' };
  return { text: '连接中', tone: 'idle' };
}

/** 一行里给用户看的"目标":http 直接给 URL,stdio 给命令与参数(过长由 CSS 截断,悬停看全文)。 */
function targetOf(config: McpConfig): string {
  return config.transport === 'stdio'
    ? [config.command, ...(config.args || [])].join(' ').trim()
    : config.url;
}

/** 把配置数组渲染成编辑区里的文本。 */
function toText(configs: unknown): string {
  return JSON.stringify(configs, null, 2);
}

export default function McpPanel() {
  const [views, setViews] = useState<McpView[]>([]);
  const [draft, setDraft] = useState('');
  /** 编辑区是否被用户改过:改过之后就不再被轮询刷新的状态覆盖(否则打字会被吞掉)。 */
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 同步在途互斥:busy 是 state,同一 tick 内的第二次点击看不到它。
  const inflight = useRef(false);

  const apply = useCallback((r: any) => {
    const list: McpView[] = Array.isArray(r?.servers) ? r.servers : [];
    setViews(list);
    return list;
  }, []);

  const reload = useCallback(async (silent = false) => {
    try {
      const list = apply(await api.request('mcp_list', {}, 8000));
      if (!silent) setDraft((cur) => (cur === '' ? toText(list.map((v) => v.config)) : cur));
    } catch (e) {
      if (!silent) setErr((e as Error).message);
    }
  }, [apply]);

  useEffect(() => { void reload(); }, [reload]);

  // 服务端状态变了(轮询或保存后)就把编辑区同步成权威配置;用户正在改(dirty)时不动它。
  const serverText = useMemo(() => toText(views.map((v) => v.config)), [views]);
  useEffect(() => {
    if (!dirty) setDraft(serverText);
  }, [serverText, dirty]);

  // 还有 server 没连上(且没放弃)时轮询:连接与工具发现本来就是异步的。
  const pending = useMemo(
    () => views.some((v) => v.config.enabled !== false && !v.status.connected && !v.status.givenUp),
    [views]
  );
  useEffect(() => {
    if (!pending) return;
    timer.current = setTimeout(() => { void reload(true); }, 3000);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [pending, views, reload]);

  const save = async () => {
    if (inflight.current) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft);
    } catch (e) {
      setMsg(''); setErr('JSON 语法错误:' + (e as Error).message); return;
    }
    inflight.current = true; setBusy(true); setErr(''); setMsg('');
    try {
      const list = apply(await api.request('mcp_save', { servers: parsed }, 20000));
      setDirty(false);
      setDraft(toText(list.map((v) => v.config)));
      setMsg(`已生效,${list.filter((v) => v.status.connected).length}/${list.length} 个已连接。`);
    } catch (e) {
      setErr((e as Error).message);
    } finally { inflight.current = false; setBusy(false); }
  };

  const format = () => {
    try {
      setDraft(JSON.stringify(JSON.parse(draft), null, 2));
      setDirty(true); setErr(''); setMsg('');
    } catch (e) {
      setMsg(''); setErr('JSON 语法错误:' + (e as Error).message);
    }
  };

  const reloadAll = async () => {
    if (inflight.current) return;
    inflight.current = true; setBusy(true); setErr(''); setMsg('');
    try {
      const list = apply(await api.request('mcp_reload', {}, 20000));
      setDirty(false);
      setDraft(toText(list.map((v) => v.config)));
      setMsg('已按当前配置重新连接。');
    } catch (e) {
      setErr((e as Error).message);
    } finally { inflight.current = false; setBusy(false); }
  };

  const connected = views.filter((v) => v.status.connected).length;
  const toolTotal = views.reduce((n, v) => n + (v.status.connected ? v.status.toolCount : 0), 0);

  return (
    <div className="mcp-panel">
      <div className="panel-title row">
        <span>MCP 服务</span>
        <span className="mcp-meta">{connected}/{views.length} 已连接 · {toolTotal} 个工具</span>
        <span className="grow" />
        <button className="sm" onClick={() => void reloadAll()} disabled={busy}>重新连接</button>
      </div>
      <div className="mcp-lead">
        <span>接入外部 MCP 服务器,它的工具会以 <code>mcp__&lt;serverName&gt;__&lt;工具名&gt;</code> 进入模型的工具列表。</span>
        <details className="mcp-fields">
          <summary>说明与字段速查</summary>
          <div className="mcp-fields-body">
            <p className="mcp-note">
              字段与 deepseek-harness 的 dsh-mcp-client 一致,除 serverName 外都可省略。
              stdio 用 command / args / env / cwd,Streamable HTTP 用 url / headers。
              服务器声明的 instructions 会进入模型上下文;掉线按指数退避重连,默认 500 毫秒起、封顶 30 秒、最多 10 次。
              MCP 工具是外部能力,访问类别按 fail-closed 记为「写」:计划模式直接拒绝,确认模式先弹审批。
              命令示例:
            </p>
            <pre className="mcp-snippet">{`[{ "serverName": "fs",
   "command": "npx",
   "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user"] }]`}</pre>
            {FIELD_GROUPS.map((group) => (
              <div className="mcp-field-group" key={group.title}>
                <h4>{group.title}</h4>
                {group.rows.map(([name, def, desc]) => (
                  <div className="mcp-field" key={name}>
                    <code>{name}</code>
                    <span className="mcp-def">{def}</span>
                    <span className="mcp-desc">{desc}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </details>
      </div>

      {(err || msg) && (
        <div className={`mcp-feedback ${err ? 'err' : 'ok'}`} role="status"
          onClick={() => { setErr(''); setMsg(''); }}>
          {err ? `✕ ${err}` : `✓ ${msg}`}
        </div>
      )}

      {views.length > 0 ? (
        <div className="mcp-servers">
          {views.map((v) => {
            const state = statusOf(v);
            const target = targetOf(v.config);
            const open = expanded === v.config.serverName;
            return (
              <div key={v.config.serverName} className={`mcp-row ${v.config.enabled === false ? 'off' : ''}`}>
                <div className="mcp-row-main">
                  <div className="mcp-row-head">
                    <span className="mcp-name">{v.config.serverName}</span>
                    <span className={`mcp-state ${state.tone}`}>{state.text}</span>
                    {v.status.connected && <span className="mcp-count">{v.status.toolCount} 个工具</span>}
                  </div>
                  {target && <div className="mcp-target" title={target}>{target}</div>}
                  {v.status.error && <div className="mcp-errline">最近错误:{v.status.error}</div>}
                </div>
                {v.status.connected && v.status.tools.length > 0 && (
                  <button className="link mcp-toggle" aria-expanded={open}
                    onClick={() => setExpanded(open ? null : v.config.serverName)}>
                    {open ? '收起' : `工具 ${v.status.toolCount}`}
                  </button>
                )}
                {open && (
                  <div className="mcp-toolgrid">
                    {v.status.tools.map((t) => <code key={t}>{t}</code>)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="provider-empty mcp-empty">
          <div>还没有接入任何 MCP 服务器。</div>
          <button className="sm" onClick={() => { setDraft(toText(TEMPLATE)); setDirty(true); setErr(''); setMsg(''); }}>
            插入示例
          </button>
        </div>
      )}

      <div className="panel-title row mcp-editor-title">
        <span>配置</span>
        <span className="mcp-meta">data/mcp-servers.json 的 servers 数组</span>
        <span className="grow" />
        {dirty && <span className="mcp-dirty">未保存</span>}
      </div>
      <textarea
        className="mcp-editor"
        aria-label="MCP 服务器配置(JSON 数组)"
        spellCheck={false}
        value={draft}
        onChange={(e) => { setDraft(e.target.value); setDirty(true); setErr(''); setMsg(''); }}
        placeholder={'[\n  { "serverName": "fs", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem"] }\n]'}
      />
      <div className="row mcp-editor-actions">
        <button onClick={() => void save()} disabled={busy} aria-busy={busy}>{busy ? '处理中' : '保存并应用'}</button>
        {dirty && <button className="ghost" onClick={format} disabled={busy}>格式化</button>}
        {dirty && (
          <button className="ghost" disabled={busy}
            onClick={() => { setDraft(serverText); setDirty(false); setErr(''); setMsg(''); }}>
            放弃修改
          </button>
        )}
      </div>
    </div>
  );
}
