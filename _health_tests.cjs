// 体检用:逐条运行 package.json#scripts.test 里的每个测试,单条失败不中断
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const root = __dirname;
const pkg = require(path.join(root, "package.json"));
const chain = pkg.scripts.test;
const steps = chain.split("&&").map((s) => s.trim()).filter(Boolean);
const PER_TEST_MS = Number(process.env.PER_TEST_MS || 180000);
const results = [];
const t0 = Date.now();
for (const step of steps) {
  const label = step.replace(/^node\s+/, "");
  const r = spawnSync(process.execPath, step.replace(/^node\s+/, "").split(/\s+/).slice(1), {
    cwd: root,
    encoding: "utf8",
    timeout: PER_TEST_MS,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  const failed = r.status !== 0;
  results.push({ label, failed, timedOut: r.error !== undefined, tail: out.trim().split(/\r?\n/).slice(-6).join("\n") });
  console.log(`${failed ? "FAIL" : "ok  "}  ${label}`);
  if (failed) console.log(out.trim().split(/\r?\n/).slice(-8).map((l) => "      | " + l).join("\n"));
}
const fails = results.filter((r) => r.failed);
console.log("\n===== 汇总 =====");
console.log(`总计 ${results.length} 个测试,通过 ${results.length - fails.length},失败 ${fails.length},耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
for (const f of fails) console.log(`  FAIL ${f.label}${f.timedOut ? " (超时)" : ""}`);
