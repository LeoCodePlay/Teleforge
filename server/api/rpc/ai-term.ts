// AI 运行终端 RPC:列表 / 拉取历史日志 / 同步尺寸 / 删除(= 停止并移除)。
// 实时输出走全局广播事件(ws.ts 里 type='ai_term'),这里只处理低频控制类请求。
// 只有这一组操作:不接受任何「向终端写入输入」的请求 —— 运行终端刻意保持只读。
import { aiTerms } from '../../core/ai-term.ts';
import type { RpcModule } from './router.ts';

export function registerAiTerm(rpc: RpcModule) {
  rpc.register('ai_term_list', async (_msg, { reply }) => {
    reply({ type: 'ai_term_list', terms: aiTerms.list() });
  });

  rpc.register('ai_term_log', async (msg, { reply }) => {
    const id = String(msg.id || '');
    reply({ type: 'ai_term_log', id, log: aiTerms.log(id), term: aiTerms.get(id) });
  });

  rpc.register('ai_term_resize', async (msg, { reply }) => {
    const ok = aiTerms.resize(String(msg.id || ''), Number(msg.cols) || 0, Number(msg.rows) || 0);
    reply({ type: 'ok', resized: ok });
  });

  rpc.register('ai_term_delete', async (msg, { reply }) => {
    const id = String(msg.id || '');
    const deleted = await aiTerms.remove(id);
    reply({ type: 'ai_term_deleted', id, deleted });
  });
}
