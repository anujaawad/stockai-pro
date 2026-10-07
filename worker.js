/**
 * ═══════════════════════════════════════════════════════════════════════════
 * STOCKAI PRO - CLOUDFLARE WORKER
 * TwelveData (market data) + Groq (LLM). Technical analysis (RSI) is
 * calculated in-house. The "news" section is AI-generated sentiment context,
 * not live headlines. NewsAPI is only used by the health check.
 *
 * Required bindings/secrets:
 *   KV namespace:  REQUEST_LOGS
 *   Secrets:       GROQ_API_KEY, TWELVEDATA_KEY, NEWSAPI_KEY
 * Optional secret:
 *   DEBUG_TOKEN    If set, /debug, /api/logs and /api/health require it
 *                  (open /debug?token=YOUR_TOKEN)
 * ═══════════════════════════════════════════════════════════════════════════
 */

const MAX_QUESTION_LENGTH = 300;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Same-origin app: no cross-origin access needed, so no CORS headers.
    const cors = {};

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204 });
    }

    try {
      if (url.pathname === "/" && request.method === "GET") {
        return new Response(getChatUI(), {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }

      if (url.pathname === "/api/chat" && request.method === "POST") {
        return handleChat(request, env, cors);
      }

      // Protected routes (only enforced when DEBUG_TOKEN is configured)
      const isDebugRoute =
        (url.pathname === "/api/logs" || url.pathname === "/api/health" || url.pathname === "/debug") &&
        request.method === "GET";

      if (isDebugRoute && !isAuthorized(request, url, env)) {
        return new Response("Unauthorized", { status: 401 });
      }

      if (url.pathname === "/api/logs" && request.method === "GET") {
        const raw = await env.REQUEST_LOGS.get("logs").catch(() => null);
        return new Response(JSON.stringify(raw ? JSON.parse(raw) : []), {
          headers: { "Content-Type": "application/json" }
        });
      }

      if (url.pathname === "/api/health" && request.method === "GET") {
        return handleHealth(env, cors);
      }

      if (url.pathname === "/debug" && request.method === "GET") {
        return new Response(getDebugUI(), {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }

      return new Response("Not found", { status: 404 });
    } catch (error) {
      console.error("Worker error:", error);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }
};

function isAuthorized(request, url, env) {
  if (!env.DEBUG_TOKEN) return true; // no token configured: open (demo mode)
  const provided = url.searchParams.get("token") || request.headers.get("x-debug-token") || "";
  return provided === env.DEBUG_TOKEN;
}

// ═════════════════════════════════════════════════════════════════════════
// CHAT HANDLER
// ═════════════════════════════════════════════════════════════════════════

async function handleChat(request, env, cors) {
  const reqId = "req_" + Math.random().toString(36).slice(2, 6);
  const steps = [];
  const startTime = Date.now();

  function log(step, status, desc) {
    steps.push({ step, status, desc, ms: Date.now() - startTime });
    console.log(`[${reqId}] ${step}: ${status} — ${desc}`);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...cors }
    });
  }

  const question = String(body.question || "").slice(0, MAX_QUESTION_LENGTH);
  if (!question.trim()) {
    return new Response(JSON.stringify({ error: "Please ask about a stock" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...cors }
    });
  }

  let prediction = "";

  try {
    log("Request received", "ok", `"${question.substring(0, 50)}..."`);

    log("Extracting symbol", "ok", "Calling Groq");
    const symbol = await extractSymbol(question, env);
    log("Symbol extracted", "ok", symbol);

    let quoteData = null;
    try {
      quoteData = await getQuoteData(symbol, env);
      log("Quote data fetched", "ok", `$${quoteData.price}`);
    } catch (e) {
      log("Quote data", "error", e.message);
    }

    let technicalData = null;
    try {
      technicalData = await getTechnicalData(symbol, env);
      log("Technical data fetched", "ok", "RSI loaded");
    } catch (e) {
      log("Technical data", "error", e.message);
    }

    let news = null;
    try {
      news = await getNewsData(symbol, env);
      log("News context generated", "ok", `${news.length} items`);
    } catch (e) {
      log("News", "error", e.message);
    }

    if (!quoteData) {
      prediction = `⚠️ Could not fetch market data for **${symbol}**. The symbol may be invalid or the market data service is temporarily unavailable. Please check the ticker and try again.`;
      log("Prediction skipped", "error", "quoteData is null");
    } else {
      log("Generating prediction", "ok", "Calling Groq");
      prediction = await generatePrediction({
        question,
        symbol,
        quoteData,
        technicalData: technicalData || { rsi: "N/A", rsiStatus: "N/A", interpretation: "Data unavailable" },
        news: news || []
      }, env);
      log("Prediction generated", "ok", "Success");
    }

  } catch (e) {
    log("Fatal error", "error", e.message);
    prediction = e.message && e.message.startsWith("Please")
      ? e.message
      : "Unable to generate prediction. Please try again.";
  }

  try {
    const raw = await env.REQUEST_LOGS.get("logs").catch(() => null);
    const logs = raw ? JSON.parse(raw) : [];
    logs.unshift({
      id: reqId,
      question: question.slice(0, 100),
      steps,
      totalMs: Date.now() - startTime,
      timestamp: new Date().toISOString()
    });
    if (logs.length > 20) logs.splice(20);
    await env.REQUEST_LOGS.put("logs", JSON.stringify(logs));
  } catch (e) {
    console.error("KV save failed:", e.message);
  }

  return new Response(JSON.stringify({ prediction }), {
    headers: { "Content-Type": "application/json", ...cors }
  });
}

// ═════════════════════════════════════════════════════════════════════════
// API FUNCTIONS
// ═════════════════════════════════════════════════════════════════════════

async function extractSymbol(question, env) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.GROQ_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "openai/gpt-oss-20b",
      max_tokens: 200,
      reasoning_effort: "low",
      messages: [
        {
          role: "system",
          content: "You are a stock ticker extractor. Your ONLY job is to output the US stock ticker symbol from the user message. Reply with JUST the ticker in uppercase (e.g. AAPL, TSLA, MSFT). Never refuse. Never explain. Never say anything else. If user mentions a company name, convert it to its ticker symbol."
        },
        { role: "user", content: question }
      ]
    })
  });
  const data = await res.json();
  if (!data.choices?.[0]) {
    console.error("Groq extractSymbol raw response:", JSON.stringify(data));
    throw new Error(data.error?.message || "Groq error");
  }
  const raw = (data.choices[0].message.content || "").trim().toUpperCase();
  const match = raw.match(/\b[A-Z]{1,5}\b/);
  if (!match) {
    console.error("extractSymbol: no ticker found in model output:", JSON.stringify(data.choices[0].message));
    throw new Error("Please mention a company name or stock symbol, like Apple or AAPL.");
  }
  return match[0];
}

async function getQuoteData(symbol, env) {
  const res = await fetch(
    `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbol)}&apikey=${env.TWELVEDATA_KEY}`
  );
  const data = await res.json();

  if (data.status === "error") throw new Error("Invalid symbol");

  return {
    price: parseFloat(data.close).toFixed(2),
    currency: data.currency || "USD",
    change: parseFloat(data.change).toFixed(2),
    changePercent: parseFloat(data.percent_change).toFixed(2),
    high: parseFloat(data.high).toFixed(2),
    low: parseFloat(data.low).toFixed(2),
    open: parseFloat(data.open).toFixed(2),
    volume: data.volume || "N/A",
    timestamp: data.timestamp,
    exchange: data.exchange || "Unknown"
  };
}

async function getTechnicalData(symbol, env) {
  try {
    const res = await fetch(
      `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&outputsize=15&apikey=${env.TWELVEDATA_KEY}`
    );
    const data = await res.json();

    if (!data.values || data.values.length < 14) {
      return { rsi: "N/A", rsiStatus: "N/A", interpretation: "Insufficient data" };
    }

    const closes = data.values.map(v => parseFloat(v.close)).reverse();

    let gains = 0, losses = 0;
    for (let i = 1; i < 15; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains += diff;
      else losses += Math.abs(diff);
    }

    const avgGain = gains / 14;
    const avgLoss = losses / 14;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    const rsi = parseFloat((100 - (100 / (1 + rs))).toFixed(2));

    const rsiStatus = rsi > 70 ? "Overbought" : rsi < 30 ? "Oversold" : "Neutral";
    const interpretation =
      rsiStatus === "Overbought" ? "Potential downside pressure" :
      rsiStatus === "Oversold"   ? "Potential upside opportunity" :
                                   "Balanced momentum";

    return { rsi, rsiStatus, interpretation };
  } catch (e) {
    return { rsi: "N/A", rsiStatus: "N/A", interpretation: "Data unavailable" };
  }
}

// NOTE: AI-generated sentiment context, not live headlines.
async function getNewsData(symbol, env) {
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-20b",
        max_tokens: 800,
        reasoning_effort: "low",
        messages: [
          {
            role: "system",
            content: `You are a financial news summarizer. Given a stock symbol, return a JSON array of exactly 4 recent news items about that company.
Reply ONLY with a valid JSON array, no explanation, no markdown. Format:
[
  {"headline": "...", "source": "...", "sentiment": "Positive|Negative|Neutral", "published": "recent"},
  ...
]`
          },
          {
            role: "user",
            content: `Give me 4 recent relevant news headlines for stock symbol: ${symbol}`
          }
        ]
      })
    });
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim() || "[]";
    const clean = text.replace(/```json|```/g, "").trim();
    const articles = JSON.parse(clean);
    return Array.isArray(articles) ? articles : [];
  } catch (e) {
    return [];
  }
}

async function generatePrediction({ question, symbol, quoteData, technicalData, news }, env) {
  const newsBlock = news.length > 0
    ? news.map((n, i) => `${i+1}. ${n.headline} (${n.sentiment})`).join("\n")
    : "No news context available";

  const dataBlock = `
STOCK: ${symbol}
Current Price: $${quoteData.price}
Change: ${quoteData.change} (${quoteData.changePercent}%)
Today's Range: $${quoteData.low} - $${quoteData.high}
Volume: ${quoteData.volume}
Exchange: ${quoteData.exchange}

TECHNICAL ANALYSIS:
RSI: ${technicalData.rsi} (${technicalData.rsiStatus})
Interpretation: ${technicalData.interpretation}

NEWS CONTEXT (AI-generated, not verified headlines):
${newsBlock}
`;

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.GROQ_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "openai/gpt-oss-120b",
      max_tokens: 1200,
      reasoning_effort: "low",
      messages: [
        {
          role: "system",
          content: `You are a stock market analyst providing educational analysis. Analyze ONLY the provided data. If a value is not in the data, write "N/A" instead of guessing.
Do not give personalized buy, sell or hold advice. If the user asks "should I buy", explain that you provide educational analysis only and describe what the data shows.

Format response as:

📊 MARKET SNAPSHOT
- Current Price: [price]
- Daily Change: [change %]
- Recent Trend: [assessment based only on the data provided]

📈 TECHNICAL ANALYSIS
- RSI Level: [value and status]
- Momentum: [interpretation]
- Support/Resistance: [levels if available, otherwise N/A]

📰 NEWS SENTIMENT
- Overall Sentiment: [Positive/Negative/Neutral]
- Key Drivers: [list 2-3]

🎯 OUTLOOK
- Direction: [UP ⬆️ / DOWN ⬇️ / SIDEWAYS →]
- Target Price: [range or next resistance, or N/A]
- Timeframe: [short-term/medium-term]
- Conviction: [HIGH/MEDIUM/LOW]

⚠️ RISK FACTORS
1. [Major risk]
2. [Secondary risk]

📌 KEY TAKEAWAY
[One sentence summary of what the data suggests]

⚡ DISCLAIMER
This is AI-generated analysis for educational purposes only. It may be inaccurate and is not financial advice. Do your own research before making any investment decisions.`
        },
        { role: "user", content: `${dataBlock}\n\nUser Question: ${question}` }
      ]
    })
  });

  const data = await res.json();
  if (!data.choices?.[0]) {
    console.error("Groq generatePrediction raw response:", JSON.stringify(data));
    throw new Error(data.error?.message || "No prediction generated");
  }
  return data.choices[0].message.content;
}

// ═════════════════════════════════════════════════════════════════════════
// HEALTH CHECK HANDLER
// ═════════════════════════════════════════════════════════════════════════

async function handleHealth(env, cors) {
  const results = {};

  // Check KV
  try {
    const testKey = "__health_check__";
    await env.REQUEST_LOGS.put(testKey, "ok");
    const val = await env.REQUEST_LOGS.get(testKey);
    await env.REQUEST_LOGS.delete(testKey);
    results.kv = {
      ok: val === "ok",
      detail: val === "ok" ? "Read/write successful" : "Read mismatch",
      ms: 0
    };
  } catch (e) {
    results.kv = { ok: false, detail: e.message || "KV binding error", ms: 0 };
  }

  // Check Groq: verifies the key is valid AND that the chat model responds
  try {
    const start = Date.now();
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-20b",
        max_tokens: 50,
        reasoning_effort: "low",
        messages: [{ role: "user", content: "ping" }]
      })
    });
    const data = await res.json();
    results.groq = {
      ok: res.ok && !!data.choices?.[0],
      status: res.status,
      ms: Date.now() - start,
      detail: res.ok && data.choices?.[0]
        ? "Authenticated, model responding"
        : (data.error?.message || "Auth failed or model unavailable")
    };
  } catch (e) {
    results.groq = { ok: false, detail: e.message };
  }

  // Check TwelveData
  try {
    const start = Date.now();
    const res = await fetch(
      `https://api.twelvedata.com/api_usage?apikey=${env.TWELVEDATA_KEY}`
    );
    const data = await res.json();
    results.twelvedata = {
      ok: !data.code,
      ms: Date.now() - start,
      detail: data.code ? data.message : "API key valid"
    };
  } catch (e) {
    results.twelvedata = { ok: false, detail: e.message };
  }

  // Check NewsAPI (HTTP 426 = free plan restriction, key itself is valid)
  try {
    const start = Date.now();
    const res = await fetch(
      `https://newsapi.org/v2/top-headlines?country=us&pageSize=1&apiKey=${env.NEWSAPI_KEY}`,
      { headers: { "User-Agent": "StockAI-Pro/1.0 (Cloudflare Worker)" } }
    );
    const data = await res.json();
    const keyIsValid = data.status === "ok" || res.status === 426;

    results.newsapi = {
      ok: keyIsValid,
      ms: Date.now() - start,
      detail: data.status === "ok"
        ? "API key valid"
        : res.status === 426
          ? "Key valid (free plan: server-side calls require upgrade)"
          : (data.message || "Auth failed")
    };
  } catch (e) {
    results.newsapi = { ok: false, detail: e.message };
  }

  return new Response(JSON.stringify(results), {
    headers: { "Content-Type": "application/json", ...cors }
  });
}

// ═════════════════════════════════════════════════════════════════════════
// UI TEMPLATES
// ═════════════════════════════════════════════════════════════════════════

function getChatUI() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>StockAI Pro - Stock Analysis</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }

    :root {
      --primary: #1e40af;
      --primary-light: #3b82f6;
      --primary-dark: #1e3a8a;
      --accent: #10b981;
      --accent-dark: #059669;
      --danger: #ef4444;
      --warning: #f59e0b;
      --success: #10b981;
      --bg-dark: #0f172a;
      --bg-darker: #030a15;
      --bg-secondary: #1e293b;
      --bg-tertiary: #334155;
      --text-primary: #f1f5f9;
      --text-secondary: #cbd5e1;
      --text-tertiary: #94a3b8;
      --border: #1e293b;
      --border-light: #334155;
    }

    html, body { width: 100%; height: 100%; -webkit-font-smoothing: antialiased; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", sans-serif;
      background: linear-gradient(135deg, var(--bg-darker) 0%, var(--bg-dark) 100%);
      color: var(--text-primary);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      height: 100vh;
    }

    .header {
      background: linear-gradient(90deg, rgba(30, 40, 175, 0.9) 0%, rgba(15, 23, 42, 0.8) 100%);
      backdrop-filter: blur(20px);
      border-bottom: 1px solid rgba(16, 185, 129, 0.2);
      padding: 1.25rem 1.5rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      flex-shrink: 0;
      box-shadow: 0 4px 20px rgba(30, 40, 175, 0.15);
    }

    .header-left { display: flex; align-items: center; gap: 1rem; flex: 1; }

    .header-logo {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      font-weight: 700;
      font-size: 1.1rem;
      background: linear-gradient(135deg, var(--primary-light) 0%, var(--accent) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .logo-icon { font-size: 1.5rem; }
    .header-subtitle { font-size: 0.75rem; color: var(--text-tertiary); margin-top: 2px; }

    .header-status {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.8rem;
      color: var(--accent);
      padding: 0.4rem 0.8rem;
      background: rgba(16, 185, 129, 0.1);
      border-radius: 1rem;
      border: 1px solid rgba(16, 185, 129, 0.3);
    }

    .status-dot {
      width: 6px;
      height: 6px;
      background: var(--accent);
      border-radius: 50%;
      animation: pulse 2s ease-in-out infinite;
    }

    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

    .chat-wrapper { flex: 1; display: flex; flex-direction: column; overflow: hidden; }

    #messages {
      flex: 1;
      overflow-y: auto;
      scroll-behavior: smooth;
      padding: 1.5rem;
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
    }

    #messages::-webkit-scrollbar { width: 8px; }
    #messages::-webkit-scrollbar-track { background: transparent; }
    #messages::-webkit-scrollbar-thumb { background: var(--border-light); border-radius: 4px; }
    #messages::-webkit-scrollbar-thumb:hover { background: var(--text-tertiary); }

    .chat-empty {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      gap: 1.5rem;
      min-height: 400px;
    }

    .empty-icon { font-size: 3.5rem; opacity: 0.7; animation: float 3s ease-in-out infinite; }

    @keyframes float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-20px); } }

    .empty-title { font-size: 1.5rem; font-weight: 700; color: var(--text-primary); }

    .empty-subtitle {
      font-size: 0.95rem;
      color: var(--text-tertiary);
      max-width: 350px;
      line-height: 1.8;
    }

    .example-tags { display: flex; flex-direction: column; gap: 0.75rem; margin-top: 1rem; }

    .example-tag {
      background: rgba(30, 64, 175, 0.1);
      border: 1px solid var(--primary-light);
      color: var(--primary-light);
      padding: 0.75rem 1.25rem;
      border-radius: 0.75rem;
      font-size: 0.9rem;
      cursor: pointer;
      transition: all 0.3s;
      font-weight: 500;
    }

    .example-tag:hover {
      background: rgba(30, 64, 175, 0.2);
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(30, 64, 175, 0.2);
    }

    .message {
      display: flex;
      animation: message-in 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
      padding: 0 0.5rem;
    }

    @keyframes message-in { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }

    .message.user { justify-content: flex-end; }
    .message.bot { justify-content: flex-start; }

    .message-bubble {
      max-width: 85%;
      padding: 1.25rem;
      border-radius: 1rem;
      word-wrap: break-word;
      line-height: 1.7;
      font-size: 0.95rem;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
    }

    .message.user .message-bubble {
      background: linear-gradient(135deg, var(--primary-light) 0%, var(--primary) 100%);
      color: white;
      border-radius: 1rem 1rem 0.25rem 1rem;
    }

    .message.bot .message-bubble {
      background: var(--bg-secondary);
      color: var(--text-primary);
      border: 1px solid var(--border-light);
      border-radius: 1rem 1rem 1rem 0.25rem;
    }

    .message.bot .message-bubble a { color: var(--primary-light); text-decoration: none; }
    .message.bot .message-bubble a:hover { text-decoration: underline; }

    .typing-indicator { display: flex; gap: 6px; align-items: center; }

    .typing-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--primary-light);
      animation: bounce 1.4s infinite;
    }

    .typing-dot:nth-child(2) { animation-delay: 0.2s; }
    .typing-dot:nth-child(3) { animation-delay: 0.4s; }

    @keyframes bounce { 0%, 60%, 100% { opacity: 0.4; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-8px); } }

    .input-area {
      background: linear-gradient(180deg, rgba(30, 40, 175, 0.3) 0%, rgba(30, 40, 175, 0.1) 100%);
      backdrop-filter: blur(20px);
      border-top: 1px solid var(--border-light);
      padding: 1.25rem max(1.25rem, env(safe-area-inset-bottom));
      display: flex;
      gap: 0.75rem;
      flex-shrink: 0;
    }

    .input-wrapper {
      flex: 1;
      display: flex;
      align-items: flex-end;
      gap: 0.5rem;
      background: var(--bg-dark);
      border: 2px solid var(--border-light);
      border-radius: 1rem;
      padding: 0.75rem;
      transition: all 0.3s;
    }

    .input-wrapper:focus-within {
      border-color: var(--primary-light);
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
    }

    #message-input {
      flex: 1;
      background: transparent;
      border: none;
      color: var(--text-primary);
      font-size: 0.95rem;
      outline: none;
      resize: none;
      max-height: 100px;
      font-family: inherit;
      line-height: 1.5;
    }

    #message-input::placeholder { color: var(--text-tertiary); }
    .input-actions { display: flex; gap: 0.25rem; }

    .input-action-btn {
      width: 32px;
      height: 32px;
      border-radius: 0.5rem;
      border: none;
      background: transparent;
      color: var(--text-tertiary);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1rem;
      transition: all 0.2s;
    }

    .input-action-btn:hover:not(:disabled) {
      color: var(--primary-light);
      background: rgba(59, 130, 246, 0.1);
    }

    #send-btn {
      width: 44px;
      height: 44px;
      border-radius: 0.75rem;
      border: none;
      background: linear-gradient(135deg, var(--primary-light) 0%, var(--primary) 100%);
      color: white;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.1rem;
      transition: all 0.3s;
      box-shadow: 0 4px 12px rgba(59, 130, 246, 0.3);
      flex-shrink: 0;
      font-weight: 600;
    }

    #send-btn:hover:not(:disabled) {
      transform: translateY(-2px);
      box-shadow: 0 6px 20px rgba(59, 130, 246, 0.4);
    }

    #send-btn:active:not(:disabled) { transform: scale(0.95); }
    #send-btn:disabled { opacity: 0.5; cursor: not-allowed; }

    .footer-note { text-align: center; font-size: 0.7rem; color: var(--text-tertiary); padding: 0.4rem; flex-shrink: 0; }

    @media (max-width: 768px) {
      .header { padding: 1rem; }
      .header-logo { font-size: 1rem; }
      #messages { padding: 1rem; gap: 1rem; }
      .message-bubble { max-width: 92%; font-size: 0.9rem; padding: 1rem; }
      .input-area { padding: 1rem 0.5rem max(1rem, env(safe-area-inset-bottom)); }
      .empty-title { font-size: 1.25rem; }
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <div class="header-logo">
        <div class="logo-icon">📊</div>
        <div>
          <div>StockAI Pro</div>
          <div class="header-subtitle">AI Stock Analysis</div>
        </div>
      </div>
    </div>
    <div class="header-status">
      <span class="status-dot"></span>
      <span>Live</span>
    </div>
  </div>

  <div class="chat-wrapper">
    <div id="messages">
      <div class="chat-empty">
        <div class="empty-icon">📈</div>
        <div class="empty-title">Stock Market Intelligence</div>
        <div class="empty-subtitle">Get AI-powered stock analysis with live prices, technical indicators, and AI-generated sentiment context</div>
        <div class="example-tags">
          <div class="example-tag" onclick="sendExample('What is the current price and RSI of Apple stock?')">📱 Apple Stock Analysis</div>
          <div class="example-tag" onclick="sendExample('Analyze Tesla stock technical indicators')">⚡ Tesla Technical Analysis</div>
          <div class="example-tag" onclick="sendExample('Compare Microsoft stock momentum and give an outlook')">💼 Microsoft Outlook</div>
          <div class="example-tag" onclick="sendExample('What is the sentiment around Google stock?')">🔍 Google Sentiment</div>
        </div>
      </div>
    </div>
  </div>

  <div class="input-area">
    <div class="input-wrapper">
      <textarea id="message-input" placeholder="Ask about any stock symbol..." rows="1" maxlength="300"></textarea>
      <div class="input-actions">
        <button class="input-action-btn" onclick="clearInput()" title="Clear">✕</button>
      </div>
    </div>
    <button id="send-btn" onclick="sendMessage()" title="Send">📤</button>
  </div>
  <div class="footer-note">Educational use only. AI-generated, may be inaccurate. Not financial advice.</div>

  <script>
    const messagesDiv = document.getElementById("messages");
    const messageInput = document.getElementById("message-input");
    const sendBtn = document.getElementById("send-btn");
    let messageCount = 0;

    messageInput.addEventListener("input", function() {
      this.style.height = "auto";
      this.style.height = Math.min(this.scrollHeight, 120) + "px";
    });

    messageInput.addEventListener("keydown", function(e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    function clearInput() {
      messageInput.value = "";
      messageInput.style.height = "auto";
      messageInput.focus();
    }

    function sendExample(text) {
      messageInput.value = text;
      messageInput.style.height = "auto";
      messageInput.style.height = messageInput.scrollHeight + "px";
      sendMessage();
    }

    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }

    function addMessage(content, sender = "bot", isError = false) {
      if (messageCount === 0) messagesDiv.innerHTML = "";
      const messageEl = document.createElement("div");
      messageEl.className = \`message \${sender} \${isError ? "error" : ""}\`;
      const bubble = document.createElement("div");
      bubble.className = "message-bubble";
      if (isError) {
        bubble.innerHTML = \`<div style="color: var(--danger); font-weight: 600;">⚠️ Error</div><div style="margin-top: 0.5rem; font-size: 0.9rem;">\${escapeHtml(content)}</div>\`;
      } else {
        bubble.innerHTML = escapeHtml(content).replace(/\\n/g, "<br>");
      }
      messageEl.appendChild(bubble);
      messagesDiv.appendChild(messageEl);
      messageCount++;
      scrollToBottom();
    }

    function showLoading() {
      const messageEl = document.createElement("div");
      messageEl.className = "message bot";
      messageEl.id = "loading-message";
      const bubble = document.createElement("div");
      bubble.className = "message-bubble";
      bubble.innerHTML = \`<div class="typing-indicator"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>\`;
      messageEl.appendChild(bubble);
      messagesDiv.appendChild(messageEl);
      scrollToBottom();
    }

    function removeLoading() {
      const loading = document.getElementById("loading-message");
      if (loading) loading.remove();
    }

    function scrollToBottom() {
      setTimeout(() => { messagesDiv.scrollTop = messagesDiv.scrollHeight; }, 0);
    }

    async function sendMessage() {
      const message = messageInput.value.trim();
      if (!message) { messageInput.focus(); return; }

      sendBtn.disabled = true;
      messageInput.disabled = true;

      addMessage(message, "user");
      clearInput();
      showLoading();

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: message })
        });

        removeLoading();

        if (!response.ok) throw new Error(\`Server error: \${response.statusText}\`);

        const data = await response.json();
        addMessage(data.prediction || data.error || "No response", "bot", !!data.error);
      } catch (error) {
        removeLoading();
        addMessage(\`Error: \${error.message || "Could not reach server"}\`, "bot", true);
      } finally {
        sendBtn.disabled = false;
        messageInput.disabled = false;
        messageInput.focus();
      }
    }

    window.addEventListener("load", () => { messageInput.focus(); });
  </script>
</body>
</html>`;
}

function getDebugUI() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>StockAI Pro - Debug Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --primary: #1e40af;
      --primary-light: #3b82f6;
      --accent: #10b981;
      --bg-dark: #0f172a;
      --bg-secondary: #1e293b;
      --text-primary: #f1f5f9;
      --text-tertiary: #94a3b8;
      --border: #1e293b;
    }
    html, body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", monospace; background: linear-gradient(135deg, #030a15 0%, var(--bg-dark) 100%); color: var(--text-primary); }
    body { display: flex; flex-direction: column; overflow-y: auto; }

    .header {
      background: linear-gradient(90deg, rgba(30, 40, 175, 0.9), rgba(15, 23, 42, 0.8));
      backdrop-filter: blur(20px);
      border-bottom: 1px solid rgba(16, 185, 129, 0.2);
      padding: 2rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      position: sticky;
      top: 0;
      z-index: 100;
      box-shadow: 0 4px 20px rgba(30, 40, 175, 0.15);
    }

    .header-left { display: flex; align-items: center; gap: 1rem; }
    .header-icon { font-size: 1.75rem; }
    .header-title { font-size: 1.5rem; font-weight: 700; }
    .header-right { display: flex; gap: 1rem; align-items: center; }
    .status-badge { display: inline-flex; align-items: center; gap: 0.5rem; font-size: 0.85rem; padding: 0.5rem 1rem; background: rgba(16, 185, 129, 0.1); border: 1px solid var(--accent); border-radius: 0.5rem; color: var(--accent); }
    .refresh-btn { background: transparent; border: 1px solid var(--text-tertiary); color: var(--text-tertiary); padding: 0.5rem 1rem; border-radius: 0.5rem; cursor: pointer; transition: all 0.2s; }
    .refresh-btn:hover { background: rgba(59, 130, 246, 0.1); border-color: var(--primary-light); color: var(--primary-light); }

    .container { max-width: 1400px; margin: 0 auto; padding: 2rem; width: 100%; }
    .section { margin-bottom: 2.5rem; }
    .section-title { font-size: 1.1rem; font-weight: 600; margin-bottom: 1.5rem; padding-bottom: 1rem; border-bottom: 2px solid var(--primary-light); }

    .health-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 1.5rem; }
    .health-card { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 1rem; padding: 1.5rem; border-left: 4px solid transparent; transition: all 0.3s; }
    .health-card:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3); }
    .health-card.online { border-left-color: var(--accent); }
    .health-card.offline { border-left-color: #ef4444; }

    .health-header { display: flex; justify-content: space-between; margin-bottom: 1rem; }
    .health-name { font-weight: 600; font-size: 1.1rem; }
    .health-status { display: inline-flex; align-items: center; gap: 0.5rem; font-size: 0.8rem; padding: 0.3rem 0.8rem; border-radius: 0.375rem; font-weight: 500; }
    .health-status.online { background: rgba(16, 185, 129, 0.15); color: var(--accent); }
    .health-status.offline { background: rgba(239, 68, 68, 0.15); color: #ef4444; }
    .health-dot { width: 6px; height: 6px; border-radius: 50%; }
    .health-dot.online { background: var(--accent); animation: pulse 2s ease-in-out infinite; }
    .health-dot.offline { background: #ef4444; }

    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

    .health-details { display: flex; flex-direction: column; gap: 0.75rem; font-size: 0.9rem; }
    .health-row { display: flex; justify-content: space-between; align-items: center; }
    .health-label { color: var(--text-tertiary); }
    .health-value { font-weight: 600; color: var(--primary-light); }

    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1.5rem; }
    .stat-card { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 1rem; padding: 1.5rem; text-align: center; }
    .stat-value { font-size: 2.5rem; font-weight: 700; color: var(--primary-light); }
    .stat-label { font-size: 0.85rem; color: var(--text-tertiary); margin-top: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; }

    .logs-container { display: flex; flex-direction: column; gap: 1rem; }
    .log-entry { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 0.75rem; overflow: hidden; }
    .log-header { padding: 1rem; display: flex; justify-content: space-between; align-items: center; cursor: pointer; user-select: none; transition: all 0.2s; }
    .log-header:hover { background: rgba(59, 130, 246, 0.1); }
    .log-question { font-size: 0.95rem; font-weight: 500; color: var(--text-primary); }
    .log-meta { display: flex; gap: 1rem; font-size: 0.8rem; color: var(--text-tertiary); }
    .log-duration { background: rgba(59, 130, 246, 0.15); color: var(--primary-light); padding: 0.25rem 0.75rem; border-radius: 0.375rem; font-weight: 600; }
    .log-body { display: none; padding: 1rem; border-top: 1px solid var(--border); background: rgba(0, 0, 0, 0.2); }
    .log-entry.expanded .log-body { display: block; }
    .log-steps { display: flex; flex-direction: column; gap: 0.5rem; }
    .log-step { display: flex; gap: 0.75rem; font-size: 0.8rem; padding: 0.5rem 0.75rem; background: rgba(59, 130, 246, 0.1); border-radius: 0.375rem; }
    .log-step-icon { color: var(--accent); font-weight: 700; }
    .log-step-icon.error { color: #ef4444; }
    .empty-state { text-align: center; padding: 3rem; color: var(--text-tertiary); }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <div class="header-icon">🔍</div>
      <div><div class="header-title">Debug Dashboard</div></div>
    </div>
    <div class="header-right">
      <div class="status-badge"><span style="display: inline-block; width: 6px; height: 6px; background: var(--accent); border-radius: 50%; animation: pulse 2s ease-in-out infinite;"></span> Live</div>
      <button class="refresh-btn" onclick="refreshAll()">↻ Refresh</button>
    </div>
  </div>

  <div class="container">
    <div class="section">
      <div class="section-title">API Health Status</div>
      <div class="health-grid" id="health-grid">
        <div class="health-card"><div class="health-header"><div class="health-name">Checking...</div></div></div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">System Statistics</div>
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-value" id="total-requests">0</div><div class="stat-label">Total Requests</div></div>
        <div class="stat-card"><div class="stat-value" id="avg-response">0ms</div><div class="stat-label">Avg Response</div></div>
        <div class="stat-card"><div class="stat-value" id="success-rate">0%</div><div class="stat-label">Success Rate</div></div>
        <div class="stat-card"><div class="stat-value" id="last-update">—</div><div class="stat-label">Last Update</div></div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Request Logs</div>
      <div class="logs-container" id="logs-container">
        <div class="empty-state"><div style="font-size: 2.5rem; margin-bottom: 1rem;">📋</div>No requests yet</div>
      </div>
    </div>
  </div>

  <script>
    let logs = [];

    // Token for protected routes (open /debug?token=YOUR_TOKEN when DEBUG_TOKEN is set)
    const TOKEN = new URLSearchParams(location.search).get("token") || "";
    const AUTH = { headers: { "x-debug-token": TOKEN } };

    function esc(s) {
      return String(s == null ? "" : s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    async function checkHealth() {
      const grid = document.getElementById("health-grid");
      grid.innerHTML = "<div style=\'padding:1rem;color:#94a3b8\'>Checking services...</div>";
      try {
        const res = await Promise.race([
          fetch("/api/health", AUTH),
          new Promise((_, r) => setTimeout(() => r(new Error("Timeout after 8s")), 8000))
        ]);
        if (!res.ok) throw new Error("Request failed (" + res.status + ")");
        const data = await res.json();

        const services = [
          { key: "kv",         name: "Cloudflare KV", icon: "💾" },
          { key: "groq",       name: "Groq AI",        icon: "🤖" },
          { key: "twelvedata", name: "TwelveData",     icon: "📈" },
          { key: "newsapi",    name: "NewsAPI",         icon: "📰" }
        ];

        grid.innerHTML = "";
        for (const svc of services) {
          const info = data[svc.key] || { ok: false, detail: "No data returned from health check" };
          const cls = info.ok ? "online" : "offline";
          const card = document.createElement("div");
          card.className = "health-card " + cls;
          card.innerHTML = \`
            <div class="health-header">
              <div class="health-name">\${svc.icon} \${svc.name}</div>
              <div class="health-status \${cls}"><div class="health-dot \${cls}"></div>\${info.ok ? "Online" : "Offline"}</div>
            </div>
            <div class="health-details">
              <div class="health-row"><span class="health-label">Status</span><span class="health-value">\${info.ok ? "✓ OK" : "✗ Error"}</span></div>
              <div class="health-row"><span class="health-label">Detail</span><span class="health-value">\${esc(info.detail) || "—"}</span></div>
              \${info.ms ? \`<div class="health-row"><span class="health-label">Response Time</span><span class="health-value">\${esc(info.ms)}ms</span></div>\` : ""}
              <div class="health-row"><span class="health-label">Checked</span><span class="health-value">\${new Date().toLocaleTimeString()}</span></div>
            </div>
          \`;
          grid.appendChild(card);
        }
      } catch (e) {
        grid.innerHTML = \`<div style="color:#ef4444;padding:1rem">Health check failed: \${esc(e.message)}</div>\`;
      }
    }

    async function loadLogs() {
      try {
        const res = await fetch("/api/logs", AUTH);
        logs = res.ok ? await res.json() : [];
      } catch { logs = []; }
      renderLogs();
      updateStats();
    }

    function renderLogs() {
      const container = document.getElementById("logs-container");
      if (!logs?.length) {
        container.innerHTML = '<div class="empty-state"><div style="font-size: 2.5rem; margin-bottom: 1rem;">📋</div>No requests yet</div>';
        return;
      }
      container.innerHTML = logs.map(log => \`
        <div class="log-entry" onclick="this.classList.toggle('expanded')">
          <div class="log-header">
            <div class="log-question">❓ \${esc((log.question || "Unknown").substring(0, 50))}...</div>
            <div class="log-meta">
              <div>\${new Date(log.timestamp).toLocaleTimeString()}</div>
              <div class="log-duration">\${esc(log.totalMs)}ms</div>
            </div>
          </div>
          <div class="log-body">
            <div class="log-steps">
              \${log.steps.map(s => \`
                <div class="log-step">
                  <span class="log-step-icon \${s.status === 'ok' ? 'ok' : 'error'}">\${s.status === 'ok' ? '✓' : '✗'}</span>
                  <span>\${esc(s.step)} — \${esc(s.desc)} (\${esc(s.ms)}ms)</span>
                </div>
              \`).join('')}
            </div>
          </div>
        </div>
      \`).join('');
    }

    function updateStats() {
      const total = logs.length;
      const success = logs.filter(l => l.steps?.every(s => s.status === 'ok')).length;
      const avg = total > 0 ? Math.round(logs.reduce((a, b) => a + b.totalMs, 0) / total) : 0;
      const rate = total > 0 ? Math.round((success / total) * 100) : 0;
      document.getElementById("total-requests").textContent = total;
      document.getElementById("avg-response").textContent = avg + "ms";
      document.getElementById("success-rate").textContent = rate + "%";
      document.getElementById("last-update").textContent = new Date().toLocaleTimeString();
    }

    function refreshAll() { checkHealth(); loadLogs(); }
    window.addEventListener("load", () => { refreshAll(); setInterval(refreshAll, 30000); });
  </script>
</body>
</html>`;
}
