// 全局 UI 反馈层:页面内确认弹窗 + 消息弹出提示(toast)
// 统一替换浏览器原生 confirm()/alert(),风格遵循液态玻璃 Liquid Glass 规范(见 web/LIQUID_GLASS.md)
// 用法:
//   const { confirm, toast } = useFeedback();
//   if (await confirm({ title: '删除', message: '确定删除?', danger: true })) { ... }
//   toast.success('已保存') / toast.error(msg) / toast.warning(msg) / toast.info(msg)
import React, { createContext, useCallback, useContext, useRef, useState } from 'react';

export interface ConfirmOptions {
  /** 弹窗标题,缺省显示「操作确认」 */
  title?: React.ReactNode;
  /** 提示正文(支持 \n 换行,自动按 pre-line 渲染) */
  message: React.ReactNode;
  /** 确认按钮文案,缺省「确定」 */
  confirmLabel?: string;
  /** 取消按钮文案,缺省「取消」 */
  cancelLabel?: string;
  /** 危险操作:确认按钮使用红色 danger 样式(删除/覆盖等破坏性操作建议开启) */
  danger?: boolean;
}

export type ToastType = 'success' | 'error' | 'warning' | 'info';

interface ToastItem {
  id: number;
  type: ToastType;
  content: React.ReactNode;
}

export interface FeedbackValue {
  /** 页面内确认弹窗,返回 Promise<boolean>:点「确定」为 true,点「取消」/遮罩/✕ 为 false */
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  /** 消息弹出提示:自动消失,可点击关闭 */
  toast: {
    success: (content: React.ReactNode, duration?: number) => void;
    error: (content: React.ReactNode, duration?: number) => void;
    warning: (content: React.ReactNode, duration?: number) => void;
    info: (content: React.ReactNode, duration?: number) => void;
  };
}

const Ctx = createContext<FeedbackValue | null>(null);
export const useFeedback = (): FeedbackValue => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useFeedback 必须在 FeedbackProvider 内使用');
  return v;
};

const TOAST_ICON: Record<ToastType, string> = {
  success: '✓',
  error: '✕',
  warning: '⚠',
  info: 'ℹ'
};
const TOAST_DURATION = 3200;

export function FeedbackProvider({ children }: { children: React.ReactNode }) {
  // ---- 确认弹窗:单例。新 confirm 会先结束上一个未决确认(false),保证 Promise 不会悬挂 ----
  const [confirmOpts, setConfirmOpts] = useState<ConfirmOptions | null>(null);
  const resolveRef = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback((opts: ConfirmOptions) => new Promise<boolean>((resolve) => {
    resolveRef.current?.(false);
    resolveRef.current = resolve;
    setConfirmOpts(opts);
  }), []);

  const closeConfirm = useCallback((result: boolean) => {
    resolveRef.current?.(result);
    resolveRef.current = null;
    setConfirmOpts(null);
  }, []);

  // ---- 消息弹出:堆叠、自动消失、可点击关闭 ----
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastId = useRef(0);

  const pushToast = useCallback((type: ToastType, content: React.ReactNode, duration = TOAST_DURATION) => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, type, content }]);
    window.setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id));
    }, duration);
  }, []);

  const toast = {
    success: (c: React.ReactNode, d?: number) => pushToast('success', c, d),
    error: (c: React.ReactNode, d?: number) => pushToast('error', c, d),
    warning: (c: React.ReactNode, d?: number) => pushToast('warning', c, d),
    info: (c: React.ReactNode, d?: number) => pushToast('info', c, d)
  };

  return (
    <Ctx.Provider value={{ confirm, toast }}>
      {children}

      {/* 确认弹窗:复用 .modal 玻璃面板,遮罩更高层级压在业务弹窗之上 */}
      {confirmOpts && (
        <div className="modal-overlay confirm-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) closeConfirm(false); }}>
          <div className="modal confirm-modal" role="dialog" aria-modal="true"
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); closeConfirm(false); } }}>
            <div className="modal-head">
              <span>{confirmOpts.title ?? '操作确认'}</span>
              <button type="button" className="ghost" title="取消" onClick={() => closeConfirm(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="confirm-msg">{confirmOpts.message}</div>
            </div>
            <div className="modal-foot row gap">
              <button type="button" className="grow" onClick={() => closeConfirm(false)}>
                {confirmOpts.cancelLabel ?? '取消'}
              </button>
              <button type="button" className={`${confirmOpts.danger ? 'danger' : 'primary'} grow`} autoFocus
                onClick={() => closeConfirm(true)}>
                {confirmOpts.confirmLabel ?? '确定'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 消息弹出:顶部居中堆叠 */}
      <div className="toast-host">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.type}`} title="点击关闭"
            onClick={() => setToasts((list) => list.filter((x) => x.id !== t.id))}>
            <span className="toast-ico">{TOAST_ICON[t.type]}</span>
            <span className="toast-content">{t.content}</span>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
