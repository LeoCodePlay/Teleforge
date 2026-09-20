// 工具插件管理面板(位于设置面板中)
//  的插件启停配置:每个工具可独立启用/禁用,
// 被禁用的工具不会出现在发给模型的 tools 列表里(schema 投影层过滤),
// 执行管线同样拒绝——模型既看不到也调不到。开关状态持久化在服务端
// data/agent-tools.json,重启后保持。
import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import './PluginsPanel.scss';

interface ToolEntry {
  name: string;
  description: string;
  enabled: boolean;
}

export default function PluginsPanel() {
  const [tools, setTools] = useState<ToolEntry[]>([]);
  const [err, setErr] = useState('');
  const [pending, setPending] = useState<string | null>(null); // 正在切换的工具名

  // AI 电脑操控是"运行时安全闸门",与工具启停语义不同(截图/操作都需要它开启),单独管理
  const [cu, setCu] = useState({ active: false, userLocked: false, supported: false });
  const [cuBusy, setCuBusy] = useState(false);

  useEffect(() => {
    const off = api.on('computer_use', (m: any) => setCu({ active: !!m.active, userLocked: !!m.userLocked, supported: !!m.supported }));
    api.request('computer_use_status', {}, 8000)
      .then((r) => setCu({ active: !!r.active, userLocked: !!r.userLocked, supported: !!r.supported }))
      .catch(() => {});
    return () => { off(); };
  }, []);

  const setCuEnabled = async (on: boolean) => {
    if (cuBusy) return;
    setCuBusy(true);
    setErr('');
    try {
      const r = await api.request('computer_use_set', { enabled: on }, 8000);
      setCu({ active: !!r.active, userLocked: !!r.userLocked, supported: !!r.supported });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setCuBusy(false);
    }
  };

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
      {err && <div className="error" onClick={() => setErr('')}>✕ {err}</div>}

      {/* AI 电脑操控:开启后 AI 才能截屏/操作鼠标键盘,所有显示器会显示「AI 操控中」悬浮窗 */}
      <div className="cu-block">
        <div className="cu-head">
          <span>AI 电脑操控</span>
          <span className={`badge ${cu.active ? 'ok' : cu.userLocked ? 'warn' : ''}`}>
            {cu.active ? '进行中' : cu.userLocked ? '已被你关闭' : '未开启'}
          </span>
          <button className={`plugin-switch ${cu.active ? 'on' : ''}`} role="switch" aria-checked={cu.active}
            aria-label="开启或关闭 AI 电脑操控" disabled={!cu.supported || cuBusy}
            onClick={() => setCuEnabled(!cu.active)}>
            <span className="plugin-knob" />
          </button>
        </div>
        <div className="hint">
          开启后 AI 可以截取屏幕并操作鼠标键盘;所有显示器上会显示「AI 操控中」悬浮窗(自带「停止」按钮,点它立即中断)。
          {cu.userLocked && ' 你手动关闭过,AI 不能自行重新开启,需要在这里打开。'}
          {!cu.supported && ' 当前平台不支持(仅 Windows 可用)。'}
        </div>
      </div>

      <div className="plugin-list">
        {tools.map((t) => (
          <div key={t.name} className={`plugin-card ${t.enabled ? '' : 'off'}`}>
            <div className="plugin-main">
              <div className="pc-head">
                <span className="pc-name">{t.name}</span>
                <span className={`badge ${t.enabled ? 'ok' : 'warn'}`}>{t.enabled ? '已启用' : '已禁用'}</span>
              </div>
              <div className="plugin-desc">{t.description}</div>
            </div>
            <button
              className={`plugin-switch ${t.enabled ? 'on' : ''}`}
              role="switch"
              aria-checked={t.enabled}
              aria-label={`${t.enabled ? '禁用' : '启用'} ${t.name}`}
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
