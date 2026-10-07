// 用 **dsh 自己的 spec 文件**验证搬过来的时间内核(server/schedule/dsh/)。
//
// 这是这次迁移的"验收":daily/weekly/cron/domain/recurrence 五个 spec 原样放在
// test/dsh-schedule/ 下(只改了 import 路径),跑的却是我们的实现。任何一处 DST 缺口、
// 重叠取更早、cron 子集、every 锚点、错过只取最近一次的口径不一致,这里都会亮红。
// 运行:node test/dsh-schedule-specs.test.js
import './dsh-schedule/vitest-shim.mjs'

const shim = await import('./dsh-schedule/vitest-shim.mjs')

const specs = ['daily', 'weekly', 'cron', 'domain', 'recurrence']
for (const name of specs) {
  console.log(`\n===== dsh spec: ${name} =====`)
  await import(`./dsh-schedule/${name}.spec.ts`)
}

await shim.flush()
await new Promise((resolve) => setTimeout(resolve, 50))
await shim.flush()

const { pass, fail, failures } = shim.summary()
for (const f of failures) {
  console.error(`\n✗ ${f.name}\n  ${f.error?.message ?? f.error}`)
}
console.log(`\n==== dsh spec 结果: ${pass} 通过, ${fail} 失败 ====`)
if (fail) process.exit(1)
