// 哪些会话名下有「还在跑的后台终端」—— 会话列表据此显示蓝色状态点。
//
// 数据源与 AiTermPanel 同源但互不依赖:挂载时拉一次 ai_term_list(服务端只返回运行中的终端),
// 之后靠全局 ai_term 事件增量维护 id → sid,再派生出 sid 列表。这样会话列表不必等
// 运行终端面板被打开过。
import { useEffect, useState } from 'react';
import { api } from '../api';
import type { AiTermInfo } from '../types';

export function useRunningTermSessions(): string[] {
  const [sids, setSids] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    // id → sid(只装运行中的终端)
    const live = new Map<string, string>();
    const flush = () => {
      const set = new Set<string>();
      for (const sid of live.values()) if (sid) set.add(sid);
      const next = [...set].sort();
      setSids((prev) => (prev.length === next.length && prev.every((v, i) => v === next[i]) ? prev : next));
    };

    const rebuild = () => {
      void api.request('ai_term_list', {}, 10000, 'ai_term_list')
        .then((r: any) => {
          if (!alive) return;
          live.clear();
          const list: AiTermInfo[] = Array.isArray(r?.terms) ? r.terms : [];
          for (const t of list) if (t?.id && t?.sid) live.set(t.id, t.sid);
          flush();
        })
        .catch(() => { /* 服务端未起/断线:保持上一次结果,WS 重连后会重试 */ });
    };

    rebuild();
    const offTerm = api.on('ai_term', (m: any) => {
      const id = String(m?.id || m?.term?.id || '');
      if (!id) return;
      if (m.event === 'start') {
        const sid = String(m?.term?.sid || '');
        if (sid) live.set(id, sid);
      } else if (m.event === 'exit' || m.event === 'removed') {
        live.delete(id);
      } else {
        return; // output 等高频事件不影响这个集合
      }
      flush();
    });
    // 重连后服务端可能已经有新终端/已结束的终端,整体重拉一次
    const offOpen = api.on('open', rebuild);
    return () => { alive = false; offTerm(); offOpen(); };
  }, []);

  return sids;
}
