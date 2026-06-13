// test/selftest.mjs — carve proves itself.
//
// Copies the bundled example monolith, extracts two modules, runs the gates,
// then boots the original vs. the patched server and diffs every route. CI
// runs this on every push: if behavior ever changes, the build goes red.

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "carve-selftest-"));

function sh(cmd, args, cwd = work) {
  return execFileSync(cmd, args, { cwd, stdio: "pipe" }).toString();
}

fs.copyFileSync(path.join(repo, "examples/server.js"), path.join(work, "server.js"));
fs.copyFileSync(path.join(repo, "examples/server.js"), path.join(work, "orig.js"));
fs.writeFileSync(path.join(work, "carve.config.json"), JSON.stringify({
  source: path.join(work, "server.js"),
  app: "app",
  expectedRoutes: 6,
  modules: [
    { name: "billing", ranges: [[26, 33]] },
    { name: "session", ranges: [[36, 44]] },
  ],
}, null, 2));

console.log("· installing express in sandbox…");
sh("npm", ["install", "express", "--no-save", "--silent"]);

console.log("· extract…");
console.log(sh("node", [path.join(repo, "bin/cli.mjs"), "extract", "--config", path.join(work, "carve.config.json")]));

console.log("· verify (gates)…");
console.log(sh("node", [path.join(repo, "bin/cli.mjs"), "verify", "--config", path.join(work, "carve.config.json")]));

console.log("· probe-diff (behavioral)…");
const SEQ = [
  ["GET", "/health"], ["GET", "/billing/price/pro"],
  ["GET", "/session/abc"], ["GET", "/session/abc"], ["GET", "/health"],
  ["POST", "/billing/reset"], ["GET", "/session/abc"],
  ["DELETE", "/session/abc"], ["GET", "/billing/price/nope"],
];
function boot(file) {
  return new Promise((res) => {
    const p = spawn("node", [file], { cwd: work });
    p.stdout.on("data", (d) => { if (String(d).includes("up on 3000")) res(p); });
  });
}
async function probe(file) {
  const p = await boot(file);
  await new Promise((r) => setTimeout(r, 250));
  const out = [];
  for (const [m, u] of SEQ) {
    const r = await fetch("http://localhost:3000" + u, { method: m });
    out.push(`${m} ${u} ${r.status} ${await r.text()}`);
  }
  p.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 250));
  return out;
}
const before = await probe("orig.js");
const after = await probe("server.js");
let diffs = 0;
for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) {
  diffs++; console.log(`  ✗ DIFF\n    orig: ${before[i]}\n    new:  ${after[i]}`);
}
fs.rmSync(work, { recursive: true, force: true });
if (diffs === 0) { console.log("\nselftest: PASS — 9/9 routes identical ✓"); process.exit(0); }
console.log(`\nselftest: FAIL — ${diffs} behavioral differences ✗`); process.exit(1);
