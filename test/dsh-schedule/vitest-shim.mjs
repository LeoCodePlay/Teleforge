// 极简 vitest 兼容层:目的是让 **dsh 自己的 spec 文件原样跑起来**(只改了 import 路径)。
// 支持的范围就是这 5 个 spec 实际用到的那部分:describe / it / it.each / expect(常用匹配器) / vi.spyOn。
// 不追求通用 —— 这是"dsh 的测试原样跑"的脚手架,不是要重写 vitest。
const state = { pass: 0, fail: 0, failures: [], suite: [], pending: [] }

export function summary() { return state }
export function flush() { return Promise.all(state.pending) }

function record(name, fn, body) {
  const full = [...state.suite, name].join(' › ')
  const p = (async () => { await body() })()
    .then(() => { state.pass += 1 })
    .catch((error) => { state.fail += 1; state.failures.push({ name: full, error }) })
  state.pending.push(p)
  return p
}

function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) }

function isMatcher(v) { return isPlainObject(v) && typeof v.__matcher === 'string' }

/** toEqual 用的深度比较:**支持非对称匹配器**(expected 里可以嵌 objectContaining,与 vitest 一致) */
function deepEqual(a, b) {
  if (isMatcher(b)) return matchesPartial(a, b)
  if (Object.is(a, b)) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a), kb = Object.keys(b)
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]))
  }
  return false
}

function matchesPartial(actual, partial) {
  if (partial && partial.__matcher === 'objectContaining') return includesShape(actual, partial.sample)
  return deepEqual(actual, partial)
}

/** toMatchObject 的语义:嵌套的普通对象按"子集"比较(不要求键数相等) */
function includesShape(actual, sample) {
  if (isMatcher(sample)) return matchesPartial(actual, sample)
  if (isPlainObject(sample)) {
    if (!isPlainObject(actual)) return deepEqual(actual, sample)
    return Object.keys(sample).every((k) => includesShape(actual[k], sample[k]))
  }
  if (Array.isArray(sample)) {
    if (!Array.isArray(actual) || actual.length !== sample.length) return false
    return sample.every((v, i) => includesShape(actual[i], v))
  }
  return deepEqual(actual, sample)
}

const show = (v) => {
  try { return typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? String(v) } catch { return String(v) }
}

class AssertionError extends Error {}

function matchers(actual, negated, label) {
  const check = (ok, message) => {
    if (negated ? ok : !ok) throw new AssertionError(`${label}: ${message}`)
  }
  return {
    toBe: (expected) => check(Object.is(actual, expected), `期望 ${show(expected)},实际 ${show(actual)}`),
    toEqual: (expected) => check(deepEqual(actual, expected), `期望 ${show(expected)},实际 ${show(actual)}`),
    toMatchObject: (expected) => check(includesShape(actual, expected), `期望包含 ${show(expected)},实际 ${show(actual)}`),
    toContain: (expected) => check(typeof actual?.includes === 'function' && actual.includes(expected), `期望包含 ${show(expected)}`),
    toHaveLength: (n) => check(actual?.length === n, `期望长度 ${n},实际 ${actual?.length}`),
    toBeInstanceOf: (Ctor) => check(actual instanceof Ctor, `期望是 ${Ctor?.name} 的实例,实际 ${show(actual)}`),
    toBeGreaterThan: (n) => check(actual > n, `期望 > ${n},实际 ${show(actual)}`),
    toBeLessThan: (n) => check(actual < n, `期望 < ${n},实际 ${show(actual)}`),
    toBeLessThanOrEqual: (n) => check(actual <= n, `期望 <= ${n},实际 ${show(actual)}`),
    toBeUndefined: () => check(actual === undefined, `期望 undefined,实际 ${show(actual)}`),
    toBeDefined: () => check(actual !== undefined, '期望有值'),
    toBeTruthy: () => check(!!actual, '期望为真'),
    toHaveBeenCalled: () => check((actual?.mock?.calls?.length ?? 0) > 0, '期望被调用过'),
    toThrow: (expected) => {
      let thrown
      let threw = false
      try { actual() } catch (e) { threw = true; thrown = e }
      if (!threw) { check(false, '期望抛错,但没有抛'); return }
      if (expected === undefined) { check(true, ''); return }
      const ok = expected instanceof RegExp
        ? expected.test(String(thrown?.message ?? thrown))
        : typeof expected === 'function'
          ? thrown instanceof expected
          : expected?.__matcher === 'objectContaining'
            ? includesShape(thrown, expected.sample)
            : String(thrown?.message ?? thrown).includes(String(expected))
      check(ok, `抛出的错误不匹配:${String(thrown?.message ?? thrown)}`)
    },
  }
}

function expect(actual) {
  const api = matchers(actual, false, 'expect')
  api.not = matchers(actual, true, 'expect.not')
  return api
}
expect.objectContaining = (sample) => ({ __matcher: 'objectContaining', sample })
expect.any = (Ctor) => ({ __matcher: 'any', Ctor })

function formatTemplate(template, args, index) {
  return String(template)
    .replace(/%[sdifjo]/g, (m, offset) => show(args[0]) && show(args[0]))
    .replace(/%j/g, show(args[0]))
    .replace(/%#/g, String(index))
    .replace(/%[sdif]/g, () => show(args[0]))
}

function it(name, fn) { return record(name, fn, () => fn()) }
it.each = (cases) => (name, fn) => {
  cases.forEach((row, index) => {
    const args = Array.isArray(row) ? row : [row]
    const title = String(name)
      .replace(/%#/g, String(index))
      .replace(/%j/g, show(args[0]))
      .replace(/%[sdifo]/g, () => show(args[0]))
    record(title, fn, () => fn(...args))
  })
}
it.skip = () => {}
it.only = (name, fn) => it(name, fn)

function describe(name, fn) {
  state.suite.push(name)
  try { fn() } finally { state.suite.pop() }
}
describe.skip = () => {}
describe.each = (cases) => (name, fn) => cases.forEach((row) => describe(formatTemplate(name, Array.isArray(row) ? row : [row], 0), () => fn(...(Array.isArray(row) ? row : [row]))))

const vi = {
  fn: (impl) => {
    const spy = (...args) => { spy.mock.calls.push(args); return impl?.(...args) }
    spy.mock = { calls: [] }
    return spy
  },
  spyOn: (obj, method) => {
    const original = obj[method]
    const spy = function (...args) { spy.mock.calls.push(args); return original.apply(this, args) }
    spy.mock = { calls: [] }
    spy.mockRestore = () => { obj[method] = original }
    obj[method] = spy
    return spy
  },
  useFakeTimers: () => {},
  advanceTimersByTime: () => {},
  runAllTimers: () => {},
}

globalThis.describe = describe
globalThis.it = it
globalThis.expect = expect
globalThis.vi = vi
globalThis.beforeEach = () => {}
globalThis.afterEach = () => {}
globalThis.beforeAll = () => {}
globalThis.afterAll = () => {}

// 同时用具名导出:把 spec 里的 `from 'vitest'` 换成 `from './vitest-shim.mjs'` 即可原样跑
export { describe, it, expect, vi }
export const beforeEach = globalThis.beforeEach
export const afterEach = globalThis.afterEach
export const beforeAll = globalThis.beforeAll
export const afterAll = globalThis.afterAll
