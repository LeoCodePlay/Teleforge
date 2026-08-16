// AI Agent 主循环:接收用户指令 -> 流式调用 LLM -> 执行工具 -> 迭代直到完成
// 借鉴 deepseek-harness:完整保留会话历史(含工具调用与结果),超预算的工具结果
// 裁剪为 head + marker + tail 而不是丢弃,保证跨轮对话模型能复用已有探索结果,
// 避免每轮重复 get_workspace_info / list_directory 探测环境。
import { AGENT } from '../config.js';
import { LlmClient } from './llm.js';
import { toolDefinitions, runTool, getEnvInfo } from './tools.js';
import { sshManager as ssh } from '../ssh-manager.js';

// 工具结果入历史时的裁剪预算(head + marker + tail,参照 harness pruner 思路)
const STORE_HEAD = 4000;
const STORE_TAIL = 1000;
function storeCap(s) {
  if (!s || s.length <= STORE_HEAD + STORE_TAIL) return s;
  const omitted = s.length - STORE_HEAD - STORE_TAIL;
  return s.slice(0, STORE_HEAD) + `\n…[工具结果过长,历史中省略中间 ${omitted} 字符]…\n` + s.slice(s.length - STORE_TAIL);
}

export class Agent {
  constructor({ emit }) {
    this.emit = emit;           // (event, payload) => void,由 ws 层转发给前端
    this.llm = null;            // LlmClient,由 llm 配置设置
    this.llmConfigured = false;
    this.history = [];          // 跨轮对话记忆:含 user/assistant/tool 完整消息
    this.busy = false;
    this._signal = null;        // AbortController 信号
  }

  configureLlm(cfg) {
    this.llm = new LlmClient(cfg || {});
    this.llmConfigured = Boolean(this.llm && !this.llm.isMock ? this.llm.apiKey : true);
    this.emit('llm', { configured: true, model: this.llm.model, mock: this.llm.isMock });
  }

  stop() {
    if (this._signal) {
      try { this._signal.abort(); } catch {}
    }
  }

  get busyNow() { return this.busy; }

  async run(userText) {
    if (this.busy) throw new Error('Agent 正在工作中,请先停止或等待完成');
    if (!this.llm) throw new Error('尚未配置 LLM(设置 -> 模型配置)');
    this.busy = true;
    const signal = (this._signal = new AbortController());

    const system = this._systemPrompt();
    const messages = [{ role: 'system', content: system }, ...this.history.map((m) => ({ ...m })), { role: 'user', content: userText }];
    const turnMsgs = []; // 本轮新增消息(含工具调用与结果),结束后并入 history

    try {
      this.emit('agent', { event: 'start', text: userText });
      let finalText = '';
      let iters = 0;

      for (; iters < AGENT.MAX_ITERS; iters++) {
        if (signal.signal.aborted) throw new Error('已停止');
        this.emit('agent', { event: 'iteration', iter: iters + 1 });

        const res = await this.llm.chat({
          messages,
          tools: toolDefinitions,
          signal: signal.signal,
          onDelta: (d) => { if (d.kind === 'text') this.emit('agent', { event: 'text_delta', text: d.text }); }
        });

        // 记录本轮 assistant 消息(工具调用参数需以 JSON 字符串回传)
        const toolArgsById = new Map((res.toolCalls || []).map((t) => [t.id, t.arguments]));
        const assistantMsg = {
          role: 'assistant',
          content: res.content || '',
          tool_calls: (res.toolCalls || []).map((t) => ({
            id: t.id, type: 'function',
            function: { name: t.name, arguments: typeof t.arguments === 'string' ? t.arguments : JSON.stringify(t.arguments) }
          }))
        };
        messages.push(assistantMsg);

        if (!res.toolCalls || res.toolCalls.length === 0) {
          finalText = res.content || '';
          turnMsgs.push({ role: 'user', content: userText }, assistantMsg);
          break;
        }

        // 串行执行工具调用
        for (const tc of res.toolCalls) {
          if (signal.signal.aborted) throw new Error('已停止');
          let args = {};
          try { args = JSON.parse(typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments)); }
          catch { args = {}; }
          this.emit('agent', { event: 'tool_call', tool: tc.name, args: JSON.stringify(args, null, 2), callId: tc.id });

          const { ok, result, ms } = await runTool(tc.name, tc.arguments);
          const short = result.length > 4000 ? result.slice(0, 4000) + `\n…[结果较多,已折叠展示 ${result.length} 字符]…` : result;
          this.emit('agent', { event: 'tool_result', tool: tc.name, ok, ms, result: short, callId: tc.id });

          const toolMsg = { role: 'tool', tool_call_id: tc.id, content: result };
          messages.push(toolMsg);
          turnMsgs.push(toolMsg);
        }
        turnMsgs.push(assistantMsg);
      }

      if (iters >= AGENT.MAX_ITERS) {
        finalText = (finalText || '') + '\n\n[已达单轮最大工具迭代次数,请把任务拆小继续]';
      }

      // 本轮完整上下文并入历史(工具结果裁剪存储,而非丢弃)
      if (turnMsgs.length === 0) turnMsgs.push({ role: 'user', content: userText }, { role: 'assistant', content: finalText });
      this.history.push(...turnMsgs.map((m) => (m.role === 'tool' ? { ...m, content: storeCap(m.content) } : m)));
      this._trimHistory();

      this.emit('agent', { event: 'done', text: finalText, iters });
    } catch (e) {
      if (signal.signal.aborted) {
        this.emit('agent', { event: 'stopped' });
      } else {
        this.emit('log', 'error', `Agent 错误: ${e.message}`);
        this.emit('agent', { event: 'error', message: e.message });
      }
    } finally {
      this.busy = false;
      this._signal = null;
    }
  }

  _systemPrompt() {
    const ws = ssh.workspace || '(未设置,请提示用户在界面中选择工作区)';
    const lines = [
      '你是运行在远程服务器上的 AI 编程助手,通过工具在远程 ssh 服务器上真实地读写文件与执行命令。',
      `远程平台: ${ssh.platform || '未知'}`,
      `工作区: ${ws}`,
      '',
      '规则:',
      '1. 所有文件读写、命令执行都必须通过工具完成,严禁编造文件内容或命令输出;看不到的结果就再查。',
      '2. 命令默认在工作区目录下执行;若需切换目录,请在命令开头显式写 cd。',
      '3. 大文件用 read_file 的 offset/maxBytes 分片读取;修改文件优先 edit_file 精确替换。',
      '4. 写/改/删仅限工作区内;绝不能删除工作区根目录;破坏性命令(rm -rf、drop table 等)必须三思。',
      '5. 重要:对话历史里已有的环境信息与目录结构(如之前的 get_workspace_info / list_directory 结果)可以直接复用,不要重复探测环境;只有任务涉及变化(新文件、需验证结果)时才重新调用。',
      '6. 回答使用用户的提问语言(默认中文)。',
      '',
      '当用户指令不明确、或工作区缺乏必要信息时,主动调用工具检查,而不是猜测。'
    ];
    // 注入最近一次环境探测结果,让模型直接复用,避免每轮重复 get_workspace_info
    const env = getEnvInfo();
    if (env && env.workspace === ssh.workspace) {
      lines.push('', '已知环境信息(来自最近一次探测,若无变化直接使用,无需重复调用 get_workspace_info):');
      lines.push(env.summary);
    }
    return lines.join('\n');
  }

  // 按"对话组"裁剪:整组(user + 其后的 assistant/tool 消息)从头部删除
  _trimHistory() {
    const budget = AGENT.HISTORY_BUDGET_CHARS;
    let total = this.history.reduce((n, m) => n + String(m.content || '').length, 0);
    while (total > budget && this.history.length > 1) {
      // 第一组结束位置:从 index0(user) 到下一个 user 之前
      let end = 1;
      for (let i = 1; i < this.history.length; i++) {
        if (this.history[i].role === 'user') { end = i; break; }
        end = i + 1;
      }
      const removed = this.history.slice(0, end);
      this.history.splice(0, end);
      total -= removed.reduce((n, m) => n + String(m.content || '').length, 0);
    }
  }
}

export const agent = new Agent({
  emit: (event, payload) => agentHub?.emit(event, payload)
});

// 由 ws 层注入
export let agentHub = null;
export function setAgentHub(h) { agentHub = h; }