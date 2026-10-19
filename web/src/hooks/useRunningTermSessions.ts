// 哪些会话名下有「还在跑的后台终端」—— 会话列表据此显示蓝色状态点。
//
// 数据源与 AiTermPanel 同一份(utils/termInventory 的共享缓存):谁先挂载谁触发一次
// ai_term_list,另一方直接读缓存,不再各拉一次(dsh 0.2.1-rc 的 0ae278b935)。
// 所以会话列表不必等运行终端面板被打开过,反过来也一样。
import { useEffect, useState } from 'react';
import { readTermInventory, subscribeTermInventory, useTermInventoryBridge } from '../utils/termInventory';
import type { AiTermInfo } from '../types';

/** 从清单派生出「有运行终端的会话 id」列表(排序稳定,避免无变化时触发重绘) */
function runningSids(list: AiTermInfo[]): string[] {
  const set = new Set<string>();
  for (const t of list) if (t?.sid && t.state !== 'exited' && t.state !== 'failed') set.add(String(t.sid));
  return [...set].sort();
}

export function useRunningTermSessions(): string[] {
  const [sids, setSids] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    const commit = (list: AiTermInfo[]) => {
      if (!alive) return;
      const next = runningSids(list);
      setSids((prev) => (prev.length === next.length && prev.every((v, i) => v === next[i]) ? prev : next));
    };
    const offBridge = useTermInventoryBridge();
    const offList = subscribeTermInventory(commit);
    // 首次:读共享缓存(没有缓存时才真正发请求);失败保持上一次结果,重连会重试
    void readTermInventory().then(commit).catch(() => { /* 服务端未起/断线:等 WS open 再重拉 */ });
    return () => { alive = false; offList(); offBridge(); };
  }, []);

  return sids;
}
