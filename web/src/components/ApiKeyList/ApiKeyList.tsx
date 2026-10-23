// 多 API Key 编辑器(AI 配置 / 生图配置共用):
// 每行一个 Key,行尾的小眼睛负责「点一下看明文」,右侧徽标展示该 Key 的运行状态。
// 两个面板必须长得一样 —— 用户在同一份设置里看到两套不同的 Key 行只会怀疑哪套是准的,
// 所以显隐按钮、状态徽标、删除/添加按钮都收敛到这里,改一次两边同时生效。
import React, { useState } from 'react';
import { keyUnusable, type KeyState } from '../../types';
import { IconEye16, IconEyeOff16, IconTrashOutline14 } from '../icons/icons';
import { keyStateTip } from '../../utils/apiKeys';

interface ApiKeyListProps {
  /** 当前 Key 列表(至少一行;首行是主 Key) */
  keys: string[];
  onChange: (keys: string[]) => void;
  /** 每个 Key 的运行状态(按 Key 文本索引);新增/编辑时由调用方从条目上取 */
  states?: Record<string, KeyState>;
}

export default function ApiKeyList({ keys, onChange, states }: ApiKeyListProps) {
  // 明文显示的行(按行下标记录,与 keys 数组同序)。默认全部遮罩:
  // Key 是密码级信息,滚动/截屏时不应默认外露;要看时点行尾眼睛显式露出。
  // 增删 Key 后下标会错位,但最坏只是某行延续了相邻行的显隐状态,不影响输入与保存。
  const [revealed, setRevealed] = useState<Set<number>>(() => new Set());

  return (
    <div className="key-list">
      {keys.map((k, i) => {
        const st = states?.[k.trim()];
        const bad = keyUnusable(st);
        const shown = revealed.has(i);
        return (
          <div key={i} className={'key-row' + (bad ? ' exhausted' : '')}>
            <input type={shown ? 'text' : 'password'} value={k}
              placeholder={i === 0 ? 'sk-…(主 Key)' : 'sk-…(备用 Key)'}
              onChange={(e) => onChange(keys.map((v, j) => (j === i ? e.target.value : v)))} />
            {bad && (
              <span className="badge warn" data-tip={keyStateTip(st)}>
                {st?.invalid ? '失效' : '无余额'}
              </span>
            )}
            {/* 显隐切换:点眼睛在明文/遮罩之间切换(仅影响显示,不改动值) */}
            <button type="button" className="key-reveal action-icon"
              aria-label={shown ? '隐藏 Key' : '显示 Key 明文'}
              aria-pressed={shown}
              onClick={() => setRevealed((cur) => {
                const next = new Set(cur);
                if (next.has(i)) next.delete(i); else next.add(i);
                return next;
              })}>
              {shown ? <IconEyeOff16 size={16} /> : <IconEye16 size={16} />}
            </button>
            {/* 单 Key 行不给删除:删空后无从恢复「主 Key」输入位,由下方「＋ 添加 Key」重新加行 */}
            {keys.length > 1 && (
              <button type="button" className="key-del action-icon danger"
                aria-label="删除该 Key"
                onClick={() => onChange(keys.filter((_, j) => j !== i))}>
                <IconTrashOutline14 size={14} />
              </button>
            )}
          </div>
        );
      })}
      <button type="button" className="sm" onClick={() => onChange([...keys, ''])}>＋ 添加 Key</button>
    </div>
  );
}
