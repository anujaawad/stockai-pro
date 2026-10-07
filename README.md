# StockAI Pro

AI-powered stock analysis chatbot on Cloudflare Workers. Ask a question in plain English (e.g. *"What is Apple's stock price and RSI?"*
*"What is Tesla's current stock price?"*) and get live market data, a custom RSI indicator, and LLM-generated insights in one response.

**Live demo:** https://stock-chatbot.anujaawad6.workers.dev

## Features

- **Natural language input:** company names and tickers both work
- **Live quotes:** price, change, high/low, volume via TwelveData
- **Custom RSI:** 14-day RSI calculated from raw closing prices, with no TA library
- **Multi-step LLM pipeline:** separate calls for ticker extraction, news sentiment, and final analysis
- **Graceful degradation:** analysis still runs if news or technical data fails
- **Monitoring:** API health checks and request tracing with Cloudflare KV

## Tech Stack

JavaScript · Cloudflare Workers · Cloudflare KV · Groq API · TwelveData API · Vanilla HTML/CSS/JS

## How It Works

```
Question → Extract ticker → Live quote + RSI + News sentiment → Structured analysis → Response
```

## Setup

1. Create a Worker in Cloudflare and paste in `worker.js`
2. Create a KV namespace and bind it as `REQUEST_LOGS`
3. Add your API keys as Worker secrets (never commit them to the repo)
4. Deploy with `npx wrangler deploy`

## Notes

- The "news" section is AI-generated sentiment context, not live headlines.
- Free-tier API rate limits apply.

## Disclaimer

For educational purposes only. Output is AI-generated, may be inaccurate, and is **not financial advice**. Do your own research before making any investment decisions.

**Author:** Anuja Awad
