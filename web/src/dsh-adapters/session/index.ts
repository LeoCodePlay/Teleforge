// @deepseek-ai/dsh-session 的适配:会话 id 与相关品牌类型。
// 本项目的会话 id 就是普通字符串(服务端 sessions/<id>.json),所以直接等价。
export type SessionId = string;
export type SessionPhase = 'idle' | 'running' | 'waiting-input' | 'stopped';
