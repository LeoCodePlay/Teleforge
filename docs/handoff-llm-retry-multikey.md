# 对接文档:LLM 重试策略改造 + 多 API Key 轮询

> 交接给下一个会话。**本任务已收口**:代码 + 测试 + 界面端到端验证全部完成,
> 完整 `npm test` 0 失败,`npm run build` 通过。§3 是验证证据,§4 是可选的后续加固项。

---

## 1. 用户需求(原始口径,不要改写)

1. **连接超时/未响应不能直接停止**:旧行为是「等 600s 总预算用尽就停止重试」,用户明确要求取消。
2. **除了余额不足以外的错误,全部都要重试**;重试次数上限 **10 次**。
3. 用户补充口径:**取消 600s 总预算,改成「等待 300s 仍无响应就再次重试」,直到 10 次上限**。
4. **余额不足**时:
   - 提供商设置里的 API Key 要**支持填多个**;
   - 某个 Key 余额不足 → **自动轮询到下一个可用 Key** 重试;
   - **直到所有 Key 都没余额了才停止重试**;
   - 没余额的 Key 要**显示「无余额」**;
   - 要有一个**「重置」按钮**:充值后点重置,下次轮询会**再次尝试**这个 Key;
   - 未重置的无余额 Key,轮询时**不会**再被尝试。
5. 作用域:仅**同一提供商内部**的多个 Key 轮询(不跨提供商)。

---

## 2. 已完成改动(按文件)

### 2.1 `server/agent/llm.ts`(CRLF)

**重试策略**
- `LLM_RETRY`:
  - **删除** `BUDGET_MS`(600s 总预算);
  - `IDLE_MS`:`60_000` → **`300_000`**(等待 300s 无任何数据 → 作废本次尝试并重试);
  - `MAX_ATTEMPTS`:`20` → **`10`**;
  - **新增** `ATTEMPT_MS`:`300_000`(单次尝试总时长上限)。
- 重试循环:
  - 删除 `deadline` / `deadlineFired` / `budgetLeftMs`;
  - **唯一放弃条件** = `attempt >= LLM_RETRY.MAX_ATTEMPTS`;
  - 新增 `attemptTimer` + `attemptTimedOut`,由 `ATTEMPT_MS` 兜底。
- **为什么必须新增 `ATTEMPT_MS`**:旧代码的 deadline 同时兜住了「流一直有数据却永远不结束」这种情形
  —— 静默看门狗每次收到数据就被 `kick()` 重置,永远等不到。只删预算不加这道上限,会把
  「永远生成中」的挂死问题重新引入。两种超时都按可重试处理。

**多 Key 轮询**
- `LlmOptions` 新增:`apiKeys?: string[]`、`providerId?: string`、`onKeyExhausted?: (key, reason) => void`。
- `LlmClient` 新增字段 `apiKeys: string[]`、`onKeyExhausted`;构造函数用 `normalizeApiKeys(apiKeys, apiKey)` 归一化。
- `chat()` 内新增 `keyList` / `keyIdx` / `activeKey`;请求头用 `activeKey`。
- HTTP 分支新增**余额不足分支**(在 reasoning 降级判定之前):
  - `isBalanceError(res.status, rawBody)` 为真 → `onKeyExhausted(activeKey, reason)`;
  - 还有下一个 Key → 切换、`attempt = 0`(新 Key 重新给满 10 次额度)、`startedAt` 重置、`onRetry` 通知前端,`continue`;
  - 没有下一个 Key → 抛 `toFriendlyLlmError(..., { allKeysExhausted: true })`。
- `isRetryableStatus(status)` 改为 `!isBalanceError(status, '')` → **除余额不足外一律可重试**(含 401/400/404 等)。
- 新增导出 `isBalanceError(status, text)`:`402` 或文案命中余额/欠费/额度关键词。
- `toFriendlyLlmError`:ctx 增加 `exhausted` / `allKeysExhausted`;全部 Key 耗尽时给出「充值 + 点重置」指引。
- `permanentErrorHint(402)` 文案更新;`retryExhaustedHint` 对确定性错误(401/403/404/413)附上原永久性提示。
- 新增模块级 `normalizeApiKeys()`。

**有意保留的例外**:`IMAGES_ONLY_RE`(生图模型被当文本模型用)仍然**立即失败**、不重试。
它是确定性的配置/路由错误,重试 10 次只会白等并给出同样结论,且错误文案已经告诉用户去开「生图」开关。
若下个会话认为必须严格「除余额外全部重试」,再改这里。

### 2.2 `server/store/ai-providers-store.ts`(LF,整文件重写)

- 新增 `KeyState { exhausted?, reason?, at? }`。
- `AiProvider` 新增 `apiKeys?: string[]`、`keyStates?: Record<string, KeyState>`;`apiKey` 保留为兼容镜像 = `apiKeys[0]`。
- 新增纯函数:`normalizeKeys(apiKey, apiKeys)`、`usableKeys(p)`(排除已标记无余额)、`alignKeys(p)`(对齐 + 清理已删除 Key 的残留状态)。
- 新增 store 方法:`find(id)`、`markKeyExhausted(id, key, reason)`、`resetKey(id, key)`、`resetAllKeys(id)`。
- `add()` / `update()` 会调用 `alignKeys`;`update` 中若只给 `apiKey` 不给 `apiKeys`,语义是「单 Key 覆盖」(旧的单 Key 编辑路径)。

### 2.3 `server/api/http/providers.ts`(CRLF)

- `POST /api/providers` 接受 `apiKeys`。
- `PATCH /api/providers/:id` 接受 `apiKeys`(权威列表;`apiKey` 由 store 对齐为首项)。
- **新增** `POST /api/providers/:id/reset-key`,body `{ key }` 重置单个 Key;body `{}` 重置该提供商全部 Key。返回 `{ userProviders }`。

### 2.4 `server/agent/agent.ts`(CRLF)

- 新增 `import { aiProviders } from '../store/ai-providers-store.ts';`。
- `configureLlm()`:`new LlmClient({ ...cfg, onKeyExhausted })`;回调里
  `aiProviders.markKeyExhausted(providerId, key, reason)` +
  `this.emit('agent', { event: 'key_exhausted', providerId, key, reason })`。
  (`providerId` 由前端随 `llm` 配置下发;复用已有 `agent` 事件通道,无需新增 WS 转发。)

### 2.5 `web/src/types/index.ts`(CRLF)

- 新增 `KeyState`。
- `LlmProvider` 新增 `apiKeys?: string[]`、`keyStates?: Record<string, KeyState>`。
- `ProviderDraft` 新增 **必填** `apiKeys: string[]`。

### 2.6 `web/src/context/llm-context.tsx`(CRLF)

- `import` 增加 `useMemo`。
- 新增 `usableApiKeys`(`useMemo`,排除 `keyStates[k].exhausted === true`)。
- `llmPayload()` 改为下发 `apiKeys: usableApiKeys`、`apiKey: usableApiKeys[0] || effKey`、`providerId: isUser ? providerId : ''`。
- 两个 effect 的依赖数组加入 `usableApiKeys`(`useMemo` 保证引用稳定,不会造成无限循环)。
- `persistUserKey` 改为连同完整列表一起 PATCH —— **只发单个 `apiKey` 会把多 Key 列表截断成一条**。
- `duplicateProvider` 复制 `apiKeys`。
- 新增 `resetProviderKey(id, key?)` → `POST /api/providers/:id/reset-key`;已加入 `LlmContextValue` 类型与 context value。
- 新增 effect:监听 `api.on('agent')` 的 `key_exhausted` → 重新拉 `/api/providers`,刷新「无余额」徽标。

### 2.7 `web/src/components/AiConfigPanel/AiConfigPanel.tsx`(CRLF)

- 新增 `keyList(p)` / `maskKey(k)` 辅助函数。
- `ProviderCard`:新增 `onResetKey` prop;新增 Key 状态行(脱敏显示 + 「可用」/「无余额」徽标 + **「重置」按钮**)。
- `ProviderModal`:单个 `apiKey` 字符串改为 `apiKeys: string[]`,渲染多行编辑器(每行一个 Key、可「＋ 添加 Key」/「删除」,无余额行带徽标);`submit` 提交 `apiKey: keys[0]` + `apiKeys: keys`。
- 卡片列表传入 `onResetKey={(k) => resetProviderKey(p.id, k)}`。

### 2.8 `web/src/components/AiConfigPanel/AiConfigPanel.scss`(CRLF)

- 新增 `.key-list` / `.key-row` / `.pc-keys` / `.pc-key` / `.pc-key-mask`(`.badge.warn` 已存在于 `web/src/styles.scss`)。

### 2.9 测试

- `test/llm-retry-budget.test.js`(LF)已重写为新语义:假死→重试到 `MAX_ATTEMPTS`、流不结束→`ATTEMPT_MS` 兜底、空响应→多次重试。**6/6 通过。**
  文件名仍叫 `budget`(改文件名要同步 `package.json` 里那条很长的 test 列表,故保留)。
- `test/llm-retry.test.js`(CRLF)**已改并全绿(60/60)**:
  - 环境变量 `LLM_RETRY_BUDGET_MS` → `LLM_ATTEMPT_MS`;
  - 新增 `auths` 数组,记录每次请求的 `Authorization` 头;
  - `run()` 改为**不抛错**,统一返回 `{ res, err, retries, texts }` box —— 失败分支也能断言最终结果,
    不必再写 `.catch((e) => { err = e; })`;
  - 第 7 节(401)断言 = 「重试到 `MAX_ATTEMPTS` 次 + 始终用同一个 Key + 最终文案提示检查 API Key」;
  - **新增 7.1 / 7.2 / 7.3 三节多 Key 用例**:402→换 Key→成功;全部 Key 无余额→只遍历一遍并指引充值+重置;单 Key 402→不轮询。
- `test/ai-providers-multikey.test.js`(LF,**新增,27/27 通过**):store 层单测 ——
  `normalizeKeys` 归一化、`usableKeys` 过滤、入库对齐、**只给 `apiKeys` 时 `apiKey` 跟随首项**、
  「无余额」标记→轮询跳过→`resetKey`/`resetAllKeys` 恢复、删除 Key 后残留状态被清理、边界返回值。
- `test/agent-llm-retry.test.js`(LF)新增第 7 / 8 节端到端用例(**40/40 通过**):真 Agent + 真 `LlmClient` + 假网关,
  断言「第 1 个 Key 402 → 第 2 个 Key 接手 → 本轮 completed」「`key_exhausted` 已广播 + 已写回 store + `usableKeys` 只剩第 2 个 + 重置后恢复」
  「全部 Key 无余额 → 只遍历一遍 → 本轮 error 收尾 + 文案指引充值/重置」。该文件顶部 `LLM_RETRY_BUDGET_MS` 也一并改为 `LLM_ATTEMPT_MS`。

### 2.10 本轮修掉的一个真 bug:`update()` 会复活被删掉的 Key

`server/store/ai-providers-store.ts` 原 `update()` 在 `patch.apiKeys` 是权威列表时,仍把**旧的** `p.apiKey` 当输入喂给
`normalizeKeys(p.apiKey, p.apiKeys)` —— 于是「先单 Key 覆盖成 `solo`、再 `apiKeys: ['a','b']`」得到 `['solo','a','b']`,
**被删掉的 Key 会复活,连带它残留的「无余额」状态一起复活**。

修法:抽出 `applyKeys(p, keys)`(用一份权威列表覆盖 + 清理已移除 Key 的状态),`update()` 分三路:
`patch.apiKeys` 是数组 → 完全以它为准(`apiKey` 由它派生,不拼旧值);只给 `patch.apiKey` → 单 Key 覆盖(清空 `apiKeys`);
两者都没给 → 只 `Object.assign`。`alignKeys()` 保留给 `add()` 这类「没有权威列表」的场景。

> 通过 UI 走不到这个 bug:弹窗总是同时提交 `apiKey: keys[0]` + `apiKeys: keys`,旧值恰好等于首项而被去重掉。
> 但 `PATCH /api/providers/:id { apiKeys }` 单独调用就会踩中,而 providers.ts 的注释正把 `apiKeys` 声明为权威列表。

---

## 3. 验证状态

| 项目 | 状态 |
| --- | --- |
| `npm run typecheck`(web + server) | 67 个错误,**与改动前逐条一致(0 新增)**;全是既有基线(`agent.ts` implicit-any、`attachments-store.ts`),本次改动的文件 0 错误 |
| `node test/llm-retry.test.js` | **60/60 通过** |
| `node test/llm-retry-budget.test.js` | **6/6 通过** |
| `node test/ai-providers-multikey.test.js`(新增) | **27/27 通过** |
| `node test/agent-llm-retry.test.js` | **40/40 通过**(含新增多 Key 端到端 14 项) |
| `npm test`(全部 58 个文件) | **0 失败** |
| `npm run build`(vite) | **通过**(212 modules,3.33s) |
| 残留旧语义(搜 `BUDGET_MS` / `deadlineFired` / `budgetLeftMs`) | 仅剩 3 处**解释性注释**说明「旧行为已移除」,无代码引用 |
| 界面端到端(无余额徽标 / 重置按钮) | **已实测通过**(见下) |

### 界面端到端实测方法(可复现)

不碰用户真实配置、也不占用已在跑的 4000 端口:把 `web/dist`(已 build)+ 一个**临时 `DATA_DIR`** 起在 4100,
`node server/index.ts` 只在「直接运行」时自启,所以要显式调 `startApp()`:

```js
// _e2e/serve.mjs
import { fileURLToPath } from 'node:url';
process.env.DATA_DIR = fileURLToPath(new URL('./data/', import.meta.url));
process.env.PORT = '4100';
const { startApp } = await import('../server/index.ts');
await startApp();
```

临时 `ai-providers.json` 里放一个 2 Key 提供商、其中 `keyStates[key1].exhausted = true`,然后浏览器打开
`http://127.0.0.1:4100` → ⚙ → AI 配置。**实测结果**:

- 卡片显示「2 个 Key」;`sk-e2e…-one` 行带 `无余额` 徽标 + `重置` 按钮,`sk-e2e…-two` 行显示 `可用`;
- 点「重置」后徽标与按钮消失、该行变 `可用`,且 `GET /api/providers` 与临时 `ai-providers.json` 里
  `keyStates` 已变成 `{}` —— 说明重置确实落盘,不只是前端乐观更新。

> 注意:后台「运行终端」在本环境不可用(工作区路径含中文,`background=true` 一律报
> 「文件名、目录名或卷标语法不正确」,连 `node -e "setInterval(...)"` 都起不来)。
> 需要长期进程时用 `powershell -NoProfile -Command "Start-Process node -ArgumentList '...' -WindowStyle Hidden -RedirectStandardOutput ..."`,
> 结束后 `taskkill /PID <pid> /T /F`。

---

## 4. 下个会话待办

**本任务已收口**,没有阻塞项。若要继续加固,按价值排序:

1. 现在 401/403/404 这类**确定性**错误也会重试满 10 次(退避 1s→2s→…封顶 30s,整轮约 2 分钟)才报错。
   这是需求口径「除余额不足外一律重试」的直接结果,代码与测试都已对齐;若想省掉这段白等,
   需要在 `isRetryableStatus()` 里重新划一条「确定性错误立即失败」的线 —— 那会改变用户明确给过的口径,**先问用户**。
2. `IMAGES_ONLY_RE`(生图模型被当文本模型用)仍立即失败、不重试(见 §2.1「有意保留的例外」)。
3. `test/llm-retry-budget.test.js` 文件名与内容已不符(内容是新语义)。改名要同步 `package.json` 的 test 列表。

---

## 5. 环境与工具注意事项(踩过的坑)

- **`edit_local_file` 不做换行归一化**:它是**逐字面匹配**。文件是 CRLF 时,用 LF 写的**多行 `old_string` 永远匹配不上**(单行没问题)。
  → 对 CRLF 文件请用**单行锚点**(把要插入的多行放进 `new_string`),改完再统一把该文件规范化为 CRLF。
  → 参考:deepseek-harness 自己的 `applyLiteralEdit`(`packages/fs/fs-local/src/fsio.ts`)会把文件内容与 `old_string` **双方**都归一化为 LF,所以没这个问题;本运行时的编辑工具没有这一步。
- **本仓库换行约定是混的**:
  - CRLF:`server/agent/llm.ts`、`server/agent/agent.ts`、`server/api/http/providers.ts`、`web/src/types/index.ts`、`web/src/context/llm-context.tsx`、`web/src/components/AiConfigPanel/AiConfigPanel.{tsx,scss}`、`test/llm-retry.test.js`
  - LF:`server/store/ai-providers-store.ts`、`test/llm-retry-budget.test.js`、`test/agent-llm-retry.test.js`、`test/ai-providers-multikey.test.js`
- **既有未提交改动(不是本任务产生的,别误判)**:`server/agent/tools.ts`、`server/config.ts`、`server/core/computer-use/ps-scripts.ts`、`web/src/App.tsx`、`web/src/components/ChatPanel/ChatPanel.tsx`、未跟踪文件 `x_比特币_推文_20260922.md`。
- `npm run typecheck` 的 67 个错误是**既有基线**(改动前后逐条相同),不要试图在本任务里顺手修完。
  判断「有没有引入新错误」的正确姿势:归一化掉行号后比对错误集合,而不是比总数或行号。

---

## 6. 关键代码位置速查

| 内容 | 位置 |
| --- | --- |
| 重试常量 | `server/agent/llm.ts` → `LLM_RETRY` |
| 重试主循环 | `server/agent/llm.ts` → `chat()` 内 `for (;;)` |
| 余额不足 → 换 Key | `server/agent/llm.ts` → `if (isBalanceError(res.status, rawBody))` |
| 余额判定 | `server/agent/llm.ts` → `isBalanceError()` |
| Key 归一化 | `server/agent/llm.ts` → `normalizeApiKeys()` |
| Key 状态持久化 | `server/store/ai-providers-store.ts` → `markKeyExhausted` / `resetKey` / `usableKeys` |
| Key 列表权威覆盖 | `server/store/ai-providers-store.ts` → `applyKeys()` / `update()` |
| 重置接口 | `server/api/http/providers.ts` → `POST /api/providers/:id/reset-key` |
| 回调注册 | `server/agent/agent.ts` → `configureLlm()` |
| 下发载荷 | `web/src/context/llm-context.tsx` → `llmPayload()` / `usableApiKeys` |
| 重置入口 | `web/src/context/llm-context.tsx` → `resetProviderKey()` |
| 无余额徽标 + 重置按钮 | `web/src/components/AiConfigPanel/AiConfigPanel.tsx` → `ProviderCard` |
| 多 Key 编辑器 | `web/src/components/AiConfigPanel/AiConfigPanel.tsx` → `ProviderModal` |
| 多 Key 轮询单测 | `test/llm-retry.test.js` → §7.1 / §7.2 / §7.3 |
| store 单测 | `test/ai-providers-multikey.test.js` |
| 多 Key 端到端 | `test/agent-llm-retry.test.js` → §7 / §8 |
