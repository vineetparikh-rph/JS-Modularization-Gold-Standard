# JS Modularization Gold Standard

**Safely split a Node monolith into modules — and prove behavior didn't change.**

> Command-line tool name: `jsmod`

`jsmod` lifts regions of a giant `server.js`-style file into small
`register(app, kernel)` modules. Every extraction is a **verbatim move**: the
code you pull out is byte-for-byte the code that was there, except for the one
mechanical edit a module boundary forces — references to mutable singletons
become getter/setter calls so the live binding survives the move.

It does **not** refactor. Refactoring and modularizing in the same step is how
you ship silent behavior changes. `jsmod` moves; you refactor later, as
separate, reviewable commits.

> Provenance: this is a clean-room, generic implementation of a methodology
> proven on a real production monolith (an Express `server.js` taken from
> 5,121 lines down to 1,402 across incremental PRs, zero behavioral diffs). The
> npm package name (`js-modularization-gold-standard`) — verify availability
> before publishing to npm; GitHub repo name is independent.

---

## The idea

A monolith accretes route handlers that quietly share helpers and mutable
state. You can't just cut-and-paste a handler into its own file: it closes over
things it no longer has, and any `let` it touches becomes a dead copy.

`jsmod` solves both halves mechanically:

```
require("./modules/billing").register(app, {
  hashId, PRICE_TABLE,                          // immutable: passed straight through
  getSessionCache: () => sessionCache,          // mutable singleton: live read
  setSessionCache: (v) => { sessionCache = v }, // ...and live write
});
```

Inside the module, reads of `sessionCache` become `getSessionCache()` and
`sessionCache = x` becomes `setSessionCache(x)`. The binding still lives in the
parent, so two different modules that share one singleton stay in sync — exactly
as they did before the cut.

## The six gates

An extraction is only allowed to land if it clears all six:

1. **`node --check`** — every file still parses.
2. **Route-count parity** — total registered routes is unchanged.
3. **Isolation `register()`** — each module exports a `register(app, kernel)`.
4. **Residual free-var audit** — the module references nothing it isn't given.
   This is the gate that catches auth-gated handler bodies an HTTP probe never
   reaches, because it reads the AST, not the running server.
5. **Live probe-diff** — boot old vs. new, hit every route, diff status + body.
6. **Incremental PRs** — one module per PR; gates 1–4 run in CI.

`jsmod verify` automates 1–4. Gate 5 ships as the bundled self-test pattern
(`npm test`). Gate 6 is process.

## Install

```bash
npm install -g js-modularization-gold-standard   # or: npx js-modularization-gold-standard ...
```

Requires Node ≥ 18. Built on [`ts-morph`](https://ts-morph.com).

## Quickstart

```bash
# 1. See the seams: which routes touch which symbols, and what clusters
jsmod survey examples/server.js

# 2. Inspect one region before committing to it
jsmod analyze examples/server.js --range 26:33

# 3. Describe the cuts (see jsmod.config.example.json), then preview
jsmod extract --config jsmod.config.json --dry

# 4. Do it for real, then clear the gates
jsmod extract --config jsmod.config.json
jsmod verify  --config jsmod.config.json

# 5. Audit any single module on its own
jsmod audit modules/billing.js
```

## Config

```jsonc
{
  "source": "src/server.js",   // the monolith
  "app": "app",                 // the carrier symbol (first arg to register)
  "expectedRoutes": 137,        // optional: enforce route-count parity
  "modules": [
    { "name": "billing", "ranges": [[420, 511]] },
    { "name": "session", "ranges": [[512, 587]] }
  ]
}
```

Ranges are **inclusive line numbers** and must align to whole top-level
statements. A module may list multiple ranges; the first becomes the
`register(...)` call site, the rest are removed.

## Worked example

`examples/server.js` is a small tangled Express app. Two domains —
`billing` and `session` — both touch a `let sessionCache`, and `billing`
*reassigns* it. After `jsmod extract`:

- `modules/billing.js` gets `getSessionCache` **and** `setSessionCache`
  (it reassigns), `modules/session.js` gets only `getSessionCache` (it reads).
- The parent keeps `let sessionCache` and hands both modules closures over it.
- `POST /billing/reset` clears the cache that `GET /session/:id` reads — across
  two separate files — because the binding never left the parent.

`npm test` proves it: it extracts, runs the gates, then boots the original and
the modularized version and diffs all nine routes. They match exactly, including the
reset-then-read sequence.

## What jsmod assumes / does not do

- **CommonJS, `app.method(...)` registration style** (Express and lookalikes).
  The carrier symbol is configurable but the register pattern is the model.
- **Contiguous statements per range.** Interleaved domains: reorder first, or
  extract across multiple passes (which is what gate 6 wants anyway).
- **JavaScript semantics, not TypeScript types.** It moves code; it won't fix
  type errors a split exposes.
- **It is not magic.** `jsmod` makes the safe move and proves the move; you
  still read the diff. Treat any `unresolved` warning from `analyze` as a
  "look here" flag.

If you've used this on your own monolith and hit a wiring case it didn't
handle, that case is the most valuable thing you can contribute back.

## Credits

Built by [Vineet Parikh](https://github.com/vineetparikh-rph).

Contributions from [lotusmuds](https://github.com/lotusmuds) and
[chrisboyd08043](https://github.com/chrisboyd08043).

## License

MIT.
