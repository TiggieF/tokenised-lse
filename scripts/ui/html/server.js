const express = require('express');
const path = require('path');
const YahooFinance = require('yahoo-finance2').default;
const { fetchIntradayCandles, aggregateCandles, fetchQuote } = require('../dataFetch/tsla-yahoo/yahoo');

const app = express();
const yahooFinance = new YahooFinance({
  suppressNotices: ['yahooSurvey'],
  queue: { concurrency: 1 },
});
const candleCache = new Map();
const CANDLE_TTL_MS = 300000;
const quoteCache = new Map();
const QUOTE_TTL_MS = 5000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(
  '/dataFetch/tsla-yahoo',
  express.static(
    path.join(__dirname, '../dataFetch/tsla-yahoo')
  )
);

const HOLIDAYS_ET = new Set([
  '2025-01-01','2025-01-20','2025-02-17','2025-04-18','2025-05-26','2025-06-19','2025-07-04','2025-09-01','2025-11-27','2025-12-25',
  '2026-01-01','2026-01-19','2026-02-16','2026-04-03','2026-05-25','2026-06-19','2026-07-03','2026-09-07','2026-11-26','2026-12-25',
]);

const TZ = 'America/New_York';

function fmtET(unixSec) {
  return new Date(unixSec * 1000).toLocaleString('en-US', { timeZone: TZ });
}

function etParts(unixSec) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(unixSec * 1000));

  const get = (t) => parts.find(p => p.type === t)?.value;
  return {
    ymd: `${get('year')}-${get('month')}-${get('day')}`,
    hm: `${get('hour')}:${get('minute')}`,
  };
}

function etToUnixSec(ymd, hh, mm) {
  const [Y, M, D] = ymd.split('-').map(Number);
  let guess = Date.UTC(Y, M - 1, D, hh, mm) / 1000;

  for (let i = 0; i < 4; i++) {
    const p = etParts(guess);
    const cur = Date.UTC(
      Number(p.ymd.slice(0, 4)),
      Number(p.ymd.slice(5, 7)) - 1,
      Number(p.ymd.slice(8, 10)),
      Number(p.hm.slice(0, 2)),
      Number(p.hm.slice(3, 5))
    ) / 1000;

    const tgt = Date.UTC(Y, M - 1, D, hh, mm) / 1000;
    guess += (tgt - cur);
  }
  return guess;
}

function round2(x) {
  return x == null ? null : Number(x.toFixed(2));
}

function isWeekend(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return weekday === 0 || weekday === 6;
}

function isTradingDay(ymd) {
  return !isWeekend(ymd) && !HOLIDAYS_ET.has(ymd);
}

function getETDateString() {
  const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
  const y = etNow.getFullYear();
  const m = String(etNow.getMonth() + 1).padStart(2, '0');
  const d = String(etNow.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function previousTradingDay(ymd) {
  let [y, m, d] = ymd.split('-').map(Number);
  let dt = new Date(Date.UTC(y, m - 1, d));
  for (let i = 0; i < 10; i++) {
    const cur = dt.toISOString().slice(0, 10);
    if (isTradingDay(cur)) return cur;
    dt.setUTCDate(dt.getUTCDate() - 1);
  }
  return ymd;
}

function previousTradingDays(endYmd, count) {
  const [y, m, d] = endYmd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const days = [];

  while (days.length < count) {
    const cur = dt.toISOString().slice(0, 10);
    if (isTradingDay(cur)) {
      days.push(cur);
    }
    dt.setUTCDate(dt.getUTCDate() - 1);
  }

  return days.reverse();
}

function tradingDaysInLastMonth(endYmd) {
  const [y, m, d] = endYmd.split('-').map(Number);
  const end = new Date(Date.UTC(y, m - 1, d));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 30);

  const days = [];
  const cur = new Date(start);
  while (cur <= end) {
    const ymd = cur.toISOString().slice(0, 10);
    if (isTradingDay(ymd)) {
      days.push(ymd);
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

function tradingDaysInLastNDays(endYmd, n) {
  const [y, m, d] = endYmd.split('-').map(Number);
  const end = new Date(Date.UTC(y, m - 1, d));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - n);

  const days = [];
  const cur = new Date(start);
  while (cur <= end) {
    const ymd = cur.toISOString().slice(0, 10);
    if (isTradingDay(ymd)) {
      days.push(ymd);
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

async function fetchIntradayCandlesYF(symbol, interval, dateET) {
  return await fetchIntradayCandles(symbol, interval, dateET);
}

app.get('/api/stock/:symbol', async (req, res) => {
  const symbol = req.params.symbol || 'AAPL';

  try {
    const data = await yahooFinance.quoteSummary(symbol, {
      modules: [
        'price',
        'summaryDetail',
        'financialData',
        'majorHoldersBreakdown',
        'institutionOwnership',
        'fundOwnership',
        'insiderHolders',
        'insiderTransactions'
      ]
    });

    res.json(data);
  } catch (err) {
    console.error(err);
    try {
      const quote = await fetchQuote(String(symbol).toUpperCase());
      return res.json({ price: quote, stale: true });
    } catch (fallbackErr) {
      res.status(500).json({ error: 'Failed to fetch data' });
    }
  }
});

app.get('/api/quote', async (req, res) => {
  const symbol = String(req.query.symbol || 'TSLA').toUpperCase();
  const cached = quoteCache.get(symbol);

  try {
    if (cached && (Date.now() - cached.timestamp) < QUOTE_TTL_MS) {
      return res.json(cached.data);
    }
    const data = await fetchQuote(symbol);
    quoteCache.set(symbol, { data, timestamp: Date.now() });
    res.json(data);
  } catch (err) {
    if (cached) {
      return res.json({ ...cached.data, stale: true });
    }

    try {
      const todayEt = getETDateString();
      const dateEt = isTradingDay(todayEt) ? todayEt : previousTradingDay(todayEt);
      const candles = await fetchIntradayCandles(symbol, '5m', dateEt);
      if (candles.length) {
        const first = candles[0];
        const last = candles[candles.length - 1];
        const regularMarketOpen = first.open ?? null;
        const regularMarketPrice = last.close ?? last.open ?? null;
        const regularMarketChange =
          regularMarketOpen != null && regularMarketPrice != null
            ? Number((regularMarketPrice - regularMarketOpen).toFixed(2))
            : null;
        const regularMarketChangePercent =
          regularMarketOpen
            ? Number(((regularMarketChange / regularMarketOpen) || 0).toFixed(6))
            : null;
        const fallbackQuote = {
          symbol,
          currency: 'USD',
          regularMarketPrice,
          regularMarketOpen,
          regularMarketChange,
          regularMarketChangePercent,
          regularMarketTime: last.timeSec,
          stale: true,
        };
        quoteCache.set(symbol, { data: fallbackQuote, timestamp: Date.now() });
        return res.json(fallbackQuote);
      }
    } catch (fallbackErr) {
      // fall through to 502
    }

    const msg = err.message || 'Failed to fetch quote';
    res.status(502).json({ error: msg });
  }
});

app.get('/api/candles', async (req, res) => {
  const symbol = String(req.query.symbol || 'TSLA').toUpperCase();
  const date = String(req.query.date || '');
  const interval = Number(req.query.interval || 5);
  const range = String(req.query.range || '1d');
  const cacheKey = `${symbol}|${date}|${interval}|${range}`;
  const cached = candleCache.get(cacheKey);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });
  }

  if (!Number.isFinite(interval) || interval < 5 || interval % 5 !== 0) {
    return res.status(400).json({
      error: 'interval must be a positive multiple of 5 minutes',
    });
  }

  try {
    if (cached && (Date.now() - cached.timestamp) < CANDLE_TTL_MS) {
      return res.json(cached.data);
    }

    const endDate = date;
    const dates =
      range === '5d' ? previousTradingDays(endDate, 5) :
      range === '1m' ? tradingDaysInLastMonth(endDate) :
      range === '3m' ? tradingDaysInLastNDays(endDate, 90) :
      range === '6m' ? tradingDaysInLastNDays(endDate, 180) :
      [endDate];
    const baseCandles = [];

    for (const day of dates) {
      const dayCandles = await fetchIntradayCandlesYF(symbol, '5m', day);
      baseCandles.push(...dayCandles);
    }

    if (baseCandles.length === 0) {
      return res.status(404).json({
        error: 'No candles for selected date/range (market closed or future date).',
      });
    }

    const candles = aggregateCandles(baseCandles, interval).map(c => ({
      timeSec: c.timeSec,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
      timeET: c.timeET,
    }));

    const payload = { symbol, date: endDate, interval, range, dates, candles };
    candleCache.set(cacheKey, { data: payload, timestamp: Date.now() });
    res.json(payload);
  } catch (err) {
    const msg = err.message || 'Unknown error';
    const status = /future|No chart data|No quote data/i.test(msg) ? 400 : 502;
    if (cached) {
      return res.json({ ...cached.data, stale: true });
    }
    res.status(status).json({ error: msg });
  }
});

app.use((_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.STAGE0_PORT ? Number(process.env.STAGE0_PORT) : 3000;
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
