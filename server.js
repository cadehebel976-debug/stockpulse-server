const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || "";
const FINNHUB_KEY = process.env.FINNHUB_KEY || "";

// ─── Postgres setup ──────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      token TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      data JSONB DEFAULT '{}'
    )
  `);
  console.log("DB ready");
}
initDB().catch(console.error);

// ─── Helpers ─────────────────────────────────────────────────────
function hashPassword(pw) {
  return crypto.createHash("sha256").update(pw + "sp_salt_2026").digest("hex");
}
function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

// ─── Auth endpoints ──────────────────────────────────────────────
app.post("/api/signup", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: "Missing fields" });
  try {
    const emailLower = email.toLowerCase().trim();
    const token = generateToken();
    const userId = "u_" + Date.now();
    const defaultData = { stocks: [], alerts: {}, portfolio: {}, frequency: "daily" };
    await pool.query(
      `INSERT INTO users (id, name, email, password, token, data) VALUES ($1,$2,$3,$4,$5,$6)`,
      [userId, name.trim(), emailLower, hashPassword(password), token, JSON.stringify(defaultData)]
    );
    res.json({ token, name: name.trim(), userId });
  } catch(e) {
    if (e.code === "23505") return res.status(400).json({ error: "Email already registered" });
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Missing fields" });
  try {
    const emailLower = email.toLowerCase().trim();
    const result = await pool.query(`SELECT * FROM users WHERE email = $1`, [emailLower]);
    if (!result.rows.length) return res.status(401).json({ error: "No account found with that email" });
    const user = result.rows[0];
    if (user.password !== hashPassword(password)) return res.status(401).json({ error: "Wrong password" });
    const token = generateToken();
    await pool.query(`UPDATE users SET token = $1 WHERE id = $2`, [token, user.id]);
    res.json({ token, name: user.name, userId: user.id, data: user.data });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/verify", async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    const result = await pool.query(`SELECT * FROM users WHERE token = $1`, [token]);
    if (!result.rows.length) return res.status(401).json({ error: "Invalid token" });
    const user = result.rows[0];
    res.json({ valid: true, name: user.name, userId: user.id, data: user.data });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/save", async (req, res) => {
  const { token, data } = req.body;
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    const result = await pool.query(`UPDATE users SET data = $1 WHERE token = $2 RETURNING id`, [JSON.stringify(data), token]);
    if (!result.rows.length) return res.status(401).json({ error: "Invalid token" });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Health check ────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "StockPulse server running", time: new Date().toISOString() });
});

// ─── Live price ──────────────────────────────────────────────────
app.get("/api/price/:ticker", async (req, res) => {
  const { ticker } = req.params;
  for (const host of ["query1", "query2"]) {
    try {
      const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1m&range=1d`;
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      const data = await r.json();
      const meta = data?.chart?.result?.[0]?.meta;
      if (!meta?.regularMarketPrice) continue;
      const price = meta.postMarketPrice > 0 ? meta.postMarketPrice :
                    meta.preMarketPrice > 0 ? meta.preMarketPrice :
                    meta.regularMarketPrice;
      const prev = meta.chartPreviousClose || meta.previousClose || price;
      const closes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
      return res.json({ price, prev, chg: prev?((price-prev)/prev*100):0, closes: closes.filter(x=>x!==null&&x>0), isAH: meta.postMarketPrice>0, isPM: meta.preMarketPrice>0 });
    } catch(e) {}
  }
  if (FINNHUB_KEY) {
    try {
      const fd = await fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FINNHUB_KEY}`).then(r=>r.json());
      if (fd.c > 0) return res.json({ price: fd.c, prev: fd.pc, chg: fd.pc?((fd.c-fd.pc)/fd.pc*100):0, closes: [], isAH: false, isPM: false });
    } catch(e) {}
  }
  res.status(500).json({ error: "Price unavailable" });
});

// ─── Intraday sparkline ──────────────────────────────────────────
app.get("/api/intraday/:ticker", async (req, res) => {
  const { ticker } = req.params;
  for (const host of ["query1", "query2"]) {
    try {
      const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${ticker}?interval=5m&range=1d`;
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      const data = await r.json();
      const result = data?.chart?.result?.[0];
      if (!result) continue;
      const meta = result.meta;
      const price = meta.regularMarketPrice;
      const prev = meta.chartPreviousClose || meta.previousClose || price;
      const closes = result.indicators?.quote?.[0]?.close || [];
      return res.json({ price, prev, chg: prev?((price-prev)/prev*100):0, closes: closes.filter(x=>x!==null&&x>0) });
    } catch(e) {}
  }
  res.status(500).json({ error: "Unavailable" });
});

// ─── Historical chart ────────────────────────────────────────────
app.get("/api/chart/:ticker", async (req, res) => {
  const { ticker } = req.params;
  try {
    const to = Math.floor(Date.now() / 1000);
    const from = to - (35 * 24 * 60 * 60);
    const [candle, metric] = await Promise.all([
      fetch(`https://finnhub.io/api/v1/stock/candle?symbol=${ticker}&resolution=D&from=${from}&to=${to}&token=${FINNHUB_KEY}`).then(r=>r.json()),
      fetch(`https://finnhub.io/api/v1/stock/metric?symbol=${ticker}&metric=all&token=${FINNHUB_KEY}`).then(r=>r.json())
    ]);
    if (candle && candle.s !== "no_data" && candle.c?.length >= 5) {
      const m = metric.metric || {};
      return res.json({ ticker, closes: candle.c, hi52: m["52WeekHigh"], lo52: m["52WeekLow"] });
    }
    res.status(500).json({ error: "Chart unavailable" });
  } catch(e) {
    res.status(500).json({ error: "Chart unavailable" });
  }
});

// ─── Macro data ──────────────────────────────────────────────────
app.get("/api/macro", async (req, res) => {
  const tickers = { vix: "%5EVIX", yield: "%5ETNX", oil: "CL%3DF" };
  const results = {};
  await Promise.all(Object.entries(tickers).map(async ([key, ticker]) => {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1m&range=1d`;
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      const data = await r.json();
      const meta = data?.chart?.result?.[0]?.meta;
      if (meta?.regularMarketPrice) results[key] = meta.regularMarketPrice;
    } catch(e) {}
  }));
  res.json(results);
});

// ─── Sectors ─────────────────────────────────────────────────────
app.get("/api/sectors", async (req, res) => {
  const sectors = { Technology:"XLK", Energy:"XLE", Healthcare:"XLV", Financials:"XLF", Consumer:"XLY", Industrials:"XLI" };
  const results = [];
  await Promise.all(Object.entries(sectors).map(async ([name, ticker]) => {
    try {
      if (FINNHUB_KEY) {
        const fd = await fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FINNHUB_KEY}`).then(r=>r.json());
        if (fd.c > 0 && fd.pc > 0) { results.push({ name, chg: (fd.c-fd.pc)/fd.pc*100 }); return; }
      }
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1m&range=1d`;
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      const data = await r.json();
      const meta = data?.chart?.result?.[0]?.meta;
      if (meta?.regularMarketPrice && (meta.chartPreviousClose||meta.previousClose)) {
        results.push({ name, chg: (meta.regularMarketPrice-(meta.chartPreviousClose||meta.previousClose))/(meta.chartPreviousClose||meta.previousClose)*100 });
      }
    } catch(e) {}
  }));
  results.sort((a,b) => b.chg - a.chg);
  res.json(results);
});

// ─── News ─────────────────────────────────────────────────────────
app.get("/api/news/:ticker", async (req, res) => {
  const { ticker } = req.params;
  if (!FINNHUB_KEY) return res.status(400).json({ error: "No Finnhub key" });
  try {
    const to = new Date().toISOString().split("T")[0];
    const from = new Date(Date.now()-7*24*60*60*1000).toISOString().split("T")[0];
    const data = await fetch(`https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${from}&to=${to}&token=${FINNHUB_KEY}`).then(r=>r.json());
    res.json(data.slice(0,5).map(n=>({ headline: n.headline, url: n.url, source: n.source })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Anthropic API proxy ──────────────────────────────────────────
app.post("/api/brief", async (req, res) => {
  if (!ANTHROPIC_KEY) return res.status(400).json({ error: "No Anthropic key" });
  const { messages, max_tokens } = req.body;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: max_tokens || 3000, messages })
    });
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Earnings ────────────────────────────────────────────────────
app.get("/api/earnings/:ticker", async (req, res) => {
  try {
    const r = await fetch(`https://finnhub.io/api/v1/stock/earnings?symbol=${req.params.ticker}&limit=4&token=${FINNHUB_KEY}`);
    const d = await r.json();
    const next = (d || []).find(e => new Date(e.period) >= new Date());
    if (next) res.json({ date: next.period, epsEstimate: next.estimate, hour: "" });
    else res.json({});
  } catch(e) { res.json({}); }
});

// ─── Analyst ratings ─────────────────────────────────────────────
app.get("/api/analyst/:ticker", async (req, res) => {
  try {
    const [rec, pt] = await Promise.all([
      fetch(`https://finnhub.io/api/v1/stock/recommendation?symbol=${req.params.ticker}&token=${FINNHUB_KEY}`).then(r=>r.json()),
      fetch(`https://finnhub.io/api/v1/stock/price-target?symbol=${req.params.ticker}&token=${FINNHUB_KEY}`).then(r=>r.json())
    ]);
    const latest = rec && rec[0] ? rec[0] : {};
    res.json({ buy: latest.buy, hold: latest.hold, sell: latest.sell, strongBuy: latest.strongBuy, strongSell: latest.strongSell, targetPrice: pt.targetMean });
  } catch(e) { res.json({}); }
});

app.listen(PORT, () => console.log(`StockPulse server running on port ${PORT}`));
