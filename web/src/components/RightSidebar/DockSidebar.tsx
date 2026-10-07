// 右栏宿主:用**搬来的 dsh dockkit 原件**驱动界面(标签条 / 分屏 / 拖拽 / 浮动 / 右键菜单
// / 空栏提示全由 DockSurface 及其 CSS Modules 负责),我们只提供三件事:
//
//   1. 状态源 —— DockController(dsh 原件里那个「纯 TS + 无 React」的可观察控制器):
//      `subscribe` + `getSnapshot` 正好对上 React 18 的 useSyncExternalStore;
//   2. 文案 —— DockLabels(每个字符串都由宿主传,kit 自己不造词);
//   3. 标签正文 —— renderTab:按 tab.kind 分派到本项目的面板组件(FileViewer / ReviewTab /
//      SubagentConversation …)。kind 对 kit 而言是不透明字符串,翻译只发生在这里。
//
// 注意:**不要**在这里写任何布局/标签条样式 —— 那些是 dockkit.module.css 的职责。
// 本项目只负责最外层 aside 的宽度与那条可拖拽的分隔条(见 RightSidebar.scss)。
import React, { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { DockController, DockSurface, MAX_DOCK_PANES, type DockLabels, type TabRecord } from '@deepseek-ai/dsh-client-ui-dockkit';

/** 右栏宽度约束(最外层 aside 的职责,kit 不管宿主外壳) */
export const SIDEBAR_MIN_WIDTH = 300;
export const SIDEBAR_DEFAULT_WIDTH = 460;

/** 里世界文案:全部由宿主给出(kit 不造词),这里就是 dsh 对应文案的中文版 */
const LABELS: DockLabels = {
  emptyPane: '空栏 —— 从对话里点「对比」或「侧栏」把内容放进来',
  splitPane: '分屏(左右并排)',
  splitPaneDisabled: `最多 ${MAX_DOCK_PANES} 栏`,
  splitPaneNarrow: '栏太窄,放不下两栏',
  closeTab: '关闭',
  addTab: '新建空白栏',
  dockFloat: '收回栏内',
  closeFloat: '关闭浮窗',
  dropZone: {
    center: '移入此栏',
    top: '在上方新建栏',
    right: '在右侧新建栏',
    bottom: '在下方新建栏',
    left: '在左侧新建栏'
  }
};

/** 空白起始标签:第一栏先给个明确的空态,而不是什么都不画 */
const BLANK: Omit<TabRecord, 'id'> = { kind: 'empty', contentId: 'blank', title: '空白' };

interface Props {
  /** 打开请求(nonce 变化即视为一次新请求);由外层把「在侧栏打开」翻译成标签 */
  request: { kind: string; contentId: string; title: string; nonce: number } | null;
  /** 按 kind 渲染标签正文;api.close 让正文自带的关闭按钮也能关掉标签 */
  renderBody: (tab: TabRecord, api: { close: () => void; active: boolean }) => React.ReactNode;
  /** 可见性(展开/收起)变化时通知外层 */
  onVisibilityChange?: (open: boolean) => void;
  /** 画在右上角标签条末端的额外控件(宿主自己的按钮) */
  chrome?: React.ReactNode;
}

export default function DockSidebar({ request, renderBody, onVisibilityChange, chrome }: Props) {
  // 一个 surface 一个 controller;它内部持有布局树与全部意图方法(即 DockIntents)
  const controllerRef = useRef<DockController | null>(null);
  if (!controllerRef.current) {
    // 不预置任何标签:空栏由 dockkit 自己用 labels.emptyPane 渲染(它的空态),
    // 预置一个假标签只会多出一个没人认识的 kind。
      // makePaneTab 的签名等接了 A 运行时再收紧(现在先按宽松写法,避免为了一个 UI 入口
      // 去猜 kit 的选项类型);labels.addTab 的 ＋ 会开出一个文件树面板。
      controllerRef.current = new DockController({
        mode: 'push',
        makePaneTab: (id: string) => ({ id, kind: 'files', contentId: '.', title: '文件' })
      } as never);
  }
  const controller = controllerRef.current;

  // React 18 的一等公民接法:controller 的快照只在布局真的变化时才换引用
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  // 外部打开请求 → 开标签(同一 (kind, contentId) 只会聚焦已有标签,这是 kit 的语义)
  useEffect(() => {
    if (!request) return;
    controller.openContent({ kind: request.kind, contentId: request.contentId, title: request.title });
  }, [controller, request?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    onVisibilityChange?.(snapshot.state.expanded);
  }, [snapshot.state.expanded, onVisibilityChange]);

  const labels = useMemo(() => LABELS, []);

  return (
    <DockSurface
      state={snapshot.state}
      canSplit={snapshot.canSplit}
      intents={controller}
      labels={labels}
      chrome={chrome}
      renderTab={(tab) => renderBody(tab, {
        close: () => controller.closeTab(tab.id),
        // kit 自己知道哪个标签是激活的;这里只需要一个「是否可见」的近似:
        // 正文里用它决定要不要轮询/动画(FileViewer 等对后台空转敏感)
        active: true
      })}
    />
  );
}
