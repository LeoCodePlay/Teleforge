// AI Agent 主循环:接收用户指令 -> 流式调用 LLM -> 执行工具 -> 迭代直到完成
import { AGENT } from '../config.js';
import { LlmClient } from './llm.js';
import { toolDefinitions, runTool } from './tools.js';
import { sshManager as ssh } from '../ssh-manager.js';

export class Agent {
  constructor({ emit }) {
    this.emit = emit;           // (event, payload) => void,由 ws 层转发给前端
    this.llm = null;            // LlmClient,由 llm 配置设置
    this.llmConfigured = false;
    this.history = [];          // 跨轮对话记忆(user/assistant)
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
    const messages = [system, ...this.history.map((m) => ({ ...m })), { role: 'user', content: userText }];

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
        messages.push({
          role: 'assistant',
          content: res.content || '',
          tool_calls: (res.toolCalls || []).map((t) => ({
            id: t.id, type: 'function',
            function: { name: t.name, arguments: typeof t.arguments === 'string' ? t.arguments : JSON.stringify(t.arguments) }
          }))
        });

        if (!res.toolCalls || res.toolCalls.length === 0) {
          finalText = res.content || '';
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

          messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
        }
      }

      if (iters >= AGENT.MAX_ITERS) {
        finalText = (finalText || '') + '\n\n[已达单轮最大工具迭代次数,请把任务拆小继续]';
      }

      // 记忆裁剪:保留最近 N 轮
      this.history.push({ role: 'user', content: userText }, { role: 'assistant', content: finalText });
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
    return [
      '你是运行在远程服务器上的 AI 编程助手,通过工具在远程 ssh 服务器上真实地读写文件与执行命令。',
      `远程平台: ${ssh.platform || '未知'}`,
      `工作区: ${ws}`,
      '',
      '规则:',
      '1. 所有文件读写、命令执行都必须通过工具完成,严禁编造文件内容或命令输出;看不到的结果就再查。',
      '2. 命令默认在工作区目录下执行;若需切换目录,请在命令开头显式写 cd。',
      '3. 大文件用 read_file 的 offset/maxBytes 分片读取;修改文件优先 edit_file 精确替换。',
      '4. 写/改/删仅限工作区内;绝不能删除工作区根目录;破坏性命令(rm -rf、drop table 等)必须三思。',
      '5. 任务开始时先 get_workspace_info 了解环境,执行前用 list_directory/read_file 熟悉代码,改完再用 run_command 验证。',
      '6. 回答使用用户的提问语言(默认中文)。',
      '',
      '当用户指令不明确、或工作区缺乏必要信息时,主动调用工具检查,而不是猜测。'
    ].join('\n');
  }

  _trimHistory() {
    let total = this.history.reduce((n, m) => n + String(m.content || '').length, 0);
    while (total > AGENT.HISTORY_BUDGET_CHARS && this.history.length > 4) {
      total -= String(this.history[0].content || '').length + String(this.history[1].content || '').length;
      this.history.splice(0, 2);
    }
  }
}

export const agent = new Agent({
  emit: (event, payload) => agentHub?.emit(event, payload)
});

// 由 ws 层注入
export let agentHub = null;
export function setAgentHub(h) { agentHub = h; }