// 用户提问回传消息:ask_user_answer / ask_user_cancel
import { answerAskUser, rejectAskUser } from '../../agent/ask-user.ts';

export function registerAskUser(rpc) {
  rpc.register('ask_user_answer', async (msg, { reply }) => {
    // 原 ws.js ask_user_answer case(468-472)逐字复制
    // 模型调用 ask_user_question 时会广播 agent 事件 ask_user(含 askId+题面),
    // 前端作答后回传;挂起的提问由 ask-user.js 管理,超时/中止/断开自动作废。
    if (!answerAskUser(msg.askId, msg.answers)) throw new Error('提问不存在或已过期');
    reply({ type: 'ok' });
  });

  rpc.register('ask_user_cancel', async (msg, { reply }) => {
    // 原 ws.js ask_user_cancel case(473-477)逐字复制
    if (!rejectAskUser(msg.askId, '用户取消了提问')) throw new Error('提问不存在或已过期');
    reply({ type: 'ok' });
  });
}
