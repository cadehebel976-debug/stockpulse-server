# StockPulse Server

Backend server for StockPulse app.

## Deploy to Railway
1. Upload this folder to Railway
2. Set environment variables:
   - `ANTHROPIC_KEY` — your Anthropic API key
   - `FINNHUB_KEY` — your Finnhub API key

## Endpoints
- `GET /` — health check
- `GET /api/price/:ticker` — live price + sparkline data
- `GET /api/quotes?symbols=SPY,QQQ,DIA` — multi-ticker quotes
- `GET /api/news/:ticker` — recent news headlines
- `POST /api/brief` — Anthropic API proxy
