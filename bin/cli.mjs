#!/usr/bin/env node
// carve — safely split a Node monolith into register(app, kernel) modules,
// and prove behavior didn't change.
//
// Commands:
//   carve survey   <file> [--app app]               map routes -> symbols, suggest clusters
//   carve analyze  <file> --range A:B [--app app]    free-variable report for a region
//   carve extract  --config carve.config.json [--dry] perform verbatim extractions
//   carve audit    <moduleFile>                       residual free-var gate (must be clean)
//   carve verify   --config carve.config.json         run the automatable gates

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { makeProject, analyzeRegion } from "../src/analyze.mjs";
import { planModule } from "../src/extract.mjs";
import { survey } from "../src/survey.mjs";

const args = process.argv.slice(2);
const cmd = args[0];

function flag(name, fallback = undefined) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : true;
}
const has = (name) => args.includes(`--${name}`);

function die(msg) { console.error("carve: " + msg); process.exit(1); }

function loadSourceFile(file) {
  if (!file || !fs.existsSync(file)) die(`file not found: ${file}`);
  const project = makeProject();
  return { project, sf: project.addSourceFileAtPath(path.resolve(file)) };
}

// ---------------------------------------------------------------- survey
function cmdSurvey() {
  const file = args[1];
  const { sf } = loadSourceFile(file);
  const app = flag("app", "app");
  const { rows, clusters } = survey(sf, { app });

  console.log(`\nRoutes on \`${app}\` in ${file}:\n`);
  for (const r of rows) {
    const m = r.mutable.length ? `  [mutable: ${r.mutable.join(", ")}]` : "";
    console.log(`  ${String(r.startLine).padStart(4)}-${String(r.endLine).padEnd(4)} ${r.method.toUpperCase().padEnd(6)} ${r.path}`);
    if (r.deps.length) console.log(`         deps: ${r.deps.join(", ")}${m}`);
  }
  console.log(`\nSuggested clusters (routes that share state):\n`);
  clusters
    .sort((a, b) => a[0].startLine - b[0].startLine)
    .forEach((c, i) => {
      const lo = Math.min(...c.map((r) => r.startLine));
      const hi = Math.max(...c.map((r) => r.endLine));
      const shared = [...new Set(c.flatMap((r) => r.deps))];
      console.log(`  cluster ${i + 1}: lines ~${lo}-${hi} (${c.length} route${c.length > 1 ? "s" : ""})`);
      c.forEach((r) => console.log(`     - ${r.method.toUpperCase()} ${r.path}`));
      if (shared.length) console.log(`     shared symbols: ${shared.join(", ")}`);
      const contiguous = c.every((r, k, arr) =>
        k === 0 || r.startLine > arr[k - 1].endLine);
      if (c.length > 1 && !routesAreContiguous(rows, c)) {
        console.log(`     ⚠ not contiguous in the file — reorder before extracting, or split into passes`);
      }
    });
  console.log();
}

// true if the cluster's routes form an unbroken run with no foreign routes between
function routesAreContiguous(allRows, cluster) {
  const idxs = cluster.map((r) => allRows.indexOf(r)).sort((a, b) => a - b);
  return idxs.every((v, i) => i === 0 || v === idxs[i - 1] + 1);
}

// ---------------------------------------------------------------- analyze
function cmdAnalyze() {
  const file = args[1];
  const { sf } = loadSourceFile(file);
  const range = flag("range");
  if (!range || range === true) die("--range A:B required (line numbers)");
  const [a, b] = String(range).split(":").map(Number);
  const app = flag("app", "app");
  const { deps, unresolved } = analyzeRegion(sf, a, b, { carriers: [app] });

  console.log(`\nFree-variable analysis, lines ${a}-${b} (carrier: ${app}):\n`);
  const values = deps.filter((d) => d.kind === "value");
  const mut = deps.filter((d) => d.kind === "mutable");
  if (values.length) console.log("  value deps (kernel/destructure): " + values.map((d) => d.name).join(", "));
  if (mut.length) console.log("  mutable singletons (getter" +
    (mut.some((d) => d.reassigned) ? "/setter" : "") + "): " +
    mut.map((d) => d.name + (d.reassigned ? " (reassigned→setter)" : " (read→getter)")).join(", "));
  if (unresolved.length) console.log("  ⚠ unresolved (check manually): " + unresolved.join(", "));
  if (!deps.length && !unresolved.length) console.log("  [] (clean — nothing to wire)");
  console.log();
}

// ---------------------------------------------------------------- extract
function readConfig() {
  const cfgPath = flag("config", "carve.config.json");
  if (!fs.existsSync(cfgPath)) die(`config not found: ${cfgPath}`);
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  if (!cfg.source) die("config needs a \"source\" path");
  if (!Array.isArray(cfg.modules) || !cfg.modules.length) die("config needs a non-empty \"modules\" array");
  return { cfgPath, cfg };
}

function cmdExtract() {
  const { cfg } = readConfig();
  const dry = has("dry");
  const { sf } = loadSourceFile(cfg.source);
  const carrier = cfg.app || "app";

  // Plan every module against the ORIGINAL file (line numbers stay valid).
  const plans = cfg.modules.map((m) =>
    planModule(sf, { app: carrier, ...m }));

  // Apply parent edits bottom-up so offsets never drift.
  let parentText = sf.getFullText();
  const edits = [];
  for (const plan of plans) {
    const sorted = [...plan.slices].sort((a, b) => a.start - b.start);
    // first slice -> register call; remaining slices -> deleted
    edits.push({ start: sorted[0].start, end: sorted[0].end, text: plan.registerCall });
    for (let i = 1; i < sorted.length; i++) {
      edits.push({ start: sorted[i].start, end: sorted[i].end, text: "" });
    }
  }
  edits.sort((a, b) => b.start - a.start);
  for (const e of edits) {
    parentText = parentText.slice(0, e.start) + e.text + parentText.slice(e.end);
  }

  const srcDir = path.dirname(path.resolve(cfg.source));
  const modDir = path.join(srcDir, "modules");

  if (dry) {
    console.log(`\n[dry run] would write ${plans.length} module(s) to ${modDir}/ and patch ${cfg.source}\n`);
    for (const p of plans) {
      console.log(`--- modules/${p.name}.js ---`);
      console.log(p.moduleSrc);
    }
    console.log(`--- patched ${path.basename(cfg.source)} (preview) ---`);
    console.log(parentText);
    return;
  }

  fs.mkdirSync(modDir, { recursive: true });
  for (const p of plans) {
    fs.writeFileSync(path.join(modDir, `${p.name}.js`), p.moduleSrc);
    console.log(`wrote modules/${p.name}.js`);
  }
  fs.writeFileSync(path.resolve(cfg.source), parentText);
  console.log(`patched ${cfg.source}`);
  console.log(`\nNext: run \`carve verify --config <config>\` to clear the gates.`);
}

// ---------------------------------------------------------------- audit
function auditModuleFile(file) {
  const { sf } = loadSourceFile(file);
  // find register(...) body
  let body = null, carrier = "app", destructured = new Set();
  sf.forEachDescendant((n) => {
    if (body) return;
    if (n.getKindName() === "FunctionExpression" || n.getKindName() === "ArrowFunction") {
      const parent = n.getParent();
      if (parent && parent.getText().includes("register")) {
        const params = n.getParameters();
        if (params[0]) carrier = params[0].getName();
        body = n.getBody();
      }
    }
  });
  if (!body) return { ok: false, reason: "no register() function found" };

  // collect destructured kernel names + local declarations are handled by analyzeRegion
  const a = body.getStartLineNumber();
  const b = body.getEndLineNumber();
  const { deps, unresolved } = analyzeRegion(sf, a, b, { carriers: [carrier, "kernel"] });
  // names destructured from kernel are declared inside the body, so analyzeRegion
  // already treats them as local. What remains in deps would be true leaks.
  const leaks = deps.map((d) => d.name).concat(unresolved);
  return { ok: leaks.length === 0, leaks };
}

function cmdAudit() {
  const file = args[1];
  if (!file) die("usage: carve audit <moduleFile>");
  const r = auditModuleFile(file);
  if (r.ok) { console.log(`\n${file}: [] (clean) ✓\n`); }
  else {
    console.log(`\n${file}: residual free vars: ${(r.leaks || []).join(", ") || r.reason} ✗\n`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------- verify
function nodeCheck(file) {
  try { execFileSync("node", ["--check", file], { stdio: "pipe" }); return true; }
  catch (e) { console.log(`  ✗ node --check ${file}\n${e.stderr?.toString() || ""}`); return false; }
}
function countRoutes(text) {
  const m = text.match(/\b\w+\.(get|post|put|delete|patch|options|head|all|use)\s*\(/g);
  return m ? m.length : 0;
}
function cmdVerify() {
  const { cfg } = readConfig();
  const srcPath = path.resolve(cfg.source);
  const modDir = path.join(path.dirname(srcPath), "modules");
  let pass = true;

  console.log("\nGate 1 — node --check (syntax):");
  pass = nodeCheck(srcPath) && pass;
  for (const m of cfg.modules) {
    const f = path.join(modDir, `${m.name}.js`);
    if (fs.existsSync(f)) pass = nodeCheck(f) && pass;
  }
  if (pass) console.log("  ✓ all files parse");

  console.log("\nGate 2 — route count parity:");
  const parentRoutes = countRoutes(fs.readFileSync(srcPath, "utf8"));
  let moduleRoutes = 0;
  for (const m of cfg.modules) {
    const f = path.join(modDir, `${m.name}.js`);
    if (fs.existsSync(f)) moduleRoutes += countRoutes(fs.readFileSync(f, "utf8"));
  }
  const baseline = cfg.expectedRoutes;
  console.log(`  parent now: ${parentRoutes}, modules: ${moduleRoutes}, total: ${parentRoutes + moduleRoutes}` +
    (baseline != null ? ` (baseline: ${baseline})` : ""));
  if (baseline != null && parentRoutes + moduleRoutes !== baseline) {
    console.log("  ✗ route count changed"); pass = false;
  } else console.log("  ✓ (set \"expectedRoutes\" in config to enforce)");

  console.log("\nGate 3 — isolation register():");
  for (const m of cfg.modules) {
    const f = path.join(modDir, `${m.name}.js`);
    const ok = fs.existsSync(f) && /module\.exports\.register\s*=/.test(fs.readFileSync(f, "utf8"));
    console.log(`  ${ok ? "✓" : "✗"} modules/${m.name}.js exports register`);
    pass = ok && pass;
  }

  console.log("\nGate 4 — residual free-var audit:");
  for (const m of cfg.modules) {
    const f = path.join(modDir, `${m.name}.js`);
    if (!fs.existsSync(f)) { pass = false; continue; }
    const r = auditModuleFile(f);
    console.log(`  ${r.ok ? "✓" : "✗"} modules/${m.name}.js ${r.ok ? "[] (clean)" : "leaks: " + (r.leaks || []).join(", ")}`);
    pass = r.ok && pass;
  }

  console.log("\nGate 5 — live probe-diff:  (manual) boot old vs new, diff every route's status+body.");
  console.log("Gate 6 — incremental PRs:  (process) one module per PR; the gates above run in CI.");
  console.log(pass ? "\nAutomatable gates: PASS ✓\n" : "\nAutomatable gates: FAIL ✗\n");
  if (!pass) process.exit(2);
}

// ---------------------------------------------------------------- dispatch
const HELP = `carve — verbatim monolith modularization

  carve survey  <file> [--app app]
  carve analyze <file> --range A:B [--app app]
  carve extract --config carve.config.json [--dry]
  carve audit   <moduleFile>
  carve verify  --config carve.config.json
`;

try {
  switch (cmd) {
    case "survey": cmdSurvey(); break;
    case "analyze": cmdAnalyze(); break;
    case "extract": cmdExtract(); break;
    case "audit": cmdAudit(); break;
    case "verify": cmdVerify(); break;
    default: console.log(HELP);
  }
} catch (e) {
  die(e.stack || e.message);
}
