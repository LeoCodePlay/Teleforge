// 全局指令注入面板(移植自 deepseek-harness 的 dsh-purge 插件)
// dsh-purge 的核心能力之一:prompt-inject.md(用户全局指令注入文件)。
// 用户在设置里维护一段全局强指令,系统提示词构建时自动注入到每次会话,
// 优先级高于普通对话(参考 dsh-purge 的 STRONG_INTRO/override 语义)。
// 注入内容存于 server/data/prompt-inject.md,仅本机可读写。
import React, { useEffect, useState } from 'react';
import { api } from '../api';

export default function PromptInjectPanel() {
  const [content, setContent] = useState('');
  const [savedText, setSavedText] = useState('');
  const [file, setFile] = useState('');
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.request('prompt_inject_get', {}, 8000)
      .then((r) => { setContent(r.content || ''); setSavedText(r.content || ''); setFile(r.file || ''); })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true);
    setErr('');
    try {
      const r = await api.request('prompt_inject_set', { content }, 8000);
      setContent(r.content || '');
      setSavedText(r.content || '');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const dirty = content !== savedText;

  return (
    <div>
      <div className="panel-title">全局指令注入</div>
      <div className="hint" style={{ marginBottom: 8 }}>
        移植自 deepseek-harness 的 dsh-purge 插件。维护一段全局强指令,<b>每次会话</b>都会自动注入到
        系统提示词中(优先级高于普通对话)。典型用途:固定工作要求、自定义行为准则、通用的编码规范。
        {file && <><br />注入文件:<code>{file}</code></>}
      </div>
      {err && <div className="error" onClick={() => setErr('')} title="点击关闭">✕ {err}</div>}
      {loading ? (
        <div className="provider-empty">正在读取注入文件…</div>
      ) : (
        <>
          <textarea className="codeedit inject-edit" rows={12} value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={'# 全局指令示例\n- 所有回答使用中文\n- 修改文件前先阅读相关上下文\n- …'} />
          <div className="row gap" style={{ marginTop: 10 }}>
            <button className="grow" onClick={() => { setContent(savedText); setErr(''); }} disabled={!dirty || saving}>恢复</button>
            <button className="primary grow" onClick={save} disabled={saving}>
              {saving ? '保存中…' : dirty ? '保存并立即生效' : '已保存'}
            </button>
          </div>
          {dirty && <div className="hint" style={{ marginTop: 6 }}>未保存的修改;保存后从下一轮对话开始生效(当前轮不变)。</div>}
        </>
      )}
    </div>
  );
}