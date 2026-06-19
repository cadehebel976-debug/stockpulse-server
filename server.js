const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || "";
const FINNHUB_KEY = process.env.FINNHUB_KEY || "";

// ─── Health check ───────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "StockPulse server running", time: new Date().toISOString() });
});

// ─── Yahoo Finance price ─────────────────────────────────────────
app.get("/api/price/:ticker", async (req, res) => {
  const { ticker } = req.params;
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1m&range=1d`;
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    const data = await r.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) throw new Error("No meta");
    const price = meta.postMarketPrice > 0 ? meta.postMarketPrice :
                  meta.preMarketPrice > 0 ? meta.preMarketPrice :
                  meta.regularMarketPrice;
    const prev = meta.chartPreviousClose || meta.previousClose || price;
    const closes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
    res.json({
      price,
      prev,
      chg: prev ? ((price - prev) / prev * 100) : 0,
      closes: closes.filter(x => x !== null && x > 0),
      isAH: meta.postMarketPrice > 0,
      isPM: meta.preMarketPrice > 0
    });
  } catch (e) {
    // Fallback to query2
    try {
      const url2 = `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1m&range=1d`;
      const r2 = await fetch(url2, { headers: { "User-Agent": "Mozilla/5.0" } });
      const data2 = await r2.json();
      const meta2 = data2?.chart?.result?.[0]?.meta;
      if (!meta2) throw new Error("No meta2");
      const price = meta2.regularMarketPrice;
      const prev = meta2.chartPreviousClose || meta2.previousClose || price;
      const closes = data2?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
      res.json({ price, prev, chg: prev ? ((price-prev)/prev*100) : 0, closes: closes.filter(x=>x!==null&&x>0), isAH: false, isPM: false });
    } catch(e2) {
      res.status(500).json({ error: e2.message });
    }
  }
});

// ─── Multi-quote (for market overview) ──────────────────────────
app.get("/api/quotes", async (req, res) => {
  const { symbols } = req.query; // e.g. ?symbols=SPY,QQQ,DIA
  if (!symbols) return res.status(400).json({ error: "symbols required" });
  
  const tickers = symbols.split(",");
  const results = {};
  
  await Promise.all(tickers.map(async (ticker) => {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1m&range=1d`;
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      const data = await r.json();
      const meta = data?.chart?.result?.[0]?.meta;
      if (!meta) return;
      const price = meta.regularMarketPrice;
      const prev = meta.chartPreviousClose || meta.previousClose || price;
      const closes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
      results[ticker] = {
        price,
        prev,
        chg: prev ? ((price - prev) / prev * 100) : 0,
        closes: closes.filter(x => x !== null && x > 0)
      };
    } catch(e) {
      // Try Finnhub as fallback
      if (FINNHUB_KEY) {
        try {
          const fhUrl = `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FINNHUB_KEY}`;
          const fr = await fetch(fhUrl);
          const fd = await fr.json();
          if (fd.c > 0) {
            results[ticker] = { price: fd.c, prev: fd.pc, chg: fd.pc ? ((fd.c-fd.pc)/fd.pc*100) : 0, closes: [] };
          }
        } catch(fe) {}
      }
    }
  }));
  
  res.json(results);
});

// ─── Finnhub news ────────────────────────────────────────────────
app.get("/api/news/:ticker", async (req, res) => {
  const { ticker } = req.params;
  if (!FINNHUB_KEY) return res.status(400).json({ error: "No Finnhub key" });
  try {
    const to = new Date().toISOString().split("T")[0];
    const from = new Date(Date.now() - 7*24*60*60*1000).toISOString().split("T")[0];
    const url = `https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${from}&to=${to}&token=${FINNHUB_KEY}`;
    const r = await fetch(url);
    const data = await r.json();
    res.json(data.slice(0, 5).map(n => ({ headline: n.headline, url: n.url, source: n.source })));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Anthropic API proxy ─────────────────────────────────────────
app.post("/api/brief", async (req, res) => {
  if (!ANTHROPIC_KEY) return res.status(400).json({ error: "No Anthropic key configured" });
  const { messages, max_tokens, system } = req.body;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: max_tokens || 1000,
        system: system || "",
        messages
      })
    });
    const data = await r.json();
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`StockPulse server running on port ${PORT}`));
