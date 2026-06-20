const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || "";
const FINNHUB_KEY = process.env.FINNHUB_KEY || "";

// Health check
app.get("/", (req, res) => {
  res.json({ status: "StockPulse server running", time: new Date().toISOString() });
});

// Live price (with intraday closes for sparklines)
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
      return res.json({
        price, prev,
        chg: prev ? ((price - prev) / prev * 100) : 0,
        closes: closes.filter(x => x !== null && x > 0),
        isAH: meta.postMarketPrice > 0,
        isPM: meta.preMarketPrice > 0
      });
    } catch(e) {}
  }
  // Finnhub fallback
  if (FINNHUB_KEY) {
    try {
      const fd = await fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FINNHUB_KEY}`).then(r=>r.json());
      if (fd.c > 0) return res.json({ price: fd.c, prev: fd.pc, chg: fd.pc?((fd.c-fd.pc)/fd.pc*100):0, closes: [], isAH: false, isPM: false });
    } catch(e) {}
  }
  res.status(500).json({ error: "Price unavailable" });
});

// Intraday sparkline (5m interval)
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
      return res.json({
        price, prev,
        chg: prev ? ((price - prev) / prev * 100) : 0,
        closes: closes.filter(x => x !== null && x > 0)
      });
    } catch(e) {}
  }
  res.status(500).json({ error: "Unavailable" });
});

// Historical chart (30-day, for portfolio charts)
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
      return res.json({
        ticker,
        price: meta.regularMarketPrice,
        prev: meta.chartPreviousClose || meta.previousClose,
        hi52: meta.fiftyTwoWeekHigh,
        lo52: meta.fiftyTwoWeekLow,
        closes: closes.filter(x => x !== null && x > 0)
      });
    } catch(e) {}
  }
  res.status(500).json({ error: "Chart unavailable" });
});

// Macro data (VIX, 10Y yield, Oil)
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

// Sector data
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
        const p = meta.regularMarketPrice;
        const pc = meta.chartPreviousClose || meta.previousClose;
        results.push({ name, chg: (p-pc)/pc*100 });
      }
    } catch(e) {}
  }));
  results.sort((a,b) => b.chg - a.chg);
  res.json(results);
});

// Finnhub news
app.get("/api/news/:ticker", async (req, res) => {
  const { ticker } = req.params;
  if (!FINNHUB_KEY) return res.status(400).json({ error: "No Finnhub key" });
  try {
    const to = new Date().toISOString().split("T")[0];
    const from = new Date(Date.now() - 7*24*60*60*1000).toISOString().split("T")[0];
    const url = `https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${from}&to=${to}&token=${FINNHUB_KEY}`;
    const data = await fetch(url).then(r=>r.json());
    res.json(data.slice(0, 5).map(n => ({ headline: n.headline, url: n.url, source: n.source })));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Anthropic API proxy
app.post("/api/brief", async (req, res) => {
  if (!ANTHROPIC_KEY) return res.status(400).json({ error: "No Anthropic key configured" });
  const { messages, max_tokens } = req.body;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: max_tokens || 3000, messages })
    });
    res.json(await r.json());
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`StockPulse server running on port ${PORT}`));
