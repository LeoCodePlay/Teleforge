// @deepseek-ai/dsh-brand 的适配:命名空间。
//
// dsh 用它给「id / name / path」这类字符串打**品牌类型**(branded type),防止把会话 id
// 当文件路径传。它没有任何运行时实现(纯类型),所以这里照搬即可 ——
// 搬进来的 dsh 源码 import { Branded } from '@deepseek-ai/dsh-brand' 时映射到这里。
//
// 签名照 dsh 的用法**只吃一个类型参数**(dockkit 里写作 `Branded<'pane'>`):得到的仍然是
// 字符串,只是名义上不可与别的字符串互换 —— 这才是品牌类型要的效果。
//
// 为什么不把 dsh 的 brand 包也整包复制:它的价值只在类型层,复制一整个包(含 package.json
// 与 exports 映射)对运行时毫无影响,给一个同名同签名的类型反而更清楚。

/** 品牌字符串:底层仍是 string,T 是「名义标签」(用字符串字面量区分用途) */
export type Branded<T extends string> = string & { readonly __brand: T };
