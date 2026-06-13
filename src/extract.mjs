// carve — verbatim extraction engine
//
// Core principle: an extraction is a *move*, never a rewrite. We lift a region
// of top-level statements out of the monolith and drop it, byte-for-byte, into
// a `register(app, kernel)` module. The only edits we make to the moved code are
// the mechanical ones forced by crossing a module boundary: references to mutable
// singletons become getter/setter calls so the live binding is preserved.
//
// We never touch the AST of the code we move. All transforms are computed as
// text spans and applied to a string copy, so there is zero chance of a clever
// refactor sneaking in.

import { SyntaxKind, ts } from "ts-morph";
import { analyzeRegion } from "./analyze.mjs";

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const getterName = (n) => `get${cap(n)}`;
const setterName = (n) => `set${cap(n)}`;

// Top-level statements wholly inside [startLine, endLine].
function statementsInRange(sourceFile, startLine, endLine) {
  return sourceFile.getStatements().filter((st) => {
    const a = st.getStartLineNumber();
    const b = st.getEndLineNumber();
    return a >= startLine && b <= endLine;
  });
}

// Is this const declared as `const X = require("...")`? If so return the require text.
function requireInitializerText(decls) {
  for (const d of decls) {
    if (d.getKind() !== SyntaxKind.VariableDeclaration) continue;
    const init = d.getInitializer?.();
    if (!init) continue;
    if (init.getKind() === SyntaxKind.CallExpression) {
      const ce = init;
      if (ce.getExpression().getText() === "require") {
        return init.getText();
      }
    }
  }
  return null;
}

// Build {start,end,text} replacement spans (absolute file offsets) for one
// mutable singleton within [regionStart, regionEnd].
function mutableSpans(sourceFile, name, regionStart, regionEnd) {
  const spans = [];
  const consumed = new Set(); // identifier nodes already handled by an enclosing assign/incdec

  const refs = [];
  sourceFile.forEachDescendant((node) => {
    if (node.getKind() !== SyntaxKind.Identifier) return;
    if (node.getText() !== name) return;
    const s = node.getStart();
    if (s < regionStart || s > regionEnd) return;
    const p = node.getParent();
    // skip property names / keys (`obj.name`, `{ name: ... }`)
    if (p && p.getKind() === SyntaxKind.PropertyAccessExpression && p.getNameNode() === node) return;
    refs.push(node);
  });

  for (const id of refs) {
    const p = id.getParent();
    if (!p) continue;
    // x = expr  /  x += expr ...
    if (p.getKind() === SyntaxKind.BinaryExpression && p.getLeft() === id) {
      const op = p.getOperatorToken().getText();
      const rhs = p.getRight().getText();
      if (op === "=") {
        spans.push({ start: p.getStart(), end: p.getEnd(), text: `${setterName(name)}(${rhs})` });
        consumed.add(id); continue;
      }
      const compound = { "+=": "+", "-=": "-", "*=": "*", "/=": "/", "%=": "%",
        "**=": "**", "&=": "&", "|=": "|", "^=": "^", "<<=": "<<", ">>=": ">>",
        ">>>=": ">>>", "&&=": "&&", "||=": "||", "??=": "??" }[op];
      if (compound) {
        spans.push({ start: p.getStart(), end: p.getEnd(),
          text: `${setterName(name)}(${getterName(name)}() ${compound} (${rhs}))` });
        consumed.add(id); continue;
      }
    }
    // x++ / ++x / x-- / --x  (statement-position value semantics preserved well enough)
    if (p.getKind() === SyntaxKind.PostfixUnaryExpression ||
        p.getKind() === SyntaxKind.PrefixUnaryExpression) {
      const tok = p.getOperatorToken?.();
      if (tok === ts.SyntaxKind.PlusPlusToken || tok === ts.SyntaxKind.MinusMinusToken) {
        const delta = tok === ts.SyntaxKind.PlusPlusToken ? "+ 1" : "- 1";
        spans.push({ start: p.getStart(), end: p.getEnd(),
          text: `${setterName(name)}(${getterName(name)}() ${delta})` });
        consumed.add(id); continue;
      }
    }
  }
  // plain reads
  for (const id of refs) {
    if (consumed.has(id)) continue;
    spans.push({ start: id.getStart(), end: id.getEnd(), text: `${getterName(name)}()` });
  }
  return spans;
}

/**
 * Plan one module from one or more contiguous line ranges.
 * Returns the module source text + the kernel object literal the parent must pass,
 * + the parent text spans to delete/replace.
 */
export function planModule(sourceFile, mod) {
  const carrier = mod.app || "app";
  const ranges = [...mod.ranges].sort((a, b) => a[0] - b[0]);

  const valueDeps = new Map();    // name -> "kernel" | requireText
  const mutableDeps = new Map();  // name -> { reassigned }
  const slices = [];              // { regionStart, regionEnd, text(rewritten) }

  for (const [startLine, endLine] of ranges) {
    const stmts = statementsInRange(sourceFile, startLine, endLine);
    if (stmts.length === 0) {
      throw new Error(`No top-level statements found in lines ${startLine}-${endLine} for module "${mod.name}". Ranges must align to whole statements.`);
    }
    const regionStart = stmts[0].getStart();
    const regionEnd = stmts[stmts.length - 1].getEnd();

    const { deps } = analyzeRegion(sourceFile, startLine, endLine, { carriers: [carrier] });

    // Gather text-replacement spans for every mutable singleton in this region.
    const allSpans = [];
    for (const d of deps) {
      if (d.kind === "mutable") {
        mutableDeps.set(d.name, {
          reassigned: (mutableDeps.get(d.name)?.reassigned || d.reassigned),
        });
        allSpans.push(...mutableSpans(sourceFile, d.name, regionStart, regionEnd));
      }
    }

    // Resolve value deps (require-backed vs kernel) using symbols.
    for (const d of deps) {
      if (d.kind !== "value") continue;
      if (valueDeps.has(d.name)) continue;
      let decls = [];
      sourceFile.forEachDescendant((n) => {
        if (decls.length) return;
        if (n.getKind() === SyntaxKind.Identifier && n.getText() === d.name) {
          const s = n.getStart();
          if (s >= regionStart && s <= regionEnd) {
            try { const sym = n.getSymbol(); if (sym) decls = sym.getDeclarations(); } catch {}
          }
        }
      });
      const reqText = requireInitializerText(decls);
      valueDeps.set(d.name, reqText ? { require: reqText } : "kernel");
    }

    // Apply spans (descending) to a copy of the region text.
    const full = sourceFile.getFullText();
    let text = full.slice(regionStart, regionEnd);
    const rel = allSpans
      .map((s) => ({ start: s.start - regionStart, end: s.end - regionStart, text: s.text }))
      .sort((a, b) => b.start - a.start);
    for (const s of rel) {
      text = text.slice(0, s.start) + s.text + text.slice(s.end);
    }
    slices.push({ regionStart, regionEnd, text });
  }

  // ---- assemble module source ----
  const requires = [];
  const kernelValueNames = [];
  for (const [name, v] of valueDeps) {
    if (v && v.require) requires.push(`const ${name} = ${v.require};`);
    else kernelValueNames.push(name);
  }
  const getterDestructure = [];
  const kernelProvide = []; // what the PARENT passes
  for (const name of kernelValueNames) kernelProvide.push(name);
  for (const [name, info] of mutableDeps) {
    getterDestructure.push(getterName(name));
    if (info.reassigned) getterDestructure.push(setterName(name));
    kernelProvide.push(`${getterName(name)}: () => ${name}`);
    if (info.reassigned) kernelProvide.push(`${setterName(name)}: (v) => { ${name} = v; }`);
  }

  const destructureLines = [];
  if (kernelValueNames.length) destructureLines.push(`  const { ${kernelValueNames.join(", ")} } = kernel;`);
  if (getterDestructure.length) destructureLines.push(`  const { ${getterDestructure.join(", ")} } = kernel;`);

  const body = slices.map((s) => s.text).join("\n\n");
  const indentedBody = body.split("\n").map((l) => (l.length ? "  " + l : l)).join("\n");

  const moduleSrc =
`"use strict";
// Verbatim-extracted from the monolith by carve. Do not refactor in place.
// Generated module — edits should be made as deliberate follow-up commits.
${requires.length ? requires.join("\n") + "\n" : ""}
module.exports.register = function register(${carrier}, kernel = {}) {
${destructureLines.length ? destructureLines.join("\n") + "\n" : ""}
${indentedBody}
};
`;

  // ---- parent replacement ----
  const provide = kernelProvide.length ? `{ ${kernelProvide.join(", ")} }` : "{}";
  const registerCall = `require("./modules/${mod.name}").register(${carrier}, ${provide});`;

  return {
    name: mod.name,
    moduleSrc,
    registerCall,
    slices: slices.map((s) => ({ start: s.regionStart, end: s.regionEnd })),
    kernelProvide,
  };
}
