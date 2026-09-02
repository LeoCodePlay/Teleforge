// 用户提问(ask_user_question)能力接缝(设计参照 deepseek-harness 的
// interaction / user-questions + tool-ask-user):
// - 模型侧工具 ask_user_question 在 tools.js 注册;工具运行时会阻塞到用户回答;
// - 前端 UI 通过 agent 事件 ask_user 收到题面,作答后经 ws 消息 ask_user_answer 回传;
// - 取消路径:用户点取消(ask_user_cancel)/ 停止 Agent(signal abort)/ 断开连接 /
//   长时间未作答(超时),统一清理 pending 并向模型返回结构化错误而不是挂死整轮。
import { randomUUID } from 'node:crypto';

interface PendingEntry {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
  sid?: string;
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
    const entry: PendingEntry = { resolve, reject, sid, emit, signal };
    const onAbort = () => cancel(askId, 'Agent 已停止,提问作废');
    const timer = setTimeout(
      () => cancel(askId, '用户长时间未回答,提问已超时取消(如需确认请再次调用 ask_user_question)'),
      ASK_TIMEOUT_MS
    );
    entry.onAbort = onAbort;
    entry.timer = timer;
    signal.addEventListener('abort', onAbort, { once: true });
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

/** 当前挂起的提问批次数量(诊断用) */
export function pendingAskCount(): number { return pending.size; }