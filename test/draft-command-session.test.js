// 回归:/目标、/计划 在**草稿态**(点"新会话"、还没发过消息)必须能用 —— 命令自己先建会话。
//
// 背景:这两个命令过去在草稿态直接 pushCmd 一句「请先开始对话(或选好工作区)再…」拦掉。
// 但项目里会话是"第一条消息才创建",草稿态没有服务端会话,命令无处可落 —— 于是用户在工作区
// 已选好的新会话里敲 /目标 <描述> 只会看到那句提示。现在改成:命令就地 session_create,
// 再用**新建出来的 sid** 调 RPC(不能读 props.sid:那一帧它还是占位符)。
//
// 断言方式:本文件做的是 ChatPanel 的结构与关键调用检查(前端组件无法在 node 里直接渲染),
// 真正的服务端语义(/目标 落盘 + 立刻续第 1 轮)由 test/goal-plan.test.js 场景 6 覆盖。
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };

const src = readFileSync(new URL('../web/src/components/ChatPanel/ChatPanel.tsx', import.meta.url), 'utf8');

check('不再出现草稿态硬拦文案(设置目标)', !src.includes('再设置目标'), 'ChatPanel 里仍能找到「再设置目标」');
check('不再出现草稿态硬拦文案(切换计划模式)', !src.includes('再切换计划模式'), 'ChatPanel 里仍能找到「再切换计划模式」');

check('存在 ensureCommandSession 助手(草稿态就地建会话)', /const ensureCommandSession = async \(\): Promise<string \| null> =>/.test(src));
check('助手走的是与 send() 同一套建会话调用', /api\.request\('session_create', \{ transferFrom: draftSid \|\| undefined \}, 8000\)/.test(src));
check('助手把新会话交给 App(列入历史并激活)', /onSessionCreated\?\.\(created\)/.test(src));
check('助手同步事件路由,不等 props 同步', /activeRef\.current = real/.test(src));

// 两个命令:run 里必须先 ensureCommandSession,且 RPC 用返回值 target
const goalRun = /name: 'goal'[\s\S]{0,900}?ensureCommandSession\(\)[\s\S]{0,400}?api\.request\('goal_command', \{ input: query \|\| '', sid: target/.exec(src);
check('/目标 命令:先建会话,再用新 sid 调 goal_command', !!goalRun);
const planRun = /name: 'plan'[\s\S]{0,900}?ensureCommandSession\(\)[\s\S]{0,400}?api\.request\('plan_command', \{ input: query \|\| '', sid: target/.exec(src);
check('/计划 命令:先建会话,再用新 sid 调 plan_command', !!planRun);

check('两个命令都不再读 props.sid 当命令目标', !/api\.request\('(goal|plan)_command', \{ input: query \|\| '', sid: sidArg\(sid\)/.test(src));

// 建会话失败必须明确报错并中止,不能静默当成成功
check('建会话失败 → toast + 中止命令', /toast\.error\(`新建会话失败: \$\{\(e as Error\)\.message\}`\);\s*\n\s*return null;/.test(src));

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
if (fail) process.exit(1);
