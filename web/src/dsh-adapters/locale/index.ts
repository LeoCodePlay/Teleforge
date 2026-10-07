// @deepseek-ai/dsh-client-locale 的适配:翻译函数与命名空间类型。
// 本项目目前只有中文,不需要运行时 i18n;TranslateNS 是 seam 类型,
// 搬运过来的组件用它标注 props,这里放行即可(文案由宿主以中文传入)。
export type Translate = (key: string, vars?: Record<string, unknown>) => string;
export type TranslateNS<NS extends string = string> = Translate & { readonly ns?: NS };
