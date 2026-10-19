// 模型选择器(二级菜单,交互对齐 deepseek-harness 的 ModelSelect):
// 触发按钮显示当前模型(附推理等级与提供商色点),点击弹出根菜单 = 两行「模型 / 推理等级」,
// 各自带右箭头下钻:模型 → 按提供商分组(提供商名不可选)的完整清单;
// 推理等级 → 该模型**支持**的档位(dsh 0.2.1-rc 的 f61d9982f8:每模型可声明支持的档位)。
// 点击外部关闭,Esc 先退回根菜单再关闭。
import React, { useEffect, useRef, useState } from 'react';
import { useLlm } from '../../context/llm-context';
import { modelSupportedLevels, REASONING_LEVELS } from '../../utils/reasoningLevels';
import { IconChevronDownOutline14 } from '../icons/icons';
import './ModelMenu.scss';

// 等级清单已迁到 utils/reasoningLevels(设置面板与菜单共用);此处保留再导出,
// 避免历史调用方(以及"推理等级定义在 ModelMenu"这条注释)失效。
export { REASONING_LEVELS };

/** 提供商色相:按 id 稳定散列到 0..359,同一提供商在触发按钮/分组标题/模型行里始终同色。 */
function providerHue(id: string): number {
  let h = 7;
  for (const ch of id) h = (h * 31 + (ch.codePointAt(0) ?? 0)) % 360;
  return h;
}

interface ModelMenuProps {
  reasoning: string;
  onChangeReasoning: (lv: string) => void;
}

export default function ModelMenu({ reasoning, onChangeReasoning }: ModelMenuProps) {
  const llm = useLlm();
  // 当前打开的面板:'root' 根菜单(模型/推理等级两行) / 'model' 模型清单 / 'effort' 推理等级
  const [open, setOpen] = useState(false);
  const [pane, setPane] = useState<'root' | 'model' | 'effort'>('root');
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // 供 document 级 Esc 监听读取最新面板(Esc 需区分"退回根菜单 / 关闭")
  const paneRef = useRef(pane);
  paneRef.current = pane;

  const curLevel = REASONING_LEVELS.find((lv) => lv.id === reasoning);
  const curModel = llm.isMock ? 'mock' : llm.effModel;
  // 当前模型的「支持档位」(缺省 = 全部):菜单只列它支持的那些,见 utils/reasoningLevels
  const curProvider = llm.userProviders.find((p) => p.id === llm.providerId);
  const curLevels = modelSupportedLevels(curProvider?.modelConfig?.[curModel]);
  // 当前生效模型是否正是选中项(兼容自定义模型:自定义名命中也算选中)
  const isCur = (pid: string, m: string) =>
    pid === llm.providerId && (llm.model === m || (llm.model === '__custom__' && llm.customModel === m));

  const close = () => { setOpen(false); setPane('root'); };

  // 点击外部关闭;Esc 先退回根菜单,再按一次关闭
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      if (paneRef.current !== 'root') setPane('root');
      else close();
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // ↑↓ 在菜单内可交互项间移动焦点(Enter 由 button 原生触发选中)
  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    const btns = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    if (btns.length === 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const i = btns.indexOf(document.activeElement as HTMLButtonElement);
      const n = e.key === 'ArrowDown' ? 1 : -1;
      const next = i === -1
        ? (e.key === 'ArrowDown' ? 0 : btns.length - 1)
        : (i + n + btns.length) % btns.length;
      btns[next]?.focus();
    }
  };

  // 选择模型:跨提供方时先切换提供方(恢复其 Key/上次模型),再落到目标模型
  const pickModel = (pid: string, m: string) => {
    if (pid !== llm.providerId) llm.switchProvider(pid);
    llm.setModel(m);
    close();
  };

  const pickEffort = (lv: string) => {
    onChangeReasoning(lv);
    close();
  };

  return (
    <div ref={rootRef} className={`msm ${open ? 'open' : ''}`}>
      <button
        type="button"
        className="msm-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => { if (open) close(); else { setPane('root'); setOpen(true); } }}
      >
        <span className="msm-badge" style={{ ['--h' as string]: providerHue(llm.providerId) }} aria-hidden />
        <span className="msm-label">{curModel}</span>
        {curLevel && <span className="msm-effort">{curLevel.label}</span>}
        <span className="msm-arrow"><IconChevronDownOutline14 size={13} /></span>
      </button>
      {open && (
        <div ref={menuRef} className="msm-menu" role="menu" onKeyDown={onMenuKeyDown}>
          {pane === 'root' && (
            <>
              <button type="button" role="menuitem" className="msm-cell" onClick={() => setPane('model')}>
                <span className="msm-cell-label">模型</span>
                <span className="msm-cell-value">{curModel}</span>
                <span className="msm-cell-chev">›</span>
              </button>
              <button type="button" role="menuitem" className="msm-cell" onClick={() => setPane('effort')}>
                <span className="msm-cell-label">推理等级</span>
                <span className="msm-cell-value">{curLevel ? curLevel.label : '默认'}</span>
                <span className="msm-cell-chev">›</span>
              </button>
            </>
          )}
          {pane === 'model' && (
            <div className="msm-groups">
              {llm.userProviders.length === 0 && (
                <div className="msm-empty">尚无提供商,请先在设置中添加</div>
              )}
              {llm.userProviders.map((p) => {
                const cur = p.id === llm.providerId;
                return (
                  <div className="msm-group" key={p.id}>
                    {/* 提供商名:仅作分组标题,不可选;色点让同名模型在不同网关下也能一眼区分 */}
                    <div className="msm-group-title" data-provider-id={p.id}>
                      <span className="msm-badge" style={{ ['--h' as string]: providerHue(p.id) }} aria-hidden />
                      {p.name}
                    </div>
                    {p.models.length === 0 ? (
                      <div className="msm-empty">无模型(手动输入)</div>
                    ) : p.models.map((m) => (
                      <button
                        key={m}
                        type="button"
                        role="menuitemradio"
                        aria-checked={isCur(p.id, m)}
                        data-provider-id={p.id}
                        data-model-id={m}
                        className={`msm-option ${isCur(p.id, m) ? 'on' : ''}`}
                        onClick={() => pickModel(p.id, m)}
                      >
                        <span className="msm-badge" style={{ ['--h' as string]: providerHue(p.id) }} aria-hidden />
                        <span className="msm-option-name">{m}</span>
                        {isCur(p.id, m) && <span className="msm-check">✓</span>}
                      </button>
                    ))}
                    {/* 当前提供方追加「自定义模型」入口:输入任意模型名 */}
                    {cur && (
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={llm.model === '__custom__'}
                        className={`msm-option ${llm.model === '__custom__' ? 'on' : ''}`}
                        onClick={() => pickModel(p.id, '__custom__')}
                      >
                        <span className="msm-option-name msm-custom">自定义模型…</span>
                        {llm.model === '__custom__' && <span className="msm-check">✓</span>}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {pane === 'effort' && (
            <div className="msm-groups">
              {/* 只列当前模型支持的档位;声明过档位的模型会多一行说明,免得用户以为菜单缺项 */}
              {curLevels.length < REASONING_LEVELS.length && (
                <div className="msm-empty">该模型只声明了 {curLevels.length} 档(可在 AI 配置里修改)</div>
              )}
              {curLevels.map((lv) => (
                <button
                  key={lv.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={reasoning === lv.id}
                  className={`msm-option ${reasoning === lv.id ? 'on' : ''}`}
                  onClick={() => pickEffort(lv.id)}
                >
                  <span className="msm-option-name">{lv.label}</span>
                  {reasoning === lv.id && <span className="msm-check">✓</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
