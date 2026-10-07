// 会话级持久目标域(逐条移植自 deepseek-harness 的 packages/goal/*):
//   goal/          —— 事件溯源状态 + 比较并交换(CAS)变更 + 进程内续跑授权
//   tool-goal/     —— 模型侧 get_goal / create_goal / update_goal 与 goal:policy 指引
//   command-goal/  —— 人侧 /目标 子命令语法与状态渲染
//   goal-round-driver/ —— 自动续跑一轮的提示词(轮次调度在 agent.ts,_scheduleGoalRound)
//
// 与 harness 的差异(都是宿主架构差异,语义不变):
// 1. 事件载荷直接落在 teleforge 的 SessionEvent.data 上(harness 用 change 元对象包一层,
//    这里保留同样的字段与严格校验),仍是一条 append-only 的 'goal/change' 事件,version=1。
// 2. 目标续跑轮的归属标在 user/message 事件上(source='goal' + goalId/revision/round),
//    harness 放在 MessageSource 对象里;折叠规则完全一致。
// 3. 进程内授权(armed/disarmed)按 Session 对象记账(WeakMap):从磁盘载入会新建 Session,
//    所以重启/切回会话后一定是 disarmed,与 harness "session-start 边一律解除授权" 等价。
// 4. 折叠错误不回滚日志,只向调用方抛出(GoalError);严格校验项与 harness 逐条对齐。
import { randomUUID } from 'node:crypto';
import type { Session } from './session.ts';
import type { ToolDef, ToolRegistry } from './registry.ts';
import * as sessions from '../store/session-store.ts';

/** 目标变更事件版本(harness 的 GOAL_CHANGE_VERSION) */
export const GOAL_CHANGE_VERSION = 1;
/** 未指定轮次上限时的默认值(harness GoalService 的 defaultMaxGoalRounds) */
export const DEFAULT_MAX_GOAL_ROUNDS = 256;
/** 模型自报 blocked 前必须已经过的最少续跑轮数(harness tool-goal 的 blockedAfterConsecutiveRounds) */
export const BLOCKED_AFTER_CONSECUTIVE_ROUNDS = 3;

/** 目标生命周期阶段(harness GoalPhase) */
export type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete';

/** 受阻原因:稳定的小写连字符码 + 人类可读说明 */
export interface GoalBlockReason { code: string; message: string }

/** 不可变身份 + 修订号:CAS 比较并交换的依据 */
export interface GoalRef { id: string; revision: number }

/** 每次非 clear 变更写入的完整快照 */
export interface GoalSnapshot extends GoalRef {
  objective: string;
  phase: GoalPhase;
  blockedReason?: GoalBlockReason;
  maxGoalRounds: number;
}

/** 进程内续跑授权:armed=可自动续跑,disarmed=不续跑(永不落盘) */
export type GoalActivation = 'armed' | 'disarmed';

/** 对外视图 = 快照 + 派生计数/时间 + 进程内授权 */
export interface GoalView extends GoalSnapshot {
  roundsStarted: number;
  createdAt: number;
  updatedAt: number;
  activation: GoalActivation;
}

/** 持久投影(不含进程内授权) */
export interface GoalProjection {
  goal: GoalSnapshot;
  roundsStarted: number;
  createdAt: number;
  updatedAt: number;
}

/** 严格折叠的累加器 */
export interface GoalFoldState {
  goal?: GoalSnapshot;
  roundsStarted: number;
  createdAt?: number;
  updatedAt?: number;
  lastRef?: GoalRef;
  /** 本会话已经创建过的目标 id:create 不得复用(harness seenGoalIds) */
  seenGoalIds: Set<string>;
}

/** 变更动词 */
export type GoalOperation = 'create' | 'edit' | 'pause' | 'resume' | 'complete' | 'block' | 'clear';

/** 目标域稳定错误码(harness GoalErrorCode) */
export type GoalErrorCode =
  | 'GOAL_NOT_FOUND'
  | 'GOAL_ALREADY_EXISTS'
  | 'GOAL_STALE_REVISION'
  | 'GOAL_INVALID_OBJECTIVE'
  | 'GOAL_INVALID_MAX_ROUNDS'
  | 'GOAL_INVALID_BLOCK_REASON'
  | 'GOAL_INVALID_EDIT'
  | 'GOAL_INVALID_TRANSITION';

/** 目标域边界错误(harness GoalError:message + 稳定 code) */
export class GoalError extends Error {
  code: GoalErrorCode;
  constructor(message: string, code: GoalErrorCode) {
    super(message);
    this.name = 'GoalError';
    this.code = code;
  }
}

// ---------------- 折叠(严格重放,逐条对齐 harness goal/src/fold.ts) ----------------

const SNAPSHOT_OPERATIONS = new Set(['create', 'edit', 'pause', 'resume', 'complete', 'block']);
const PHASES = new Set<GoalPhase>(['active', 'paused', 'blocked', 'complete']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`goal change ${field} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`goal change ${field} must be a non-negative safe integer`);
  }
  return value;
}

function decodeBlockReason(value: unknown): GoalBlockReason {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'code,message') {
    throw new Error('goal change goal.blockedReason must have exactly code and message fields');
  }
  if (typeof value['code'] !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value['code'])) {
    throw new Error('goal change goal.blockedReason.code must be lower-kebab-case');
  }
  const message = value['message'];
  if (typeof message !== 'string' || message.trim().length === 0 || message !== message.trim()) {
    throw new Error('goal change goal.blockedReason.message must be non-empty and normalized');
  }
  return { code: value['code'] as string, message };
}

function decodeSnapshot(value: unknown): GoalSnapshot {
  if (!isRecord(value)) throw new Error('goal change goal must be a record');
  if (typeof value['id'] !== 'string' || value['id'].length === 0) {
    throw new Error('goal change goal.id must be a non-empty string');
  }
  const objective = value['objective'];
  if (typeof objective !== 'string' || objective.trim().length === 0 || objective !== objective.trim()) {
    throw new Error('goal change goal.objective must be non-empty and normalized');
  }
  if (typeof value['phase'] !== 'string' || !PHASES.has(value['phase'] as GoalPhase)) {
    throw new Error('goal change goal.phase is invalid');
  }
  const phase = value['phase'] as GoalPhase;
  const expectedKeys = phase === 'blocked'
    ? 'blockedReason,id,maxGoalRounds,objective,phase,revision'
    : 'id,maxGoalRounds,objective,phase,revision';
  if (Object.keys(value).sort().join(',') !== expectedKeys) {
    throw new Error(`goal change goal for phase ${phase} must have exactly ${expectedKeys} fields`);
  }
  return {
    id: value['id'] as string,
    revision: positiveInteger(value['revision'], 'goal.revision'),
    objective,
    phase,
    maxGoalRounds: positiveInteger(value['maxGoalRounds'], 'goal.maxGoalRounds'),
    ...(phase === 'blocked' ? { blockedReason: decodeBlockReason(value['blockedReason']) } : {})
  };
}

function decodeRef(value: unknown): GoalRef {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'id,revision') {
    throw new Error('goal clear tombstone must have exactly id and revision fields');
  }
  if (typeof value['id'] !== 'string' || value['id'].length === 0) {
    throw new Error('goal clear tombstone id must be a non-empty string');
  }
  return { id: value['id'] as string, revision: positiveInteger(value['revision'], 'cleared.revision') };
}

/** 空的严格折叠累加器 */
export function emptyGoalFoldState(): GoalFoldState {
  return { goal: undefined, roundsStarted: 0, createdAt: undefined, updatedAt: undefined, lastRef: undefined, seenGoalIds: new Set<string>() };
}

/** 变更事件里携带的身份(快照或墓碑) */
export function goalChangeRef(change: any): GoalRef {
  return change?.operation === 'clear'
    ? { id: String(change.cleared?.id), revision: Number(change.cleared?.revision) }
    : { id: String(change?.goal?.id), revision: Number(change?.goal?.revision) };
}

/** 所需的字段名必须完全一致(多余/缺少都判失败) */
function requireExactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const want = [...allowed].sort().join(',');
  if (Object.keys(value).sort().join(',') !== want) {
    throw new Error(`${label} must have exactly ${want} fields`);
  }
}

/** 解码一条自称 goal/change 的载荷;不是目标变更返回 undefined,形状非法则抛错 */
export function decodeGoalChange(value: unknown): any {
  if (!isRecord(value) || value['kind'] !== 'goal/change') return undefined;
  if (value['version'] !== GOAL_CHANGE_VERSION) {
    throw new Error(`unsupported goal change version ${String(value['version'])}`);
  }
  if (value['operation'] === 'clear') {
    requireExactKeys(value, ['cleared', 'clearedAt', 'kind', 'operation', 'version'], 'goal clear change');
    return {
      kind: 'goal/change', version: GOAL_CHANGE_VERSION, operation: 'clear',
      cleared: decodeRef(value['cleared']),
      clearedAt: nonNegativeInteger(value['clearedAt'], 'clearedAt')
    };
  }
  if (typeof value['operation'] !== 'string' || !SNAPSHOT_OPERATIONS.has(value['operation'])) {
    throw new Error('goal change operation is invalid');
  }
  requireExactKeys(value,
    ['createdAt', 'goal', 'kind', 'operation', 'roundsStarted', 'updatedAt', 'version'],
    'goal snapshot change');
  const createdAt = nonNegativeInteger(value['createdAt'], 'createdAt');
  const updatedAt = nonNegativeInteger(value['updatedAt'], 'updatedAt');
  if (updatedAt < createdAt) throw new Error('goal change updatedAt cannot precede createdAt');
  return {
    kind: 'goal/change', version: GOAL_CHANGE_VERSION, operation: value['operation'],
    goal: decodeSnapshot(value['goal']),
    roundsStarted: nonNegativeInteger(value['roundsStarted'], 'roundsStarted'),
    createdAt, updatedAt
  };
}

function requireSameDefinition(current: GoalSnapshot, next: GoalSnapshot, operation: GoalOperation): void {
  if (next.objective !== current.objective || next.maxGoalRounds !== current.maxGoalRounds) {
    throw new Error(`goal ${operation} cannot change objective or maxGoalRounds`);
  }
}

function requireNextRevision(current: GoalSnapshot, next: GoalRef, operation: GoalOperation): void {
  if (next.id !== current.id || next.revision !== current.revision + 1) {
    throw new Error(`goal ${operation} must advance the current goal by one revision`);
  }
}

function validateSnapshotTransition(state: GoalFoldState, change: any, current: GoalSnapshot): void {
  const next: GoalSnapshot = change.goal;
  requireNextRevision(current, next, change.operation);
  if (state.updatedAt === undefined) throw new Error('current goal fold lacks updatedAt');
  if (change.createdAt !== state.createdAt
    || change.updatedAt < state.updatedAt
    || change.roundsStarted !== state.roundsStarted) {
    throw new Error(`goal ${change.operation} does not preserve the current counters and timestamps`);
  }
  switch (change.operation) {
    case 'edit':
      if (next.phase !== current.phase
        || JSON.stringify(next.blockedReason) !== JSON.stringify(current.blockedReason)) {
        throw new Error('goal edit cannot change phase or blocked reason');
      }
      break;
    case 'pause':
      requireSameDefinition(current, next, change.operation);
      if (current.phase !== 'active' || next.phase !== 'paused') throw new Error('goal pause has an invalid phase transition');
      break;
    case 'resume': {
      requireSameDefinition(current, next, change.operation);
      if (!new Set<GoalPhase>(['active', 'paused', 'blocked']).has(current.phase)
        || next.phase !== 'active' || state.roundsStarted >= next.maxGoalRounds) {
        throw new Error('goal resume has an invalid phase transition or exhausted round budget');
      }
      break;
    }
    case 'complete':
      requireSameDefinition(current, next, change.operation);
      if (current.phase === 'complete' || next.phase !== 'complete') throw new Error('goal complete has an invalid phase transition');
      break;
    case 'block':
      requireSameDefinition(current, next, change.operation);
      if (current.phase !== 'active' || next.phase !== 'blocked') throw new Error('goal block has an invalid phase transition');
      break;
    default:
      throw new Error('goal create cannot be validated as a current-goal transition');
  }
}

/** 把一条已解码的变更应用到累加器(严格校验,非法即抛错) */
export function applyGoalChange(state: GoalFoldState, change: any): void {
  const ref = goalChangeRef(change);
  if (change.operation === 'clear') {
    const current = state.goal;
    if (current === undefined) throw new Error('goal clear requires a current goal');
    requireNextRevision(current, change.cleared, change.operation);
    if (state.updatedAt === undefined) throw new Error('current goal fold lacks updatedAt');
    if (change.clearedAt < state.updatedAt) {
      throw new Error('goal clear timestamp cannot precede the current goal update');
    }
    state.goal = undefined;
    state.roundsStarted = 0;
    state.createdAt = undefined;
    state.updatedAt = undefined;
    state.lastRef = ref;
    return;
  }
  if (change.operation === 'create') {
    if (change.goal.revision !== 1 || change.goal.phase !== 'active' || change.roundsStarted !== 0
      || (state.goal !== undefined && state.goal.phase !== 'complete')
      || state.seenGoalIds.has(change.goal.id)) {
      throw new Error('goal create requires a fresh active revision-one goal with zero rounds');
    }
    state.seenGoalIds.add(change.goal.id);
  } else {
    const current = state.goal;
    if (current === undefined) throw new Error(`goal ${change.operation} requires a current goal`);
    validateSnapshotTransition(state, change, current);
  }
  state.goal = change.goal;
  state.roundsStarted = change.roundsStarted;
  state.createdAt = change.createdAt;
  state.updatedAt = change.updatedAt;
  state.lastRef = ref;
}

/** 一条会话事件对严格目标折叠的影响 */
export function applyGoalEvent(state: GoalFoldState, event: any): void {
  if (event?.type === 'goal/change') {
    const change = decodeGoalChange(event.data);
    if (change === undefined) throw new Error(`goal change at session event ${event.seq} has an invalid kind`);
    applyGoalChange(state, change);
    return;
  }
  if (event?.type === 'user/message' && event.data?.source === 'goal') {
    const source = event.data;
    if (typeof source.goalId !== 'string' || source.goalId.length === 0
      || !Number.isSafeInteger(source.revision) || source.revision < 1
      || !Number.isSafeInteger(source.round) || source.round < 1) {
      throw new Error('goal message source is invalid');
    }
    const current = state.goal;
    if (current === undefined || current.phase !== 'active' || source.goalId !== current.id
      || source.revision !== current.revision || source.round !== state.roundsStarted + 1
      || source.round > current.maxGoalRounds) {
      throw new Error(`goal round at session event ${event.seq} is not the next admitted round of the active goal`);
    }
    state.roundsStarted = source.round;
  }
}

/** 从整份会话日志折叠出持久目标状态 */
export function foldGoal(events: readonly any[]): GoalFoldState {
  const state = emptyGoalFoldState();
  for (const event of events || []) applyGoalEvent(state, event);
  return state;
}

// ---------------- 进程内授权(不落盘,harness 的 runtime activation) ----------------

const activations = new WeakMap<Session, GoalActivation>();

/** 当前进程内授权;未记录的会话一律 disarmed(等价 harness 的 session-start 边解除授权) */
export function goalActivation(session: Session): GoalActivation {
  return activations.get(session) ?? 'disarmed';
}

function setActivation(session: Session, activation: GoalActivation): void {
  activations.set(session, activation);
}

/** 解除授权:不写修订、不落盘(harness GoalService.disarm) */
export function disarmGoal(session: Session): void {
  setActivation(session, 'disarmed');
}

// ---------------- 校验与变更(harness GoalService) ----------------

function resolveObjective(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GoalError('goal objective must be a non-empty string', 'GOAL_INVALID_OBJECTIVE');
  }
  return value.trim();
}

function resolveMaxGoalRounds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new GoalError('maxGoalRounds must be a positive safe integer', 'GOAL_INVALID_MAX_ROUNDS');
  }
  return value;
}

function resolveBlockReason(reason: unknown): GoalBlockReason {
  const record = isRecord(reason) ? reason : undefined;
  const code = record?.['code'];
  const message = record?.['message'];
  if (typeof code !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(code)
    || typeof message !== 'string' || message.trim().length === 0) {
    throw new GoalError(
      'goal block reason requires a lower-kebab-case code and a non-empty message',
      'GOAL_INVALID_BLOCK_REASON'
    );
  }
  return { code, message: message.trim() };
}

/** 当前持久状态(严格折叠;日志非法时抛普通 Error,与 harness 保留 replay failure 同义) */
function projection(session: Session): GoalProjection | null {
  const state = foldGoal(session.events);
  if (state.goal === undefined) return null;
  if (state.createdAt === undefined || state.updatedAt === undefined) {
    throw new Error('current goal fold lacks timestamps');
  }
  return { goal: state.goal, roundsStarted: state.roundsStarted, createdAt: state.createdAt, updatedAt: state.updatedAt };
}

function expectCurrent(state: GoalProjection | null, ref: GoalRef): GoalProjection {
  if (state === null) throw new GoalError('no current goal', 'GOAL_NOT_FOUND');
  const current = state.goal;
  if (!ref || ref.id !== current.id || ref.revision !== current.revision) {
    throw new GoalError(
      `stale goal ref "${ref?.id}" revision ${ref?.revision}; current is "${current.id}" revision ${current.revision}`,
      'GOAL_STALE_REVISION'
    );
  }
  return state;
}

function withPhase(current: GoalSnapshot, phase: GoalPhase): GoalSnapshot {
  return { id: current.id, revision: current.revision + 1, objective: current.objective, phase, maxGoalRounds: current.maxGoalRounds };
}

function nextMutationTime(state: GoalProjection): number {
  return Math.max(Date.now(), state.updatedAt);
}

/** 追加一条完整快照变更并同步进程内授权 */
function commitSnapshot(
  session: Session,
  operation: Exclude<GoalOperation, 'clear'>,
  goal: GoalSnapshot,
  roundsStarted: number,
  createdAt: number,
  updatedAt: number,
  activation: GoalActivation
): GoalRef {
  session.append('goal/change', {
    kind: 'goal/change', version: GOAL_CHANGE_VERSION, operation, goal, roundsStarted, createdAt, updatedAt
  });
  setActivation(session, activation);
  return { id: goal.id, revision: goal.revision };
}

/**
 * 创建并激活一个目标(harness GoalService.create):已完成的目标可直接替换,其余阶段必须先清空。
 * @returns 新建目标的不可变引用
 */
export function createGoal(session: Session, request: { objective: string; maxGoalRounds?: number }): GoalRef {
  const objective = resolveObjective(request?.objective);
  const maxGoalRounds = resolveMaxGoalRounds(request?.maxGoalRounds ?? DEFAULT_MAX_GOAL_ROUNDS);
  const state = projection(session);
  const current = state?.goal;
  if (current !== undefined && current.phase !== 'complete') {
    throw new GoalError(`goal "${current.id}" already exists with phase "${current.phase}"`, 'GOAL_ALREADY_EXISTS');
  }
  const now = Date.now();
  const goal: GoalSnapshot = {
    id: `goal-${randomUUID()}`, revision: 1, objective, phase: 'active', maxGoalRounds
  };
  return commitSnapshot(session, 'create', goal, 0, now, now, 'armed');
}

/** 改目标描述 / 轮次上限,阶段与授权不变(harness GoalService.edit) */
export function editGoal(session: Session, ref: GoalRef, request: { objective?: string; maxGoalRounds?: number }): GoalRef {
  const state = expectCurrent(projection(session), ref);
  const current = state.goal;
  if (request?.objective === undefined && request?.maxGoalRounds === undefined) {
    throw new GoalError('goal edit requires objective and/or maxGoalRounds', 'GOAL_INVALID_EDIT');
  }
  const goal: GoalSnapshot = {
    ...current,
    revision: current.revision + 1,
    ...(request.objective === undefined ? {} : { objective: resolveObjective(request.objective) }),
    ...(request.maxGoalRounds === undefined ? {} : { maxGoalRounds: resolveMaxGoalRounds(request.maxGoalRounds) })
  };
  return commitSnapshot(session, 'edit', goal, state.roundsStarted, state.createdAt, nextMutationTime(state), goalActivation(session));
}

/** 共享的阶段迁移 */
function transition(
  session: Session,
  ref: GoalRef,
  operation: Exclude<GoalOperation, 'create' | 'edit' | 'clear'>,
  allowed: readonly GoalPhase[],
  phase: GoalPhase,
  activation: GoalActivation
): GoalRef {
  const state = expectCurrent(projection(session), ref);
  const current = state.goal;
  if (!allowed.includes(current.phase)) {
    throw new GoalError(
      `cannot ${operation} goal "${current.id}" from phase "${current.phase}"; expected ${allowed.join(' or ')}`,
      'GOAL_INVALID_TRANSITION'
    );
  }
  return commitSnapshot(session, operation, withPhase(current, phase), state.roundsStarted, state.createdAt, nextMutationTime(state), activation);
}

/** 暂停并解除续跑授权 */
export function pauseGoal(session: Session, ref: GoalRef): GoalRef {
  return transition(session, ref, 'pause', ['active'], 'paused', 'disarmed');
}

/**
 * 恢复/重新激活:停止中的目标可恢复;会话重启后仍 active 但 disarmed 的也可重新激活。
 * 轮次预算耗尽时拒绝(harness GoalService.resume)。
 */
export function resumeGoal(session: Session, ref: GoalRef): GoalRef {
  const state = expectCurrent(projection(session), ref);
  const current = state.goal;
  const resumable: readonly GoalPhase[] = ['active', 'paused', 'blocked'];
  if (!resumable.includes(current.phase)) {
    throw new GoalError(
      `cannot resume goal "${current.id}" from phase "${current.phase}"; expected ${resumable.join(' or ')}`,
      'GOAL_INVALID_TRANSITION'
    );
  }
  if (current.phase === 'active' && goalActivation(session) === 'armed') {
    throw new GoalError(`goal "${current.id}" is already active and armed`, 'GOAL_INVALID_TRANSITION');
  }
  if (state.roundsStarted >= current.maxGoalRounds) {
    throw new GoalError(
      `goal "${current.id}" exhausted ${current.maxGoalRounds} goal rounds; increase maxGoalRounds before resuming`,
      'GOAL_INVALID_TRANSITION'
    );
  }
  return commitSnapshot(session, 'resume', withPhase(current, 'active'), state.roundsStarted, state.createdAt, nextMutationTime(state), 'armed');
}

/** 标记完成并解除授权 */
export function completeGoal(session: Session, ref: GoalRef): GoalRef {
  return transition(session, ref, 'complete', ['active', 'paused', 'blocked'], 'complete', 'disarmed');
}

/** 标记受阻(稳定 code + 说明)并解除授权 */
export function blockGoal(session: Session, ref: GoalRef, reason: GoalBlockReason): GoalRef {
  const state = expectCurrent(projection(session), ref);
  const current = state.goal;
  if (current.phase !== 'active') {
    throw new GoalError(
      `cannot block goal "${current.id}" from phase "${current.phase}"; expected active`,
      'GOAL_INVALID_TRANSITION'
    );
  }
  const goal: GoalSnapshot = { ...withPhase(current, 'blocked'), blockedReason: resolveBlockReason(reason) };
  return commitSnapshot(session, 'block', goal, state.roundsStarted, state.createdAt, nextMutationTime(state), 'disarmed');
}

/** 清除当前目标,保留一条墓碑(历史仍在日志里) */
export function clearGoal(session: Session, ref: GoalRef): GoalRef {
  const state = expectCurrent(projection(session), ref);
  const current = state.goal;
  const tombstone: GoalRef = { id: current.id, revision: current.revision + 1 };
  session.append('goal/change', {
    kind: 'goal/change', version: GOAL_CHANGE_VERSION, operation: 'clear', cleared: tombstone, clearedAt: nextMutationTime(state)
  });
  setActivation(session, 'disarmed');
  return tombstone;
}

/** 读取当前目标的对外视图(无目标返回 undefined);会话不在内存时也成立(纯日志折叠) */
export function goalView(session: Session): GoalView | undefined {
  const state = projection(session);
  if (state === null) return undefined;
  return {
    ...state.goal,
    roundsStarted: state.roundsStarted,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    activation: goalActivation(session)
  };
}

// ---------------- 人侧 /目标 命令(harness command-goal/src/index.ts) ----------------

const GOAL_USAGE = '用法:/目标 [<目标描述>|clear|edit <目标描述>|pause|resume]';

type GoalCommand =
  | { kind: 'show' }
  | { kind: 'create'; objective: string }
  | { kind: 'edit'; objective: string }
  | { kind: 'invalid-edit' }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'clear' };

/** 解析 /目标 的语法;控制词只在整个输入恰好是它时生效,其余非空输入一律当作目标描述 */
export function parseGoalCommand(rawInput: string): GoalCommand {
  const input = String(rawInput ?? '').trim();
  if (input.length === 0) return { kind: 'show' };
  const control = input.toLowerCase();
  if (control === 'clear') return { kind: 'clear' };
  if (control === 'pause') return { kind: 'pause' };
  if (control === 'resume') return { kind: 'resume' };
  if (control === 'edit') return { kind: 'invalid-edit' };
  if (/^edit(?=\s)/i.test(input)) return { kind: 'edit', objective: input.slice(4).trim() };
  return { kind: 'create', objective: input };
}

/** 阶段的人类标签 */
function phaseLabel(phase: GoalPhase): string {
  switch (phase) {
    case 'active': return '进行中';
    case 'paused': return '已暂停';
    case 'blocked': return '受阻';
    case 'complete': return '已完成';
    default: return String(phase);
  }
}

function activationLabel(activation: GoalActivation): string {
  return activation === 'armed' ? '已启用' : '未启用';
}

/** 当前状态下真正可用的后续命令 */
function commandHint(goal: GoalView): string {
  if (goal.phase === 'active') {
    return goal.activation === 'armed'
      ? '/目标 edit <目标描述>、/目标 pause、/目标 clear'
      : '/目标 edit <目标描述>、/目标 resume、/目标 clear';
  }
  if (goal.phase === 'complete') return '/目标 <目标描述>、/目标 clear';
  return '/目标 edit <目标描述>、/目标 resume、/目标 clear';
}

function renderGoal(title: string, goal: GoalView): string {
  const blocker = goal.phase === 'blocked' && goal.blockedReason
    ? [`受阻原因: ${goal.blockedReason.code}: ${goal.blockedReason.message}`]
    : [];
  return [
    title,
    `状态: ${phaseLabel(goal.phase)}`,
    ...blocker,
    `目标: ${goal.objective}`,
    `轮次: ${goal.roundsStarted}/${goal.maxGoalRounds}`,
    `续跑: ${activationLabel(goal.activation)}`,
    '',
    `可用命令: ${commandHint(goal)}`
  ].join('\n');
}

function goalRefOf(goal: GoalView): GoalRef {
  return { id: goal.id, revision: goal.revision };
}

/** /目标 一条指令的执行结果(命令卡直接渲染 text) */
export interface GoalCommandResult {
  kind: 'success' | 'error';
  text: string;
  /** 执行后的目标视图(无目标为 null);前端据此刷新目标条 */
  goal?: GoalView | null;
  /** 该动作是否放行附件(成功 create/edit 时才把附件作为参考消息投递) */
  attachmentsAccepted?: boolean;
}

/** 执行一条 /目标 指令:所有变更走同一套 CAS 语义(harness executeGoalCommand) */
export function runGoalCommand(session: Session, rawInput: string, hasAttachments = false): GoalCommandResult {
  const command = parseGoalCommand(rawInput);
  const current = goalView(session);
  const withGoal = (r: GoalCommandResult): GoalCommandResult => ({ ...r, goal: goalView(session) ?? null });
  if (hasAttachments && command.kind !== 'create' && command.kind !== 'edit') {
    return { kind: 'error', text: '附件只能随目标描述一起提交:/目标 <目标描述> 或 /目标 edit <目标描述>。' };
  }
  try {
    switch (command.kind) {
      case 'show':
        return current === undefined
          ? { kind: 'success', text: `当前没有设置目标。\n${GOAL_USAGE}`, goal: null }
          : { kind: 'success', text: renderGoal('目标', current), goal: current };
      case 'invalid-edit':
        return { kind: 'error', text: `edit 需要给出替换后的目标描述。\n${GOAL_USAGE}`, goal: current ?? null };
      case 'create': {
        if (current !== undefined && current.phase !== 'complete') {
          return {
            kind: 'error',
            text: `已有一个${phaseLabel(current.phase)}的目标。用 /目标 edit <目标描述> 修改,或先 /目标 clear 再替换。`,
            goal: current
          };
        }
        createGoal(session, { objective: command.objective });
        const view = goalView(session);
        return withGoal({ kind: 'success', text: renderGoal('已创建目标', view as GoalView), attachmentsAccepted: true });
      }
      case 'edit': {
        if (current === undefined) {
          return { kind: 'error', text: `当前没有目标,/目标 edit 需要先有一个目标。${GOAL_USAGE}`, goal: null };
        }
        if (current.phase === 'complete') {
          createGoal(session, { objective: command.objective });
          const view = goalView(session);
          return withGoal({ kind: 'success', text: renderGoal('已创建目标', view as GoalView), attachmentsAccepted: true });
        }
        editGoal(session, goalRefOf(current), { objective: command.objective });
        const view = goalView(session);
        return withGoal({ kind: 'success', text: renderGoal('已更新目标', view as GoalView), attachmentsAccepted: true });
      }
      case 'pause': {
        if (current === undefined) return { kind: 'error', text: `当前没有目标,/目标 pause 需要先有一个目标。${GOAL_USAGE}`, goal: null };
        pauseGoal(session, goalRefOf(current));
        const view = goalView(session);
        return withGoal({ kind: 'success', text: renderGoal('已暂停目标', view as GoalView) });
      }
      case 'resume': {
        if (current === undefined) return { kind: 'error', text: `当前没有目标,/目标 resume 需要先有一个目标。${GOAL_USAGE}`, goal: null };
        resumeGoal(session, goalRefOf(current));
        const view = goalView(session);
        return withGoal({ kind: 'success', text: renderGoal('已恢复目标', view as GoalView) });
      }
      case 'clear': {
        if (current === undefined) return { kind: 'success', text: '没有可清除的目标。', goal: null };
        clearGoal(session, goalRefOf(current));
        return { kind: 'success', text: '已清除目标。', goal: null };
      }
      default:
        return { kind: 'error', text: GOAL_USAGE, goal: current ?? null };
    }
  } catch (error: unknown) {
    if (error instanceof GoalError) {
      return { kind: 'error', text: `该指令在当前目标状态下不可用。运行 /目标 查看可用命令。(${error.message})`, goal: current ?? null };
    }
    throw error;
  }
}

// ---------------- 模型侧指引与续跑提示词(harness tool-goal / goal-round-driver) ----------------

/** goal:policy 段落(逐字移植 harness tool-goal 的 guidance) */
export const GOAL_GUIDANCE = 'create_goal may infer goal intent from a direct human request in any language. '
  + 'After session resume or fork, an active goal is disarmed: when '
  + 'a human asks to continue or resume in any wording or language, use update_goal action '
  + 'resume to rearm it. Mark complete only when the objective is actually achieved. Mark '
  + `blocked only after the same blocking condition persists for at least ${BLOCKED_AFTER_CONSECUTIVE_ROUNDS} `
  + 'consecutive goal rounds, and report that concrete condition in blocked_reason; difficulty, uncertainty, '
  + 'or remaining useful work is not blocked.';

/** 一轮自动续跑的完整指令(逐字移植 harness goal-round-driver 的 renderGoalRoundPrompt) */
export function renderGoalRoundPrompt(goal: GoalView, round: number): string {
  return '<goal_round>\n'
    + `Objective: ${JSON.stringify(goal.objective)}\n`
    + `Round: ${round}/${goal.maxGoalRounds}\n\n`
    + 'Continue working toward the objective in this same session. Treat the current workspace, '
    + 'tool results, and durable session state as authoritative; inspect them instead of assuming '
    + 'earlier narration is still current. Make concrete progress and verify the result. Before '
    + 'claiming completion, gather evidence that the whole objective is achieved, read the current '
    + 'goal, and mark it complete. If work remains, leave the goal active for the next round. Follow '
    + 'the configured goal-tool policy before reporting a blocker.\n'
    + '</goal_round>';
}

// ---------------- 模型侧工具(harness tool-goal/src/index.ts) ----------------

const GET_GOAL_DESCRIPTION = 'Read the current session goal, including the id and revision that update_goal requires.';

const CREATE_GOAL_DESCRIPTION =
  'Create a persisted goal that keeps this session working across automatic continuation rounds. '
  + 'Use it when the direct human request is a long-running objective, even if the user did not say "goal"; '
  + 'not for single-turn work.';

const UPDATE_ACTIONS = ['edit', 'pause', 'resume', 'complete', 'blocked'];

/** 模型可见的紧凑目标值(harness GoalToolValue) */
function goalValue(goal: GoalView | undefined): string {
  if (goal === undefined) return JSON.stringify({ goal: null });
  return JSON.stringify({
    goal: {
      id: goal.id,
      revision: goal.revision,
      objective: goal.objective,
      phase: goal.phase,
      roundsStarted: goal.roundsStarted,
      maxGoalRounds: goal.maxGoalRounds,
      ...(goal.blockedReason === undefined ? {} : {
        blockedReason: { code: goal.blockedReason.code, message: goal.blockedReason.message }
      })
    },
    activation: goal.activation
  });
}

/** 工具调用上下文里由 agent 注入的当轮事实 */
interface GoalToolContext {
  session?: Session;
  sid?: string | null;
  emit?: (event: string, payload: any) => void;
  /** 本轮首个 user 消息的来源:user / auto-resume / schedule / goal / steer */
  turnSource?: string | null;
  /** 当轮是自动续跑轮时的归属信息 */
  goalRound?: { goalId: string; revision: number; round: number } | null;
}

function requireGoalSession(ctx: GoalToolContext): Session {
  if (!ctx?.session) throw new Error('目标工具需要所属会话(缺少调用上下文)');
  return ctx.session;
}

/** create/edit/pause/resume 必须由人类的顶层请求发起(harness requireDirectHuman) */
function requireDirectHuman(ctx: GoalToolContext): void {
  if (ctx.turnSource !== 'user' && ctx.turnSource !== 'steer') {
    throw new Error('该目标操作只能由用户的直接请求发起:自动续跑轮里模型不能自行创建/修改/暂停/恢复目标');
  }
}

/** 变更后立即落盘并广播(命令/工具都不在轮末统一落盘的路径上) */
function persistGoal(session: Session, sid: string | null | undefined, emit?: (event: string, payload: any) => void): void {
  if (sid) {
    try { sessions.saveEvents(sid, session.events); } catch { /* 落盘失败不阻塞本次变更 */ }
  }
  emit?.('agent', { event: 'goal_changed', sid, goal: goalView(session) ?? null });
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function hasRoundCap(value: unknown): value is number {
  return typeof value === 'number' && value !== 0;
}

/** 注册 get_goal / create_goal / update_goal(由 agent.ts 在启动时挂载) */
export function registerGoalTools(registry: ToolRegistry): void {
  registry.register({
    name: 'get_goal',
    description: GET_GOAL_DESCRIPTION,
    parameters: { type: 'object', properties: {}, required: [] },
    access: 'meta',
    mutating: true,
    run(_args: any, ctx: GoalToolContext) {
      const session = requireGoalSession(ctx);
      return goalValue(goalView(session));
    }
  } as ToolDef);

  registry.register({
    name: 'create_goal',
    description: CREATE_GOAL_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        objective: {
          type: 'string',
          description: 'The concrete completion objective inferred from the direct human request.'
        },
        max_goal_rounds: {
          type: 'number',
          description: 'Optional positive safe-integer limit on automatic continuation rounds.'
        }
      },
      required: ['objective']
    },
    access: 'meta',
    mutating: true,
    run(args: any, ctx: GoalToolContext) {
      const session = requireGoalSession(ctx);
      requireDirectHuman(ctx);
      createGoal(session, {
        objective: args?.objective,
        ...(args?.max_goal_rounds === undefined ? {} : { maxGoalRounds: args.max_goal_rounds })
      });
      persistGoal(session, ctx.sid, ctx.emit);
      return goalValue(goalView(session));
    }
  } as ToolDef);

  registry.register({
    name: 'update_goal',
    description: 'Update the current goal.',
    parameters: {
      type: 'object',
      properties: {
        goal_id: { type: 'string', description: 'Exact id returned by get_goal.' },
        revision: { type: 'number', description: 'Exact positive revision returned by get_goal.' },
        action: {
          type: 'string',
          enum: UPDATE_ACTIONS,
          description: 'edit, pause, and resume require a direct top-level human request. complete and blocked are also allowed '
            + 'during an automatic continuation of this goal; blocked is rejected before the configured minimum round count.'
        },
        objective: { type: 'string', description: 'Replacement objective; valid only with action edit.' },
        max_goal_rounds: { type: 'number', description: 'Replacement cap; valid only with action edit.' },
        blocked_reason: {
          type: 'string',
          description: 'Required only with action blocked: the concrete condition that persisted across rounds and blocks progress.'
        }
      },
      required: ['goal_id', 'revision', 'action']
    },
    access: 'meta',
    mutating: true,
    run(args: any, ctx: GoalToolContext) {
      const session = requireGoalSession(ctx);
      const goalId = String(args?.goal_id ?? '');
      const revision = args?.revision;
      if (goalId.length === 0 || goalId !== goalId.trim() || !Number.isSafeInteger(revision) || revision < 1) {
        throw new Error('goal_id must be non-empty and revision must be a positive safe integer');
      }
      const ref: GoalRef = { id: goalId, revision };
      const action = String(args?.action ?? '');
      const objective = args?.objective;
      const maxGoalRounds = args?.max_goal_rounds;
      const blockedReason = args?.blocked_reason;
      if (action === 'edit') {
        requireDirectHuman(ctx);
        if (hasText(blockedReason)) throw new Error('blocked_reason is valid only with action blocked');
        editGoal(session, ref, {
          ...(hasText(objective) ? { objective } : {}),
          ...(hasRoundCap(maxGoalRounds) ? { maxGoalRounds } : {})
        });
        persistGoal(session, ctx.sid, ctx.emit);
        return goalValue(goalView(session));
      }
      if (action === 'pause' || action === 'resume') {
        requireDirectHuman(ctx);
        if (hasText(objective) || hasRoundCap(maxGoalRounds) || hasText(blockedReason)) {
          throw new Error('objective and max_goal_rounds are valid only with action edit; blocked_reason is valid only with action blocked');
        }
        const current = goalView(session);
        if (action === 'resume' && current?.id === ref.id && current.revision === ref.revision && current.phase === 'paused') {
          throw new Error('the model cannot resume a paused goal; the user must resume it');
        }
        if (action === 'pause') pauseGoal(session, ref); else resumeGoal(session, ref);
        persistGoal(session, ctx.sid, ctx.emit);
        return goalValue(goalView(session));
      }
      if (action !== 'complete' && action !== 'blocked') throw new Error(`unknown action "${action}"`);
      if (hasText(objective) || hasRoundCap(maxGoalRounds)) {
        throw new Error('objective and max_goal_rounds are valid only with action edit');
      }
      if (action === 'complete' && hasText(blockedReason)) {
        throw new Error('blocked_reason is valid only with action blocked');
      }
      if (action === 'blocked' && (typeof blockedReason !== 'string' || blockedReason.trim().length === 0)) {
        throw new Error('blocked_reason is required with action blocked');
      }
      // blocked 的机械下限:只在自动续跑轮里生效(人类直接请求可以立刻叫停)
      const round = ctx.goalRound;
      if (action === 'blocked' && round) {
        const current = goalView(session);
        if (current !== undefined && current.roundsStarted < BLOCKED_AFTER_CONSECUTIVE_ROUNDS) {
          throw new Error(`blocked requires at least ${BLOCKED_AFTER_CONSECUTIVE_ROUNDS} consecutive goal rounds; `
            + `current round is ${current.roundsStarted}`);
        }
      }
      if (action === 'complete') completeGoal(session, ref);
      else blockGoal(session, ref, { code: 'model-reported', message: blockedReason as string });
      persistGoal(session, ctx.sid, ctx.emit);
      const view = goalView(session);
      if (round) {
        // 自动续跑轮里报告完成/受阻:本轮到此为止,模型写收尾说明(harness 的 deferContext + concludeTurn)
        return {
          content: goalValue(view) + (action === 'complete'
            ? '\n（目标已完成,本轮结束;请在正文里给用户写一段收尾说明,不要再发起新的工具调用。）'
            : '\n（目标已标记受阻,本轮结束;请在正文里说明受阻原因与用户可采取的动作。）'),
          concludesTurn: true
        };
      }
      return goalValue(view);
    }
  } as ToolDef);
}
