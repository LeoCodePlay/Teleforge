// CodeMirror 6 编辑器封装:代码高亮 + 左侧行号 + 编辑能力 + 右键菜单
// 主题与配色全部走主题令牌(见 FileViewer.scss 与 codeMirrorTheme.ts),随深浅主题自动翻转。
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  EditorView,
  keymap as cmKeymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  dropCursor,
  highlightSpecialChars,
  rectangularSelection,
  crosshairCursor
} from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import {
  history, defaultKeymap, historyKeymap, indentWithTab,
  undo, redo, undoDepth, redoDepth, selectAll
} from '@codemirror/commands';
import { foldGutter, indentOnInput, bracketMatching, syntaxHighlighting } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { searchKeymap } from '@codemirror/search';
import { langOf, syntaxStyle } from './codeMirrorTheme';

interface CodeEditorProps {
  /** 文件名,用于推断语言高亮 */
  fileName: string;
  /** 文件路径(local: 前缀表示本地文件),右键菜单复制路径用 */
  path: string;
  /** 初始内容(组件仅在内容加载完成后挂载,故只需一次) */
  initial: string;
  /** 内容变化回调(驱动脏标记/保存) */
  onEdit: (value: string) => void;
  /** Ctrl/Cmd + S 保存回调 */
  onSave?: () => void;
}

/** 右键菜单状态:记录打开瞬间的编辑器快照(禁用态由快照决定,防止菜单打开期间状态漂移) */
interface CtxMenuState {
  x: number;
  y: number;
  hasSel: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

const MENU_W = 210;
const MENU_H = 320;

export default function CodeEditor({ fileName, path, initial, onEdit, onSave }: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<CtxMenuState | null>(null);
  // 每次渲染刷新回调引用,让编辑器内闭包永远拿到最新 onEdit/onSave
  const cbRef = useRef({ onEdit, onSave });
  cbRef.current = { onEdit, onSave };

  useEffect(() => {
    const parent = hostRef.current;
    if (!parent) return;
    // 行号位数:按文件总行数固定 gutter 最小宽度,避免个位/两位行号切换时宽度变化导致抖动
    const digits = Math.max(1, String(initial.split('\n').length).length);
    parent.style.setProperty('--fviewer-digits', String(digits));
    // 保留文件原有行尾:配置 lineSeparator 后 CM 按 \r\n 切行,toString/save 会还原行尾
    const lineSep = initial.includes('\r\n') ? '\r\n' : '\n';
    const view = new EditorView({
      state: EditorState.create({
        doc: initial,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          // 折叠箭头:不用默认字符,由 markerDOM 生成空 span + 类名,chevron 用 CSS 伪元素绘制
          foldGutter({
            markerDOM: (open) => {
              const span = document.createElement('span');
              span.className = open ? 'fld-open' : 'fld-closed';
              return span;
            }
          }),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          EditorState.lineSeparator.of(lineSep),
          indentOnInput(),
          // 仅用本项目的高亮样式(fallback:true 让未定义的 tag 保持继承色,不套用默认浅色板)
          syntaxHighlighting(syntaxStyle, { fallback: true }),
          bracketMatching(),
          closeBrackets(),
          autocompletion(),
          rectangularSelection(),
          crosshairCursor(),
          highlightActiveLine(),
          cmKeymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...completionKeymap,
            indentWithTab,
            { key: 'Mod-s', preventDefault: true, run: () => { cbRef.current.onSave?.(); return true; } }
          ]),
          langOf(fileName),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cbRef.current.onEdit(u.state.doc.toString());
          })
        ]
      }),
      parent
    });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
    // 仅挂载时创建一次:FileViewer 在读取完成后再渲染本组件,initial 即最终内容
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 右键打开菜单:坐标夹取到视口内;快照选区/撤销重做状态用于禁用态
  const openMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const view = viewRef.current;
    if (!view) return;
    const sel = view.state.selection.main;
    setMenu({
      x: Math.max(0, Math.min(e.clientX, window.innerWidth - MENU_W - 8)),
      y: Math.max(0, Math.min(e.clientY, window.innerHeight - MENU_H - 8)),
      hasSel: !sel.empty,
      canUndo: undoDepth(view.state) > 0,
      canRedo: redoDepth(view.state) > 0
    });
  };

  // 关闭菜单:点击外部(pointerdown)/ Esc / 任意滚动 —— 与 FileManager 右键菜单同一套范式
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menuRef.current && menuRef.current.contains(t)) return;
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu]);

  const closeMenu = () => setMenu(null);

  // 复制文本:优先 Clipboard API,失败退回临时 textarea + execCommand(旧浏览器/权限受限场景)
  const copyText = async (text: string) => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return;
      }
    } catch { /* 继续走兜底 */ }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* 忽略 */ }
    document.body.removeChild(ta);
  };

  // 当前选中文本(取自编辑器 state,不依赖 DOM selection)
  const selText = () => {
    const view = viewRef.current;
    if (!view) return '';
    const sel = view.state.selection.main;
    return view.state.sliceDoc(sel.from, sel.to);
  };

  const onUndo = () => { const v = viewRef.current; if (v) { v.focus(); undo(v); } closeMenu(); };
  const onRedo = () => { const v = viewRef.current; if (v) { v.focus(); redo(v); } closeMenu(); };
  const onCut = () => {
    const view = viewRef.current;
    const text = selText();
    if (view && text) {
      void copyText(text);
      view.dispatch(view.state.replaceSelection(''));
      view.focus();
    }
    closeMenu();
  };
  const onCopy = () => {
    const text = selText();
    if (text) void copyText(text);
    closeMenu();
  };
  const onPaste = async () => {
    const view = viewRef.current;
    if (!view) return;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        const text = await navigator.clipboard.readText();
        if (text) {
          view.dispatch(view.state.replaceSelection(text));
          view.focus();
          closeMenu();
          return;
        }
      }
    } catch { /* 走 execCommand 兜底 */ }
    view.focus();
    try { document.execCommand('paste'); } catch { /* 忽略 */ }
    closeMenu();
  };
  const onSelectAll = () => { const v = viewRef.current; if (v) { selectAll(v); v.focus(); } closeMenu(); };
  const onSave = () => { cbRef.current.onSave?.(); closeMenu(); };
  const onCopyPath = () => {
    const real = path.startsWith('local:') ? path.slice('local:'.length) : path;
    void copyText(real);
    closeMenu();
  };
  const onCopyName = () => { void copyText(fileName); closeMenu(); };

  return (
    <>
      <div ref={hostRef} className="codeedit" onContextMenu={openMenu} />
      {menu && createPortal(
        <div
          ref={menuRef}
          className="ctxmenu"
          style={{ left: menu.x, top: menu.y }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button onClick={onUndo} disabled={!menu.canUndo}>↺ 撤销<span className="ctx-key">Ctrl+Z</span></button>
          <button onClick={onRedo} disabled={!menu.canRedo}>↻ 重做<span className="ctx-key">Ctrl+Y</span></button>
          <div className="ctx-sep" />
          <button onClick={onCut} disabled={!menu.hasSel}>✂ 剪切<span className="ctx-key">Ctrl+X</span></button>
          <button onClick={onCopy} disabled={!menu.hasSel}>📋 复制<span className="ctx-key">Ctrl+C</span></button>
          <button onClick={onPaste}>📥 粘贴<span className="ctx-key">Ctrl+V</span></button>
          <button onClick={onSelectAll}>全选<span className="ctx-key">Ctrl+A</span></button>
          <button onClick={onSave}>💾 保存<span className="ctx-key">Ctrl+S</span></button>
          <div className="ctx-sep" />
          <button onClick={onCopyPath}>📄 复制文件路径</button>
          <button onClick={onCopyName}>🏷 复制文件名</button>
        </div>,
        document.body
      )}
    </>
  );
}
