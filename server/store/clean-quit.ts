// 「上次是不是用户主动退出」的标记:用来区分两种看起来一样的"上一轮没有正常结束"——
//  - 后端进程异常退出(崩溃 / 被任务管理器结束 / 断电 / 开发模式热重启)→ 应当自动接着做;
//  - 用户自己关掉软件或按 Ctrl+C 停服务 → 下次打开只是看看,不该擅自继续。
//
// 谁写这个标记:① 桌面外壳在 kill 后端子进程之前(见 src-tauri/src/backend.rs 的 stop);
// ② 服务端收到 SIGINT/SIGTERM 时(控制台 Ctrl+C、npm run dev 退出)。
// 谁读:后端启动时(agent 构造前)读一次并删除 —— 一次退出只影响一次启动,
// 读不到就是"上次非正常退出"(崩溃),这正是要自动续跑的情形。
import fs from 'node:fs';
import { QUIT_FLAG_FILE } from '../config.ts';

/** 标记「这次退出是用户主动的」。幂等;写失败只告警(少写一个标记不影响正常启动)。 */
export function markCleanQuit(reason = 'quit'): void {
  try {
    fs.writeFileSync(QUIT_FLAG_FILE, JSON.stringify({ at: Date.now(), reason }));
  } catch (e: any) {
    console.warn('[clean-quit] 写入主动退出标记失败:', e?.message ?? e);
  }
}

/** 读取并清除标记。@returns true = 上次是用户主动退出(不要自动续跑) */
export function consumeCleanQuitFlag(): boolean {
  try {
    if (!fs.existsSync(QUIT_FLAG_FILE)) return false;
    fs.unlinkSync(QUIT_FLAG_FILE);
    return true;
  } catch {
    return false; // 读不到/删不掉都按"非主动退出"处理:宁可多续一次,也不要丢掉一个长任务
  }
}
