// @deepseek-ai/dsh-api-session-controller/client 的适配(类型面)。
// dsh 用它拿「会话远程接口」。本项目的会话数据走自己的 RPC(api.request('session_list') 等),
// 所以这里只提供类型;真正接线时用本项目的 api 客户端实现这两个接口。
export interface SessionReference {
  readonly id: string;
  readonly title?: string;
}
export interface ISessions {
  readonly list: () => Promise<readonly SessionReference[]>;
  readonly get?: (id: string) => Promise<SessionReference | undefined>;
}
