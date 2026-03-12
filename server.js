const https = require('https');
const http = require('http');

const PORT = process.env.PORT || 3000;

// In-memory price cache — avoid hammering Yahoo for the same symbol
const cache = new Map(); // symbol -> { price, ts }
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function fetchYahoo(symbol) {
  return new Promise((resolve, reject) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 10000,
    };

    const req = https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const meta = json?.chart?.result?.[0]?.meta;
          if (meta) {
            const price = meta.regularMarketPrice ?? meta.previousClose;
            if (price && price > 0) return resolve(price);
          }
          // Fallback: last close in quotes array
          const closes = json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
          if (closes?.length) {
            const last = [...closes].reverse().find(v => v != null && v > 0);
            if (last) return resolve(last);
          }
          reject(new Error('No price in response'));
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// Try query1, fall back to query2
async function fetchWithFallback(symbol) {
  try {
    return await fetchYahoo(symbol, 'query1');
  } catch (e) {
    // Try query2
    return new Promise((resolve, reject) => {
      const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
      const options = {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'application/json',
        },
        timeout: 10000,
      };
      const req = https.get(url, options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const meta = json?.chart?.result?.[0]?.meta;
            if (meta) {
              const price = meta.regularMarketPrice ?? meta.previousClose;
              if (price && price > 0) return resolve(price);
            }
            const closes = json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
            if (closes?.length) {
              const last = [...closes].reverse().find(v => v != null && v > 0);
              if (last) return resolve(last);
            }
            reject(new Error('No price'));
          } catch(e2) { reject(e2); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
  }
}

const server = http.createServer(async (req, res) => {
  // CORS headers — allow your HTML file to call this from any origin
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return;
  }

  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);

  // Health check
  if (parsedUrl.pathname === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }

  // Single quote: GET /quote?symbol=AAPL
  if (parsedUrl.pathname === '/quote') {
    const symbol = parsedUrl.searchParams.get('symbol');
    if (!symbol) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Missing symbol parameter' }));
      return;
    }

    // Check cache
    const cached = cache.get(symbol);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      res.writeHead(200);
      res.end(JSON.stringify({ symbol, price: cached.price, cached: true }));
      return;
    }

    try {
      const price = await fetchWithFallback(symbol);
      cache.set(symbol, { price, ts: Date.now() });
      res.writeHead(200);
      res.end(JSON.stringify({ symbol, price, cached: false }));
    } catch (e) {
      res.writeHead(404);
      res.end(JSON.stringify({ symbol, error: 'Price not found', detail: e.message }));
    }
    return;
  }

  // Batch quotes: GET /quotes?symbols=AAPL,MSFT,9988.HK
  if (parsedUrl.pathname === '/quotes') {
    const symbolsParam = parsedUrl.searchParams.get('symbols');
    if (!symbolsParam) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Missing symbols parameter' }));
      return;
    }

    const symbols = symbolsParam.split(',').map(s => s.trim()).filter(Boolean).slice(0, 50);
    const results = {};

    await Promise.all(symbols.map(async (sym) => {
      // Check cache first
      const cached = cache.get(sym);
      if (cached && Date.now() - cached.ts < CACHE_TTL) {
        results[sym] = { price: cached.price, cached: true };
        return;
      }
      try {
        const price = await fetchWithFallback(sym);
        cache.set(sym, { price, ts: Date.now() });
        results[sym] = { price, cached: false };
      } catch (e) {
        results[sym] = { error: 'Not found' };
      }
    }));

    res.writeHead(200);
    res.end(JSON.stringify({ results }));
    return;
  }

  // 404
  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found. Use /quote?symbol=AAPL or /quotes?symbols=AAPL,MSFT' }));
});

server.listen(PORT, () => {
  console.log(`Yahoo Finance proxy running on port ${PORT}`);
});
