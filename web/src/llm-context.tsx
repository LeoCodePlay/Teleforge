// LLM 配置全局状态:右侧连接面板与聊天输入框下方的「提供方/模型」切换器共享同一份状态
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { PROVIDERS, DEFAULT_PROVIDER } from './llm-providers';
import { useFeedback } from './feedback';
import type { LlmProvider, ProviderDraft, ModelContextConfig } from './types';

const LS = (k: string, v: string) => localStorage.getItem('sshai.' + k) || v;
const LSS = (k: string, v: string) => localStorage.setItem('sshai.' + k, v);
const initialProviderId = () => LS('llm.provider', '') || DEFAULT_PROVIDER;
// 删除对象某个 key 并返回新对象(避免直接修改 React 状态里的对象)
const omitKey = <T extends Record<string, unknown>>(o: T, k: string): T => {
  const n = { ...o };
  delete n[k];
  return n;
};

// 模型未显式配置上下文能力时的全局兜底默认:1M 输入上下文 / 32k 输出上限
// (预置提供方与用户自定义提供方、乃至手动输入模型名都生效)
// 注意:不要给过大的 maxTokens——部分网关(如 tokenrhythm 的 glm-5.3)有硬上限(131072),
// 超过会直接 400;32k 是多数中转都接受的安全默认。
const FALLBACK_CONTEXT: ModelContextConfig = { contextWindow: 1000000, maxTokens: 32000 };

// 按「提供方 + 模型」单独保存的单轮最大工具迭代次数(存 JSON 映射,key 为模型名)
const LS_ITERS_PREFIX = 'sshai.llm.maxIters.';
const loadModelIters = (pid: string, model: string): string => {
  if (!pid || !model) return '';
  try {
    const m = JSON.parse(localStorage.getItem(LS_ITERS_PREFIX + pid) || '{}');
    return m[model] ? String(m[model]) : '';
  } catch { return ''; }
};
const saveModelIters = (pid: string, model: string, val: string) => {
  if (!pid || !model) return;
  try {
    const key = LS_ITERS_PREFIX + pid;
    const m = JSON.parse(localStorage.getItem(key) || '{}');
    if (val && Number(val) > 0) m[model] = String(Math.floor(Number(val)));
    else delete m[model];
    localStorage.setItem(key, JSON.stringify(m));
  } catch { /* 存储失败静默 */ }
};

export interface LlmContextValue {
  userProviders: LlmProvider[];
  allProviders: LlmProvider[];
  providerId: string;
  provider: LlmProvider;
  isUser: boolean;
  isMock: boolean;
  model: string;
  setModel: React.Dispatch<React.SetStateAction<string>>;
  customModel: string;
  setCustomModel: React.Dispatch<React.SetStateAction<string>>;
  apiKey: string;
  setApiKey: React.Dispatch<React.SetStateAction<string>>;
  effModel: string;
  /** 当前模型生效的上下文能力(显式配置优先,否则全局默认 1M/300k) */
  effModelContext: ModelContextConfig;
  effBaseUrl: string;
  effKey: string;
  maxIters: string;
  setMaxIters: React.Dispatch<React.SetStateAction<string>>;
  switchProvider: (id: string) => void;
  addProvider: (d: ProviderDraft) => Promise<boolean>;
  updateProvider: (id: string, d: ProviderDraft) => Promise<boolean>;
  duplicateProvider: (id: string) => Promise<void>;
  removeProvider: (id: string) => Promise<void>;
  err: string;
  setErr: React.Dispatch<React.SetStateAction<string>>;
}

const Ctx = createContext<LlmContextValue | null>(null);
export const useLlm = (): LlmContextValue => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useLlm 必须在 LlmProvider 内使用');
  return v;
};

export function LlmProvider({ children }: { children: React.ReactNode }) {
  const { confirm } = useFeedback();
  // ---- LLM 配置:「我的提供商」来自服务端配置文件 + 预置条目 ----
  const [userProviders, setUserProviders] = useState<LlmProvider[]>([]);
  const allProviders: LlmProvider[] = [...userProviders, ...PROVIDERS];
  const [providerId, setProviderId] = useState(initialProviderId);
  const provider = allProviders.find((p) => p.id === providerId) || allProviders[0];
  const isUser = userProviders.some((p) => p.id === providerId);
  const isMock = providerId === 'mock';
  const [model, setModel] = useState<string>(() => LS('llm.model.' + initialProviderId(), ''));
  const [customModel, setCustomModel] = useState<string>(() => LS('llm.customModel', ''));
  const [apiKey, setApiKey] = useState<string>(() => LS('llm.key.' + initialProviderId(), '') || (initialProviderId() === DEFAULT_PROVIDER ? LS('llmKey', '') : ''));
  const [err, setErr] = useState('');
  // 当前使用模型的单轮最大工具迭代次数('' = 未单独配置,用全局默认 300)
  const [maxIters, setMaxIters] = useState('');
  // 提供方是否已从服务端加载完成(加载完成前不渲染 UI,避免首帧误显示为 mock 再跳变抖动)
  const [ready, setReady] = useState(false);
  // 后端持久化的「选择级配置」(权威):当前提供方/自定义模型名/各提供方模型/Key/迭代上限
  // 后端 JSON 为唯一权威源,localStorage 仅作离线缓存,两者在持久化时同步写入
  const [uiStateData, setUiStateData] = useState<{
    providerId: string;
    customModel: string;
    models: Record<string, string>;
    keys: Record<string, string>;
    maxIters: Record<string, Record<string, string>>;
  }>({ providerId: '', customModel: '', models: {}, keys: {}, maxIters: {} });
  const uiTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 挂载时加载「我的提供商」+「选择级配置」(均存服务端 JSON 文件)
  const keyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    (async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000); // 后端未响应时兜底,3s 后降级
      try {
        const r = await fetch('/api/providers', { signal: ctrl.signal });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || '加载失败');
        const list = Array.isArray(j.userProviders) ? j.userProviders as LlmProvider[] : [];
        setUserProviders(list);
        // 选择级配置(后端 JSON 为权威);接口不可用/异常时降级为 localStorage
        let us: {
          providerId: string;
          customModel: string;
          models: Record<string, string>;
          keys: Record<string, string>;
          maxIters: Record<string, Record<string, string>>;
        } = { providerId: '', customModel: '', models: {}, keys: {}, maxIters: {} };
        try {
          const ur = await fetch('/api/ui-state', { signal: ctrl.signal });
          if (ur.ok) {
            const uj = await ur.json();
            if (uj.uiState && typeof uj.uiState === 'object') us = uj.uiState;
          }
        } catch { /* 后端无此接口/失败,沿用 localStorage */ }
        setUiStateData({
          providerId: us.providerId || '',
          customModel: us.customModel || '',
          models: us.models || {},
          keys: us.keys || {},
          maxIters: us.maxIters || {}
        });
        // 当前选中提供方:后端优先 → localStorage → 默认;并校验存在性
        const pid = us.providerId && [...list, ...PROVIDERS].some((p) => p.id === us.providerId)
          ? us.providerId
          : initialProviderId();
        const finalPid = [...list, ...PROVIDERS].some((p) => p.id === pid) ? pid : DEFAULT_PROVIDER;
        setProviderId(finalPid);
        // 模型:后端保存的该提供方模型优先,否则 localStorage
        const savedModel = (us.models && typeof us.models[finalPid] === 'string' && us.models[finalPid]) || LS('llm.model.' + finalPid, '');
        if (savedModel) setModel(savedModel);
        // 自定义模型名(后端优先)
        if (typeof us.customModel === 'string' && us.customModel) setCustomModel(us.customModel);
        // Key:用户提供方实体(ai-providers.json)优先 → 后端 keys → localStorage
        const provEnt = list.find((x) => x.id === finalPid);
        const savedKey = provEnt?.apiKey
          || (us.keys && typeof us.keys[finalPid] === 'string' && us.keys[finalPid])
          || LS('llm.key.' + finalPid, '')
          || (finalPid === DEFAULT_PROVIDER ? LS('llmKey', '') : '');
        if (savedKey) setApiKey(savedKey);
      } catch (e) { setErr('加载我的 AI 提供商失败:' + (e as Error).message); }
      finally { clearTimeout(timer); setReady(true); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- 生效配置 ----
  const effModel = isMock ? 'mock'
    : provider.models.length === 0 ? model
      : model === '__custom__' ? customModel
        : (model || provider.models[0] || '');
  // 当前模型生效的上下文能力:该模型显式配置优先,否则全局兜底默认(1M/32k)
  const effModelContext: ModelContextConfig = provider.modelConfig?.[effModel] || FALLBACK_CONTEXT;
  const effBaseUrl = provider.baseUrl;
  const effKey = isMock ? '' : apiKey;

  // 切换提供商:恢复该条目的 Key 与上次使用的模型(优先后端保存的选择级配置)
  const switchProvider = (pid: string) => {
    const p = allProviders.find((x) => x.id === pid);
    setProviderId(pid);
    setApiKey(p?.apiKey || uiStateData.keys?.[pid] || LS('llm.key.' + pid, ''));
    const saved = uiStateData.models?.[pid] || LS('llm.model.' + pid, '');
    setModel(saved || p?.models?.[0] || '');
  };

  // 写回「我的提供商」的 Key:去抖后保存到服务端配置文件(随条目删除一并删除)
  const persistUserKey = (id: string, key: string) => {
    if (keyTimer.current) clearTimeout(keyTimer.current);
    keyTimer.current = setTimeout(async () => {
      try {
        const r = await fetch('/api/providers/' + id, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey: key })
        });
        if (!r.ok) return;
        const j = await r.json();
        if (Array.isArray(j.userProviders)) setUserProviders(j.userProviders);
      } catch { /* 瞬时失败忽略,后续输入会重存 */ }
    }, 400);
  };

  // 切换提供方/模型时,载入该模型单独配置的最大迭代次数(优先后端,localStorage 兜底)
  useEffect(() => {
    if (isMock || !effModel) { setMaxIters(''); return; }
    const v = uiStateData.maxIters?.[providerId]?.[effModel];
    setMaxIters(typeof v === 'string' && v !== '' ? v : loadModelIters(providerId, effModel));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, effModel, isMock]);

  // 应用 + 持久化(切换/修改即生效)
  useEffect(() => {
    // 该模型的上下文能力(输入窗口/输出上限):显式配置优先,否则用全局默认 1M/32k
    const cfg = provider.modelConfig?.[effModel] || FALLBACK_CONTEXT;
    api.send('llm', {
      llm: {
        baseUrl: effBaseUrl, apiKey: effKey, model: effModel,
        maxIters: maxIters ? Math.floor(Number(maxIters)) || 0 : 0,
        contextWindow: cfg.contextWindow || 0,
        maxTokens: cfg.maxTokens || 0
      }
    });
    LSS('llm.provider', providerId);
    LSS('llm.customModel', customModel);
    if (isMock) localStorage.removeItem('sshai.llm.model.' + providerId);
    else {
      LSS('llm.model.' + providerId, model);
      if (isUser) persistUserKey(providerId, apiKey);
      else LSS('llm.key.' + providerId, apiKey);
    }
    // 该模型的迭代上限单独落盘(留空 = 使用全局默认)
    if (!isMock && effModel) saveModelIters(providerId, effModel, maxIters);
    // 选择级配置(当前提供方/模型/Key/自定义模型名/迭代上限)防抖写回后端 JSON(权威存储)
    if (uiTimer.current) clearTimeout(uiTimer.current);
    uiTimer.current = setTimeout(async () => {
      try {
        await fetch('/api/ui-state', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            providerId,
            customModel,
            models: { [providerId]: model },
            keys: isMock ? {} : { [providerId]: apiKey },
            maxIters: effModel ? { [providerId]: { [effModel]: maxIters } } : {}
          })
        });
        // 同步内存态,避免后续切换/加载读到旧缓存
        setUiStateData((s) => ({
          ...s,
          providerId,
          customModel,
          models: model ? { ...s.models, [providerId]: model } : omitKey(s.models, providerId),
          keys: !isMock && apiKey ? { ...s.keys, [providerId]: apiKey } : omitKey(s.keys, providerId),
          maxIters: effModel
            ? (maxIters
              ? { ...s.maxIters, [providerId]: { ...(s.maxIters[providerId] || {}), [effModel]: maxIters } }
              : { ...s.maxIters, [providerId]: omitKey(s.maxIters[providerId] || {}, effModel) })
            : s.maxIters
        }));
      } catch { /* 后端写失败不阻塞 UI,下次变更会重试 */ }
    }, 400);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effBaseUrl, effKey, effModel, providerId, apiKey, model, customModel, maxIters, isMock]);

  // ---- 添加 / 编辑 / 复制 / 删除「我的提供商」(增删改均写入服务端配置文件) ----
  // 添加成功后自动切换为当前使用;返回 true/false 供弹窗决定是否关闭
  const addProvider = async (d: ProviderDraft): Promise<boolean> => {
    try {
      const r = await fetch('/api/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(d)
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || '添加失败');
      const list = Array.isArray(j.userProviders) ? j.userProviders as LlmProvider[] : [];
      setUserProviders(list);
      const entry = list.length ? list[list.length - 1] : null;
      if (entry) {
        setProviderId(entry.id);
        setApiKey(entry.apiKey || '');
        setModel(entry.models?.[0] || '');
      }
      return true;
    } catch (e) {
      setErr('添加提供商失败:' + (e as Error).message);
      return false;
    }
  };

  // 编辑已有提供商;若编辑的是当前使用中的条目,同步本地 Key 与模型
  const updateProvider = async (id: string, d: ProviderDraft): Promise<boolean> => {
    try {
      const r = await fetch('/api/providers/' + id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(d)
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || '保存失败');
      const list = Array.isArray(j.userProviders) ? j.userProviders as LlmProvider[] : [];
      setUserProviders(list);
      if (providerId === id) {
        const p = list.find((x) => x.id === id);
        if (p) {
          setApiKey(p.apiKey || '');
          setModel((cur) => (p.models.length === 0 ? '' : p.models.includes(cur) ? cur : p.models[0]));
        }
      }
      return true;
    } catch (e) {
      setErr('保存提供商失败:' + (e as Error).message);
      return false;
    }
  };

  // 复制:以「名称(副本)」新增一条同配置的提供商
  const duplicateProvider = async (id: string): Promise<void> => {
    const p = userProviders.find((x) => x.id === id);
    if (!p) return;
    try {
      const r = await fetch('/api/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: p.name + '(副本)', baseUrl: p.baseUrl, models: p.models, apiKey: p.apiKey })
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || '复制失败');
      setUserProviders(Array.isArray(j.userProviders) ? j.userProviders as LlmProvider[] : []);
    } catch (e) { setErr('复制提供商失败:' + (e as Error).message); }
  };

  const removeProvider = async (id: string): Promise<void> => {
    const p = userProviders.find((x) => x.id === id);
    if (!p) return;
    const ok = await confirm({
      title: '删除提供商',
      message: `删除提供商「${p.name}」?其 API Key 也会一并删除`,
      confirmLabel: '删除',
      danger: true
    });
    if (!ok) return;
    try {
      const r = await fetch('/api/providers/' + id, { method: 'DELETE' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || '删除失败');
      const list = Array.isArray(j.userProviders) ? j.userProviders as LlmProvider[] : [];
      setUserProviders(list);
      localStorage.removeItem('sshai.llm.model.' + id);
      localStorage.removeItem('sshai.llm.key.' + id);
      // 同步清除内存态中的该提供方选择级配置(后端已联动删除 ui-state 条目)
      setUiStateData((s) => ({
        ...s,
        models: omitKey(s.models, id),
        keys: omitKey(s.keys, id),
        maxIters: omitKey(s.maxIters, id)
      }));
      if (providerId === id) switchProvider(DEFAULT_PROVIDER);
    } catch (e) { setErr('删除提供商失败:' + (e as Error).message); }
  };

  const value: LlmContextValue = {
    userProviders, allProviders, providerId, provider, isUser, isMock,
    model, setModel, customModel, setCustomModel, apiKey, setApiKey,
    effModel, effModelContext, effBaseUrl, effKey,
    maxIters, setMaxIters,
    switchProvider, addProvider, updateProvider, duplicateProvider, removeProvider,
    err, setErr
  };
  // 提供方配置未就绪前不渲染应用:避免首帧 provider 缺失回退为 mock、请求返回后再跳变引起的抖动
  if (!ready) return <div className="app-boot"><div className="app-boot-spin" />加载 AI 提供方配置…</div>;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}