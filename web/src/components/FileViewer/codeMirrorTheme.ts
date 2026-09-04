// CodeMirror 6 编辑器主题与语言识别
// 语法 token 只挂 .cmx-* 类名(颜色全部由 FileViewer.scss 用主题令牌填充),
// 深/浅主题自动翻转,不硬编码任何颜色。
import { HighlightStyle, StreamLanguage } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { markdown } from '@codemirror/lang-markdown';
import { sql } from '@codemirror/lang-sql';
import { cpp } from '@codemirror/lang-cpp';
import { java } from '@codemirror/lang-java';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import { rust } from '@codemirror/lang-rust';
import { go } from '@codemirror/lang-go';
import { php } from '@codemirror/lang-php';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import type { Extension } from '@codemirror/state';

/** 语法高亮:仅绑定语义化类名,配色在 scss 中由 --text-n、--accent-n、--ok-n 等主题令牌填充 */
export const syntaxStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.operatorKeyword, tags.definitionKeyword, tags.self], class: 'cmx-key' },
  { tag: [tags.string, tags.special(tags.string), tags.character], class: 'cmx-str' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], class: 'cmx-cmt' },
  { tag: [tags.number, tags.integer, tags.float, tags.bool, tags.null], class: 'cmx-num' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.definition(tags.function(tags.variableName))], class: 'cmx-fn' },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.definition(tags.typeName)], class: 'cmx-type' },
  { tag: [tags.propertyName, tags.definition(tags.propertyName)], class: 'cmx-prop' },
  { tag: [tags.tagName, tags.angleBracket], class: 'cmx-tag' },
  { tag: [tags.attributeName, tags.definition(tags.attributeName)], class: 'cmx-attr' },
  { tag: [tags.constant(tags.variableName), tags.constant(tags.propertyName), tags.macroName, tags.standard(tags.variableName)], class: 'cmx-cons' },
  { tag: [tags.heading, tags.contentSeparator], class: 'cmx-head' },
  { tag: [tags.link, tags.url], class: 'cmx-link' },
  { tag: [tags.quote], class: 'cmx-quote' },
  { tag: [tags.meta, tags.processingInstruction], class: 'cmx-meta' },
  { tag: tags.invalid, class: 'cmx-err' }
]);

/** 按文件扩展名挑选语言解析器;识别不了的返回空扩展(纯文本) */
export function langOf(fileName: string): Extension {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  switch (ext) {
    case 'js': case 'mjs': case 'cjs': case 'jsx': return javascript();
    case 'ts': case 'mts': case 'cts': return javascript({ typescript: true });
    case 'tsx': return javascript({ typescript: true, jsx: true });
    case 'py': case 'pyw': return python();
    case 'json': case 'jsonc': case 'geojson': return json();
    case 'html': case 'htm': case 'vue': return html();
    case 'css': case 'scss': case 'less': case 'pcss': case 'postcss': return css();
    case 'md': case 'markdown': case 'mdx': return markdown();
    case 'sql': return sql();
    case 'c': case 'h': case 'cpp': case 'cc': case 'cxx': case 'c++': case 'hh': case 'hpp': case 'cs': case 'm': return cpp();
    case 'java': return java();
    case 'xml': case 'svg': case 'xsl': case 'wsdl': case 'plist': return xml();
    case 'yml': case 'yaml': return yaml();
    case 'rs': return rust();
    case 'go': return go();
    case 'php': case 'phtml': return php();
    case 'sh': case 'bash': case 'zsh': case 'fish': case 'bashrc': case 'profile': return StreamLanguage.define(shell);
    default: return [];
  }
}