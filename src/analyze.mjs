// carve — free-variable analysis
//
// The kernel of the whole tool: given a region of a monolith, work out which
// identifiers it *references but does not own*. Those are the symbols that have
// to be wired across the module boundary. Everything in carve is built on top
// of getting this exactly right — including the auth-gated handler bodies that
// HTTP probes never execute.

import { Project, SyntaxKind, ts } from "ts-morph";

// Identifiers that resolve to no in-file/import declaration are globals/builtins
// and never need wiring. We resolve via the type-checker, but keep a denylist as
// a fast path and a backstop for ambient names.
const GLOBALS = new Set([
  "console", "process", "Buffer", "module", "exports", "require", "global",
  "__dirname", "__filename", "globalThis", "setTimeout", "clearTimeout",
  "setInterval", "clearInterval", "setImmediate", "queueMicrotask",
  "Promise", "Object", "Array", "String", "Number", "Boolean", "Symbol",
  "Math", "JSON", "Date", "RegExp", "Error", "TypeError", "RangeError",
  "Map", "Set", "WeakMap", "WeakSet", "Proxy", "Reflect", "BigInt",
  "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent",
  "decodeURIComponent", "structuredClone", "fetch", "URL", "URLSearchParams",
  "undefined", "NaN", "Infinity", "arguments", "this", "super",
]);

export function makeProject() {
  return new Project({
    compilerOptions: {
      allowJs: true,
      checkJs: false,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.CommonJS,
      noLib: false,
    },
    skipAddingFilesFromTsConfig: true,
    useInMemoryFileSystem: false,
  });
}

// Is this Identifier a *reference* (read/write of a binding) vs. a declaration
// name, a property name, an object-literal key, a label, etc.?
function isReference(id) {
  const parent = id.getParent();
  if (!parent) return false;
  const pk = parent.getKind();

  // `foo.bar` — `bar` is a property, not a binding reference.
  if (pk === SyntaxKind.PropertyAccessExpression &&
      parent.getNameNode() === id) return false;
  // `{ bar: 1 }` — `bar` is a key.
  if (pk === SyntaxKind.PropertyAssignment &&
      parent.getNameNode?.() === id) return false;
  // `{ bar }` shorthand IS a reference to `bar`, so don't skip it.
  // declaration names:
  if (pk === SyntaxKind.VariableDeclaration && parent.getNameNode() === id) return false;
  if (pk === SyntaxKind.FunctionDeclaration && parent.getNameNode?.() === id) return false;
  if (pk === SyntaxKind.ClassDeclaration && parent.getNameNode?.() === id) return false;
  if (pk === SyntaxKind.Parameter && parent.getNameNode() === id) return false;
  if (pk === SyntaxKind.BindingElement && parent.getNameNode() === id) return false;
  if (pk === SyntaxKind.PropertySignature) return false;
  // labels (`break foo`)
  if (pk === SyntaxKind.LabeledStatement) return false;
  return true;
}

function declaredInsideRange(decls, startPos, endPos, sourceFile) {
  return decls.some((d) => {
    if (d.getSourceFile() !== sourceFile) return false;
    const s = d.getStart();
    return s >= startPos && s <= endPos;
  });
}

// Classify how an in-file declaration must be wired.
//   "value"   — const / function / class  → destructure straight from kernel
//   "mutable" — let / var (reassigned)     → getter (+ setter if reassigned)
function classifyDecl(decls) {
  for (const d of decls) {
    const k = d.getKind();
    if (k === SyntaxKind.FunctionDeclaration || k === SyntaxKind.ClassDeclaration) {
      return "value";
    }
    if (k === SyntaxKind.VariableDeclaration) {
      const list = d.getFirstAncestorByKind(SyntaxKind.VariableDeclarationList);
      const flags = list ? list.getDeclarationKind() : "let";
      return flags === "const" ? "value" : "mutable";
    }
    if (k === SyntaxKind.ImportSpecifier || k === SyntaxKind.ImportClause ||
        k === SyntaxKind.NamespaceImport) {
      return "import";
    }
  }
  return "value";
}

// Does any reference to `name` in the range reassign the binding? (`x =`, `x++`)
function isReassignedInRange(refs) {
  return refs.some((id) => {
    const p = id.getParent();
    if (!p) return false;
    if (p.getKind() === SyntaxKind.BinaryExpression) {
      const be = p;
      const opTok = be.getOperatorToken().getText();
      const assignOps = new Set(["=", "+=", "-=", "*=", "/=", "%=", "**=",
        "&=", "|=", "^=", "<<=", ">>=", ">>>=", "&&=", "||=", "??="]);
      if (assignOps.has(opTok) && be.getLeft() === id) return true;
    }
    const pk = p.getKind();
    if (pk === SyntaxKind.PostfixUnaryExpression ||
        pk === SyntaxKind.PrefixUnaryExpression) {
      const op = p.getOperatorToken?.();
      if (op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken) return true;
    }
    return false;
  });
}

/**
 * Analyze one region of a source file.
 * @returns {{ deps: Array, carriers: string[], unresolved: string[] }}
 *   deps[]: { name, kind: "value"|"mutable"|"import", reassigned }
 */
export function analyzeRegion(sourceFile, startLine, endLine, opts = {}) {
  const carriers = new Set(opts.carriers || ["app"]);
  const full = sourceFile.getFullText();
  const lines = full.split("\n");
  // line -> char position
  const lineStartPos = [];
  let pos = 0;
  for (const ln of lines) { lineStartPos.push(pos); pos += ln.length + 1; }
  const startPos = lineStartPos[startLine - 1] ?? 0;
  const endPos = (lineStartPos[endLine] ?? full.length) - 1;

  // Collect identifier references whose start falls in [startPos, endPos].
  const refsByName = new Map();
  sourceFile.forEachDescendant((node) => {
    if (node.getKind() !== SyntaxKind.Identifier) return;
    const s = node.getStart();
    if (s < startPos || s > endPos) return;
    if (!isReference(node)) return;
    const name = node.getText();
    if (!refsByName.has(name)) refsByName.set(name, []);
    refsByName.get(name).push(node);
  });

  const deps = [];
  const carriersSeen = new Set();
  const unresolved = [];

  for (const [name, refs] of refsByName) {
    if (carriers.has(name)) { carriersSeen.add(name); continue; }
    if (GLOBALS.has(name)) continue;

    // Resolve the binding.
    let decls = [];
    try {
      const sym = refs[0].getSymbol();
      if (sym) decls = sym.getDeclarations();
    } catch { /* checker can throw on broken nodes; treat as unresolved */ }

    if (!decls || decls.length === 0) {
      unresolved.push(name);
      continue;
    }
    // Declared inside the range? Then it's local — not free.
    if (declaredInsideRange(decls, startPos, endPos, sourceFile)) continue;

    // Declared in a lib / node_modules file? Treat as ambient global.
    const inLib = decls.every((d) => {
      const fp = d.getSourceFile().getFilePath();
      return fp.includes("node_modules") || fp.endsWith(".d.ts");
    });
    if (inLib) continue;

    const kind = classifyDecl(decls);
    const reassigned = kind === "mutable" && isReassignedInRange(refs);
    deps.push({ name, kind, reassigned });
  }

  deps.sort((a, b) => a.name.localeCompare(b.name));
  return { deps, carriers: [...carriersSeen], unresolved: unresolved.sort() };
}
