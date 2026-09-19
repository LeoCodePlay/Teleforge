// 「关于与更新」面板(设置面板内的最后一页):
//   ┌ 版本卡:应用标识 / 版本号 / 许可 / 配置与数据目录
//   └ 更新:检查 → 发现新版本(版本迁移 + 变更日志)→ 下载(进度)→ 重启安装
//
// 桌面生产壳走 Rust 命令;浏览器 / 开发模式优雅降级(只展示版本与 GitHub Releases 入口)。
//
// 状态机(phase)与界面映射:
//   idle / checking        → 状态行(检查中)
//   ready + hasUpdate      → 状态行(有新版本)+ 版本迁移 + 变更日志 + 下载按钮
//   ready + !hasUpdate     → 状态行(已是最新)
//   downloading            → 状态行 + 变更日志 + 进度条
//   downloaded             → 状态行(已就绪)+ 「重启并安装」主操作
//   installing             → 状态行 + 禁用按钮(安装程序已拉起,应用即将退出)
//   error                  → 状态行(失败)+ 就地重试
//
// 安装包已下载的记录落盘(见 utils/updater),重开面板仍能恢复「重启并安装」。
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { useFeedback } from '../../context/feedback';
import { isDesktop } from '../../utils/desktop';
import {
  UPDATE_REPO_URL, getUpdateInfo, downloadUpdate, installUpdate, openExternal, isAboutPreview,
  saveDownloadedUpdate, loadDownloadedUpdate, clearDownloadedUpdate,
  type UpdateInfo, type DownloadProgress
} from '../../utils/updater';
import './AboutPanel.scss';

const APP_VERSION: string = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.1.0';
/** 与 package.json / tauri.conf.json 保持一致 */
const APP_LICENSE = 'GPL-3.0';
const APP_TAGLINE = '远程 AI 编程工具:保持 SSH 连接,让 AI 在远程服务器上读写文件、执行命令。';

type Phase = 'idle' | 'checking' | 'ready' | 'downloading' | 'downloaded' | 'installing' | 'error';

/** 进度回调节流间隔:避免每个数据块都触发一次重渲染(下载大包时尤其明显) */
const PROGRESS_THROTTLE_MS = 140;

const mdParser = new Marked({ gfm: true, breaks: true });

/** 更新说明是 GitHub Release 正文(Markdown),白名单清洗后再插入 */
function renderNotes(text: string): string {
  if (!text || !text.trim()) return '';
  return DOMPurify.sanitize(mdParser.parse(text) as string, { USE_PROFILES: { html: true } });
}

function fmtSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '';
  const mb = bytes / 1024 / 1024;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function fmtSpeed(bytes: number): string {
  if (!bytes || bytes <= 0) return '';
  const mb = bytes / 1024 / 1024;
  if (mb >= 1) return `${mb.toFixed(1)} MB/s`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB/s`;
}

/** 「多久以前」:更新检查结果的时间感(超过 30 天退回具体日期,免得读者自己算) */
function fmtAgo(iso: string): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const mins = Math.floor((Date.now() - t) / 60000);
  if (mins < 1) return '刚刚发布';
  if (mins < 60) return `${mins} 分钟前发布`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前发布`;
  const days = Math.floor(hours / 24);
  if (days <= 30) return `${days} 天前发布`;
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} 发布`;
}

export default function AboutPanel() {
  const { confirm, toast } = useFeedback();
  // 桌面安装版:有完整自动更新链路;本地预览桩(仅 DEV)也按桌面分支渲染
  const desktop = isDesktop() || isAboutPreview();
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  // 浏览器 / 开发模式没有自动更新链路:直接进入 ready(只读态),不做无意义的 loading 闪烁
  const [phase, setPhase] = useState<Phase>(desktop ? 'idle' : 'ready');
  const [err, setErr] = useState('');
  const [prog, setProg] = useState({ received: 0, total: 0, percent: 0 });
  const [savedPath, setSavedPath] = useState('');
  const [dirCopied, setDirCopied] = useState(false);

  // 已发起的检查去重:面板每次打开都会挂载,避免重复打 GitHub
  const checkedRef = useRef(false);
  const startedAt = useRef(0);
  const lastTick = useRef(0);
  const dirCopiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (dirCopiedTimer.current) clearTimeout(dirCopiedTimer.current); }, []);

  const check = useCallback(async () => {
    if (!desktop) {
      setPhase('ready');
      return;
    }
    setErr('');
    setPhase('checking');
    try {
      const i = await getUpdateInfo();
      setInfo(i);
      setPhase('ready');
    } catch (e) {
      const msg = (e as Error)?.message || String(e);
      setErr(msg);
      setPhase('error');
    }
  }, [desktop]);

  // 桌面壳自动检查一次;失败不弹 toast(错误就地显示在面板里,重开设置即可重试)
  useEffect(() => {
    if (checkedRef.current) return;
    checkedRef.current = true;
    if (desktop) void check();
  }, [check, desktop]);

  // 恢复「已下载待安装」:上次下载完成的安装包若仍指向当前最新版本,直接回到 downloaded,
  // 让「重启并安装」按钮始终可见(记录已落盘,关闭设置 / 刷新面板都不丢)
  useEffect(() => {
    if (!info?.hasUpdate) return;
    const saved = loadDownloadedUpdate();
    if (saved && saved.latest === info.latest) {
      setSavedPath(saved.path);
      setPhase('downloaded');
    }
  }, [info]);

  const startDownload = async () => {
    if (!info) return;
    setErr('');
    setPhase('downloading');
    setProg({ received: 0, total: info.assetSize || 0, percent: 0 });
    startedAt.current = Date.now();
    lastTick.current = 0;
    try {
      const p = await downloadUpdate(info.assetUrl, info.fileName, (ev: DownloadProgress) => {
        // 节流:下载大包时事件非常密集,每次 setState 都会重渲染整棵子树
        const now = Date.now();
        if (now - lastTick.current < PROGRESS_THROTTLE_MS) return;
        lastTick.current = now;
        setProg({
          received: ev.received || 0,
          total: ev.total || info.assetSize || 0,
          // 收尾前不显示 100%:否则进度条先满、按钮再变,像卡住了
          percent: Math.min(0.995, ev.percent || 0)
        });
      });
      setSavedPath(p);
      setProg((s) => ({ ...s, percent: 1 }));
      saveDownloadedUpdate({ latest: info.latest, path: p, ts: Date.now() });
      setPhase('downloaded');
      toast.success(`v${info.latest} 已下载完成`);
    } catch (e) {
      const msg = (e as Error)?.message || String(e);
      setErr(msg);
      setPhase('error');
    }
  };

  const startInstall = async () => {
    if (!info || !savedPath) return;
    const ok = await confirm({
      title: '安装新版本',
      message: `将关闭当前 Teleforge 并启动安装程序 v${info.latest}。\n请先保存正在进行的工作,确定继续吗?`,
      confirmLabel: '关闭并安装'
    });
    if (!ok) return;
    setErr('');
    setPhase('installing');
    try {
      await installUpdate(savedPath);
      // 安装程序已拉起,清理已下载记录,应用随后由 Rust 自动退出
      clearDownloadedUpdate();
    } catch (e) {
      const msg = (e as Error)?.message || String(e);
      setErr(msg);
      setPhase('error');
    }
  };

  const copy = async (text: string, okMsg: string, onDone?: () => void) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast.success(okMsg);
      onDone?.();
    } catch {
      toast.error('复制失败,请手动选择文本');
    }
  };

  const copyDataDir = () => {
    void copy(info?.dataDir || '', '配置目录已复制', () => {
      setDirCopied(true);
      if (dirCopiedTimer.current) clearTimeout(dirCopiedTimer.current);
      dirCopiedTimer.current = setTimeout(() => setDirCopied(false), 2000);
    });
  };

  const busy = phase === 'checking' || phase === 'downloading' || phase === 'installing';
  const repoUrl = info?.repoUrl || UPDATE_REPO_URL;
  const pct = Math.round(prog.percent * 100);
  const elapsed = startedAt.current ? (Date.now() - startedAt.current) / 1000 : 0;
  const speed = phase === 'downloading' && elapsed > 0.3 ? prog.received / elapsed : 0;
  const notesHtml = renderNotes(info?.notes || '');

  return (
    <div className="about">
      {/* ================= 版本卡 ================= */}
      <section className="about-card" aria-label="应用信息">
        <div className="about-id">
          <img className="about-logo" src="/logo-64.png" alt="" width={46} height={46} />
          <div className="about-id-text">
            <div className="about-name">Teleforge</div>
            <div className="about-tagline">{APP_TAGLINE}</div>
          </div>
        </div>

        <dl className="about-facts">
          <div className="fact">
            <dt>当前版本</dt>
            <dd className="mono">v{APP_VERSION}</dd>
          </div>
          <div className="fact">
            <dt>许可</dt>
            <dd className="mono">{APP_LICENSE}</dd>
          </div>
          <div className="fact">
            <dt>更新源</dt>
            <dd>
              <button className="fact-link" onClick={() => void openExternal(repoUrl)}>
                GitHub Releases
              </button>
            </dd>
          </div>
        </dl>

        <div className="about-dir">
          <div className="about-dir-label">配置与数据目录</div>
          <div className="about-dir-row">
            <code data-tip={info?.dataDir || undefined} data-tip-ellipsis>
              {info?.dataDir || '%APPDATA%\\com.teleforge.desktop'}
            </code>
            <button className="sm" onClick={copyDataDir} disabled={!info?.dataDir}>
              {dirCopied ? '已复制' : '复制'}
            </button>
          </div>
          <div className="about-dir-hint">提供商、SSH 配置、会话历史等全部存于此处,安装包不携带任何用户配置。</div>
        </div>
      </section>

      {/* ================= 更新 ================= */}
      <section className="about-update" aria-labelledby="about-update-title">
        <div className="about-update-head">
          <h3 className="about-update-title" id="about-update-title">更新</h3>
          <button className="ghost sm" onClick={() => void check()} disabled={busy}>
            {phase === 'checking' ? '检查中' : '重新检查'}
          </button>
        </div>

        {/* 状态行:live region,检查结果与失败原因都靠它播报 */}
        <div
          className={`up-status ${phase}`}
          role="status"
          aria-live="polite"
          aria-busy={phase === 'checking' || phase === 'downloading'}
        >
          <span className="up-status-icon" aria-hidden="true" />
          <div className="up-status-text">
            <div className="up-status-title">
              {phase === 'idle' && '尚未检查更新'}
              {phase === 'checking' && '正在检查更新'}
              {phase === 'downloading' && '正在下载安装包'}
              {phase === 'installing' && '正在启动安装程序'}
              {phase === 'ready' && (info?.hasUpdate ? `发现新版本 v${info.latest}` : '已是最新版本')}
              {phase === 'downloaded' && `v${info?.latest || ''} 已下载,可以安装`}
              {phase === 'error' && '更新失败'}
            </div>
            <div className="up-status-desc">
              {phase === 'idle' && '点击「重新检查」从 GitHub Releases 获取最新版本。'}
              {phase === 'checking' && '正在读取 GitHub Releases 的版本信息。'}
              {phase === 'ready' && !info?.hasUpdate && `当前 v${APP_VERSION} 为最新,无需操作。`}
              {phase === 'ready' && info?.hasUpdate && (
                <>
                  {info.assetSize ? `安装包 ${fmtSize(info.assetSize)}` : '安装包大小未知'}
                  {fmtAgo(info.publishedAt) ? ` · ${fmtAgo(info.publishedAt)}` : ''}
                </>
              )}
              {phase === 'downloading' && '下载完成后会停在此处,由你决定何时安装。'}
              {phase === 'installing' && '安装程序已拉起,本应用即将退出。'}
              {phase === 'downloaded' && '安装会关闭当前应用,请先保存正在进行的工作。'}
              {phase === 'error' && (err || '未知错误')}
            </div>
          </div>
          {phase === 'error' && (
            <button className="sm" onClick={() => void (info ? startDownload() : check())}>
              {info?.hasUpdate ? '重试下载' : '重新检查'}
            </button>
          )}
          {phase === 'ready' && info?.hasUpdate && (
            <button className="primary" onClick={() => void startDownload()}>
              下载并安装
            </button>
          )}
          {phase === 'downloaded' && (
            <button className="primary" onClick={() => void startInstall()}>重启并安装</button>
          )}
        </div>

        {/* 版本迁移:旧 → 新,让「在换什么」一眼可见 */}
        {info?.hasUpdate && (phase === 'ready' || phase === 'downloading' || phase === 'downloaded' || phase === 'installing') && (
          <div className="up-migrate">
            <span className="up-ver from">
              <span className="up-ver-label">当前</span>
              <b className="mono">v{info.current}</b>
            </span>
            <span className="up-arrow" aria-hidden="true">→</span>
            <span className="up-ver to">
              <span className="up-ver-label">最新</span>
              <b className="mono">v{info.latest}</b>
            </span>
          </div>
        )}

        {/* 变更日志:详情折叠,默认展开,长正文由内容区滚动承载 */}
        {info?.hasUpdate && (
          <details className="up-notes" open>
            <summary>
              <span className="up-notes-caret" aria-hidden="true">›</span>
              更新内容
              <span className="up-notes-file mono">{info.fileName}</span>
            </summary>
            {notesHtml
              ? <div className="md up-notes-body" dangerouslySetInnerHTML={{ __html: notesHtml }} />
              : <div className="up-notes-empty">该版本没有提供更新说明。</div>}
          </details>
        )}

        {/* 下载进度:条 + 字节数 + 速率 */}
        {phase === 'downloading' && (
          <div className="up-progress" aria-hidden="true">
            <div className="up-bar">
              <div className="up-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="up-meta">
              <span className="mono">
                {prog.total
                  ? `${fmtSize(prog.received)} / ${fmtSize(prog.total)}`
                  : fmtSize(prog.received)}
              </span>
              <span className="grow" />
              {speed > 0 && <span className="mono">{fmtSpeed(speed)}</span>}
              <span className="mono up-pct">{pct}%</span>
            </div>
          </div>
        )}

        {/* 浏览器 / 开发模式:没有自动更新链路,给出明确替代路径 */}
        {!desktop && (
          <div className="up-fallback">
            <div className="up-fallback-title">当前运行在浏览器 / 开发模式</div>
            <div className="up-fallback-desc">自动更新仅在桌面安装版可用,这里可以前往 GitHub Releases 手动下载最新安装包。</div>
            <button className="sm" onClick={() => void openExternal(repoUrl)}>前往 GitHub Releases</button>
          </div>
        )}
      </section>
    </div>
  );
}
