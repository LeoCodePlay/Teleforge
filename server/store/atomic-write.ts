// 原子写:先写临时文件再 rename 覆盖,避免半截文件损坏数据。
// 零依赖(Node 内置 fs),重试与只读兜底都是为 Windows 服务的:
// - 杀软实时监控、资源管理器预览等会在文件刚写完时短暂持有句柄,rename 覆盖随即失败。
//   这类失败在毫秒级自愈(实测同一模式千分之几的偶发率),退避重试即可消化。
// - Windows 不允许 rename 覆盖带只读属性的文件(EPERM),最后一次重试前先摘掉该属性。
// 临时文件名带 pid 与自增序号:同一目录存在多个写者(多实例、测试脚本)时不会互踩同一个 tmp。
import fs from 'node:fs';

// 可自愈的错误码:目标被占用或被拒(独占句柄在 Windows 上报 EPERM,共享冲突报 EBUSY)
const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RETRY_DELAYS_MS = [10, 25, 50, 100]; // 累计 185ms,远短于一次落盘调用方的等待预期

let seq = 0;

/** 同步小睡(毫秒);写路径是同步的,退避只能同步等 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 摘掉目标文件的只读属性(Windows 上它会让 rename 覆盖直接失败);失败则交给最后一次重试判定 */
function clearReadOnly(file: string): void {
  try {
    const mode = fs.statSync(file).mode;
    if ((mode & 0o200) === 0) fs.chmodSync(file, mode | 0o200);
  } catch { /* 目标不存在:问题不在只读属性 */ }
}

/** 原子写:body 写入 file。成功返回;重试耗尽后抛出最后一次的错误(临时文件一并清掉) */
export function writeFileAtomic(file: string, body: string): void {
  const tmp = `${file}.${process.pid}.${++seq}.tmp`;
  fs.writeFileSync(tmp, body, 'utf8');
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException)?.code ?? '';
      if (!RETRYABLE.has(code) || attempt === RETRY_DELAYS_MS.length) break;
      if (attempt === RETRY_DELAYS_MS.length - 1) clearReadOnly(file);
      sleepSync(RETRY_DELAYS_MS[attempt]);
    }
  }
  try { fs.unlinkSync(tmp); } catch { /* 已被 rename 走或从未落盘 */ }
  throw lastErr;
}
