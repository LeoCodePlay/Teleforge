// 配置与状态消息:llm / get_status / tools_list / tool_toggle / prompt_inject_*
import { agent, toolRegistry } from '../../agent/agent.ts';
import { toolSettings } from '../../agent/tool-settings.ts';
import { getPromptInject, setPromptInject } from '../../agent/prompt-inject.ts';

export function registerConfig(rpc) {
  rpc.register('llm', async (msg, { reply, emitStatus }) => {
    // 原 ws.js llm case(205-208)逐字复制
    agent.configureLlm(msg.llm);
    reply({ type: 'ok' });
    emitStatus();
  });

  rpc.register('get_status', async (msg, { reply, emitStatus }) => {
    // 原 ws.js get_status case(308-311)逐字复制
    reply({ type: 'ok' });
    emitStatus();
  });

  rpc.register('tools_list', async (msg, { reply }) => {
    // 原 ws.js tools_list case(288-290)逐字复制
    // 工具插件管理:禁用的工具不再暴露给模型
    reply({ type: 'tools', tools: toolRegistry.listAll() });
  });

  rpc.register('tool_toggle', async (msg, { reply }) => {
    // 原 ws.js tool_toggle case(291-297)逐字复制
    const name = String(msg.name || '');
    if (!toolRegistry.get(name)) throw new Error(`工具不存在: ${name}`);
    toolSettings.setEnabled(name, msg.enabled !== false);
    reply({ type: 'tools', tools: toolRegistry.listAll() });
  });

  rpc.register('prompt_inject_get', async (msg, { reply }) => {
    // 原 ws.js prompt_inject_get case(300-302)逐字复制
    // 全局指令注入(移植自 dsh-purge 插件:prompt-inject.md)
    reply({ type: 'ok', content: getPromptInject(), file: 'server/data/prompt-inject.md' });
  });

  rpc.register('prompt_inject_set', async (msg, { reply }) => {
    // 原 ws.js prompt_inject_set case(303-307)逐字复制
    const content = setPromptInject(msg.content);
    reply({ type: 'ok', content });
  });
}
