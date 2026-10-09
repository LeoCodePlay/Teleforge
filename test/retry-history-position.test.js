// 执行 ChatPanel 的真实历史投影函数,验证刷新后连续失败分组与实时展示一致。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { isRealUserRow } from '../web/src/utils/compactionOrder.ts';
import { mergeAttachments, mergeDeliverables } from '../web/src/utils/mergeAttachments.ts';

const source = readFileSync(new URL('../web/src/components/ChatPanel/ChatPanel.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('ChatPanel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set(['appendSeg', 'appendText', 'appendReasoning', 'appendTools', 'collectFileChanges', 'turnsToMessages', 'FILE_CHANGE_KINDS', 'LOCAL_FILE_TOOLS']);
const selected = ast.statements.filter((s) => (
  ts.isFunctionDeclaration(s) && names.has(s.name?.text)
) || (ts.isVariableStatement(s) && s.declarationList.declarations.some((d) => names.has(d.name.getText(ast)))));
assert.equal(selected.length, names.size, '历史投影依赖应完整提取');
const js = ts.transpileModule(selected.map((s) => s.getText(ast)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const project = vm.runInNewContext(`${js}\nturnsToMessages`, { isRealUserRow, mergeAttachments, mergeDeliverables });
const retry = (n, retryGroup) => ({ role: 'notice', retry: { retry: n, retryGroup, state: 'started', error: `error-${n}`, maxRetries: 10, delayMs: 0 } });
const shape = (rows) => rows.map((r) => r.retry ? `retry(${r.retry.retry})` : r.role).join('|');

for (const assistant of [
  { role: 'assistant', content: '恢复后的正文' },
  { role: 'assistant', reasoning_content: '恢复后的思考' },
  { role: 'assistant', tool_calls: [{ id: 'call-1', function: { name: 'read_local_file', arguments: '{}' } }] }
]) {
  const rows = project([{ role: 'user', content: '问' }, retry(1, 'a'), retry(6, 'a'), assistant, retry(1, 'b'), retry(2, 'b')]);
  assert.equal(shape(rows), 'user|retry(6)|assistant|retry(2)');
  assert.equal(rows[1].retry.error, 'error-6');
  assert.equal(rows[1].forkTail, 2);
  assert.equal(rows[3].forkTail, 5);
}
assert.equal(shape(project([{ role: 'user' }, retry(6, 'a'), retry(1, 'b'), retry(2, 'b')])), 'user|retry(6)|retry(2)', '回滚后没有正文落盘也能按标识分组');
assert.equal(shape(project([{ role: 'user' }, retry(6), { role: 'assistant', content: '恢复' }, retry(1), retry(2)])), 'user|retry(6)|assistant|retry(2)', '旧日志按恢复输出边界划分');
assert.equal(shape(project([{ role: 'user' }, retry(1, 'a'), { role: 'user', compaction: { dropCount: 1 } }, retry(2, 'a')])), 'user|retry(2)|user', '压缩标记不切分连续失败');
console.log('✓ 历史重试投影:正文、思考、工具、回滚、旧日志及压缩边界通过');
