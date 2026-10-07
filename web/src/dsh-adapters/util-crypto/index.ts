// @deepseek-ai/dsh-util-crypto 的适配:搬运代码只用到 randomUUID。
// Node 20+/浏览器都已内置 crypto.randomUUID,直接转发即可(不引第三方 uuid 包)。
export const randomUUID = (): string => globalThis.crypto.randomUUID();
