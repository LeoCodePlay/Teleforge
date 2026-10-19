// 已发送用户文本的渲染原子:把可识别的凭据替换成遮挡显示,交互消息额外给一个眼睛开关。
//
// 只影响显示 —— 消息原文、复制内容、发给模型的请求都是原始字符(见 utils/secretMask)。
// 每个值独立控制:点开只露出这一个,再点收回;组件重新挂载时一律回到遮挡态,
// 避免"上次开过就一直开着"把密钥留在屏幕上。
import React, { useState } from 'react';
import { splitSecrets } from '../../utils/secretMask';
import { IconEye16, IconEyeOff16 } from '../icons/icons';
import './SecretText.scss';

interface SecretTextProps {
  text: string;
  /** true = 每个凭据值后带眼睛开关(用于已发送/已受理的用户消息等交互文本) */
  interactive?: boolean;
  /** 段落渲染前的文本类名(默认沿用气泡里的普通文本) */
  className?: string;
}

export default function SecretText({ text, interactive = false, className }: SecretTextProps) {
  // 已展开的凭据:按段落下标记录(同一条消息里多个凭据互不影响)
  const [open, setOpen] = useState<Set<number>>(new Set());
  const segs = splitSecrets(text);
  if (!segs.some((s) => s.t === 'secret')) {
    return <span className={className}>{text}</span>;
  }
  const toggle = (i: number) => setOpen((cur) => {
    const next = new Set(cur);
    if (next.has(i)) next.delete(i); else next.add(i);
    return next;
  });
  return (
    <span className={className}>
      {segs.map((s, i) => {
        if (s.t === 'text') return <React.Fragment key={i}>{s.v}</React.Fragment>;
        const shown = open.has(i);
        return (
          <React.Fragment key={i}>
            <span className={'secret' + (shown ? ' shown' : '')} data-kind={s.kind} data-tip={shown ? '凭据原文(点眼睛可再次隐藏)' : '已遮挡的可识别凭据'}>
              {shown ? s.raw : s.v}
            </span>
            {interactive && (
              <button
                type="button"
                className="secret-eye"
                aria-label={shown ? '隐藏该凭据' : '显示该凭据原文'}
                aria-pressed={shown}
                data-tip={shown ? '隐藏' : '显示原文'}
                onClick={() => toggle(i)}
              >
                {shown ? <IconEyeOff16 /> : <IconEye16 />}
              </button>
            )}
          </React.Fragment>
        );
      })}
    </span>
  );
}
