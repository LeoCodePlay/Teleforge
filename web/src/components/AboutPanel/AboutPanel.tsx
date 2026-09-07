// 「关于与更新」面板:当前版本 / 配置数据目录 / GitHub 自动更新(检查 → 下载 → 关闭应用并安装)
// 桌面生产壳走 Rust 命令;浏览器/开发模式优雅降级(仅展示版本与 GitHub 下载链接)
import React, { useCallback, useEffect, useState } from 'react';
import { useFeedback } from '../../context/feedback';
import { isDesktop } from '../../utils/desktop';
import {
  UPDATE_REPO_URL, getUpdateInfo, downloadUpdate, installUpdate, openExternal,
  saveDownloadedUpdate, loadDownloadedUpdate, clearDownloadedUpdate,
  type UpdateInfo, type DownloadProgress
} from '../../utils/updater';
import './AboutPanel.scss';

const APP_VERSION: string = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.1.0';

type Phase = 'idle' | 'checking' | 'ready' | 'downloading' | 'downloaded' | 'installing' | 'error';

function fmtSize(bytes: number): string {
  if (!bytes) return '';
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export default function AboutPanel() {
  const { confirm, toast } = useFeedback();
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [err, setErr] = useState('');
  const [progress, setProgress] = useState(0); // 0..1
  const [savedPath, setSavedPath] = useState('');

  const check = useCallback(async () => {
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
      toast.error('检查更新失败: ' + msg);
    }
  }, [toast]);

  // 桌面壳自动检查一次(静默失败);浏览器/开发模式直接进入 ready
  useEffect(() => {
    if (isDesktop()) void check();
    else setPhase('ready');
  }, [check]);

  // 恢复「已下载待安装」状态:上次下载完成的安装包若仍是最新版本,
  // 直接回到 downloaded,让「立即重启安装」按钮始终可见(下载状态已持久化,
  // 关闭设置/刷新面板不再丢失)
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
    setProgress(0);
    try {
      const p = await downloadUpdate(info.assetUrl, info.fileName, (ev: DownloadProgress) => {
        setProgress(Math.min(1, ev.percent || 0));
      });
      setSavedPath(p);
      setProgress(1);
      saveDownloadedUpdate({ latest: info.latest, path: p, ts: Date.now() });
      setPhase('downloaded');
      toast.success('新版本已下载');
      // 下载完成直接进入安装确认,避免"下载完没反应"停在原地
      await startInstall();
    } catch (e) {
      const msg = (e as Error)?.message || String(e);
      setErr(msg);
      setPhase('error');
      toast.error('下载失败: ' + msg);
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
      toast.error('启动安装失败: ' + msg);
    }
  };

  const copyDataDir = async () => {
    if (!info?.dataDir) return;
    try {
      await navigator.clipboard.writeText(info.dataDir);
      toast.success('配置目录已复制');
    } catch {
      toast.error('复制失败,请手动选择');
    }
  };

  const busy = phase === 'checking' || phase === 'downloading' || phase === 'installing';

  return (
    <div>
      {/* ---- 版本与状态 ---- */}
      <div className="about-card">
        <div className="about-logo" aria-hidden="true"><img src="/logo-64.png" alt="" /></div>
        <div className="about-meta">
          <div className="about-name">Teleforge</div>
          <div className="about-ver">v{APP_VERSION}</div>
          <div className="about-status">
            {phase === 'checking' && <span className="badge">正在检查更新…</span>}
            {phase === 'ready' && info?.hasUpdate && <span className="badge warn">发现新版本 v{info.latest}</span>}
            {phase === 'ready' && info && !info.hasUpdate && <span className="badge ok">已是最新版本</span>}
            {phase === 'error' && <span className="badge warn">检查失败</span>}
            {!isDesktop() && <span className="muted">浏览器模式不支持自动更新,请前往 GitHub Releases 下载</span>}
          </div>
        </div>
        <div className="about-actions">
          <button className="sm" onClick={() => void openExternal(info?.repoUrl || UPDATE_REPO_URL)}>
            GitHub 下载页
          </button>
          <button className="sm" onClick={() => void check()} disabled={busy}>
            {phase === 'checking' ? '检查中…' : '检查更新'}
          </button>
        </div>
      </div>

      {/* ---- 配置数据目录:安装包内不含任何用户配置,全部落盘在此 ---- */}
      {info?.dataDir ? (
        <div className="field">
          <label>配置与数据目录(提供商 / SSH 配置 / 会话历史等全部存于此处)</label>
          <div className="about-datadir">
            <code className="grow">{info.dataDir}</code>
            <button className="sm" onClick={copyDataDir}>复制</button>
          </div>
        </div>
      ) : (
        <div className="hint">桌面端安装后,配置默认位于系统 App 数据目录(Windows: %APPDATA%\com.teleforge.desktop),安装包本身不携带任何用户配置。</div>
      )}

      {err && <div className="error" onClick={() => setErr('')}>✕ {err}</div>}

      {/* ---- 更新区域 ---- */}
      {info?.hasUpdate && (
        <div className="about-update">
          <div className="panel-title">新版本 v{info.latest} · 更新内容</div>
          <div className="update-notes">{info.notes || '暂无更新说明'}</div>

          {phase === 'downloading' && (
            <div className="update-progress">
              <div className="up-bar"><div className="up-fill" style={{ width: `${Math.round(progress * 100)}%` }} /></div>
              <div className="up-pct">{Math.round(progress * 100)}%</div>
            </div>
          )}

          <div className="update-actions">
            {phase === 'ready' && (
              <button className="primary" onClick={() => void startDownload()}>
                ⬇ 下载更新{info.assetSize ? ` (${fmtSize(info.assetSize)})` : ''}
              </button>
            )}
            {phase === 'downloaded' && (
              <button className="primary" onClick={() => void startInstall()}>⚡ 立即重启安装</button>
            )}
            {phase === 'installing' && (
              <button className="primary" disabled>正在启动安装程序…</button>
            )}
          </div>
          {phase === 'downloaded' && (
            <div className="hint">安装需要关闭当前应用,请先保存正在进行的工作。已下载至:{savedPath}</div>
          )}
        </div>
      )}
    </div>
  );
}
