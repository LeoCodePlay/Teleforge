// 走完整工具层(registry.execute)看模型实际收到的文本,统计字符数(= token 的代理指标)
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'sshai-cu-out-'));
process.env.TF_COMPUTER_USE_NO_OVERLAY = '1';

const { computerUse } = await import('../server/core/computer-use/index.ts');
const { ToolRegistry } = await import('../server/agent/registry.ts');
const { registerTools } = await import('../server/agent/tools.ts');

const reg = new ToolRegistry();
registerTools(reg);
computerUse.enableByUser();

function show(label, r) {
  const len = (r.content || '').length;
  console.log(`\n=== ${label}  ok=${!r.isError} chars=${len} ≈${Math.round(len / 1.6)}tok`);
  const lines = String(r.content || '').split('\n');
  console.log(lines.slice(0, 8).join('\n') + (lines.length > 8 ? `\n… (${lines.length - 8} more lines)` : ''));
}

const win = await reg.execute({ name: 'computer_windows', args: '{}' });
show('computer_windows', win);

// 挑一个真实的窗口做 ui / ocr
const list = (await computerUse.windows()).windows || [];
const target = list.find((w) => /explorer|chrome|msedge|teleforge/i.test(w.process)) || list[0];
console.log('\n目标窗口:', JSON.stringify({ hwnd: target.hwnd, process: target.process, title: target.title }));

show('computer_ui (元素树)', await reg.execute({ name: 'computer_ui', args: JSON.stringify({ hwnd: target.hwnd, max_nodes: 40 }) }));
show('computer_ui (query)', await reg.execute({ name: 'computer_ui', args: JSON.stringify({ hwnd: target.hwnd, query: '文件' }) }));
show('computer_ocr (全部)', await reg.execute({ name: 'computer_ocr', args: JSON.stringify({ hwnd: target.hwnd, scale: 1 }) }));
show('computer_ocr (match)', await reg.execute({ name: 'computer_ocr', args: JSON.stringify({ hwnd: target.hwnd, match: target.title.slice(0, 4) || '文件' }) }));
// 把鼠标移动到"它现在所在的位置":验证落点元素自检,又不改变桌面状态
const probe = await computerUse.probe();
show('computer_action (move 原地)', await reg.execute({
  name: 'computer_action',
  args: JSON.stringify({ action: 'move', sx: probe.cursor.x, sy: probe.cursor.y })
}));

// 失效句柄必须明确报错,不能悄悄回落到前台窗口(否则模型会对着另一个窗口操作)
show('computer_ui (失效 hwnd=1)', await reg.execute({ name: 'computer_ui', args: JSON.stringify({ hwnd: 1 }) }));

// 区域截图:1:1 放大看细节
const shot = await reg.execute({
  name: 'computer_screenshot',
  args: JSON.stringify({ rect: { x: 100, y: 100, w: 800, h: 500 } })
});
show('computer_screenshot (rect 800x500)', shot);
console.log('  meta.screen =', JSON.stringify(shot.meta?.screen ? {
  imageWidth: shot.meta.screen.imageWidth, imageHeight: shot.meta.screen.imageHeight, scale: shot.meta.screen.scale
} : null));

computerUse.disableByUser();
computerUse.shutdown();
process.exit(0);
