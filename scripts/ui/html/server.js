const express = require('express');
const path = require('path');
const fs = require('fs');
const { ethers } = require('ethers');
const YahooFinance = require('yahoo-finance2').default;
const { fetchIntradayCandles, aggregateCandles, fetchQuote } = require('../dataFetch/tsla-yahoo/yahoo');

const app = express();
app.use(express.json());
const yahooFinance = new YahooFinance({
  suppressNotices: ['yahooSurvey'],
  queue: { concurrency: 1 },
});
const candleCache = new Map();
const CANDLE_TTL_MS = 300000;
const quoteCache = new Map();
const QUOTE_TTL_MS = 5000;
const fmpQuoteCache = new Map();
const FMP_QUOTE_TTL_MS = 5000;
const fmpInfoCache = new Map();
const FMP_INFO_TTL_MS = 60000;
const FMP_API_KEY = process.env.FMP_API_KEY || 'TNQATNqowKe9Owu1zL9QurgZCXx9Q1BS';
const HARDHAT_RPC_URL = process.env.HARDHAT_RPC_URL || 'http://127.0.0.1:8545';

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

  const get = (t) => {
    const part = parts.find((p) => p.type === t);
    return part.value;
  };
  return {
    ymd: `${get("year")}-${get("month")}-${get("day")}`,
    hm: `${get("hour")}:${get("minute")}`,
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
  return Number(x.toFixed(2));
}

function pick(obj, keys) {
  for (const k of keys) {
    return obj[k];
  }
  return undefined;
}

function asNumber(value) {
  return Number(value);
}

async function fetchFmpJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`FMP HTTP ${res.status}: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`FMP non-JSON response: ${text.slice(0, 200)}...`);
  }
}

function getFmpUrl(pathname, params) {
  const url = new URL(`https://financialmodelingprep.com/stable/${pathname}`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  url.searchParams.set('apikey', FMP_API_KEY);
  return url.toString();
}

const equityFactoryInterface = new ethers.Interface([
  'function createEquityToken(string symbol, string name) returns (address)',
]);
const listingsRegistryInterface = new ethers.Interface([
  'function getListing(string symbol) view returns (address)',
  'function getSymbolByToken(address token) view returns (string)',
]);
const equityTokenInterface = new ethers.Interface([
  'function mint(address to, uint256 amount)',
  'function balanceOf(address account) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);
const registryListInterface = new ethers.Interface([
  'function getAllSymbols() view returns (string[])',
]);
const orderBookInterface = new ethers.Interface([
  'function placeLimitOrder(address equityToken, uint8 side, uint256 price, uint256 qty) returns (uint256)',
  'function getBuyOrders(address equityToken) view returns (tuple(uint256 id,address trader,uint8 side,uint256 price,uint256 qty,uint256 remaining,bool active)[])',
  'function getSellOrders(address equityToken) view returns (tuple(uint256 id,address trader,uint8 side,uint256 price,uint256 qty,uint256 remaining,bool active)[])',
  'event OrderFilled(uint256 indexed makerId,uint256 indexed takerId,address indexed equityToken,uint256 price,uint256 qty)',
]);

async function ensureContract(address) {
  const code = await hardhatRpc('eth_getCode', [address, 'latest']);
  return code !== '0x';
}

function loadDeployments() {
  const deploymentsPath = path.join(__dirname, '../../..', 'deployments', 'localhost.json');
  const raw = fs.readFileSync(deploymentsPath, 'utf8');
  return JSON.parse(raw);
}

function getTTokenAddressFromDeployments() {
  const deployments = loadDeployments();
  if (deployments.ttoken) {
    return deployments.ttoken;
  }
  if (deployments.ttokenAddress) {
    return deployments.ttokenAddress;
  }
  if (deployments.TTOKEN_ADDRESS) {
    return deployments.TTOKEN_ADDRESS;
  }
  return null;
}

function isValidAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

async function hardhatRpc(method, params = []) {
  const res = await fetch(HARDHAT_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const payload = await res.json();
  if (!res.ok || payload.error) {
    let msg = `Hardhat RPC ${res.status}`;
    if (payload.error && payload.error.message) {
      msg = payload.error.message;
    }
    throw new Error(msg);
  }
  return payload.result;
}
function isWeekend(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return weekday === 0 || weekday === 6;
}

function isTradingDay(ymd) {
  if (isWeekend(ymd)) {
    return false;
  }
  if (HOLIDAYS_ET.has(ymd)) {
    return false;
  }
  return true;
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

async function buildCandleFallback(symbol) {
  const todayEt = getETDateString();
  let dateEt = todayEt;
  const marketOpen = isTradingDay(todayEt);
  if (!marketOpen) {
    dateEt = previousTradingDay(todayEt);
  }
  const candles = await fetchIntradayCandles(symbol, '5m', dateEt);
  const first = candles[0];
  const last = candles[candles.length - 1];

  const open = first.open;
  const close = last.close;

  let dayLow = Number.POSITIVE_INFINITY;
  let dayHigh = 0;
  let volume = 0;
  for (const candle of candles) {
    if (candle.low < dayLow) {
      dayLow = candle.low;
    }
    if (candle.high > dayHigh) {
      dayHigh = candle.high;
    }
    volume += candle.volume;
  }

  return {
    open,
    close,
    dayLow,
    dayHigh,
    volume,
    dateEt,
  };
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
      let dateEt = todayEt;
      const marketOpen = isTradingDay(todayEt);
      if (!marketOpen) {
        dateEt = previousTradingDay(todayEt);
      }
      const candles = await fetchIntradayCandles(symbol, '5m', dateEt);
      if (candles.length) {
        const first = candles[0];
        const last = candles[candles.length - 1];
        const regularMarketOpen = first.open;
        const regularMarketPrice = last.close;
        const regularMarketChange = Number((regularMarketPrice - regularMarketOpen).toFixed(2));
        const regularMarketChangePercent = Number((regularMarketChange / regularMarketOpen).toFixed(6));
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

app.get('/api/fmp/quote-short', async (req, res) => {
  const symbol = String(req.query.symbol || 'TSLA').toUpperCase();
  const cached = fmpQuoteCache.get(symbol);

  try {
    if (cached && (Date.now() - cached.timestamp) < FMP_QUOTE_TTL_MS) {
      return res.json(cached.data);
    }

    const url = getFmpUrl('quote-short', { symbol });
    const payload = await fetchFmpJson(url);
    let quote = payload;
    if (Array.isArray(payload)) {
      quote = payload[0];
    }
    const price = quote.price;
    const volume = quote.volume;
    const data = {
      symbol: quote.symbol || symbol,
      price,
      volume,
    };
    fmpQuoteCache.set(symbol, { data, timestamp: Date.now() });
    res.json(data);
  } catch (err) {
    try {
      const fallbackQuote = await fetchQuote(symbol);
      const fallbackData = {
        symbol,
        price: fallbackQuote.regularMarketPrice,
        volume: fallbackQuote.regularMarketVolume,
        stale: true,
        source: 'yahoo',
      };
      fmpQuoteCache.set(symbol, { data: fallbackData, timestamp: Date.now() });
      return res.json(fallbackData);
    } catch (fallbackErr) {
      try {
        const candleData = await buildCandleFallback(symbol);
        if (candleData) {
          const fallbackData = {
            symbol,
            price: candleData.close,
            volume: candleData.volume,
            stale: true,
            source: 'candles',
          };
          fmpQuoteCache.set(symbol, { data: fallbackData, timestamp: Date.now() });
          return res.json(fallbackData);
        }
      } catch (candleErr) {
        // fall through
      }

      if (cached) {
        return res.json({ ...cached.data, stale: true });
      }
      const msg = err.message || 'Failed to fetch FMP quote';
      res.status(502).json({ error: msg });
    }
  }
});

app.get('/api/fmp/stock-info', async (req, res) => {
  const symbol = String(req.query.symbol || 'TSLA').toUpperCase();
  const cached = fmpInfoCache.get(symbol);

  try {
    if (cached && (Date.now() - cached.timestamp) < FMP_INFO_TTL_MS) {
      return res.json(cached.data);
    }

    const [quotePayload, afterPayload] = await Promise.all([
      fetchFmpJson(getFmpUrl('quote', { symbol })),
      fetchFmpJson(getFmpUrl('aftermarket-quote', { symbol })).catch((e) => ({ __error: e.message })),
    ]);

    let quote = quotePayload;
    if (Array.isArray(quotePayload)) {
      quote = quotePayload[0];
    }

    let after = afterPayload;
    if (Array.isArray(afterPayload)) {
      after = afterPayload[0];
    }

    const currency = quote.currency;
    const stale = false;

    const data = {
      symbol,
      currency,
      previousClose: asNumber(pick(quote, ['previousClose', 'prevClose'])),
      open: asNumber(pick(quote, ['open', 'priceOpen'])),
      dayLow: asNumber(pick(quote, ['dayLow', 'low'])),
      dayHigh: asNumber(pick(quote, ['dayHigh', 'high'])),
      yearLow: asNumber(pick(quote, ['yearLow', 'fiftyTwoWeekLow', '52WeekLow'])),
      yearHigh: asNumber(pick(quote, ['yearHigh', 'fiftyTwoWeekHigh', '52WeekHigh'])),
      volume: asNumber(pick(quote, ['volume'])),
      avgVolume: asNumber(pick(quote, ['avgVolume', 'averageVolume'])),
      marketCap: asNumber(pick(quote, ['marketCap', 'mktCap'])),
      beta: asNumber(pick(quote, ['beta'])),
      peTTM: asNumber(pick(quote, ['pe', 'peRatioTTM', 'peTTM'])),
      epsTTM: asNumber(pick(quote, ['eps', 'epsTTM'])),
      bid: asNumber(pick(after, ['bid', 'bidPrice'])),
      bidSize: asNumber(pick(after, ['bidSize', 'bidSizeShares'])),
      ask: asNumber(pick(after, ['ask', 'askPrice'])),
      askSize: asNumber(pick(after, ['askSize', 'askSizeShares'])),
      stale,
    };

    fmpInfoCache.set(symbol, { data, timestamp: Date.now() });
    res.json(data);
  } catch (err) {
    try {
      const summary = await yahooFinance.quoteSummary(symbol, {
        modules: ['summaryDetail', 'price', 'defaultKeyStatistics'],
      });
      const price = summary.price || {};
      const sd = summary.summaryDetail || {};
      const stats = summary.defaultKeyStatistics || {};
      const fallbackData = {
        symbol,
        currency: price.currency || 'USD',
        previousClose: asNumber(price.regularMarketPreviousClose),
        open: asNumber(price.regularMarketOpen),
        dayLow: asNumber(price.regularMarketDayLow),
        dayHigh: asNumber(price.regularMarketDayHigh),
        yearLow: asNumber(sd.fiftyTwoWeekLow),
        yearHigh: asNumber(sd.fiftyTwoWeekHigh),
        volume: asNumber(price.regularMarketVolume),
        avgVolume: asNumber(sd.averageVolume),
        marketCap: asNumber(price.marketCap),
        beta: asNumber(sd.beta),
        peTTM: asNumber(sd.trailingPE),
        epsTTM: asNumber(stats.trailingEps),
        bid: asNumber(sd.bid),
        bidSize: asNumber(sd.bidSize),
        ask: asNumber(sd.ask),
        askSize: asNumber(sd.askSize),
        stale: true,
      };
      fmpInfoCache.set(symbol, { data: fallbackData, timestamp: Date.now() });
      return res.json(fallbackData);
    } catch (fallbackErr) {
      try {
        const candleData = await buildCandleFallback(symbol);
        if (candleData) {
          const fallbackData = {
            symbol,
            currency: 'USD',
            previousClose: candleData.open,
            open: candleData.open,
            dayLow: candleData.dayLow,
            dayHigh: candleData.dayHigh,
            yearLow: 0,
            yearHigh: 0,
            volume: candleData.volume,
            avgVolume: 0,
            marketCap: 0,
            beta: 0,
            peTTM: 0,
            epsTTM: 0,
            bid: 0,
            bidSize: 0,
            ask: 0,
            askSize: 0,
            stale: true,
          };
          fmpInfoCache.set(symbol, { data: fallbackData, timestamp: Date.now() });
          return res.json(fallbackData);
        }
      } catch (candleErr) {
        // fall through
      }

      if (cached) {
        return res.json({ ...cached.data, stale: true });
      }
      const msg = err.message || 'Failed to fetch FMP stock info';
      res.status(502).json({ error: msg });
    }
  }
});

app.get('/api/hardhat/accounts', async (_req, res) => {
  try {
    const accounts = await hardhatRpc('eth_accounts');
    res.json({ accounts });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Hardhat RPC failed' });
  }
});

app.get('/api/ttoken-address', (_req, res) => {
  const envAddress = process.env.TTOKEN_ADDRESS;
  if (envAddress) {
    res.json({ address: envAddress });
    return;
  }

  const address = getTTokenAddressFromDeployments();
  res.json({ address });
});

app.get('/api/ttoken/balance', async (req, res) => {
  const address = String(req.query.address || '');
  try {
    const ttokenAddress = process.env.TTOKEN_ADDRESS || getTTokenAddressFromDeployments();
    const data = equityTokenInterface.encodeFunctionData('balanceOf', [address]);
    const result = await hardhatRpc('eth_call', [{ to: ttokenAddress, data }, 'latest']);
    const [balanceWei] = equityTokenInterface.decodeFunctionResult('balanceOf', result);
    res.json({ address, ttokenAddress, balanceWei: balanceWei.toString() });
  } catch (err) {
    res.status(502).json({ error: err.message || 'TTOKEN balance lookup failed' });
  }
});

app.post('/api/ttoken/mint', async (req, res) => {
  const body = req.body || {};
  const to = String(body.to || '');
  const amount = Number(body.amount || 0);
  const recipientValid = isValidAddress(to);
  if (!recipientValid) {
    return res.status(400).json({ error: 'Invalid recipient address' });
  }
  const amountIsNumber = Number.isFinite(amount);
  if (!amountIsNumber || amount < 1000) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  const ttokenAddress = process.env.TTOKEN_ADDRESS || getTTokenAddressFromDeployments();

  try {
    const deployments = loadDeployments();
    const from = deployments.admin;
    const fromValid = isValidAddress(from);
    if (!fromValid) {
      return res.status(500).json({ error: 'Admin address missing in deployments' });
    }

    const amountWei = BigInt(Math.round(amount)) * 10n ** 18n;
    const data = equityTokenInterface.encodeFunctionData('mint', [to, amountWei]);
    const txHash = await hardhatRpc('eth_sendTransaction', [{
      from,
      to: ttokenAddress,
      data,
    }]);
    res.json({ txHash });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Mint failed' });
  }
});

app.post('/api/orderbook/limit', async (req, res) => {
  try {
    const body = req.body || {};
    const symbol = String(body.symbol || '').toUpperCase();
    const sideText = String(body.side || 'BUY').toUpperCase();
    const priceCents = Number(body.priceCents || 0);
    const qty = Number(body.qty || 0);
    const from = String(body.from || '');
    const deployments = loadDeployments();
    const registryAddr = deployments.listingsRegistry;
    const orderBookAddr = deployments.orderBookDex;
    const ttokenAddr = deployments.ttoken;

    const lookupData = listingsRegistryInterface.encodeFunctionData('getListing', [symbol]);
    const lookupResult = await hardhatRpc('eth_call', [{ to: registryAddr, data: lookupData }, 'latest']);
    const [tokenAddr] = listingsRegistryInterface.decodeFunctionResult('getListing', lookupResult);

    let side = 0;
    if (sideText === 'SELL') {
      side = 1;
    }

    const qtyWei = BigInt(Math.round(qty)) * 10n ** 18n;

    if (side === 0) {
      const quoteWei = (qtyWei * BigInt(priceCents)) / 100n;
      const approveData = equityTokenInterface.encodeFunctionData('approve', [orderBookAddr, quoteWei]);
      await hardhatRpc('eth_sendTransaction', [{
        from: from,
        to: ttokenAddr,
        data: approveData,
      }]);
    } else {
      const approveData = equityTokenInterface.encodeFunctionData('approve', [orderBookAddr, qtyWei]);
      await hardhatRpc('eth_sendTransaction', [{
        from: from,
        to: tokenAddr,
        data: approveData,
      }]);
    }

    const data = orderBookInterface.encodeFunctionData('placeLimitOrder', [
      tokenAddr,
      side,
      priceCents,
      qtyWei,
    ]);

    const txHash = await hardhatRpc('eth_sendTransaction', [{
      from: from,
      to: orderBookAddr,
      data: data,
    }]);

    res.json({ txHash: txHash });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Order failed' });
  }
});

app.get('/api/orderbook/open', async (_req, res) => {
  try {
    const deployments = loadDeployments();
    const registryAddr = deployments.listingsRegistry;
    const orderBookAddr = deployments.orderBookDex;

    const listData = registryListInterface.encodeFunctionData('getAllSymbols', []);
    const listResult = await hardhatRpc('eth_call', [{ to: registryAddr, data: listData }, 'latest']);
    const [symbols] = registryListInterface.decodeFunctionResult('getAllSymbols', listResult);

    const orders = [];
    for (const symbol of symbols) {
      const lookupData = listingsRegistryInterface.encodeFunctionData('getListing', [symbol]);
      const lookupResult = await hardhatRpc('eth_call', [{ to: registryAddr, data: lookupData }, 'latest']);
      const [tokenAddr] = listingsRegistryInterface.decodeFunctionResult('getListing', lookupResult);

      const buyData = orderBookInterface.encodeFunctionData('getBuyOrders', [tokenAddr]);
      const buyResult = await hardhatRpc('eth_call', [{ to: orderBookAddr, data: buyData }, 'latest']);
      const [buyOrders] = orderBookInterface.decodeFunctionResult('getBuyOrders', buyResult);

      const sellData = orderBookInterface.encodeFunctionData('getSellOrders', [tokenAddr]);
      const sellResult = await hardhatRpc('eth_call', [{ to: orderBookAddr, data: sellData }, 'latest']);
      const [sellOrders] = orderBookInterface.decodeFunctionResult('getSellOrders', sellResult);

      for (const order of buyOrders) {
        orders.push({
          id: Number(order.id),
          side: 'BUY',
          symbol: symbol,
          priceCents: Number(order.price),
          qty: order.qty.toString(),
          remaining: order.remaining.toString(),
          trader: order.trader,
          active: order.active,
        });
      }

      for (const order of sellOrders) {
        orders.push({
          id: Number(order.id),
          side: 'SELL',
          symbol: symbol,
          priceCents: Number(order.price),
          qty: order.qty.toString(),
          remaining: order.remaining.toString(),
          trader: order.trader,
          active: order.active,
        });
      }
    }

    orders.sort((a, b) => a.id - b.id);
    res.json({ orders: orders });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Orderbook open failed' });
  }
});

app.get('/api/orderbook/fills', async (_req, res) => {
  try {
    const deployments = loadDeployments();
    const registryAddr = deployments.listingsRegistry;
    const orderBookAddr = deployments.orderBookDex;
    const latestBlock = await hardhatRpc('eth_blockNumber', []);
    const fromBlock = "0x0";

    const topic = ethers.id('OrderFilled(uint256,uint256,address,uint256,uint256)');
    const logs = await hardhatRpc('eth_getLogs', [{
      fromBlock: fromBlock,
      toBlock: latestBlock,
      address: orderBookAddr,
      topics: [topic],
    }]);

    const fills = [];
    for (const log of logs) {
      const parsed = orderBookInterface.parseLog(log);
      const tokenAddr = parsed.args.equityToken;
      const symbolData = listingsRegistryInterface.encodeFunctionData('getSymbolByToken', [tokenAddr]);
      const symbolResult = await hardhatRpc('eth_call', [{ to: registryAddr, data: symbolData }, 'latest']);
      const [symbol] = listingsRegistryInterface.decodeFunctionResult('getSymbolByToken', symbolResult);

      const block = await hardhatRpc('eth_getBlockByNumber', [log.blockNumber, false]);
      const blockTimestamp = Number(block.timestamp);
      const blockTimestampMs = blockTimestamp * 1000;

      const buyData = orderBookInterface.encodeFunctionData('getBuyOrders', [tokenAddr]);
      const buyResult = await hardhatRpc('eth_call', [{ to: orderBookAddr, data: buyData }, 'latest']);
      const [buyOrders] = orderBookInterface.decodeFunctionResult('getBuyOrders', buyResult);

      const sellData = orderBookInterface.encodeFunctionData('getSellOrders', [tokenAddr]);
      const sellResult = await hardhatRpc('eth_call', [{ to: orderBookAddr, data: sellData }, 'latest']);
      const [sellOrders] = orderBookInterface.decodeFunctionResult('getSellOrders', sellResult);

      let makerTrader = "";
      let takerTrader = "";
      const makerId = Number(parsed.args.makerId);
      const takerId = Number(parsed.args.takerId);

      for (const order of buyOrders) {
        if (Number(order.id) === makerId) {
          makerTrader = order.trader;
        }
        if (Number(order.id) === takerId) {
          takerTrader = order.trader;
        }
      }
      for (const order of sellOrders) {
        if (Number(order.id) === makerId) {
          makerTrader = order.trader;
        }
        if (Number(order.id) === takerId) {
          takerTrader = order.trader;
        }
      }

      fills.push({
        makerId: makerId,
        takerId: takerId,
        makerTrader: makerTrader,
        takerTrader: takerTrader,
        symbol: symbol,
        priceCents: Number(parsed.args.price),
        qty: parsed.args.qty.toString(),
        blockNumber: Number(log.blockNumber),
        txHash: log.transactionHash,
        timestampMs: blockTimestampMs,
      });
    }
    res.json({ fills: fills });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Orderbook fills failed' });
  }
});

app.post('/api/equity/create', async (req, res) => {
  const body = req.body || {};
  const symbol = String(body.symbol || '').toUpperCase();
  const name = String(body.name || '').trim();
  if (symbol.length === 0 || name.length === 0) {
    return res.status(400).json({ error: 'Symbol and name required' });
  }

  try {
    const deployments = loadDeployments();
    const factoryAddr = deployments.equityTokenFactory;
    const admin = deployments.admin;
    const factoryDeployed = await ensureContract(factoryAddr);
    if (!factoryDeployed) {
      return res.status(500).json({ error: 'EquityTokenFactory not deployed on this chain. Re-deploy stage2/5 and update deployments/localhost.json.' });
    }

    const data = equityFactoryInterface.encodeFunctionData('createEquityToken', [symbol, name]);
    const txHash = await hardhatRpc('eth_sendTransaction', [{
      from: admin,
      to: factoryAddr,
      data,
    }]);
    res.json({ txHash });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Create token failed' });
  }
});

app.post('/api/equity/mint', async (req, res) => {
  const body = req.body || {};
  const symbol = String(body.symbol || '').toUpperCase();
  const to = String(body.to || '');
  const amount = Number(body.amount || 0);
  if (symbol.length === 0) {
    return res.status(400).json({ error: 'Symbol required' });
  }
  const recipientValid = isValidAddress(to);
  if (!recipientValid) {
    return res.status(400).json({ error: 'Invalid recipient address' });
  }
  const amountIsNumber = Number.isFinite(amount);
  if (!amountIsNumber || amount < 1000) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  try {
    const deployments = loadDeployments();
    const registryAddr = deployments.listingsRegistry;
    const minter = deployments.defaultMinter || deployments.admin;
    const registryDeployed = await ensureContract(registryAddr);
    if (!registryDeployed) {
      return res.status(500).json({ error: 'ListingsRegistry not deployed on this chain. Re-deploy stage2/5 and update deployments/localhost.json.' });
    }

    const data = listingsRegistryInterface.encodeFunctionData('getListing', [symbol]);
    const result = await hardhatRpc('eth_call', [{ to: registryAddr, data }, 'latest']);
    const [tokenAddr] = listingsRegistryInterface.decodeFunctionResult('getListing', result);
    if (tokenAddr === ethers.ZeroAddress) {
      return res.status(404).json({ error: `Symbol ${symbol} not listed` });
    }

    const amountWei = BigInt(Math.round(amount)) * 10n ** 18n;
    const mintData = equityTokenInterface.encodeFunctionData('mint', [to, amountWei]);
    const txHash = await hardhatRpc('eth_sendTransaction', [{
      from: minter,
      to: tokenAddr,
      data: mintData,
    }]);
    res.json({ txHash, tokenAddress: tokenAddr });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Mint failed' });
  }
});

app.post('/api/equity/create-mint', async (req, res) => {
  const body = req.body || {};
  const symbol = String(body.symbol || '').toUpperCase();
  const name = String(body.name || '').trim();
  const to = String(body.to || '');
  const amount = Number(body.amount || 0);
  if (symbol.length === 0 || name.length === 0) {
    return res.status(400).json({ error: 'Symbol and name required' });
  }
  const recipientValid = isValidAddress(to);
  if (!recipientValid) {
    return res.status(400).json({ error: 'Invalid recipient address' });
  }
  const amountIsNumber = Number.isFinite(amount);
  if (!amountIsNumber || amount < 1000) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  try {
    const deployments = loadDeployments();
    const factoryAddr = deployments.equityTokenFactory;
    const registryAddr = deployments.listingsRegistry;
    const admin = deployments.admin;
    const minter = deployments.defaultMinter || deployments.admin;
    const factoryDeployed = await ensureContract(factoryAddr);
    const registryDeployed = await ensureContract(registryAddr);
    if (!factoryDeployed || !registryDeployed) {
      return res.status(500).json({ error: 'Factory/registry not deployed on this chain. Re-deploy stage2/5 and update deployments/localhost.json.' });
    }

    const lookupData = listingsRegistryInterface.encodeFunctionData('getListing', [symbol]);
    let lookupResult = await hardhatRpc('eth_call', [{ to: registryAddr, data: lookupData }, 'latest']);
    let [tokenAddr] = listingsRegistryInterface.decodeFunctionResult('getListing', lookupResult);

    let createTx = null;
    if (tokenAddr === ethers.ZeroAddress) {
      const createData = equityFactoryInterface.encodeFunctionData('createEquityToken', [symbol, name]);
      createTx = await hardhatRpc('eth_sendTransaction', [{
        from: admin,
        to: factoryAddr,
        data: createData,
      }]);

      for (let i = 0; i < 10; i++) {
        const receipt = await hardhatRpc('eth_getTransactionReceipt', [createTx]);
        if (receipt) {
          break;
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 300);
        });
      }

      lookupResult = await hardhatRpc('eth_call', [{ to: registryAddr, data: lookupData }, 'latest']);
      [tokenAddr] = listingsRegistryInterface.decodeFunctionResult('getListing', lookupResult);
    }
    if (tokenAddr === ethers.ZeroAddress) {
      return res.status(404).json({ error: `Symbol ${symbol} not listed after create` });
    }

    const amountWei = BigInt(Math.round(amount)) * 10n ** 18n;
    const mintData = equityTokenInterface.encodeFunctionData('mint', [to, amountWei]);
    const mintTx = await hardhatRpc('eth_sendTransaction', [{
      from: minter,
      to: tokenAddr,
      data: mintData,
    }]);
    res.json({ createTx, mintTx, tokenAddress: tokenAddr });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Create+mint failed' });
  }
});

app.get('/api/registry/listings', async (_req, res) => {
  try {
    const deployments = loadDeployments();
    const registryAddr = deployments.listingsRegistry;
    const registryDeployed = await ensureContract(registryAddr);
    if (!registryDeployed) {
      return res.status(500).json({ error: 'ListingsRegistry not deployed on this chain.' });
    }
    const data = registryListInterface.encodeFunctionData('getAllSymbols', []);
    const result = await hardhatRpc('eth_call', [{ to: registryAddr, data }, 'latest']);
    const [symbols] = registryListInterface.decodeFunctionResult('getAllSymbols', result);

    const listings = [];
    for (const symbol of symbols) {
      const lookup = listingsRegistryInterface.encodeFunctionData('getListing', [symbol]);
      const lookupResult = await hardhatRpc('eth_call', [{ to: registryAddr, data: lookup }, 'latest']);
      const [tokenAddr] = listingsRegistryInterface.decodeFunctionResult('getListing', lookupResult);
      if (tokenAddr !== ethers.ZeroAddress) {
        listings.push({ symbol, tokenAddress: tokenAddr });
      }
    }
    res.json({ listings });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Lookup failed' });
  }
});

app.get('/api/equity/balances', async (req, res) => {
  const address = String(req.query.address || '');
  try {
    const deployments = loadDeployments();
    const registryAddr = deployments.listingsRegistry;
    const registryDeployed = await ensureContract(registryAddr);
    if (!registryDeployed) {
      return res.status(500).json({ error: 'ListingsRegistry not deployed on this chain.' });
    }

    const data = registryListInterface.encodeFunctionData('getAllSymbols', []);
    const result = await hardhatRpc('eth_call', [{ to: registryAddr, data }, 'latest']);
    const [symbols] = registryListInterface.decodeFunctionResult('getAllSymbols', result);

    const balances = [];
    for (const symbol of symbols) {
      const lookup = listingsRegistryInterface.encodeFunctionData('getListing', [symbol]);
      const lookupResult = await hardhatRpc('eth_call', [{ to: registryAddr, data: lookup }, 'latest']);
      const [tokenAddr] = listingsRegistryInterface.decodeFunctionResult('getListing', lookupResult);
      if (tokenAddr === ethers.ZeroAddress) {
        continue;
      }

      const balData = equityTokenInterface.encodeFunctionData('balanceOf', [address]);
      const balResult = await hardhatRpc('eth_call', [{ to: tokenAddr, data: balData }, 'latest']);
      const [balanceWei] = equityTokenInterface.decodeFunctionResult('balanceOf', balResult);
      balances.push({ symbol, tokenAddress: tokenAddr, balanceWei: balanceWei.toString() });
    }
    res.json({ balances });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Balance lookup failed' });
  }
});

app.get('/api/equity/address', async (req, res) => {
  const symbol = String(req.query.symbol || '').toUpperCase();
  if (symbol.length === 0) {
    return res.status(400).json({ error: 'Symbol required' });
  }
  try {
    const deployments = loadDeployments();
    const registryAddr = deployments.listingsRegistry;
    const registryDeployed = await ensureContract(registryAddr);
    if (!registryDeployed) {
      return res.status(500).json({ error: 'ListingsRegistry not deployed on this chain.' });
    }
    const data = listingsRegistryInterface.encodeFunctionData('getListing', [symbol]);
    const result = await hardhatRpc('eth_call', [{ to: registryAddr, data }, 'latest']);
    const [tokenAddr] = listingsRegistryInterface.decodeFunctionResult('getListing', result);
    if (tokenAddr === ethers.ZeroAddress) {
      return res.status(404).json({ error: `Symbol ${symbol} not listed` });
    }
    res.json({ tokenAddress: tokenAddr });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Lookup failed' });
  }
});

app.get('/api/candles', async (req, res) => {
  const symbol = String(req.query.symbol || 'TSLA').toUpperCase();
  const date = String(req.query.date || '');
  const interval = Number(req.query.interval || 5);
  const range = String(req.query.range || '1d');
  const cacheKey = `${symbol}|${date}|${interval}|${range}`;
  const cached = candleCache.get(cacheKey);

  const dateValid = /^\d{4}-\d{2}-\d{2}$/.test(date);
  if (!dateValid) {
    return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });
  }

  const intervalValid = Number.isFinite(interval);
  if (!intervalValid || interval < 5 || interval % 5 !== 0) {
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
