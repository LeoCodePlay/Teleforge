// 工具结果附件(tool/result 的 attachments)端到端测试
//
// 背景与目标:
//   截图类工具(browser_screenshot / computer_screenshot)的产物原本只能"埋"在折叠的
//   工具卡里(靠 meta.screenshot),用户必须展开卡片才看得到。本次让工具结果可以携带
//   附件元数据,前端在卡片下方直接渲染成图片。
//
// 本测试锁死四件事:
//   1. registry.execute() 把 run() 返回的 attachments 透传到 ToolResult;
//   2. 未返回 attachments 的工具结果**不带**该字段(不能凭空造出空数组);
//   3. 非法形状(非数组)被丢弃,而不是原样塞进日志;
//   4. 落盘只有元数据(字节不進日志)——附件里的字段必须与附件库元数据同构,
//      且日志 JSON 里不出现 base64 之类的字节内容。
// 运行:node test/tool-result-attachments.test.js
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sshai-atts-'));

const { ToolRegistry } = await import('../server/agent/registry.ts');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

const registry = new ToolRegistry();

// 一个"像截图工具那样"返回附件的工具
const FAKE_META = {
  id: 'att_test_1', name: '屏幕截图.png', mime: 'image/png',
  size: 1234, kind: 'image', time: Date.now()
};
registry.register({
  name: 'fake_shot',
  description: 'test',
  access: 'read',
  run: () => ({ content: '已截图', attachments: [FAKE_META] })
});

// 一个普通工具:不返回 attachments
registry.register({
  name: 'fake_plain',
  description: 'test',
  access: 'read',
  run: () => '普通结果'
});

// 一个形状非法的工具:attachments 不是数组
registry.register({
  name: 'fake_bad',
  description: 'test',
  access: 'read',
  run: () => ({ content: '坏形状', attachments: 'not-an-array' })
});

// 一个空数组的工具:应等价于"没有附件"
registry.register({
  name: 'fake_empty',
  description: 'test',
  access: 'read',
  run: () => ({ content: '空附件', attachments: [] })
});

// ---- 1. 透传 ----
{
  const r = await registry.execute({ name: 'fake_shot', args: {} });
  check('execute 成功', r.isError === false, JSON.stringify(r));
  check('attachments 被透传', Array.isArray(r.attachments) && r.attachments.length === 1,
    JSON.stringify(r.attachments));
  check('附件元数据逐字段保真',
    r.attachments?.[0]?.id === FAKE_META.id
    && r.attachments?.[0]?.mime === 'image/png'
    && r.attachments?.[0]?.kind === 'image');
}

// ---- 2. 没有附件的工具不凭空生成字段 ----
{
  const r = await registry.execute({ name: 'fake_plain', args: {} });
  check('普通工具不返回 attachments 字段', !('attachments' in r),
    `keys=${Object.keys(r).join(',')}`);
}

// ---- 3. 非法形状被丢弃 ----
{
  const r = await registry.execute({ name: 'fake_bad', args: {} });
  check('非数组 attachments 被丢弃', !('attachments' in r),
    `keys=${Object.keys(r).join(',')}`);
  check('非法 attachments 不影响结果本身', r.isError === false && r.content === '坏形状');
}

// ---- 4. 空数组等价于无附件(避免日志里多一个恒空字段) ----
{
  const r = await registry.execute({ name: 'fake_empty', args: {} });
  check('空 attachments 数组被丢弃', !('attachments' in r),
    `keys=${Object.keys(r).join(',')}`);
}

// ---- 5. 落盘只有元数据:构造一次真实 session append,断字节不进日志 ----
{
  const { Session } = await import('../server/agent/session.ts');
  const session = new Session();
  session.append('tool/result', {
    turn: 1, step: 1, callId: 'c1', name: 'fake_shot',
    isError: false, content: '已截图', ms: 12, attachments: [FAKE_META]
  });
  const raw = JSON.stringify(session.events);
  check('日志里含附件元数据', raw.includes('att_test_1'));
  // 字节不进日志:任何超长 base64 片段都不应出现(元数据本身很短)
  const looksLikeBase64 = /[A-Za-z0-9+/]{200,}={0,2}/.test(raw);
  check('日志里不含 base64 字节内容', !looksLikeBase64);
  const ev = session.events.find((e) => e.type === 'tool/result');
  check('落盘结构保留 attachments', Array.isArray(ev?.data?.attachments) && ev.data.attachments.length === 1);
}

// ---- 6. 显示投影必须带上 attachments(否则刷新后图片消失) ----
{
  const { projectEvents } = await import('../server/agent/agent.ts');
  const events = [
    { seq: 0, time: Date.now(), type: 'turn/start', data: { turn: 1 } },
    { seq: 1, time: Date.now(), type: 'step/start', data: { turn: 1, step: 1 } },
    {
      seq: 2, time: Date.now(), type: 'assistant/message',
      data: {
        turn: 1, step: 1,
        message: { role: 'assistant', content: '', tool_calls: [{ id: 'c9', function: { name: 'fake_shot', arguments: '{}' } }] }
      }
    },
    {
      seq: 3, time: Date.now(), type: 'tool/result',
      data: {
        turn: 1, step: 1, callId: 'c9', name: 'fake_shot',
        isError: false, content: '已截图', ms: 5, attachments: [FAKE_META]
      }
    }
  ];
  const rows = projectEvents(events);
  const row = Array.isArray(rows) ? rows.find((r) => r.role === 'tool' && r.tool_call_id === 'c9') : null;
  check('显示投影带 attachments(刷新后仍可见)',
    !!row && Array.isArray(row.attachments) && row.attachments.length === 1,
    JSON.stringify(row));

  // 反向:没有附件的工具结果,投影里不该出现空数组
  const events2 = events.map((e) => e.type === 'tool/result'
    ? { ...e, data: { ...e.data, attachments: undefined } } : e);
  const row2 = projectEvents(events2).find((r) => r.role === 'tool' && r.tool_call_id === 'c9');
  check('无附件的工具结果投影不带 attachments 字段', !!row2 && !('attachments' in row2),
    JSON.stringify(row2));
}

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
if (fail) process.exit(1);
