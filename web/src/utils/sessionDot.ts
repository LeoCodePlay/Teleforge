// 会话列表里那一格「状态点」该显示什么颜色 —— 纯函数,便于单测(组件里不再散着三元)。
//
// 优先级(用户口径):
//   1. 绿色:该会话有任务正在进行(agent 正在跑)
//   2. 黄色:有挂起的模型提问(等待用户操作)
//   3. 蓝色:会话空闲,但它名下有还在跑的后台终端(AI 拉起的运行终端)
//   4. 无:都没有 → 只占位不显示(保持所有会话标题左边缘对齐)
export type SessionDot = 'run' | 'warn' | 'term' | 'idle';

export interface SessionDotInput {
  /** 该会话有任务进行中 */
  running: boolean;
  /** 该会话有挂起提问,等待用户操作 */
  askWaiting: boolean;
  /** 该会话名下有还在运行的后台终端 */
  termRunning: boolean;
}

export const SESSION_DOT_TIP: Record<SessionDot, string | null> = {
  run: '任务进行中',
  warn: '等待用户操作',
  term: '有后台终端在运行',
  idle: null
};

export function sessionDot({ running, askWaiting, termRunning }: SessionDotInput): SessionDot {
  if (running) return 'run';
  if (askWaiting) return 'warn';
  if (termRunning) return 'term';
  return 'idle';
}

/** 状态点的 class(绿色是基础态,不加修饰类;其余各自带修饰类) */
export function sessionDotClass(dot: SessionDot): string {
  return dot === 'run' ? 's-run' : `s-run ${dot}`;
}
