// examples/server.js — a deliberately tangled Express monolith.
// Used in the README walkthrough and as carve's own test fixture.
const express = require("express");
const crypto = require("crypto");

const app = express();
app.use(express.json());

// --- shared helpers (const / function: immutable "value" deps) ---
function hashId(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 12);
}
const PRICE_TABLE = { basic: 10, pro: 30 };

// --- mutable singletons (let: need getter; reassigned ones need setter too) ---
let requestCount = 0;
let sessionCache = {};

// ===== misc routes (we will NOT extract these) =====
app.get("/health", (req, res) => {
  requestCount++;
  res.json({ ok: true, seen: requestCount });
});

// ===== billing domain (extract -> modules/billing.js) =====
app.get("/billing/price/:plan", (req, res) => {
  const plan = req.params.plan;
  res.json({ plan, price: PRICE_TABLE[plan] ?? null, ref: hashId(plan) });
});
app.post("/billing/reset", (req, res) => {
  sessionCache = {}; // reassigns the binding -> setter required
  res.json({ reset: true });
});

// ===== session domain (extract -> modules/session.js) =====
app.get("/session/:id", (req, res) => {
  const id = req.params.id;
  sessionCache[id] = (sessionCache[id] || 0) + 1; // mutates, does not reassign
  res.json({ id, hits: sessionCache[id], token: hashId(id) });
});
app.delete("/session/:id", (req, res) => {
  delete sessionCache[req.params.id];
  res.json({ deleted: true });
});

app.listen(3000, () => console.log("up on 3000"));
