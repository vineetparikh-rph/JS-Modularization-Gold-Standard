// carve — survey
//
// Before you cut, you need to know where the seams are. survey walks every
// top-level route registration, records which in-file symbols each one touches,
// and groups routes that share state into candidate modules. It is a planning
// aid, not a decision — you still choose the ranges.

import { SyntaxKind } from "ts-morph";
import { analyzeRegion } from "./analyze.mjs";

const HTTP = new Set(["get", "post", "put", "delete", "patch", "options", "head", "all", "use"]);

function routeStatements(sourceFile, carrier) {
  const out = [];
  for (const st of sourceFile.getStatements()) {
    if (st.getKind() !== SyntaxKind.ExpressionStatement) continue;
    const expr = st.getExpression();
    if (expr.getKind() !== SyntaxKind.CallExpression) continue;
    const callee = expr.getExpression();
    if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) continue;
    const obj = callee.getExpression().getText();
    const method = callee.getNameNode().getText();
    if (obj !== carrier || !HTTP.has(method)) continue;
    const args = expr.getArguments();
    const path = args[0] && args[0].getKind() === SyntaxKind.StringLiteral
      ? args[0].getLiteralText() : "(dynamic)";
    out.push({
      method, path,
      startLine: st.getStartLineNumber(),
      endLine: st.getEndLineNumber(),
      node: st,
    });
  }
  return out;
}

export function survey(sourceFile, opts = {}) {
  const carrier = opts.app || "app";
  const routes = routeStatements(sourceFile, carrier);

  const rows = routes.map((r) => {
    const { deps } = analyzeRegion(sourceFile, r.startLine, r.endLine, { carriers: [carrier] });
    return {
      ...r,
      deps: deps.map((d) => d.name),
      mutable: deps.filter((d) => d.kind === "mutable").map((d) => d.name),
    };
  });

  // Cluster: union-find over routes that share any in-file symbol.
  const parent = rows.map((_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a, b) => { parent[find(a)] = find(b); };
  const bySymbol = new Map();
  rows.forEach((r, i) => {
    for (const d of r.deps) {
      if (!bySymbol.has(d)) bySymbol.set(d, []);
      bySymbol.get(d).push(i);
    }
  });
  for (const idxs of bySymbol.values()) {
    for (let k = 1; k < idxs.length; k++) union(idxs[0], idxs[k]);
  }
  const clusters = new Map();
  rows.forEach((r, i) => {
    const root = find(i);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(r);
  });

  return { rows, clusters: [...clusters.values()] };
}
