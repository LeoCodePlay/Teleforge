// AI 电脑操控工具集(computer_*):让 Agent 真正「看屏幕 + 动鼠标键盘」。
//
// 与 browser_* 的区别:browser_* 操作的是本机 Playwright 驱动的 Chromium;computer_*
// 操作的是**用户眼前这台电脑本身**(所有显示器、任意应用窗口)。
//
// 准确率设计(这是这套工具的核心,按优先级从高到低):
//   1. computer_windows / computer_launch —— 先看目标应用是否已经在跑,在跑就激活它,
//      绝不重复启动,也不需要用 Win 键搜索再点结果(那条路最容易点错)。
//   2. computer_ui / computer_ui_action —— UI Automation 元素级操作:按控件名拿到 ref,
//      直接 Invoke/SetValue,完全不需要坐标 → 100% 不会点偏,而且返回的是文字结构,
//      不支持视觉的模型照样能用。
//   3. computer_ocr —— 自绘应用(微信/QQ 等 UIA 只暴露外壳)用 OCR 找到文字所在行,
//      按"文字 → 行坐标 → 行中心"点击,比模型自己估像素坐标准得多;同时也让非视觉模型
//      能"看到"屏幕上的文字。
//   4. computer_action 的坐标点击 —— 最后手段。优先用"窗口 + 相对位置(rx/ry)",
//      它对窗口移动/缩放/多显示器完全免疫;图片坐标(x/y)是兜底。
//   每次点击后都会回报"落点下的元素",点错了立刻能发现,而不是靠下一张图猜。
//
// 安全设计(三点,缺一不可):
// 1. 默认关闭:截图与操作都要求 computer_control(action="start") 先开启控制,
//    开启即弹出「AI 操控中」悬浮窗——只要 AI 能看屏/动手,用户就一定看得见提示。
// 2. 硬门槛:未开启时工具直接返回结构化错误,不执行任何系统调用。
// 3. 手动急停不可被 AI 解除:用户在悬浮窗或界面点了停止后,userLocked=true,
//    AI 再调 start 只会被拒绝,必须用户本人重新开启。
import { computerUse } from '../core/computer-use/index.ts';
import { saveAttachment, attachmentUrl } from '../store/attachments-store.ts';
import type { ToolDef } from './registry.ts';

const COORD_RULE = '坐标一律使用最近一次 computer_screenshot 返回图片的像素坐标'
  + '(左上角为 0,0);缩放与多显示器偏移由工具自动换算,不要自己换算。';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 窗口选择器参数(三个工具共用) */
const WINDOW_PARAMS = {
  hwnd: { type: 'integer', description: '窗口句柄(来自 computer_windows,最精确)' },
  pid: { type: 'integer', description: '进程 id(来自 computer_windows)' },
  title: { type: 'string', description: '窗口标题子串(如 "微信";多个同名窗口时取面积最大的)' }
};

function fmtWindows(list: any[]): string {
  if (!list.length) return '当前没有可见窗口。';
  return list.map((w) => {
    const marks = [w.foreground ? '前台' : '', w.minimized ? '最小化' : ''].filter(Boolean).join(',');
    return `- hwnd=${w.hwnd} pid=${w.pid} ${w.process} | 「${w.title || '(无标题)'}」 | 位置 (${w.x},${w.y}) ${w.w}x${w.h}${marks ? ` [${marks}]` : ''}`;
  }).join('\n');
}

function fmtUiNodes(nodes: any[]): string {
  if (!nodes.length) return '(没有可操作元素)';
  return nodes.map((n) => {
    const flags = [n.enabled === false ? 'disabled' : '', n.offscreen ? 'offscreen' : ''].filter(Boolean).join(',');
    const pat = (n.patterns || []).length ? ` [${(n.patterns || []).join('/')}]` : '';
    return `[${n.ref}] ${n.type} "${n.name || '(无名)'}"${n.autoId ? ` id=${n.autoId}` : ''}`
      + ` @(${n.x},${n.y}) ${n.w}x${n.h}${pat}${flags ? ` (${flags})` : ''}`;
  }).join('\n');
}

function fmtOcr(lines: any[], rect: any): string {
  if (!lines.length) return `识别区域 (${rect.x},${rect.y}) ${rect.w}x${rect.h}:没有识别到文字。`;
  return lines.map((l) => {
    const cx = Math.round(l.x + l.w / 2), cy = Math.round(l.y + l.h / 2);
    return `"${l.text}" @(${l.x},${l.y}) ${l.w}x${l.h} 中心=(${cx},${cy})`;
  }).join('\n');
}

function fmtForeground(fg: any): string {
  return fg ? `前台窗口「${fg.title || '(无标题)'}」(${fg.process || '未知进程'}) 区域 (${fg.x},${fg.y}) ${fg.w}x${fg.h}` : '';
}

function fmtMonitors(shot: any): string {
  const lines: string[] = [];
  const m = shot?.mapping;
  if (m) lines.push(`截图图片:${m.imgW}x${m.imgH}px;覆盖屏幕区域:(${m.vx},${m.vy}) ${m.vw}x${m.vh}(缩放 ${Number(shot.scale || 1).toFixed(3)})`);
  const mons = Array.isArray(shot?.monitors) ? shot.monitors : [];
  if (mons.length) lines.push('显示器:' + mons.map((s: any) => `[${s.index}]${s.primary ? '主屏' : ''} ${s.w}x${s.h} @(${s.x},${s.y})`).join(' '));
  return lines.join('\n');
}

function lockNote(shot: any): string {
  return shot?.locked
    ? '\n⚠ 这台电脑当前处于【锁屏状态】:上面的画面只是锁屏界面,鼠标键盘操作也到不了任何应用。'
      + '请先让用户解锁电脑(或恢复远程会话),否则后续所有操作都是无效的。'
    : '';
}

export const computerUseToolDefs: ToolDef[] = [
  {
    name: 'computer_windows',
    description: '列出本机当前所有可见窗口(标题/进程/句柄/位置/是否前台/是否最小化)。'
      + '这是操作电脑的**第一步**:① 判断目标应用是否已经开着(开着就不要再启动,直接 activate);'
      + '② 拿到 hwnd 供 computer_ui / computer_screenshot / computer_action 精确定位窗口;'
      + '③ 用 activate 把被遮挡/最小化的窗口切到前台。'
      + '典型用法:用户说"打开微信发消息"→ 先 computer_windows 看微信在不在 → 在就 activate,不在再 computer_launch。',
    parameters: { type: 'object', properties: {} },
    access: 'read',
    timeoutMs: 30_000,
    async run() {
      computerUse.requireActive('computer_windows');
      const r = await computerUse.windows();
      return { content: `当前可见窗口 ${(r.windows || []).length} 个:\n${fmtWindows(r.windows || [])}${lockNote(r)}` };
    }
  },

  {
    name: 'computer_launch',
    description: '打开一个应用。**会先检查它是否已经在运行**:已经在跑就直接切到前台,不会重复启动。'
      + 'app 可以是完整路径,也可以是开始菜单里的应用名(如 "微信"、"记事本"、"计算器")。'
      + 'match 可选:用来匹配已运行窗口的标题或进程名(例如 app="微信" 时 match="Weixin",'
      + '因为微信的进程名是 Weixin 而窗口标题是"微信",两者都给能提高命中率)。'
      + '启动后会等窗口出现并把窗口信息返回给你。',
    parameters: {
      type: 'object',
      properties: {
        app: { type: 'string', description: '应用名或完整路径,如 "微信" / "C:\\...\\WeChat.exe"' },
        match: { type: 'string', description: '可选的窗口匹配串(标题或进程名子串),用于判断"是否已在运行"' }
      },
      required: ['app']
    },
    access: 'write',
    timeoutMs: 60_000,
    async run(args: any) {
      computerUse.requireActive('computer_launch');
      const app = String(args?.app || '').trim();
      if (!app) throw new Error('缺少 app 参数');
      const match = args?.match ? String(args.match) : undefined;
      const r = await computerUse.launchApp(app, match);
      if (r.already) {
        const ok = r.activate?.activated === true;
        return {
          content: `「${app}」已经在运行,${ok ? '已把它切到前台' : '尝试切到前台但可能没成功'}(没有重复启动)。\n${fmtForeground(r.activate?.foreground)}\n`
            + (ok ? '接下来用 computer_ui / computer_ocr 看它的界面,再决定点哪里。'
              : '⚠ 前台窗口不是它:可能有全屏覆盖层(截图工具/录屏/锁屏),或系统拒绝了前台切换。'
                + '请先确认没有覆盖层;后续截图/OCR 会抓到覆盖层而不是这个窗口。')
        };
      }
      // 等窗口出现(最多 ~8s),让下一步操作不用瞎猜
      const needles = [match, app].filter(Boolean).map((s) => String(s).toLowerCase());
      for (let i = 0; i < 16; i++) {
        await sleep(500);
        try {
          const l = await computerUse.windows();
          const hit = (l.windows || []).find((w: any) => {
            const t = String(w.title || '').toLowerCase();
            const p = String(w.process || '').toLowerCase();
            return needles.some((n) => (t && t.includes(n)) || (p && p.includes(n)));
          });
          if (hit) {
            await computerUse.activate({ hwnd: hit.hwnd });
            return { content: `已启动「${app}」(${r.launched}),窗口已就绪并切到前台:\n- hwnd=${hit.hwnd} pid=${hit.pid} ${hit.process} 「${hit.title}」 (${hit.x},${hit.y}) ${hit.w}x${hit.h}` };
          }
        } catch { /* 继续等 */ }
      }
      return { content: `已启动「${app}」(${r.launched}),但 ${8}s 内没等到它的窗口出现。可用 computer_windows 再看一次,或截图确认。` };
    }
  },

  {
    name: 'computer_ui',
    description: '用 Windows UI Automation 读取窗口的**元素结构**(不是像素):返回可点击/可输入的元素清单,每个带 ref。'
      + '这是最准的操作方式——拿到 ref 后直接 computer_ui_action,不需要任何坐标,也不依赖视觉模型。'
      + '传 query 时按控件名/文本子串查找(等价于"找名字里含 xx 的按钮/列表项/输入框");不传 query 时返回窗口的元素树。'
      + '不传窗口参数时默认用当前前台窗口。'
      + '注意:自绘应用(微信 PC 版、部分游戏/工具)只暴露外壳,元素很少或没有名字,'
      + '这时不要硬试,改用 computer_ocr 按文字定位。',
    parameters: {
      type: 'object',
      properties: {
        ...WINDOW_PARAMS,
        query: { type: 'string', description: '按控件名/文本子串查找(省略 = 返回元素树)' },
        max_depth: { type: 'integer', description: '元素树最大深度,默认 6,最大 12' },
        max_nodes: { type: 'integer', description: '最多返回多少个元素,默认 120,最大 400' },
        interactive_only: { type: 'boolean', description: '只返回可操作元素与有名字的叶子节点,默认 true(设为 false 看完整结构)' }
      }
    },
    access: 'read',
    timeoutMs: 60_000,
    async run(args: any) {
      computerUse.requireActive('computer_ui');
      const sel = { hwnd: args?.hwnd, pid: args?.pid, title: args?.title };
      if (args?.query) {
        const r = await computerUse.uiFind({ query: String(args.query), ...sel, limit: args?.max_nodes });
        return {
          content: `在窗口里查找「${args.query}」:扫描 ${r.scanned} 个元素,命中 ${r.count} 个。\n`
            + (r.count ? fmtUiNodes(r.matches) : '没有名字匹配的元素。若是自绘应用(如微信),请改用 computer_ocr 按文字定位。')
        };
      }
      const r = await computerUse.uiTree({ ...sel, maxDepth: args?.max_depth, maxNodes: args?.max_nodes, interactiveOnly: args?.interactive_only !== false });
      return {
        content: `窗口元素树(根:「${r.root?.name || '(无标题)'}」[${r.root?.type}]):\n${fmtUiNodes(r.nodes || [])}`
          + (r.truncated ? '\n(已截断,可用 query 精确查找或用 max_nodes 调大)' : '')
      };
    }
  },

  {
    name: 'computer_ui_action',
    description: '对 computer_ui 返回的元素执行动作(首选 invoke —— 直接触发控件,完全不用坐标):'
      + 'invoke(点击/触发按钮、列表项、菜单项)、set_value(直接写入文本,比模拟键盘更可靠)、'
      + 'select(选中列表项)、toggle(勾选)、expand/collapse(展开折叠)、focus(聚焦)、'
      + 'scroll_into_view(滚动到可见)、click_center(兜底:按元素中心做物理点击)。'
      + 'ref 只在**最近一次** computer_ui 的结果里有效;界面变化后要重新调用 computer_ui 获取。',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: '元素引用,如 e7(来自 computer_ui)' },
        action: {
          type: 'string',
          enum: ['invoke', 'set_value', 'select', 'toggle', 'expand', 'collapse', 'focus', 'scroll_into_view', 'click_center'],
          description: '要执行的动作'
        },
        value: { type: 'string', description: 'set_value 时要写入的文本' }
      },
      required: ['ref', 'action']
    },
    access: 'write',
    timeoutMs: 40_000,
    async run(args: any) {
      computerUse.requireActive('computer_ui_action');
      const r = await computerUse.uiAction({ ref: String(args?.ref || ''), action: String(args?.action || ''), value: args?.value });
      return {
        content: `已对元素执行 ${r.action}:「${r.element?.name || '(无名)'}」[${r.element?.type}]。\n${fmtForeground(r.foreground)}`
      };
    }
  },

  {
    name: 'computer_ocr',
    description: '对窗口(或屏幕区域)做文字识别,返回每一行文字**及其屏幕坐标与中心点**。'
      + '两个用途:① 自绘应用(UIA 读不到内容的,如微信 PC 版)里"按文字找目标";'
      + '② 给不支持视觉的模型提供屏幕上的文字内容。'
      + '强烈建议用 match 参数直接给目标文字(如 match="廖钧涛"):OCR 认错字很常见,'
      + '工具会按逐字重合度**模糊匹配**并返回最可能的几行 + 中心坐标,直接点中心即可,不用自己比对。'
      + '识别前会自动放大 2 倍(scale 可调),小字识别率更高。'
      + '不传窗口/区域时识别整张虚拟桌面。',
    parameters: {
      type: 'object',
      properties: {
        ...WINDOW_PARAMS,
        match: { type: 'string', description: '要查找的目标文字(模糊匹配,推荐填写)' },
        min_score: { type: 'number', description: '模糊匹配的最低相似度,默认 0.5;找不到可放宽到 0.34' },
        scale: { type: 'number', description: '识别前放大倍数,默认 2,可 1~4;字很小可调到 3' },
        rect: {
          type: 'object',
          description: '只识别某个屏幕区域 {x,y,w,h}(物理像素)',
          properties: { x: { type: 'integer' }, y: { type: 'integer' }, w: { type: 'integer' }, h: { type: 'integer' } }
        }
      }
    },
    access: 'read',
    timeoutMs: 60_000,
    async run(args: any) {
      computerUse.requireActive('computer_ocr');
      const r = await computerUse.ocr({
        hwnd: args?.hwnd, pid: args?.pid, title: args?.title, rect: args?.rect,
        scale: args?.scale, match: args?.match, minScore: args?.min_score
      });
      if (args?.match) {
        const head = `在识别区域 (${r.rect.x},${r.rect.y}) ${r.rect.w}x${r.rect.h} 内模糊查找「${args.match}」:`
          + `共 ${r.count} 行,命中 ${r.matches.length} 个候选(按相似度排序):`;
        const body = r.matches.length
          ? r.matches.map((m: any) => `- 相似度 ${m.score} "${m.text}" @(${m.x},${m.y}) ${m.w}x${m.h} 中心=(${m.centerX},${m.centerY})`).join('\n')
          : '(没有足够相似的文字)可放宽 min_score(如 0.34)、把 match 换成更短的片段(如只给姓名后两个字),'
            + '或先不传 match 看全部识别结果。';
        return { content: `${head}\n${body}\n点击方式:computer_action(action="click", sx=<中心x>, sy=<中心y>)。` };
      }
      const header = `识别区域 (${r.rect.x},${r.rect.y}) ${r.rect.w}x${r.rect.h},语言 ${r.language},放大 ${r.scale}x,共 ${r.count} 行:`;
      // 整屏 OCR 可能有几百行,全塞进上下文会挤爆历史:默认只回前 120 行,
      // 需要精确找目标时用 match 参数(那条路只回少量候选)。
      const MAX_LINES = 120;
      const shown = (r.lines || []).slice(0, MAX_LINES);
      return {
        content: `${header}\n${fmtOcr(shown, r.rect)}`
          + (r.count > shown.length ? `\n(仅显示前 ${shown.length} 行,还有 ${r.count - shown.length} 行未显示;找目标请用 match 参数)` : '')
          + '\n要点击某一行:直接用它给出的中心坐标调用 computer_action(action="click", sx=<中心x>, sy=<中心y>),'
          + '这是屏幕物理坐标,不需要任何换算。点完再 computer_ocr 一次确认结果。'
      };
    }
  },

  {
    name: 'computer_screenshot',
    description: '截取本机屏幕画面并交给你观察。默认截**当前前台窗口所在的那块显示器**'
      + '(整张多屏拼图会被缩得很小,看不清细节);也可以指定 window 截某个窗口、monitor 截某块显示器、all=true 截全部显示器。'
      + '这是"操作电脑"的感知入口:每次动手前先看屏,动手后再看屏确认结果。'
      + '只有在 AI 电脑操控已开启(computer_control action="start")时才能截图,否则会被拒绝。'
      + '返回:屏幕画面图片 + 显示器布局 + 当前前台窗口 + 光标位置。' + COORD_RULE,
    parameters: {
      type: 'object',
      properties: {
        ...WINDOW_PARAMS,
        monitor: { type: 'integer', description: '只截某一块显示器(0 开始的下标)' },
        all: { type: 'boolean', description: 'true = 截取所有显示器拼成的整张虚拟桌面(适合看全局布局,会缩得比较小)' },
        max_width: { type: 'integer', description: '图片最长边像素上限,默认 2560;要看清小字可调大(如 3200)' }
      }
    },
    access: 'read',
    timeoutMs: 60_000,
    async run(args: any, ctx: any) {
      computerUse.requireActive('computer_screenshot');
      const maxWidth = Number.isFinite(Number(args?.max_width)) ? Number(args.max_width) : undefined;
      const monitor = Number.isFinite(Number(args?.monitor)) ? Number(args.monitor) : undefined;
      const winSel = (args?.hwnd || args?.pid || args?.title)
        ? { hwnd: args?.hwnd, pid: args?.pid, title: args?.title } : undefined;
      const shot = await computerUse.capture({
        monitor, maxWidth,
        window: winSel,
        all: args?.all === true
      });
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const att = await saveAttachment(shot.buf, `屏幕截图-${ts}.jpg`, 'image/jpeg');
      // 当前模型没声明视觉能力时,截图不会进入请求(见 agent.ts 的 allowVision),
      // 必须显式告诉模型"你看不到这张图",否则它会假装看到了并开始瞎点。
      const blind = ctx?.llm?.multimodal !== true;
      const content = `已截取屏幕画面(附件 id:${att.id},${Math.round(shot.buf.length / 1024)}KB)。\n`
        + fmtMonitors(shot) + '\n'
        + (shot.foreground ? `当前前台窗口:「${shot.foreground.title || '(无标题)'}」(${shot.foreground.process || '未知进程'}) 区域 (${shot.foreground.x},${shot.foreground.y}) ${shot.foreground.w}x${shot.foreground.h}\n` : '')
        + (shot.cursor ? `当前光标(屏幕物理像素):(${shot.cursor.x},${shot.cursor.y})\n` : '')
        + COORD_RULE + lockNote(shot)
        + (blind ? '\n⚠ 当前模型未声明视觉能力,这张截图不会进入你的上下文(你看不到它)。'
          + '请改用 computer_ui(元素结构)或 computer_ocr(屏幕文字)来"看"界面,这两条路不依赖视觉。' : '');
      return {
        content,
        meta: {
          screenshot: { id: att.id, url: attachmentUrl(att.id), name: att.name },
          // 供请求期把图片注入多模态模型(见 session.ts 的 visionAttachments 处理)
          visionAttachments: [att],
          visionCaption: '【本机屏幕截图】这是当前电脑屏幕画面。'
            + '要操作就调用 computer_action,x/y 用这张图的像素坐标;更推荐先用 computer_ui / computer_ocr 按名字或文字定位。',
          screen: {
            imageWidth: shot.mapping.imgW, imageHeight: shot.mapping.imgH,
            scale: shot.scale,
            virtual: shot.virtual, monitors: shot.monitors,
            cursor: shot.cursor, foreground: shot.foreground, locked: shot.locked
          }
        }
      };
    }
  },

  {
    name: 'computer_action',
    description: '在本机电脑上执行鼠标/键盘操作。**这是最后手段**:能用 computer_ui_action(元素)或 '
      + 'computer_ocr(文字)定位目标时,优先用它们,不要靠估坐标。'
      + '坐标三种给法(按优先级):① 窗口相对位置 rx/ry ∈ [0,1] + 窗口(hwnd/pid/title)——'
      + '对窗口移动/缩放/多显示器完全免疫,例如"微信窗口底部中间"= rx=0.5, ry=0.9;'
      + '② 屏幕物理坐标 sx/sy —— computer_ocr 返回的"中心=(x,y)"与 computer_ui 返回的坐标就是这一套,直接填即可;'
      + '③ 图片坐标 x/y —— 最近一次 computer_screenshot 的像素坐标。'
      + 'action 取值:move/click/double_click/right_click/middle_click/down|up(配合 move 自定义拖拽)/'
      + 'drag(从 x,y 拖到 to_x,to_y,或 rx,ry → to_rx,to_ry)/scroll(amount 正数向上)/'
      + 'type(输入文本,支持中文)/key(组合键,如 ["ctrl","c"]、["alt","tab"])/wait。'
      + '每次鼠标动作后会返回"落点下的元素",如果那不是你要点的东西,立刻停下重新定位。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['move', 'click', 'double_click', 'right_click', 'middle_click', 'down', 'up', 'drag', 'scroll', 'type', 'key', 'wait'],
          description: '要执行的动作'
        },
        ...WINDOW_PARAMS,
        rx: { type: 'number', description: '窗口内相对 x(0~1),需配合窗口参数;优先级最高' },
        ry: { type: 'number', description: '窗口内相对 y(0~1),需配合窗口参数;优先级最高' },
        sx: { type: 'integer', description: '屏幕物理坐标 x(computer_ocr / computer_ui 返回的坐标系)' },
        sy: { type: 'integer', description: '屏幕物理坐标 y' },
        x: { type: 'integer', description: '截图像素坐标 x(最近一次 computer_screenshot)' },
        y: { type: 'integer', description: '截图像素坐标 y' },
        to_x: { type: 'integer', description: 'drag 终点 x(图片坐标)' },
        to_y: { type: 'integer', description: 'drag 终点 y(图片坐标)' },
        to_sx: { type: 'integer', description: 'drag 终点 x(屏幕物理坐标)' },
        to_sy: { type: 'integer', description: 'drag 终点 y(屏幕物理坐标)' },
        to_rx: { type: 'number', description: 'drag 终点相对 x(0~1)' },
        to_ry: { type: 'number', description: 'drag 终点相对 y(0~1)' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'click/down/up 的按键,默认 left' },
        amount: { type: 'integer', description: 'scroll 的滚轮格数,正数向上、负数向下,默认 3' },
        text: { type: 'string', description: 'type 要输入的文本(任意 Unicode)' },
        keys: { type: 'array', items: { type: 'string' }, description: 'key 的按键序列,如 ["ctrl","shift","s"]、["enter"]' },
        ms: { type: 'integer', description: 'wait 的等待毫秒数,默认 500' }
      },
      required: ['action']
    },
    access: 'write',
    timeoutMs: 60_000,
    async run(args: any) {
      computerUse.requireActive('computer_action');
      return computerUse.action(args);
    }
  },

  {
    name: 'computer_control',
    description: '开启/关闭/查询 AI 对本机电脑的操作权限。'
      + 'action="start":开启控制(会在所有显示器上弹出「AI 操控中」悬浮窗),之后才能 computer_screenshot / computer_action;'
      + 'action="stop":AI 主动结束控制,悬浮窗消失;'
      + 'action="status":查询当前是否开启(并返回屏幕是否锁屏)。'
      + '注意:如果用户手动点了悬浮窗的「停止」,会进入"用户已锁定"状态,start 会被拒绝——必须请用户在界面上重新开启,AI 不能自行恢复。'
      + '需要操作电脑时,第一步就调用 action="start"。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'stop', 'status'], description: 'start=开启,stop=关闭,status=查询' }
      },
      required: ['action']
    },
    access: 'write',
    timeoutMs: 30_000,
    async run(args: any) {
      const action = String(args?.action || 'status').trim();
      if (action === 'start') {
        const r = computerUse.startByAi();
        if (!r.ok) throw new Error(r.message);
        let lockNote = '';
        try {
          const p = await computerUse.probe();
          if (p?.locked) lockNote = ' ⚠ 但电脑当前处于【锁屏状态】,截图只会得到锁屏画面、鼠标键盘操作也无效;请先让用户解锁屏幕。';
        } catch { /* 探测失败不影响开启 */ }
        return { content: r.message + ' 建议下一步:先 computer_windows 看目标应用是否已在运行,再用 computer_ui / computer_ocr 定位。' + lockNote };
      }
      if (action === 'stop') {
        return { content: computerUse.stopByAi().message };
      }
      const st = computerUse.status();
      let lockNote = '';
      try {
        const p = await computerUse.probe();
        lockNote = p?.locked ? ';屏幕状态:锁屏(操作无效,需先解锁)' : ';屏幕状态:已解锁';
      } catch { /* 探测失败只省略屏幕状态 */ }
      return {
        content: `AI 电脑操控状态:${st.active ? '已开启' : '未开启'}`
          + `;用户手动锁定:${st.userLocked ? '是(AI 无法自行开启,需用户在界面开启)' : '否'}`
          + `;平台支持:${st.supported ? '是' : `否(当前 ${st.platform},仅支持 Windows)`}`
          + lockNote
      };
    }
  }
];

/** 便于外部判断某工具名是否属于电脑操控工具集 */
export function isComputerUseTool(name: string): boolean {
  return name.startsWith('computer_');
}
