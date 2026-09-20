// computer-use(AI 操作本机电脑)单元测试。
//
// 覆盖四件事:
// 1. 工具结果携带的屏幕截图,能否被投影成"模型可见的视觉 user 消息",且顺序合法
//    (OpenAI 兼容协议里 tool 消息只能带文本,图片必须另起 user 消息;插错位置会让
//    tool/result 变成孤儿,严格提供商会 400)。
// 2. 控制状态机:未开启时截图/操作被拒;用户手动关闭后 AI 不能自行开启。
// 3. 工具注册与访问类别(screenshot=read,action/control=write),以及 schema 投影。
// 4. 真机截图(需 TF_COMPUTER_USE_LIVE=1,且必须在有交互桌面的 Windows 会话里跑)。
//
// 测试期间用 TF_COMPUTER_USE_NO_OVERLAY=1 抑制悬浮窗,避免刷屏;写会话历史前先隔离 DATA_DIR。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'sshai-cu-'));
process.env.TF_COMPUTER_USE_NO_OVERLAY = '1';

const { Session } = await import('../server/agent/session.ts');
const { computerUse } = await import('../server/core/computer-use/index.ts');
const { ToolRegistry } = await import('../server/agent/registry.ts');
const { registerTools } = await import('../server/agent/tools.ts');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${e}`); } };

const IMG = { id: 'att_test', name: '屏幕截图.jpg', mime: 'image/jpeg', size: 123, kind: 'image', time: 1 };

function sessionWith(results) {
  const s = new Session();
  s.append('user/message', { content: '帮我看一下屏幕' });
  s.append('assistant/message', {
    message: {
      content: '',
      tool_calls: results.map((r) => ({ id: r.callId, type: 'function', function: { name: r.name, arguments: '{}' } }))
    }
  });
  for (const r of results) {
    s.append('tool/result', {
      callId: r.callId, name: r.name, isError: false, content: r.content, ms: 1,
      ...(r.meta ? { meta: r.meta } : {})
    });
  }
  return s.deriveMessages();
}

// ---- 1. 视觉消息投影 ----
console.log('\n[1] 屏幕截图 -> 模型可见的视觉 user 消息');
{
  const msgs = sessionWith([{
    callId: 'c1', name: 'computer_screenshot', content: '已截取屏幕画面',
    meta: { visionAttachments: [IMG], visionCaption: '看这张图' }
  }]);
  const roles = msgs.map((m) => m.role).join(',');
  check('单工具调用:顺序为 user,assistant,tool,user', roles === 'user,assistant,tool,user', roles);
  const vision = msgs[msgs.length - 1];
  check('视觉消息是 user 且带图片附件', vision.role === 'user' && Array.isArray(vision.attachments)
    && vision.attachments.length === 1 && vision.attachments[0].kind === 'image', JSON.stringify(vision));
  check('视觉消息带上 caption', vision.content === '看这张图', vision.content);
  check('tool 消息保持纯文本', msgs[2].content === '已截取屏幕画面');

  const plain = sessionWith([{ callId: 'c1', name: 'computer_screenshot', content: '普通结果' }]);
  check('无附件时不额外插入消息', plain.map((m) => m.role).join(',') === 'user,assistant,tool', plain.map((m) => m.role).join(','));
}

console.log('\n[2] 多工具调用:视觉消息必须落在全部 tool/result 之后(否则 tool 消息变孤儿)');
{
  const msgs = sessionWith([
    { callId: 'c1', name: 'computer_screenshot', content: '截图1', meta: { visionAttachments: [IMG], visionCaption: '第一张' } },
    { callId: 'c2', name: 'computer_action', content: '已点击' }
  ]);
  const roles = msgs.map((m) => m.role).join(',');
  check('顺序为 user,assistant,tool,tool,user', roles === 'user,assistant,tool,tool,user', roles);
  check('视觉消息在两条 tool 之后', msgs[4].role === 'user' && msgs[4].content === '第一张', JSON.stringify(msgs[4]));
}

// ---- 3. 控制状态机 ----
console.log('\n[3] 控制状态机与安全门槛');
{
  computerUse.disableByUser(); // 归零到"用户已关闭"状态
  check('初始:未开启', computerUse.status().active === false);

  let refused = '';
  try { computerUse.requireActive('computer_screenshot'); } catch (e) { refused = e.message; }
  check('未开启时 requireActive 抛错', /未开启/.test(refused), refused.slice(0, 80));

  const blocked = computerUse.startByAi();
  check('用户手动关闭后 AI 不能自行开启', blocked.ok === false && /用户已手动停止/.test(blocked.message), blocked.message);

  const on = computerUse.enableByUser();
  check('用户开启后 active=true 且解锁', on.active === true && on.userLocked === false, JSON.stringify(on));

  const started = computerUse.startByAi();
  check('已开启后 AI start 幂等成功', started.ok === true, started.message);

  const off = computerUse.disableByUser();
  check('用户关闭后 userLocked=true', off.active === false && off.userLocked === true, JSON.stringify(off));

  const stopped = computerUse.stopByAi();
  check('AI 主动 stop 不改变用户锁定语义', stopped.ok === true && computerUse.status().userLocked === true);
}

// ---- 4. 工具注册与访问类别 ----
console.log('\n[4] 工具注册 / 访问类别 / schema 投影');
{
  const reg = new ToolRegistry();
  registerTools(reg);
  const names = ['computer_screenshot', 'computer_action', 'computer_control',
    'computer_windows', 'computer_launch', 'computer_ui', 'computer_ui_action', 'computer_ocr'];
  check('computer_* 工具均已注册', names.every((n) => !!reg.get(n)), names.filter((n) => !reg.get(n)).join(','));
  check('computer_screenshot 是只读类', reg.get('computer_screenshot')?.access === 'read', reg.get('computer_screenshot')?.access);
  check('computer_windows / computer_ui / computer_ocr 是只读类',
    ['computer_windows', 'computer_ui', 'computer_ocr'].every((n) => reg.get(n)?.access === 'read'),
    ['computer_windows', 'computer_ui', 'computer_ocr'].map((n) => `${n}=${reg.get(n)?.access}`).join(','));
  check('computer_action / computer_launch / computer_ui_action 是写类',
    ['computer_action', 'computer_launch', 'computer_ui_action'].every((n) => reg.get(n)?.access === 'write'),
    ['computer_action', 'computer_launch', 'computer_ui_action'].map((n) => `${n}=${reg.get(n)?.access}`).join(','));
  check('computer_control 是写类', reg.get('computer_control')?.access === 'write', reg.get('computer_control')?.access);

  const schemas = reg.schemas({});
  check('schema 投影包含 computer_screenshot', schemas.some((s) => s.function?.name === 'computer_screenshot'));
  check('schema 不泄露 run 等宿主字段', schemas.every((s) => !('run' in s.function) && !('timeoutMs' in s.function) && !('access' in s.function)));

  computerUse.disableByUser();
  const r = await reg.execute({ name: 'computer_screenshot', args: '{}' });
  check('未开启控制时工具执行返回结构化错误(不抛异常)', r.isError === true && /未开启/.test(r.content), r.content.slice(0, 90));
  const r2 = await reg.execute({ name: 'computer_action', args: JSON.stringify({ action: 'click', x: 1, y: 1 }) });
  check('未开启控制时 computer_action 也被拒', r2.isError === true && /未开启/.test(r2.content), r2.content.slice(0, 90));
  const r2b = await reg.execute({ name: 'computer_windows', args: '{}' });
  check('未开启控制时 computer_windows 也被拒', r2b.isError === true && /未开启/.test(r2b.content), r2b.content.slice(0, 90));
  const r3 = await reg.execute({ name: 'computer_control', args: JSON.stringify({ action: 'status' }) });
  check('computer_control status 可查询', r3.isError === false && /未开启/.test(r3.content), r3.content);
}

// ---- 5. 真机截图(可选) ----
if (process.env.TF_COMPUTER_USE_LIVE === '1' && process.platform === 'win32') {
  console.log('\n[5] 真机截图 / 坐标换算(TF_COMPUTER_USE_LIVE=1)');
  computerUse.enableByUser();
  try {
    const shot = await computerUse.capture({});
    check('截图为非空 JPEG', shot.buf.length > 1000 && shot.buf[0] === 0xff && shot.buf[1] === 0xd8, `size=${shot.buf.length}`);
    check('返回图片尺寸与缩放', shot.mapping.imgW > 0 && shot.mapping.imgH > 0, JSON.stringify(shot.mapping));
    check('返回显示器布局', Array.isArray(shot.monitors) && shot.monitors.length >= 1, JSON.stringify(shot.monitors));
    // 锁屏判断必须能读出一个明确布尔值(注意 WTSINFOEX 的联合体对齐:偏移算错会把
    // SessionState 当成 SessionFlags,导致解锁状态被误判成锁屏、整个功能被锁死)
    check('锁定状态可读且为布尔', typeof shot.locked === 'boolean', String(shot.locked));
    const before = shot.cursor;
    const ix = Math.round((before.x - shot.mapping.vx) * (shot.mapping.imgW / shot.mapping.vw));
    const iy = Math.round((before.y - shot.mapping.vy) * (shot.mapping.imgH / shot.mapping.vh));
    if (shot.locked) {
      console.log('  (当前会话处于锁屏:按设计跳过鼠标动作与坐标换算校验)');
      let refused = '';
      try { await computerUse.action({ action: 'move', x: ix, y: iy }); } catch (e) { refused = e.message; }
      check('锁屏时鼠标动作被明确拒绝', /锁屏/.test(refused), refused.slice(0, 60));
    } else {
      const mv = await computerUse.action({ action: 'move', x: ix, y: iy });
      // 用动作刚做完那一刻的光标(meta.cursor)校验换算,避免"人同时在挪鼠标"造成误判。
      // 容差放到 20px:人工移动鼠标会引入几像素抖动,而真正的 DPI/多屏换算错误是几十到几百像素。
      const got = mv.meta?.cursor;
      check('图片坐标 -> 屏幕坐标换算无明显偏差(<=20px)',
        !!got && Math.abs(got.x - before.x) <= 20 && Math.abs(got.y - before.y) <= 20,
        JSON.stringify({ before, got }));
    }

    // 窗口枚举 / 元素树 / OCR(不改变桌面状态,不激活任何窗口)
    const win = await computerUse.windows();
    check('windows 能列出可见窗口', Array.isArray(win.windows) && win.windows.length >= 1, `count=${(win.windows || []).length}`);
    const target = (win.windows || []).find((x) => x.w > 200 && x.h > 200);
    if (target) {
      const tree = await computerUse.uiTree({ hwnd: target.hwnd, maxNodes: 30 });
      check('uiTree 能返回元素结构(带 ref)', Array.isArray(tree.nodes) && tree.nodes.every((n) => typeof n.ref === 'string'),
        `nodes=${tree.count} root=${tree.root?.type}`);
      const found = await computerUse.uiFind({ hwnd: target.hwnd, query: '__不存在的控件名__', limit: 3 });
      check('uiFind 无命中时返回 0 而不是报错', found.count === 0 && typeof found.scanned === 'number', `scanned=${found.scanned}`);
      const ocr = await computerUse.ocr({ hwnd: target.hwnd });
      check('ocr 返回结构化结果(含区域与行数)', typeof ocr.count === 'number' && !!ocr.rect && typeof ocr.language === 'string',
        `lines=${ocr.count} lang=${ocr.language}`);
    }
  } finally {
    computerUse.disableByUser();
    computerUse.shutdown();
  }
} else {
  console.log('\n[5] 跳过真机截图(设 TF_COMPUTER_USE_LIVE=1 且在有桌面的 Windows 上运行可开启)');
}

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
process.exit(fail > 0 ? 1 : 0);
