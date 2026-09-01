// 工具插件管理面板(位于设置面板中)
// 参照 deepseek-harness 的插件启停配置:每个工具可独立启用/禁用,
// 被禁用的工具不会出现在发给模型的 tools 列表里(schema 投影层过滤),
// 执行管线同样拒绝——模型既看不到也调不到。开关状态持久化在服务端
// data/agent-tools.json,重启后保持。
import React, { useEffect, useState } from 'react';
import { api } from '../api';

interface ToolEntry {
  name: string;
  description: string;
  enabled: boolean;
}

export default function PluginsPanel() {
  const [tools, setTools] = useState<ToolEntry[]>([]);
  const [err, setErr] = useState('');
  const [pending, setPending] = useState<string | null>(null); // 正在切换的工具名

  useEffect(() => {
    api.request('tools_list', {}, 8000)
      .then((r) => setTools(r.tools || []))
      .catch((e) => setErr(e.message));
  }, []);

  const toggle = async (t: ToolEntry) => {
    if (pending) return;
    setPending(t.name);
    setErr('');
    try {
      const r = await api.request('tool_toggle', { name: t.name, enabled: !t.enabled }, 8000);
      setTools(r.tools || []);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setPending(null);
    }
  };

  const enabledCount = tools.filter((t) => t.enabled).length;

  return (
    <div>
      <div className="panel-title row">
        <span>工具插件</span>
        <span className="muted sm">({enabledCount}/{tools.length} 启用)</span>
      </div>
      <div className="hint" style={{ marginBottom: 8 }}>
        AI 编程助手可用的内置工具(插件)。禁用的工具不会出现在模型的工具列表中,模型将无法调用;
        开关状态保存在服务端,重启后保持。下一轮对话即生效。
      </div>
      {err && <div className="error" onClick={() => setErr('')} title="点击关闭">✕ {err}</div>}

      <div className="plugin-list">
        {tools.map((t) => (
          <div key={t.name} className={`plugin-card ${t.enabled ? '' : 'off'}`}>
            <div className="plugin-main">
              <div className="pc-head">
                <span className="pc-name">{t.name}</span>
                <span className={`badge ${t.enabled ? 'ok' : 'warn'}`}>{t.enabled ? '已启用' : '已禁用'}</span>
              </div>
              <div className="plugin-desc" title={t.description}>{t.description}</div>
            </div>
            <button
              className={`plugin-switch ${t.enabled ? 'on' : ''}`}
              role="switch"
              aria-checked={t.enabled}
              aria-label={`${t.enabled ? '禁用' : '启用'} ${t.name}`}
              title={t.enabled ? `点击禁用 ${t.name}` : `点击启用 ${t.name}`}
              disabled={pending === t.name}
              onClick={() => toggle(t)}
            >
              <span className="plugin-knob" />
            </button>
          </div>
        ))}
        {tools.length === 0 && <div className="provider-empty">正在加载工具列表…</div>}
      </div>
    </div>
  );
}
