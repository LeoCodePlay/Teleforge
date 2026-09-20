// computer-use 控制器:把「AI 操作本机电脑」的能力收敛成一个进程内单例。
//
// 能力边界(只在 Windows 上启用):
// - 截图:PowerShell 常驻 worker 抓取全部显示器(或单显示器)画面,缩放为 JPEG 交给模型;
// - 输入:鼠标移动/点击/拖拽/滚轮、任意 Unicode 文本输入、组合键;
// - 悬浮窗:每个显示器一圈高亮边框 + 顶部「AI 操控中」悬浮条,带「停止」按钮;
// - 急停:用户点悬浮窗「停止」= 立即关控制(可选同时中断 AI 当前轮),之后 AI 无法再
//   截图或操作,直到用户在界面上重新开启——AI 自己**无法**解除用户的手动关闭。
//
// 为什么用 PowerShell 而不是 native 模块:项目要能在 Windows 上零编译运行(dev 直接
// 跑 .ts、打包只带 node_modules 预编译),robotjs/nut.js 这类需要 node-gyp 的依赖会破坏
// 这条路径;PowerShell + .NET 的 WinForms/Drawing/user32 是系统自带能力,不需要额外依赖。
//
// 坐标系:worker 进程调用 SetProcessDPIAware 后按物理像素工作,截图坐标与
// SetCursorPos 坐标一致;模型看到的是缩放后的图片,坐标换算见 action() 的 toScreen。
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WORKER_PS1, OVERLAY_PS1 } from './ps-scripts.ts';

const IS_WIN = process.platform === 'win32';
const TMP_DIR = path.join(os.tmpdir(), 'teleforge-computer-use');
const PS_EXE = 'powershell.exe';
// 测试/无人值守环境用:允许开启控制状态但不真正弹出悬浮窗(见 test/computer-use.test.js)
const OVERLAY_DISABLED = process.env.TF_COMPUTER_USE_NO_OVERLAY === '1';

/** 悬浮窗后端存活轮询失败次数上限(见 OVERLAY_PS1 里的 health timer) */
export interface ComputerUseStatus {
  /** AI 当前是否被允许截图/操作(悬浮窗是否显示) */
  active: boolean;
  /** 用户是否手动关闭过:AI 无法自行解除,必须用户在界面重新开启 */
  userLocked: boolean;
  supported: boolean;
  platform: string;
}

/** 最近一次截图的坐标映射:图片像素 -> 屏幕物理像素 */
interface CaptureMapping {
  imgW: number;
  imgH: number;
  vx: number;
  vy: number;
  vw: number;
  vh: number;
}

/** 窗口选择器:三者任一即可(hwnd 最精确) */
export interface WindowSelector { hwnd?: number; pid?: number; title?: string }
/** 屏幕物理像素矩形 */
export interface ScreenRect { x: number; y: number; w: number; h: number }

function writeScript(name: string, content: string): string {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const p = path.join(TMP_DIR, name);
  // 必须带 UTF-8 BOM:Windows PowerShell 5.1 对无 BOM 的 .ps1 会按系统 ANSI(中文机为 GBK)
  // 解码,脚本里的中文注释会被解成乱码字节,进而把引号/花括号弄错位、报语法错误。
  // 每次启动都覆写:脚本随代码更新,不能读到上一次的旧副本。
  fs.writeFileSync(p, '\ufeff' + content, 'utf8');
  return p;
}

/**
 * 文本相似度(0~1),用于 OCR 结果的模糊匹配。
 * OCR 认错字很常见(实测"廖钧涛"被认成"膠钧涛"),用精确子串匹配会直接漏掉目标;
 * 这里按"逐字重合度"打分:包含关系给高分,否则算字符交集占比。
 */
function textSimilarity(a: string, b: string): number {
  const norm = (s: string) => String(s || '').toLowerCase().replace(/\s+/g, '');
  const A = norm(a);
  const B = norm(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  if (A.includes(B) || B.includes(A)) {
    return 0.9 + 0.1 * (Math.min(A.length, B.length) / Math.max(A.length, B.length));
  }
  const pool = new Map<string, number>();
  for (const c of B) pool.set(c, (pool.get(c) || 0) + 1);
  let hit = 0;
  for (const c of A) {
    const n = pool.get(c) || 0;
    if (n > 0) { hit++; pool.set(c, n - 1); }
  }
  return hit / Math.max(A.length, B.length);
}

/** 常驻 PowerShell 进程:stdin 收 JSON 行命令、stdout 回 JSON 行结果 */
class PsWorker {
  private proc: ChildProcess | null = null;
  private seq = 0;
  private buf = '';
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void; timer: NodeJS.Timeout }>();
  private startPromise: Promise<void> | null = null;

  private onData(chunk: string) {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok === false) p.reject(new Error(String(msg.error || '本机控制操作失败')));
      else p.resolve(msg);
    }
  }

  private failAll(err: Error) {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }

  private send(op: string, params: any, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const proc = this.proc;
      if (!proc || !proc.stdin || !proc.stdin.writable) return reject(new Error('本机控制助手未运行'));
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`本机控制操作超时:${op}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { proc.stdin.write(JSON.stringify({ id, op, ...params }) + '\n'); }
      catch (e: any) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  private async start(): Promise<void> {
    const script = writeScript('worker.ps1', WORKER_PS1);
    const proc = spawn(PS_EXE, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.proc = proc;
    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (d: string) => this.onData(d));
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (d: string) => {
      const s = String(d).trim();
      if (s) console.error('[computer-use] worker:', s.slice(0, 500));
    });
    proc.on('exit', () => {
      this.proc = null;
      this.startPromise = null;
      this.failAll(new Error('本机控制助手进程已退出'));
    });
    proc.on('error', (e) => {
      this.proc = null;
      this.startPromise = null;
      this.failAll(e instanceof Error ? e : new Error(String(e)));
    });
    // 就绪握手:Add-Type 编译 Win32 声明约 1s,超时放宽到 30s(首次冷启动可能更慢)
    const r = await this.send('ping', {}, 30_000);
    if (!r?.ok) throw new Error('本机控制助手启动失败');
  }

  async call(op: string, params: any = {}, timeoutMs = 20_000): Promise<any> {
    if (!this.proc) {
      if (!this.startPromise) {
        this.startPromise = this.start().catch((e) => { this.startPromise = null; throw e; });
      }
      await this.startPromise;
    }
    return this.send(op, params, timeoutMs);
  }

  dispose() {
    const p = this.proc;
    this.proc = null;
    this.startPromise = null;
    this.failAll(new Error('本机控制助手已关闭'));
    if (p) { try { p.kill(); } catch { /* 已退出 */ } }
  }
}

class ComputerUse extends EventEmitter {
  private active = false;
  private userLocked = false;
  private overlayProc: ChildProcess | null = null;
  private worker = new PsWorker();
  private port = 0;
  private lastCapture: CaptureMapping | null = null;

  /** 由服务启动时注入实际监听端口,供悬浮窗「停止」按钮回调 */
  configure({ port }: { port: number }) { this.port = port || 0; }

  status(): ComputerUseStatus {
    return { active: this.active, userLocked: this.userLocked, supported: IS_WIN, platform: process.platform };
  }

  private changed() { this.emit('change', this.status()); }

  /** AI 请求开启控制(computer_control action=start) */
  startByAi(): { ok: boolean; message: string } {
    if (!IS_WIN) return { ok: false, message: `当前平台(${process.platform})暂不支持 AI 操作电脑;该能力目前仅支持 Windows。` };
    if (this.userLocked) {
      return { ok: false, message: '用户已手动停止 AI 控制。出于安全,AI 不能自行重新开启;请让用户在界面(设置 → 工具插件 → AI 电脑操控)中重新开启后再试。' };
    }
    if (!this.active) {
      this.active = true;
      this.showOverlay();
      this.changed();
    }
    return { ok: true, message: '已开启 AI 电脑操控,所有显示器上已显示「AI 操控中」悬浮窗。' };
  }

  /** AI 主动结束控制 */
  stopByAi(): { ok: boolean; message: string } {
    if (this.active) {
      this.active = false;
      this.hideOverlay();
      this.changed();
    }
    return { ok: true, message: '已关闭 AI 电脑操控,悬浮窗已消失。' };
  }

  /** 用户在界面重新开启(同时解除手动关闭锁定) */
  enableByUser(): ComputerUseStatus {
    this.userLocked = false;
    if (IS_WIN && !this.active) {
      this.active = true;
      this.showOverlay();
    }
    this.changed();
    return this.status();
  }

  /** 用户手动关闭(界面开关或悬浮窗「停止」):锁定,AI 不得自行恢复 */
  disableByUser(): ComputerUseStatus {
    this.active = false;
    this.userLocked = true;
    this.hideOverlay();
    this.changed();
    return this.status();
  }

  /** 工具执行前的硬门槛:未开启控制时截图/操作一律拒绝 */
  requireActive(tool: string): void {
    if (!IS_WIN) throw new Error(`${tool} 目前仅支持 Windows(当前平台 ${process.platform})。`);
    if (!this.active) {
      throw new Error(`${tool} 被拒绝:AI 电脑操控当前未开启。请先调用 computer_control(action="start") 开启控制`
        + `(会弹出「AI 操控中」悬浮窗);若返回"用户已手动停止",必须请用户在界面上重新开启。`);
    }
  }

  /** 抓取屏幕画面;支持整屏 / 单显示器 / 某个窗口 / 任意屏幕矩形(区域放大看清细节) */
  async capture({ monitor, maxWidth, rect, window: winSel, all }: { monitor?: number; maxWidth?: number; rect?: ScreenRect; window?: WindowSelector; all?: boolean } = {}) {
    let useRect = rect;
    if (!useRect && winSel && Object.keys(winSel).length) {
      const wr = await this.windowRect(winSel);
      useRect = { x: wr.x, y: wr.y, w: wr.w, h: wr.h };
    }
    let useMonitor = monitor;
    // 默认不截整张多屏拼图:6000px 宽缩到 2560 后是 0.43 倍,文字和小按钮基本看不清,
    // 模型据此估坐标必然偏。默认改成"前台窗口所在的那块显示器",接近 1:1。
    if (!useRect && useMonitor == null && all !== true) {
      try {
        const p = await this.probe();
        const fg = p?.foreground;
        const mons = Array.isArray(p?.monitors) ? p.monitors : [];
        if (fg && fg.w > 0 && mons.length > 1) {
          const cx = fg.x + fg.w / 2;
          const cy = fg.y + fg.h / 2;
          const hit = mons.find((m: any) => cx >= m.x && cx < m.x + m.w && cy >= m.y && cy < m.y + m.h);
          if (hit) useMonitor = hit.index;
        }
      } catch { /* 探测失败就回落整屏 */ }
    }
    const shotPath = path.join(TMP_DIR, `shot-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`);
    const res = await this.worker.call('capture', { path: shotPath, monitor: useMonitor, max_width: maxWidth, rect: useRect }, 40_000);
    let buf: Buffer;
    try {
      buf = await fsp.readFile(shotPath);
    } finally {
      await fsp.rm(shotPath, { force: true }).catch(() => {});
    }
    this.lastCapture = {
      imgW: Number(res.width) || 1,
      imgH: Number(res.height) || 1,
      vx: Number(res.virtual?.x) || 0,
      vy: Number(res.virtual?.y) || 0,
      vw: Number(res.virtual?.w) || Number(res.width) || 1,
      vh: Number(res.virtual?.h) || Number(res.height) || 1
    };
    return { buf, ...res, mapping: this.lastCapture as CaptureMapping };
  }

  /** 只读环境信息(不开截图):显示器布局 / 光标 / 前台窗口 */
  async probe() {
    return this.worker.call('monitors', {}, 20_000);
  }

  /** 当前所有可见顶层窗口(标题/进程/位置/是否最小化/是否前台) */
  async windows() {
    return this.worker.call('windows', {}, 25_000);
  }

  /** 窗口的屏幕矩形(用于相对坐标与窗口截图) */
  async windowRect(sel: WindowSelector) {
    return this.worker.call('window_rect', sel || {}, 20_000);
  }

  /** 把窗口激活到前台(最小化会先还原) */
  async activate(sel: WindowSelector) {
    return this.worker.call('activate', sel || {}, 20_000);
  }

  /** 启动应用(不做"是否已在运行"的判断,那层逻辑在 launchApp) */
  async launch(target: string) {
    return this.worker.call('launch', { target }, 30_000);
  }

  /**
   * 打开应用:先在已运行的窗口里找,找到就激活它,**不重复启动**。
   * 这是"打开微信"这类指令的正确姿势——重复启动既慢又可能开出第二个实例。
   */
  async launchApp(target: string, match?: string) {
    const needles = [match, target].filter(Boolean).map((s) => String(s).toLowerCase());
    let list: any = { windows: [] };
    try { list = await this.windows(); } catch { /* 枚举失败就直接尝试启动 */ }
    const hit = (list.windows || []).find((w: any) => {
      const t = String(w.title || '').toLowerCase();
      const pr = String(w.process || '').toLowerCase();
      return needles.some((n) => (t && t.includes(n)) || (pr && pr.includes(n)));
    });
    if (hit) {
      const act = await this.activate({ hwnd: hit.hwnd });
      return { already: true, window: hit, activate: act };
    }
    const r = await this.launch(target);
    return { already: false, ...r };
  }

  /** UI Automation 元素树(可操作元素 + 有名字的叶子节点,带 ref) */
  async uiTree(opts: { hwnd?: number; pid?: number; title?: string; maxDepth?: number; maxNodes?: number; interactiveOnly?: boolean } = {}) {
    return this.worker.call('uia_tree', {
      hwnd: opts.hwnd, pid: opts.pid, title: opts.title,
      max_depth: opts.maxDepth, max_nodes: opts.maxNodes,
      interactive_only: opts.interactiveOnly === false ? false : true
    }, 45_000);
  }

  /** 按名字子串查找元素 */
  async uiFind(opts: { query: string; hwnd?: number; pid?: number; title?: string; limit?: number }) {
    return this.worker.call('uia_find', {
      query: opts.query, hwnd: opts.hwnd, pid: opts.pid, title: opts.title, limit: opts.limit
    }, 45_000);
  }

  /** 对元素执行动作(invoke / set_value / select / toggle / expand / collapse / focus / scroll_into_view / click_center) */
  async uiAction(opts: { ref: string; action: string; value?: string }) {
    return this.worker.call('uia_action', { ref: opts.ref, action: opts.action, value: opts.value }, 30_000);
  }

  /** 某个屏幕坐标下"到底是什么元素"(点击后自我校验用) */
  async elementAt(x: number, y: number) {
    return this.worker.call('element_at', { x, y }, 20_000);
  }

  /**
   * 对窗口/区域做 OCR,返回带屏幕坐标的文本行(自绘应用与非视觉模型的兜底)。
   * - scale:识别前把图放大几倍(默认 2),小字放大后识别率明显更高;
   * - match:给出目标文字时做**模糊匹配**(OCR 常把汉字认错,如"廖"→"膠"),
   *   按逐字重合度打分并返回最可能的几行,每行带中心坐标,直接就能点。
   */
  async ocr(opts: { hwnd?: number; pid?: number; title?: string; rect?: ScreenRect; scale?: number; match?: string; minScore?: number } = {}) {
    const png = path.join(TMP_DIR, `ocr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.png`);
    try {
      const r = await this.worker.call('ocr', {
        path: png,
        hwnd: opts.hwnd, pid: opts.pid, title: opts.title, rect: opts.rect,
        scale: Number.isFinite(Number(opts.scale)) ? Number(opts.scale) : 2
      }, 60_000);
      const lines: any[] = Array.isArray(r?.lines) ? r.lines : [];
      let matches: any[] = [];
      if (opts.match) {
        const min = Number.isFinite(Number(opts.minScore)) ? Number(opts.minScore) : 0.5;
        matches = lines
          .map((l) => ({ ...l, score: Number(textSimilarity(String(opts.match), String(l.compact || l.text || '')).toFixed(3)) }))
          .filter((l) => l.score >= min)
          .sort((a, b) => b.score - a.score)
          .slice(0, 8)
          .map((l) => ({ ...l, centerX: Math.round(l.x + l.w / 2), centerY: Math.round(l.y + l.h / 2) }));
      }
      return { ...r, lines, matches };
    } finally {
      await fsp.rm(png, { force: true }).catch(() => {});
    }
  }

  private toScreen(ix: number, iy: number): { x: number; y: number } {
    const m = this.lastCapture;
    if (!m) throw new Error('请先调用 computer_screenshot 获取屏幕画面,再按该截图的像素坐标给出 x/y。');
    return {
      x: Math.round(m.vx + ix * (m.vw / m.imgW)),
      y: Math.round(m.vy + iy * (m.vh / m.imgH))
    };
  }

  /**
   * 解析一个目标点,支持两种给法(优先相对坐标,它对窗口移动/缩放完全免疫):
   * - 相对坐标:rx/ry ∈ [0,1] + 窗口选择器(hwnd/pid/title) → 窗口内的相对位置;
   * - 图片坐标:x/y(最近一次 computer_screenshot 的像素坐标)。
   */
  private async resolvePoint(args: any, winSel: WindowSelector | undefined, which: 'from' | 'to'): Promise<{ x: number; y: number }> {
    const num = (v: unknown): number | null => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const rxKey = which === 'from' ? 'rx' : 'to_rx';
    const ryKey = which === 'from' ? 'ry' : 'to_ry';
    const rx = num(args?.[rxKey]);
    const ry = num(args?.[ryKey]);
    if (rx != null || ry != null) {
      if (rx == null || ry == null) throw new Error(`${rxKey}/${ryKey} 必须成对给出`);
      if (!winSel || !Object.keys(winSel).length) throw new Error(`使用 ${rxKey}/${ryKey} 相对坐标时必须同时指定窗口(hwnd / pid / title)`);
      const wr = await this.windowRect(winSel);
      return { x: Math.round(wr.x + rx * wr.w), y: Math.round(wr.y + ry * wr.h) };
    }
    // 屏幕物理坐标:sx/sy。computer_ocr / computer_ui 返回的就是这个坐标系,
    // 直接用它们回传的中心点点击,中间不需要任何换算(最不容易出错的一条路)。
    const sxKey = which === 'from' ? 'sx' : 'to_sx';
    const syKey = which === 'from' ? 'sy' : 'to_sy';
    const sx = num(args?.[sxKey]);
    const sy = num(args?.[syKey]);
    if (sx != null || sy != null) {
      if (sx == null || sy == null) throw new Error(`${sxKey}/${syKey} 必须成对给出`);
      return { x: Math.round(sx), y: Math.round(sy) };
    }
    const xKey = which === 'from' ? 'x' : 'to_x';
    const yKey = which === 'from' ? 'y' : 'to_y';
    const x = num(args?.[xKey]);
    const y = num(args?.[yKey]);
    if (x == null || y == null) {
      throw new Error(`需要 ${xKey}/${yKey}(截图像素坐标)、${sxKey}/${syKey}(屏幕物理坐标),或 ${rxKey}/${ryKey} + 窗口(hwnd/pid/title)`);
    }
    return this.toScreen(x, y);
  }

  /**
   * 执行一次鼠标/键盘动作。
   * 坐标两种给法:图片像素坐标(x/y),或"窗口 + 相对位置"(rx/ry)。
   * 鼠标动作完成后会回报"落点下的元素",让模型立刻知道自己点到的是不是目标。
   */
  async action(args: any): Promise<{ content: string; meta?: any }> {
    const action = String(args?.action || '').trim();
    if (!action) throw new Error('缺少 action 参数');

    // 锁屏时屏幕帧冻结、输入到不了目标应用:先拦下来,别让模型对着锁屏瞎点。
    if (action !== 'wait') {
      const sess = await this.worker.call('session', {}, 15_000);
      if (sess?.locked) {
        throw new Error('Windows 会话当前处于锁屏状态:屏幕画面不会更新、鼠标键盘输入也到不了目标应用。'
          + '请先解锁电脑屏幕(或恢复远程会话),再重试;在此之前的所有操作都是无效的。');
      }
    }

    const num = (v: unknown): number | null => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const winSel: WindowSelector | undefined = (args?.hwnd || args?.pid || args?.title)
      ? { hwnd: num(args?.hwnd) ?? undefined, pid: num(args?.pid) ?? undefined, title: args?.title ? String(args.title) : undefined }
      : undefined;
    const p: any = {};

    switch (action) {
      case 'move':
      case 'click':
      case 'double_click':
      case 'right_click':
      case 'middle_click':
      case 'down':
      case 'up': {
        const s = await this.resolvePoint(args, winSel, 'from');
        p.op = 'mouse'; p.action = action; p.x = s.x; p.y = s.y;
        if (args?.button) p.button = String(args.button);
        break;
      }
      case 'drag': {
        const a = await this.resolvePoint(args, winSel, 'from');
        const b = await this.resolvePoint(args, winSel, 'to');
        p.op = 'mouse'; p.action = 'drag'; p.x = a.x; p.y = a.y; p.to_x = b.x; p.to_y = b.y;
        break;
      }
      case 'scroll': {
        p.op = 'scroll';
        const hasPoint = args?.x != null || args?.rx != null;
        if (hasPoint) { const s = await this.resolvePoint(args, winSel, 'from'); p.x = s.x; p.y = s.y; }
        p.amount = num(args?.amount) ?? 3;
        break;
      }
      case 'type': {
        const text = String(args?.text ?? '');
        if (!text) throw new Error('type 需要 text 参数');
        p.op = 'type'; p.text = text;
        break;
      }
      case 'key': {
        const raw = args?.keys;
        let keys: string[] = [];
        if (Array.isArray(raw)) keys = raw.map((k) => String(k)).filter(Boolean);
        else if (typeof raw === 'string' && raw.trim()) keys = raw.split('+').map((k) => k.trim()).filter(Boolean);
        if (!keys.length) throw new Error('key 需要 keys,例如 ["ctrl","c"] 或 "ctrl+c"');
        p.op = 'key'; p.keys = keys;
        break;
      }
      case 'wait': {
        p.op = 'wait'; p.ms = num(args?.ms) ?? 500;
        break;
      }
      default:
        throw new Error(`未知动作:${action}(可用:move/click/double_click/right_click/middle_click/down/up/drag/scroll/type/key/wait)`);
    }

    const r = await this.worker.call(p.op, p, p.op === 'wait' ? 40_000 : 30_000);
    const fg = r?.foreground;
    const desc: string[] = [`已执行 ${action}`];
    if (p.op === 'type') desc.push(`输入 ${String(p.text).length} 个字符`);
    if (p.op === 'key') desc.push(`按键 ${(p.keys as string[]).join('+')}`);
    if (r?.cursor) desc.push(`光标 (${r.cursor.x}, ${r.cursor.y})`);
    if (fg) desc.push(`前台窗口「${fg.title || '(无标题)'}」(${fg.process || '未知进程'})`);

    // 落点自检:告诉模型"这一点下面是什么元素",点错了立刻能发现
    let under: any = null;
    if ((p.op === 'mouse' || p.op === 'scroll') && r?.cursor) {
      try {
        const ea = await this.elementAt(r.cursor.x, r.cursor.y);
        under = ea?.element || null;
        desc.push(under
          ? `落点元素:「${under.name || '(无名)'}」[${under.type}]${under.autoId ? ` id=${under.autoId}` : ''}`
          : '落点下没有 UI 元素(可能是自绘区域,建议用 computer_ocr 确认后再点)');
      } catch { /* 自检失败不影响动作结果 */ }
    }
    // meta 里带上"动作刚做完那一刻"的光标与落点元素:供前端展示与自动化校验
    // (若改用事后再查光标,人在同一时刻挪了鼠标就会误判)。
    return { content: desc.join(';') + '。', meta: { cursor: r?.cursor ?? null, elementAt: under } };
  }

  private showOverlay() {
    if (this.overlayProc) return;
    if (!IS_WIN || OVERLAY_DISABLED) return;
    const script = writeScript('overlay.ps1', OVERLAY_PS1);
    const port = this.port || 4000;
    try {
      const proc = spawn(PS_EXE, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
        '-File', script, '-Port', String(port), '-Text', 'AI 操控中'
      ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      this.overlayProc = proc;
      // 悬浮窗脚本出错(如 WinForms 异常)时进程会立刻退出,不接 stderr 就只能看到"窗口没出来"
      proc.stderr?.setEncoding('utf8');
      proc.stderr?.on('data', (d: string) => {
        const s = String(d).trim();
        if (s) console.error('[computer-use] overlay:', s.slice(0, 500));
      });
      proc.on('exit', (code) => {
        if (this.overlayProc === proc) this.overlayProc = null;
        if (code) console.error(`[computer-use] 悬浮窗进程退出,code=${code}`);
      });
      proc.on('error', (e) => {
        if (this.overlayProc === proc) this.overlayProc = null;
        console.error('[computer-use] 悬浮窗进程启动失败:', (e as Error).message);
      });
    } catch (e: any) {
      console.error('[computer-use] 悬浮窗启动异常:', e?.message || e);
    }
  }

  private hideOverlay() {
    const p = this.overlayProc;
    this.overlayProc = null;
    if (p) { try { p.kill(); } catch { /* 已退出 */ } }
  }

  /** 服务退出时清理:关悬浮窗 + 杀 worker */
  shutdown() {
    this.hideOverlay();
    this.worker.dispose();
  }
}

export const computerUse = new ComputerUse();
export type { ComputerUse };
