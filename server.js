const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || "";
const FINNHUB_KEY = process.env.FINNHUB_KEY || "";
const USERS_FILE = path.join("/tmp", "sp_users.json");

// ─── User storage helpers ────────────────────────────────────────
function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, "utf8")); } catch(e) { return {}; }
}
function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}
function hashPassword(pw) {
  return crypto.createHash("sha256").update(pw + "sp_salt_2026").digest("hex");
}
function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

// ─── Auth endpoints ──────────────────────────────────────────────
app.post("/api/signup", (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: "Missing fields" });
  const users = loadUsers();
  const emailLower = email.toLowerCase().trim();
  if (Object.values(users).find(u => u.email === emailLower)) {
    return res.status(400).json({ error: "Email already registered" });
  }
  const token = generateToken();
  const userId = "u_" + Date.now();
  users[userId] = {
    name: name.trim(),
    email: emailLower,
    password: hashPassword(password),
    token,
    createdAt: new Date().toISOString(),
    data: { stocks: [], alerts: {}, portfolio: {}, frequency: "daily" }
  };
  saveUsers(users);
  res.json({ token, name: name.trim(), userId });
});

app.post("/api/login", (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Missing fields" });
  const users = loadUsers();
  const emailLower = email.toLowerCase().trim();
  const entry = Object.entries(users).find(([,u]) => u.email === emailLower);
  if (!entry) return res.status(401).json({ error: "No account found with that email" });
  const [userId, user] = entry;
  if (user.password !== hashPassword(password)) return res.status(401).json({ error: "Wrong password" });
  // Regenerate token on each login
  const token = generateToken();
  users[userId].token = token;
  saveUsers(users);
  res.json({ token, name: user.name, userId, data: user.data });
});

app.post("/api/verify", (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(401).json({ error: "No token" });
  const users = loadUsers();
  const entry = Object.entries(users).find(([,u]) => u.token === token);
  if (!entry) return res.status(401).json({ error: "Invalid token" });
  const [userId, user] = entry;
  res.json({ valid: true, name: user.name, userId, data: user.data });
});

app.post("/api/save", (req, res) => {
  const { token, data } = req.body;
  if (!token) return res.status(401).json({ error: "No token" });
  const users = loadUsers();
  const entry = Object.entries(users).find(([,u]) => u.token === token);
  if (!entry) return res.status(401).json({ error: "Invalid token" });
  const [userId] = entry;
  users[userId].data = data;
  saveUsers(users);
  res.json({ ok: true });
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
  const range = req.query.range || "1mo";
  const interval = req.query.interval || "1d";
  for (const host of ["query1", "query2"]) {
    try {
      const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${ticker}?interval=${interval}&range=${range}`;
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      const data = await r.json();
      const result = data?.chart?.result?.[0];
      if (!result) continue;
      const meta = result.meta;
      const closes = result.indicators?.quote?.[0]?.close || [];
      return res.json({ ticker, price: meta.regularMarketPrice, prev: meta.chartPreviousClose||meta.previousClose, hi52: meta.fiftyTwoWeekHigh, lo52: meta.fiftyTwoWeekLow, closes: closes.filter(x=>x!==null&&x>0) });
    } catch(e) {}
  }
  res.status(500).json({ error: "Chart unavailable" });
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

// ─── Sectors ────────────────────────────────────────────────────
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

// ─── News ────────────────────────────────────────────────────────
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

// ─── Anthropic API proxy ─────────────────────────────────────────
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

// Earnings
app.get('/api/earnings/:ticker', async (req, res) => {
  try {
    const r = await fetch(`https://finnhub.io/api/v1/stock/earnings?symbol=${req.params.ticker}&limit=4&token=${FINNHUB_KEY}`);
    const d = await r.json();
    const next = (d || []).find(e => new Date(e.period) >= new Date());
    if (next) res.json({ date: next.period, epsEstimate: next.estimate, hour: '' });
    else res.json({});
  } catch(e) { res.json({}); }
});

// Analyst ratings
app.get('/api/analyst/:ticker', async (req, res) => {
  try {
    const [rec, pt] = await Promise.all([
      fetch(`https://finnhub.io/api/v1/stock/recommendation?symbol=${req.params.ticker}&token=${FINNHUB_KEY}`).then(r => r.json()),
      fetch(`https://finnhub.io/api/v1/stock/price-target?symbol=${req.params.ticker}&token=${FINNHUB_KEY}`).then(r => r.json())
    ]);
    const latest = rec && rec[0] ? rec[0] : {};
    res.json({ buy: latest.buy, hold: latest.hold, sell: latest.sell, strongBuy: latest.strongBuy, strongSell: latest.strongSell, targetPrice: pt.targetMean });
  } catch(e) { res.json({}); }
});app.listen(PORT, () => console.log(`StockPulse server running on port ${PORT}`));
