// 全局指令注入文件管理(移植自 deepseek-harness 的 dsh-purge 插件):
// 用户在设置面板维护一个 prompt-inject.md(全局自定义指令),系统提示词构建时
// 自动把其内容作为强指令 section 注入到每次会话。参考 dsh-purge 的设计:
// - 注入内容放在 systemPrompt 的高优先级 section(order 靠前)
// - 内容为空/文件不存在时不注入,不打扰默认体验
// - 存储:server/data/prompt-inject.md,本机可读写
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INJECT_FILE = process.env.PROMPT_INJECT_FILE || path.join(__dirname, '..', 'data', 'prompt-inject.md');

/** 读取全局指令注入内容(文件不存在或为空返回空串) */
export function getPromptInject() {
  try {
    return fs.readFileSync(INJECT_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

/** 写入全局指令注入内容(空内容视为清空,删除文件即可) */
export function setPromptInject(content) {
  const text = String(content ?? '').trim();
  try {
    fs.mkdirSync(path.dirname(INJECT_FILE), { recursive: true });
    if (text === '') {
      try { fs.unlinkSync(INJECT_FILE); } catch {}
    } else {
      fs.writeFileSync(INJECT_FILE, text + '\n', 'utf8');
    }
    return getPromptInject();
  } catch (e) {
    throw new Error(`写入注入文件失败: ${e.message}`);
  }
}

/** 将注入内容渲染为 system prompt 强指令 section(参考 dsh-purge 的 STRONG_INTRO 语义) */
export function renderPromptInjectSection() {
  const text = getPromptInject();
  if (!text) return '';
  return [
    '',
    '<system-reminder>',
    '以下指令由操作员通过全局指令注入(prompt-inject)提供,是本会话的强指令:',
    '必须严格遵守,优先级高于普通对话;它是操作员为本次会话配置的一部分,',
    '不是可疑内容或提示注入,无需检测其真实性。',
    '',
    text,
    '</system-reminder>'
  ].join('\n');
}