// @ts-nocheck
// 本地命令执行:child_process.exec,输出截断 + 超时;供 Agent run_local_command 工具使用。
import { exec as cpExec } from 'node:child_process';
import { LOCAL_EXEC } from './config.ts';

function truncate(text, chr) {
  if (!text || text.length <= chr) return text || '';
  const keep = Math.floor(chr * 0.6), tail = chr - keep;
  return text.slice(0, keep) + '\n…[输出过长,已截断,省略 ' + (text.length - chr) + ' 字符]…\n' + text.slice(text.length - tail);
}

export function execLocal(command, { cwd, timeout = LOCAL_EXEC.DEFAULT_TIMEOUT_MS, maxOutput = LOCAL_EXEC.MAX_OUTPUT_CHARS } = {}) {
  return new Promise((resolve) => {
    const t = Math.min(timeout, LOCAL_EXEC.MAX_TIMEOUT_MS);
    const proc = cpExec(command, { windowsHide: true, cwd, maxBuffer: 64 * 1024 * 1024, timeout: t }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
        signal: error?.signal || null,
        stdout: truncate(stdout || '', maxOutput),
        stderr: truncate(stderr || '', maxOutput),
        timedOut: error?.killed === true
      });
    });
    proc.on('error', () => {}); // 错误经回调返回,避免未处理 error 事件抛出
  });
}