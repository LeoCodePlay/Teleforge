// 用户提问(ask_user_question)能力接缝(设计 的
// interaction / user-questions + tool-ask-user):
// - 模型侧工具 ask_user_question 在 tools.js 注册;工具运行时会阻塞到用户回答;
// - 前端 UI 通过 agent 事件 ask_user 收到题面,作答后经 ws 消息 ask_user_answer 回传;
// - 取消路径:用户点取消(ask_user_cancel)/ 停止 Agent(signal abort)/
//   全部前端断开且宽限期内未回来(给页面刷新留窗口)/ 长时间未作答(超时),
//   统一清理 pending 并向模型返回结构化错误而不是挂死整轮。
import { randomUUID } from 'node:crypto';

interface PendingEntry {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
  sid?: string;
  /** 规范化后的题面:ask_user 事件只在提出时广播一次,前端刷新后靠它重发恢复面板 */
  questions: any[];
  emit?: (event: string, payload: any) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingEntry>(); // askId -> PendingEntry
// 单次提问最长等待 10 分钟;超时自动取消(短于注册表兜底超时,保证先清理 pending 再报错)
const ASK_TIMEOUT_MS = 600_000;

// 规范化模型传入的题面:只保留前端渲染需要的字段(非法项静默丢弃)
function normalizeQuestions(questions: any[]): any[] {
  return (Array.isArray(questions) ? questions : [])
    .filter((q) => q && typeof q.question === 'string' && q.question.trim())
    .map((q) => ({
      id: String(q.id || `q${Math.random().toString(36).slice(2, 7)}`),
      question: String(q.question),
      ...(typeof q.header === 'string' && q.header.trim() ? { header: String(q.header) } : {}),
      ...(Array.isArray(q.options) && q.options.length
        ? {
            options: q.options
              .filter((o: any) => o && o.label)
              .map((o: any) => ({
                label: String(o.label),
                ...(o.description ? { description: String(o.description) } : {})
              }))
          }
        : {}),
      ...(q.multi_select ? { multi_select: true } : {})
    }));
}

function cancel(askId: string, reason: string) {
  const p = pending.get(askId);
  if (!p) return;
  pending.delete(askId);
  if (p.timer) clearTimeout(p.timer);
  if (p.signal && p.onAbort) p.signal.removeEventListener('abort', p.onAbort);
  p.reject(new Error(reason));
  // 通知前端关闭/移除该批次提问(即使在最坏路径,UI 也不会永久残留)
  p.emit?.('agent', { event: 'ask_user_cancelled', askId, sid: p.sid });
}

/**
 * 向用户提出一组问题并等待回答(ask_user_question 工具内调用)。
 */
export function askUserQuestion({ questions, sid, signal, emit }: { questions: any[]; sid?: string; signal?: AbortSignal; emit?: (event: string, payload: any) => void }): Promise<any[]> {
  const qs = normalizeQuestions(questions);
  if (!qs.length) return Promise.reject(new Error('ask_user_question 需要至少一个有效问题'));
  return new Promise((resolve, reject) => {
    const askId = randomUUID().slice(0, 8);
    if (signal?.aborted) {
      reject(new Error('Agent 已停止,提问作废'));
      return;
    }
    const entry: PendingEntry = { resolve, reject, sid, questions: qs, emit, signal };
    const onAbort = () => cancel(askId, 'Agent 已停止,提问作废');
    const timer = setTimeout(
      () => cancel(askId, '用户长时间未回答,提问已超时取消(如需确认请再次调用 ask_user_question)'),
      ASK_TIMEOUT_MS
    );
    entry.onAbort = onAbort;
    entry.timer = timer;
    signal?.addEventListener('abort', onAbort, { once: true });
    pending.set(askId, entry);
    emit?.('agent', { event: 'ask_user', askId, questions: qs, sid });
  });
}

/** 前端作答回传(ws 层):resolve 对应 pending;返回是否命中 */
export function answerAskUser(askId: unknown, answers: any[]): boolean {
  const key = String(askId || '');
  const p = pending.get(key);
  if (!p) return false;
  pending.delete(key);
  if (p.timer) clearTimeout(p.timer);
  p.signal?.removeEventListener('abort', p.onAbort!);
  p.resolve(Array.isArray(answers) ? answers.filter((a) => a) : []);
  // 作答完成同样广播移除事件(与取消/超时同一个事件):多窗口并行时,其他前端
  // 据此关闭该批提问并清除"待用户操作"标记;作答方的本地队列也会被同款事件兜底清理
  p.emit?.('agent', { event: 'ask_user_cancelled', askId, sid: p.sid });
  return true;
}

/** 用户主动取消提问(ws 层);返回是否命中 */
export function rejectAskUser(askId: unknown, reason = '用户取消了提问'): boolean {
  const key = String(askId || '');
  if (!pending.has(key)) return false;
  cancel(key, reason);
  return true;
}

/** 全部作废(前端断开等全局场景),返回作废数量 */
export function rejectAllAskUser(reason = '提问已取消'): number {
  const ids = [...pending.keys()];
  for (const askId of ids) cancel(askId, reason);
  return ids.length;
}

/** 当前全部挂起提问(前端刷新/重连后恢复面板用):题面在 pending 期间持续可取 */
export function listPendingAsks(): Array<{ askId: string; sid?: string; questions: any[] }> {
  return [...pending.entries()].map(([askId, p]) => ({ askId, sid: p.sid, questions: p.questions }));
}

// 最后一个前端断开后不立即作废提问:页面刷新也会断开 WS,若立即作废,
// 刷新后 agent 还在等回答而面板已丢。给一个宽限窗口,期间任一前端上线即解除;
// 真正离开(关页面)则宽限期到后统一作废,agent 不会干等。
const DISCONNECT_GRACE_MS = 20_000;
let disconnectTimer: ReturnType<typeof setTimeout> | null = null;

/** 最后一个前端断开时调用:启动宽限倒计时,到点仍无前端在线则作废全部挂起提问 */
export function armAskUserDisconnectGrace(reason = '前端连接已断开,提问已取消', ms = DISCONNECT_GRACE_MS): void {
  if (!pending.size) return;
  if (disconnectTimer) clearTimeout(disconnectTimer);
  disconnectTimer = setTimeout(() => {
    disconnectTimer = null;
    if (pending.size) rejectAllAskUser(reason);
  }, ms);
}

/** 任一前端连上时调用:解除断开宽限倒计时(刷新/重连场景) */
export function disarmAskUserDisconnectGrace(): void {
  if (disconnectTimer) { clearTimeout(disconnectTimer); disconnectTimer = null; }
}

/** 当前挂起的提问批次数量(诊断用) */
export function pendingAskCount(): number { return pending.size; }