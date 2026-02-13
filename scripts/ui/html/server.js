const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
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
const INDEXER_SYNC_INTERVAL_MS = 5000;
// fmp caches
const FMP_API_KEY = process.env.FMP_API_KEY || 'TNQATNqowKe9Owu1zL9QurgZCXx9Q1BS';
const HARDHAT_RPC_URL = process.env.HARDHAT_RPC_URL || 'http://127.0.0.1:8545';
// link to hardhat

// connect to yahoo
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
// hard coded holidays
const TZ = 'America/New_York';

function pick(obj, keys) {
  // pick first existing key from keys in obj
  for (const k of keys) {
    return obj[k];
  }
  return undefined;
}

function asNumber(value) {
  return Number(value);
}
// getter for number fields with possible different keys

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
// connec to fmp

function getFmpUrl(pathname, params) {
  const url = new URL(`https://financialmodelingprep.com/stable/${pathname}`);
  const entries = Object.entries(params);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const key = entry[0];
    const value = entry[1];
    url.searchParams.set(key, value);
  }
  url.searchParams.set('apikey', FMP_API_KEY);
  return url.toString();
}
// connect to contracts
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
const erc20Interface = new ethers.Interface([
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
const registryListInterface = new ethers.Interface([
  'function getAllSymbols() view returns (string[])',
]);
const orderBookInterface = new ethers.Interface([
  'function placeLimitOrder(address equityToken, uint8 side, uint256 price, uint256 qty) returns (uint256)',
  'function cancelOrder(uint256 orderId)',
  'function getBuyOrders(address equityToken) view returns (tuple(uint256 id,address trader,uint8 side,uint256 price,uint256 qty,uint256 remaining,bool active)[])',
  'function getSellOrders(address equityToken) view returns (tuple(uint256 id,address trader,uint8 side,uint256 price,uint256 qty,uint256 remaining,bool active)[])',
  'event OrderPlaced(uint256 indexed id,address indexed trader,address indexed equityToken,uint8 side,uint256 price,uint256 qty)',
  'event OrderFilled(uint256 indexed makerId,uint256 indexed takerId,address indexed equityToken,uint256 price,uint256 qty)',
  'event OrderCancelled(uint256 indexed id,address indexed trader,uint256 remainingRefunded)',
]);

const INDEXER_DIR = path.join(__dirname, '../../..', 'cache', 'indexer');
const INDEXER_STATE_FILE = path.join(INDEXER_DIR, 'state.json');
const INDEXER_ORDERS_FILE = path.join(INDEXER_DIR, 'orders.json');
const INDEXER_FILLS_FILE = path.join(INDEXER_DIR, 'fills.json');
const INDEXER_CANCELLATIONS_FILE = path.join(INDEXER_DIR, 'cancellations.json');
const INDEXER_CASHFLOWS_FILE = path.join(INDEXER_DIR, 'cashflows.json');
const INDEXER_TRANSFERS_FILE = path.join(INDEXER_DIR, 'transfers.json');

let indexerSyncPromise = null;
const symbolByTokenCache = new Map();

async function ensureContract(address) {
  const code = await hardhatRpc('eth_getCode', [address, 'latest']);
  return code !== '0x';
}

// load deployment and get token addresses from local file
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
  // check valid address
}

// connect to hardhat and contracts
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

function ensureIndexerDir() {
  if (!fs.existsSync(INDEXER_DIR)) {
    fs.mkdirSync(INDEXER_DIR, { recursive: true });
  }
}

function readJsonFile(filePath, fallbackValue) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallbackValue;
  }
}

function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function normalizeAddress(address) {
  try {
    return ethers.getAddress(address);
  } catch {
    return '';
  }
}

function orderStatus(order) {
  if (!order.active && order.remainingWei === '0') {
    if (order.cancelledAtBlock !== null) {
      return 'CANCELLED';
    }
    return 'FILLED';
  }
  if (order.remainingWei !== order.qtyWei) {
    return 'PARTIAL';
  }
  return 'OPEN';
}

function addCashflow(cashflows, input) {
  cashflows.push({
    id: `${input.txHash}:${input.logIndex}:${input.wallet}:${input.reason}`,
    wallet: input.wallet,
    assetType: input.assetType,
    assetSymbol: input.assetSymbol,
    direction: input.direction,
    amountWei: input.amountWei,
    reason: input.reason,
    txHash: input.txHash,
    blockNumber: input.blockNumber,
    timestampMs: input.timestampMs,
  });
}

async function lookupSymbolByToken(registryAddr, tokenAddr) {
  const normalized = normalizeAddress(tokenAddr);
  if (symbolByTokenCache.has(normalized)) {
    return symbolByTokenCache.get(normalized);
  }
  try {
    const symbolData = listingsRegistryInterface.encodeFunctionData('getSymbolByToken', [normalized]);
    const symbolResult = await hardhatRpc('eth_call', [{ to: registryAddr, data: symbolData }, 'latest']);
    const [symbol] = listingsRegistryInterface.decodeFunctionResult('getSymbolByToken', symbolResult);
    symbolByTokenCache.set(normalized, symbol);
    return symbol;
  } catch {
    symbolByTokenCache.set(normalized, '');
    return '';
  }
}

async function fetchOrderBookEvents(orderBookAddr, fromBlock, toBlock) {
  const topics = [
    ethers.id('OrderPlaced(uint256,address,address,uint8,uint256,uint256)'),
    ethers.id('OrderFilled(uint256,uint256,address,uint256,uint256)'),
    ethers.id('OrderCancelled(uint256,address,uint256)'),
  ];
  const logs = await hardhatRpc('eth_getLogs', [{
    fromBlock,
    toBlock,
    address: orderBookAddr,
    topics: [topics],
  }]);
  logs.sort((a, b) => {
    const blockA = Number(a.blockNumber);
    const blockB = Number(b.blockNumber);
    if (blockA !== blockB) {
      return blockA - blockB;
    }
    return Number(a.logIndex) - Number(b.logIndex);
  });
  return logs;
}

async function getIndexedTokenAddresses(deployments, registryAddr) {
  const addresses = new Set();
  const ttoken = normalizeAddress(deployments.ttoken || deployments.ttokenAddress || deployments.TTOKEN_ADDRESS || '');
  if (ttoken) {
    addresses.add(ttoken);
    symbolByTokenCache.set(ttoken, 'TTOKEN');
  }

  const listData = registryListInterface.encodeFunctionData('getAllSymbols', []);
  const listResult = await hardhatRpc('eth_call', [{ to: registryAddr, data: listData }, 'latest']);
  const [symbols] = registryListInterface.decodeFunctionResult('getAllSymbols', listResult);
  for (const symbol of symbols) {
    const lookupData = listingsRegistryInterface.encodeFunctionData('getListing', [symbol]);
    const lookupResult = await hardhatRpc('eth_call', [{ to: registryAddr, data: lookupData }, 'latest']);
    const [tokenAddr] = listingsRegistryInterface.decodeFunctionResult('getListing', lookupResult);
    const normalized = normalizeAddress(tokenAddr);
    if (!normalized || normalized === ethers.ZeroAddress) {
      continue;
    }
    addresses.add(normalized);
    symbolByTokenCache.set(normalized, symbol);
  }
  return Array.from(addresses);
}

async function fetchTransferEvents(tokenAddresses, fromBlock, toBlock) {
  if (!tokenAddresses.length) {
    return [];
  }
  const transferTopic = ethers.id('Transfer(address,address,uint256)');
  const logs = [];
  for (const token of tokenAddresses) {
    const part = await hardhatRpc('eth_getLogs', [{
      fromBlock,
      toBlock,
      address: token,
      topics: [transferTopic],
    }]);
    logs.push(...part);
  }
  logs.sort((a, b) => {
    const blockA = Number(a.blockNumber);
    const blockB = Number(b.blockNumber);
    if (blockA !== blockB) {
      return blockA - blockB;
    }
    return Number(a.logIndex) - Number(b.logIndex);
  });
  return logs;
}

function buildIndexerChecksum(snapshot) {
  const payload = {
    state: {
      lastIndexedBlock: snapshot.state.lastIndexedBlock,
      latestKnownBlock: snapshot.state.latestKnownBlock,
    },
    orderCount: Object.keys(snapshot.orders).length,
    fillCount: snapshot.fills.length,
    cancellationCount: snapshot.cancellations.length,
    cashflowCount: snapshot.cashflows.length,
    transferCount: snapshot.transfers.length,
    lastOrderIds: Object.values(snapshot.orders)
      .map((order) => Number(order.id))
      .sort((a, b) => a - b)
      .slice(-20),
    lastTransferIds: snapshot.transfers
      .map((t) => t.id)
      .sort()
      .slice(-20),
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function resetIndexerFiles() {
  ensureIndexerDir();
  writeJsonFile(INDEXER_STATE_FILE, { lastIndexedBlock: -1, latestKnownBlock: -1, lastSyncAtMs: 0 });
  writeJsonFile(INDEXER_ORDERS_FILE, {});
  writeJsonFile(INDEXER_FILLS_FILE, []);
  writeJsonFile(INDEXER_CANCELLATIONS_FILE, []);
  writeJsonFile(INDEXER_CASHFLOWS_FILE, []);
  writeJsonFile(INDEXER_TRANSFERS_FILE, []);
}

async function syncIndexer() {
  ensureIndexerDir();
  const deployments = loadDeployments();
  const orderBookAddr = deployments.orderBookDex;
  const registryAddr = deployments.listingsRegistry;
  if (!orderBookAddr || !registryAddr) {
    return {
      synced: false,
      reason: 'missing deployments',
    };
  }

  const latestHex = await hardhatRpc('eth_blockNumber', []);
  const latestBlock = Number(latestHex);
  const state = readJsonFile(INDEXER_STATE_FILE, { lastIndexedBlock: -1, latestKnownBlock: -1, lastSyncAtMs: 0 });
  const orders = readJsonFile(INDEXER_ORDERS_FILE, {});
  const fills = readJsonFile(INDEXER_FILLS_FILE, []);
  const cancellations = readJsonFile(INDEXER_CANCELLATIONS_FILE, []);
  const cashflows = readJsonFile(INDEXER_CASHFLOWS_FILE, []);
  const transfers = readJsonFile(INDEXER_TRANSFERS_FILE, []);

  const startBlock = Math.max(0, Number(state.lastIndexedBlock) + 1);
  if (startBlock > latestBlock) {
    state.latestKnownBlock = latestBlock;
    state.lastSyncAtMs = Date.now();
    writeJsonFile(INDEXER_STATE_FILE, state);
    return {
      synced: true,
      startBlock,
      latestBlock,
      processedLogs: 0,
    };
  }

  const fromHex = ethers.toQuantity(startBlock);
  const toHex = ethers.toQuantity(latestBlock);
  const logs = await fetchOrderBookEvents(orderBookAddr, fromHex, toHex);
  const tokenAddresses = await getIndexedTokenAddresses(deployments, registryAddr);
  const transferLogs = await fetchTransferEvents(tokenAddresses, fromHex, toHex);

  const blocksNeeded = new Set();
  for (const log of logs) {
    blocksNeeded.add(log.blockNumber);
  }
  for (const log of transferLogs) {
    blocksNeeded.add(log.blockNumber);
  }

  const blockTimestampsMs = new Map();
  for (const blockHex of blocksNeeded) {
    const block = await hardhatRpc('eth_getBlockByNumber', [blockHex, false]);
    blockTimestampsMs.set(blockHex, Number(block.timestamp) * 1000);
  }

  const existingTransferIds = new Set(transfers.map((entry) => entry.id));
  for (const log of transferLogs) {
    const txHash = log.transactionHash;
    const blockNumber = Number(log.blockNumber);
    const logIndex = Number(log.logIndex);
    const id = `${txHash}:${logIndex}`;
    if (existingTransferIds.has(id)) {
      continue;
    }

    const parsed = erc20Interface.parseLog(log);
    const tokenAddress = normalizeAddress(log.address);
    let symbol = symbolByTokenCache.get(tokenAddress) || '';
    if (!symbol || symbol === '') {
      symbol = await lookupSymbolByToken(registryAddr, tokenAddress);
      if (!symbol && deployments.ttoken && normalizeAddress(deployments.ttoken) === tokenAddress) {
        symbol = 'TTOKEN';
      }
    }
    const timestampMs = blockTimestampsMs.get(log.blockNumber) || Date.now();
    const transfer = {
      id,
      tokenAddress,
      symbol,
      from: normalizeAddress(parsed.args.from),
      to: normalizeAddress(parsed.args.to),
      amountWei: parsed.args.value.toString(),
      txHash,
      blockNumber,
      logIndex,
      timestampMs,
    };
    transfers.push(transfer);
    existingTransferIds.add(id);
  }

  for (const log of logs) {
    const parsed = orderBookInterface.parseLog(log);
    const eventName = parsed.name;
    const txHash = log.transactionHash;
    const blockNumber = Number(log.blockNumber);
    const logIndex = Number(log.logIndex);
    const timestampMs = blockTimestampsMs.get(log.blockNumber) || Date.now();

    if (eventName === 'OrderPlaced') {
      const id = Number(parsed.args.id);
      const equityToken = normalizeAddress(parsed.args.equityToken);
      const symbol = await lookupSymbolByToken(registryAddr, equityToken);
      const side = Number(parsed.args.side) === 1 ? 'SELL' : 'BUY';
      const qtyWei = parsed.args.qty.toString();
      orders[String(id)] = {
        id,
        trader: normalizeAddress(parsed.args.trader),
        side,
        symbol,
        equityToken,
        priceCents: Number(parsed.args.price),
        qtyWei,
        remainingWei: qtyWei,
        active: true,
        status: 'OPEN',
        placedTxHash: txHash,
        placedBlock: blockNumber,
        placedAtMs: timestampMs,
        updatedAtMs: timestampMs,
        cancelledAtBlock: null,
      };
      continue;
    }

    if (eventName === 'OrderFilled') {
      const makerId = Number(parsed.args.makerId);
      const takerId = Number(parsed.args.takerId);
      const priceCents = Number(parsed.args.price);
      const qtyWei = parsed.args.qty.toString();
      const equityToken = normalizeAddress(parsed.args.equityToken);
      const symbol = await lookupSymbolByToken(registryAddr, equityToken);
      const makerOrder = orders[String(makerId)];
      const takerOrder = takerId > 0 ? orders[String(takerId)] : null;

      if (makerOrder) {
        const nextRemaining = BigInt(makerOrder.remainingWei) - BigInt(qtyWei);
        makerOrder.remainingWei = nextRemaining > 0n ? nextRemaining.toString() : '0';
        makerOrder.active = nextRemaining > 0n;
        makerOrder.status = orderStatus(makerOrder);
        makerOrder.updatedAtMs = timestampMs;
      }
      if (takerOrder) {
        const nextRemaining = BigInt(takerOrder.remainingWei) - BigInt(qtyWei);
        takerOrder.remainingWei = nextRemaining > 0n ? nextRemaining.toString() : '0';
        takerOrder.active = nextRemaining > 0n;
        takerOrder.status = orderStatus(takerOrder);
        takerOrder.updatedAtMs = timestampMs;
      }

      fills.push({
        id: `${txHash}:${logIndex}`,
        makerId,
        takerId,
        makerTrader: makerOrder ? makerOrder.trader : '',
        takerTrader: takerOrder ? takerOrder.trader : '',
        symbol,
        equityToken,
        priceCents,
        qtyWei,
        blockNumber,
        txHash,
        logIndex,
        timestampMs,
      });

      const quoteWei = ((BigInt(qtyWei) * BigInt(priceCents)) / 100n).toString();
      let buyerWallet = '';
      let sellerWallet = '';
      if (makerOrder && makerOrder.side === 'BUY') buyerWallet = makerOrder.trader;
      if (makerOrder && makerOrder.side === 'SELL') sellerWallet = makerOrder.trader;
      if (takerOrder && takerOrder.side === 'BUY') buyerWallet = takerOrder.trader;
      if (takerOrder && takerOrder.side === 'SELL') sellerWallet = takerOrder.trader;

      if (buyerWallet) {
        addCashflow(cashflows, {
          wallet: buyerWallet,
          assetType: 'TTOKEN',
          assetSymbol: 'TTOKEN',
          direction: 'OUT',
          amountWei: quoteWei,
          reason: 'TRADE_BUY',
          txHash,
          logIndex,
          blockNumber,
          timestampMs,
        });
      }
      if (sellerWallet) {
        addCashflow(cashflows, {
          wallet: sellerWallet,
          assetType: 'TTOKEN',
          assetSymbol: 'TTOKEN',
          direction: 'IN',
          amountWei: quoteWei,
          reason: 'TRADE_SELL',
          txHash,
          logIndex,
          blockNumber,
          timestampMs,
        });
      }
      continue;
    }

    if (eventName === 'OrderCancelled') {
      const id = Number(parsed.args.id);
      const refundWei = parsed.args.remainingRefunded.toString();
      const order = orders[String(id)];
      if (order) {
        order.active = false;
        order.remainingWei = '0';
        order.cancelledAtBlock = blockNumber;
        order.status = 'CANCELLED';
        order.updatedAtMs = timestampMs;
      }
      const trader = normalizeAddress(parsed.args.trader);
      cancellations.push({
        id: `${txHash}:${id}`,
        orderId: id,
        trader,
        refundWei,
        blockNumber,
        txHash,
        logIndex,
        timestampMs,
      });
      if (order && order.side === 'BUY') {
        addCashflow(cashflows, {
          wallet: trader,
          assetType: 'TTOKEN',
          assetSymbol: 'TTOKEN',
          direction: 'IN',
          amountWei: refundWei,
          reason: 'ORDER_CANCEL_REFUND',
          txHash,
          logIndex,
          blockNumber,
          timestampMs,
        });
      }
    }
  }

  state.lastIndexedBlock = latestBlock;
  state.latestKnownBlock = latestBlock;
  state.lastSyncAtMs = Date.now();

  writeJsonFile(INDEXER_STATE_FILE, state);
  writeJsonFile(INDEXER_ORDERS_FILE, orders);
  writeJsonFile(INDEXER_FILLS_FILE, fills);
  writeJsonFile(INDEXER_CANCELLATIONS_FILE, cancellations);
  writeJsonFile(INDEXER_CASHFLOWS_FILE, cashflows);
  writeJsonFile(INDEXER_TRANSFERS_FILE, transfers);

  return {
    synced: true,
    startBlock,
    latestBlock,
    processedLogs: logs.length,
    processedTransfers: transferLogs.length,
  };
}

async function ensureIndexerSynced() {
  if (indexerSyncPromise) {
    return indexerSyncPromise;
  }
  indexerSyncPromise = syncIndexer()
    .catch((error) => ({ synced: false, error: error.message || '' }))
    .finally(() => {
      indexerSyncPromise = null;
    });
  return indexerSyncPromise;
}

function readIndexerSnapshot() {
  ensureIndexerDir();
  return {
    state: readJsonFile(INDEXER_STATE_FILE, { lastIndexedBlock: -1, latestKnownBlock: -1, lastSyncAtMs: 0 }),
    orders: readJsonFile(INDEXER_ORDERS_FILE, {}),
    fills: readJsonFile(INDEXER_FILLS_FILE, []),
    cancellations: readJsonFile(INDEXER_CANCELLATIONS_FILE, []),
    cashflows: readJsonFile(INDEXER_CASHFLOWS_FILE, []),
    transfers: readJsonFile(INDEXER_TRANSFERS_FILE, []),
  };
}
// check trading day for candle
function isTradingDay(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const weekend = weekday === 0 || weekday === 6;
  if (weekend) {
    return false;
  }
  if (HOLIDAYS_ET.has(ymd)) {
    return false;
  }
  return true;
}

// get current date
function getETDateString() {
  const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
  const y = etNow.getFullYear();
  const m = String(etNow.getMonth() + 1).padStart(2, '0');
  const d = String(etNow.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// compute previosu trading day just in case for fallback
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
// trading days in a range for fallback
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
app.get('/api/stock/:symbol', async (req, res) => {
  const symbol = req.params.symbol || 'AAPL';
  // try to fetch stock data
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
      res.status(500).json({ error: '' });
    }
  }
});

app.get('/api/quote', async (req, res) => {
  const symbol = String(req.query.symbol || 'TSLA').toUpperCase();
  const cached = quoteCache.get(symbol);
  // default tsla

  try {
    // try to fetch quote with fallbacks
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
      
    }

    const msg = err.message || '';
    res.status(502).json({ error: msg });
  }
});
// quote short with fmp's stock price
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
        
      }

      if (cached) {
        return res.json({ ...cached.data, stale: true });
      }
      const msg = err.message || '';
      res.status(502).json({ error: msg });
    }
  }
});

// get stock info with fmp
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

    // maps fields for info from fmp
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
      // try to fetch from yahoo for info but failed
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
        
      }

      if (cached) {
        return res.json({ ...cached.data, stale: true });
      }
      const msg = err.message || '';
      res.status(502).json({ error: msg });
    }
  }
});
// rest api to get hardhat accounts
app.get('/api/hardhat/accounts', async (_req, res) => {
  try {
    const accounts = await hardhatRpc('eth_accounts');
    res.json({ accounts });
  } catch (err) {
    res.status(502).json({ error: err.message || '' });
  }
});
// rest api to get token address
app.get('/api/ttoken-address', (_req, res) => {
  const envAddress = process.env.TTOKEN_ADDRESS;
  if (envAddress) {
    res.json({ address: envAddress });
    return;
  }

  const address = getTTokenAddressFromDeployments();
  res.json({ address });
});

// rest api to get balances with fallback if none fetched
app.get('/api/ttoken/balance', async (req, res) => {
  const address = String(req.query.address || '');
  try {
    const ttokenAddress = process.env.TTOKEN_ADDRESS || getTTokenAddressFromDeployments();
    const data = equityTokenInterface.encodeFunctionData('balanceOf', [address]);
    const result = await hardhatRpc('eth_call', [{ to: ttokenAddress, data }, 'latest']);
    const [balanceWei] = equityTokenInterface.decodeFunctionResult('balanceOf', result);
    res.json({ address, ttokenAddress, balanceWei: balanceWei.toString() });
  } catch (err) {
    res.status(502).json({ error: err.message || '' });
  }
});

// mint api with validation and fallback
app.post('/api/ttoken/mint', async (req, res) => {
  const body = req.body || {};
  const to = String(body.to || '');
  const amount = Number(body.amount || 0);
  const recipientValid = isValidAddress(to);
  if (!recipientValid) {
    return res.status(400).json({ error: '' });
  }
  const amountIsNumber = Number.isFinite(amount);
  if (!amountIsNumber || amount < 1000) {
    return res.status(400).json({ error: '' });
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
    res.status(502).json({ error: err.message || '' });
  }
});

// api for orderbook and matching engine
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
    // decimal of 18 for tokens

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
    res.status(500).json({ error: err.message || '' });
  }
});
// get orders that's no filled
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

    orders.sort((a, b) => {
      return a.id - b.id;
    });
    res.json({ orders: orders });
  } catch (err) {
    res.status(500).json({ error: err.message || '' });
  }
});

// rest api to get all the filled orders
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
    res.status(500).json({ error: err.message || '' });
  }
});

app.get('/api/indexer/status', async (_req, res) => {
  try {
    const sync = await ensureIndexerSynced();
    const snapshot = readIndexerSnapshot();
    const checksum = buildIndexerChecksum(snapshot);
    res.json({
      sync,
      state: snapshot.state,
      checksum,
      totals: {
        orders: Object.keys(snapshot.orders).length,
        fills: snapshot.fills.length,
        cancellations: snapshot.cancellations.length,
        cashflows: snapshot.cashflows.length,
        transfers: snapshot.transfers.length,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message || '' });
  }
});

app.post('/api/indexer/rebuild', async (_req, res) => {
  try {
    resetIndexerFiles();
    const sync = await ensureIndexerSynced();
    const snapshot = readIndexerSnapshot();
    const checksum = buildIndexerChecksum(snapshot);
    res.json({
      rebuild: true,
      sync,
      state: snapshot.state,
      checksum,
      totals: {
        orders: Object.keys(snapshot.orders).length,
        fills: snapshot.fills.length,
        cancellations: snapshot.cancellations.length,
        cashflows: snapshot.cashflows.length,
        transfers: snapshot.transfers.length,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message || '' });
  }
});

app.get('/api/orders/open', async (req, res) => {
  const wallet = normalizeAddress(String(req.query.wallet || ''));
  if (!wallet) {
    return res.status(400).json({ error: 'wallet is required' });
  }
  try {
    await ensureIndexerSynced();
    const { orders } = readIndexerSnapshot();
    const items = Object.values(orders)
      .filter((order) => order.trader === wallet && (order.status === 'OPEN' || order.status === 'PARTIAL'))
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
      .map((order) => ({
        ...order,
        cancellable: true,
      }));
    res.json({ wallet, orders: items });
  } catch (err) {
    res.status(500).json({ error: err.message || '' });
  }
});

app.get('/api/orders/:orderId', async (req, res) => {
  const wallet = normalizeAddress(String(req.query.wallet || ''));
  const orderId = Number(req.params.orderId);
  if (!wallet) {
    return res.status(400).json({ error: 'wallet is required' });
  }
  if (!Number.isFinite(orderId) || orderId <= 0) {
    return res.status(400).json({ error: 'invalid order id' });
  }

  try {
    await ensureIndexerSynced();
    const { orders } = readIndexerSnapshot();
    const order = orders[String(orderId)];
    if (!order || order.trader !== wallet) {
      return res.status(404).json({ error: 'order not found' });
    }
    res.json({ order });
  } catch (err) {
    res.status(500).json({ error: err.message || '' });
  }
});

app.post('/api/orders/cancel', async (req, res) => {
  const body = req.body || {};
  const wallet = normalizeAddress(String(body.wallet || ''));
  const orderId = Number(body.orderId);
  if (!wallet) {
    return res.status(400).json({ error: 'wallet is required' });
  }
  if (!Number.isFinite(orderId) || orderId <= 0) {
    return res.status(400).json({ error: 'invalid order id' });
  }

  try {
    await ensureIndexerSynced();
    const { orders } = readIndexerSnapshot();
    const order = orders[String(orderId)];
    if (!order) {
      return res.status(404).json({ error: 'order not found' });
    }
    if (order.trader !== wallet) {
      return res.status(403).json({ error: 'cannot cancel another wallet order' });
    }
    if (!(order.status === 'OPEN' || order.status === 'PARTIAL')) {
      return res.status(400).json({ error: 'order is not cancellable' });
    }

    const deployments = loadDeployments();
    const orderBookAddr = deployments.orderBookDex;
    const data = orderBookInterface.encodeFunctionData('cancelOrder', [BigInt(orderId)]);
    const txHash = await hardhatRpc('eth_sendTransaction', [{
      from: wallet,
      to: orderBookAddr,
      data,
    }]);

    await ensureIndexerSynced();
    const { orders: nextOrders } = readIndexerSnapshot();
    res.json({ txHash, order: nextOrders[String(orderId)] || null });
  } catch (err) {
    res.status(500).json({ error: err.message || '' });
  }
});

app.get('/api/txs', async (req, res) => {
  const wallet = normalizeAddress(String(req.query.wallet || ''));
  const type = String(req.query.type || 'ALL').toUpperCase();
  const parsedCursor = Number(req.query.cursor || 0);
  const cursor = Number.isFinite(parsedCursor) && parsedCursor >= 0 ? parsedCursor : 0;
  const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));

  if (!wallet) {
    return res.status(400).json({ error: 'wallet is required' });
  }

  try {
    await ensureIndexerSynced();
    const snapshot = readIndexerSnapshot();
    const { orders, fills, cancellations, cashflows, transfers } = snapshot;
    const items = [];

    if (type === 'ALL' || type === 'ORDERS') {
      for (const order of Object.values(orders)) {
        if (order.trader !== wallet) continue;
        items.push({
          kind: 'ORDER_PLACED',
          wallet,
          symbol: order.symbol,
          side: order.side,
          orderId: order.id,
          priceCents: order.priceCents,
          qtyWei: order.qtyWei,
          remainingWei: order.remainingWei,
          status: order.status,
          txHash: order.placedTxHash,
          blockNumber: order.placedBlock,
          timestampMs: order.placedAtMs,
        });
      }
      for (const cancel of cancellations) {
        if (cancel.trader !== wallet) continue;
        const order = orders[String(cancel.orderId)];
        items.push({
          kind: 'ORDER_CANCELLED',
          wallet,
          symbol: order ? order.symbol : '',
          side: order ? order.side : '',
          orderId: cancel.orderId,
          refundWei: cancel.refundWei,
          txHash: cancel.txHash,
          blockNumber: cancel.blockNumber,
          timestampMs: cancel.timestampMs,
        });
      }
    }

    if (type === 'ALL' || type === 'FILLS') {
      for (const fill of fills) {
        let side = '';
        if (fill.makerTrader === wallet) {
          const makerOrder = orders[String(fill.makerId)];
          side = makerOrder ? makerOrder.side : '';
        } else if (fill.takerTrader === wallet) {
          const takerOrder = orders[String(fill.takerId)];
          side = takerOrder ? takerOrder.side : '';
        } else {
          continue;
        }
        items.push({
          kind: 'ORDER_FILLED',
          wallet,
          symbol: fill.symbol,
          side,
          makerId: fill.makerId,
          takerId: fill.takerId,
          priceCents: fill.priceCents,
          qtyWei: fill.qtyWei,
          txHash: fill.txHash,
          blockNumber: fill.blockNumber,
          timestampMs: fill.timestampMs,
        });
      }
    }

    if (type === 'ALL' || type === 'CASHFLOW') {
      for (const cashflow of cashflows) {
        if (cashflow.wallet !== wallet) continue;
        items.push({
          kind: 'CASHFLOW',
          wallet,
          assetType: cashflow.assetType,
          assetSymbol: cashflow.assetSymbol,
          direction: cashflow.direction,
          amountWei: cashflow.amountWei,
          reason: cashflow.reason,
          txHash: cashflow.txHash,
          blockNumber: cashflow.blockNumber,
          timestampMs: cashflow.timestampMs,
        });
      }
    }

    if (type === 'ALL' || type === 'TRANSFERS') {
      for (const transfer of transfers) {
        if (transfer.from !== wallet && transfer.to !== wallet) continue;
        const direction = transfer.to === wallet ? 'IN' : 'OUT';
        items.push({
          kind: 'TRANSFER',
          wallet,
          symbol: transfer.symbol || '',
          tokenAddress: transfer.tokenAddress,
          direction,
          from: transfer.from,
          to: transfer.to,
          amountWei: transfer.amountWei,
          txHash: transfer.txHash,
          blockNumber: transfer.blockNumber,
          timestampMs: transfer.timestampMs,
        });
      }
    }

    items.sort((a, b) => b.timestampMs - a.timestampMs || b.blockNumber - a.blockNumber);
    const offset = Math.max(0, cursor);
    const paged = items.slice(offset, offset + limit);
    const nextCursor = offset + paged.length < items.length ? offset + paged.length : null;

    res.json({
      wallet,
      type,
      items: paged,
      nextCursor,
      total: items.length,
      indexerState: snapshot.state,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || '' });
  }
});
// create equity token
app.post('/api/equity/create', async (req, res) => {
  const body = req.body || {};
  const symbol = String(body.symbol || '').toUpperCase();
  const name = String(body.name || '').trim();
  if (symbol.length === 0 || name.length === 0) {
    return res.status(400).json({ error: '' });
  }

  try {
    const deployments = loadDeployments();
    const factoryAddr = deployments.equityTokenFactory;
    const admin = deployments.admin;
    const factoryDeployed = await ensureContract(factoryAddr);
    if (!factoryDeployed) {
      return res.status(500).json({ error: '' });
    }

    const data = equityFactoryInterface.encodeFunctionData('createEquityToken', [symbol, name]);
    const txHash = await hardhatRpc('eth_sendTransaction', [{
      from: admin,
      to: factoryAddr,
      data,
    }]);
    res.json({ txHash });
  } catch (err) {
    res.status(502).json({ error: err.message || '' });
  }
});
// mint equity token
app.post('/api/equity/mint', async (req, res) => {
  const body = req.body || {};
  const symbol = String(body.symbol || '').toUpperCase();
  const to = String(body.to || '');
  const amount = Number(body.amount || 0);
  if (symbol.length === 0) {
    return res.status(400).json({ error: '' });
  }
  const recipientValid = isValidAddress(to);
  if (!recipientValid) {
    return res.status(400).json({ error: '' });
  }
  const amountIsNumber = Number.isFinite(amount);
  if (!amountIsNumber || amount < 1000) {
    return res.status(400).json({ error: '' });
  }

  try {
    const deployments = loadDeployments();
    const registryAddr = deployments.listingsRegistry;
    const minter = deployments.defaultMinter || deployments.admin;
    const registryDeployed = await ensureContract(registryAddr);
    if (!registryDeployed) {
      return res.status(500).json({ error: '' });
    }

    const data = listingsRegistryInterface.encodeFunctionData('getListing', [symbol]);
    const result = await hardhatRpc('eth_call', [{ to: registryAddr, data }, 'latest']);
    const [tokenAddr] = listingsRegistryInterface.decodeFunctionResult('getListing', result);
    if (tokenAddr === ethers.ZeroAddress) {
      return res.status(404).json({ error: `` });
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
    res.status(502).json({ error: err.message || '' });
  }
});
// create and mint for equity tokens that was not deployed
app.post('/api/equity/create-mint', async (req, res) => {
  const body = req.body || {};
  const symbol = String(body.symbol || '').toUpperCase();
  const name = String(body.name || '').trim();
  const to = String(body.to || '');
  const amount = Number(body.amount || 0);
  if (symbol.length === 0 || name.length === 0) {
    return res.status(400).json({ error: '' });
  }
  const recipientValid = isValidAddress(to);
  if (!recipientValid) {
    return res.status(400).json({ error: '' });
  }
  const amountIsNumber = Number.isFinite(amount);
  if (!amountIsNumber || amount < 1000) {
    return res.status(400).json({ error: '' });
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
      return res.status(500).json({ error: '' });
    }

    const lookupData = listingsRegistryInterface.encodeFunctionData('getListing', [symbol]);
    let lookupResult = await hardhatRpc('eth_call', [{ to: registryAddr, data: lookupData }, 'latest']);
    let [tokenAddr] = listingsRegistryInterface.decodeFunctionResult('getListing', lookupResult);

    let createTx;
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
      return res.status(404).json({ error: `` });
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
    res.status(502).json({ error: err.message || '' });
  }
});

// rest api to get all the listings and addresses
app.get('/api/registry/listings', async (_req, res) => {
  try {
    const deployments = loadDeployments();
    const registryAddr = deployments.listingsRegistry;
    const registryDeployed = await ensureContract(registryAddr);
    if (!registryDeployed) {
      return res.status(500).json({ error: '' });
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
    res.status(502).json({ error: err.message || '' });
  }
});

// check the balance of all equity tokens
app.get('/api/equity/balances', async (req, res) => {
  const address = String(req.query.address || '');
  try {
    const deployments = loadDeployments();
    const registryAddr = deployments.listingsRegistry;
    const registryDeployed = await ensureContract(registryAddr);
    if (!registryDeployed) {
      return res.status(500).json({ error: '' });
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
    res.status(502).json({ error: err.message || '' });
  }
});

// get equity token address by symbol
app.get('/api/equity/address', async (req, res) => {
  const symbol = String(req.query.symbol || '').toUpperCase();
  if (symbol.length === 0) {
    return res.status(400).json({ error: '' });
  }
  try {
    const deployments = loadDeployments();
    const registryAddr = deployments.listingsRegistry;
    const registryDeployed = await ensureContract(registryAddr);
    if (!registryDeployed) {
      return res.status(500).json({ error: '' });
    }
    const data = listingsRegistryInterface.encodeFunctionData('getListing', [symbol]);
    const result = await hardhatRpc('eth_call', [{ to: registryAddr, data }, 'latest']);
    const [tokenAddr] = listingsRegistryInterface.decodeFunctionResult('getListing', result);
    if (tokenAddr === ethers.ZeroAddress) {
      return res.status(404).json({ error: `Symbol ${symbol} not listed` });
    }
    res.json({ tokenAddress: tokenAddr });
  } catch (err) {
    res.status(502).json({ error: err.message || '' });
  }
});

// get candle info
app.get('/api/candles', async (req, res) => {
  const symbol = String(req.query.symbol || 'TSLA').toUpperCase();
  const date = String(req.query.date || '');
  const interval = Number(req.query.interval || 5);
  const range = String(req.query.range || '1d');
  const cacheKey = `${symbol}|${date}|${interval}|${range}`;
  const cached = candleCache.get(cacheKey);

  const dateValid = /^\d{4}-\d{2}-\d{2}$/.test(date);
  if (!dateValid) {
    return res.status(400).json({ error: '' });
  }

  const intervalValid = Number.isFinite(interval);
  if (!intervalValid || interval < 5 || interval % 5 !== 0) {
    return res.status(400).json({
      error: '',
    });
  }

  try {
    if (cached && (Date.now() - cached.timestamp) < CANDLE_TTL_MS) {
      return res.json(cached.data);
    }

    const endDate = date;
    let dates = [endDate];

    if (range === '5d') {
      const [y, m, d] = endDate.split('-').map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d));
      const days = [];

      while (days.length < 5) {
        const cur = dt.toISOString().slice(0, 10);
        if (isTradingDay(cur)) {
          days.push(cur);
        }
        dt.setUTCDate(dt.getUTCDate() - 1);
      }

      dates = days.reverse();
    }

    if (range === '1m') {
      const [y, m, d] = endDate.split('-').map(Number);
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
      dates = days;
    }

    if (range === '3m') {
      dates = tradingDaysInLastNDays(endDate, 90);
    }
    if (range === '6m') {
      dates = tradingDaysInLastNDays(endDate, 180);
    }

    const baseCandles = [];

    for (const day of dates) {
      const dayCandles = await fetchIntradayCandles(symbol, '5m', day);
      baseCandles.push(...dayCandles);
    }

    if (baseCandles.length === 0) {
      return res.status(404).json({
        error: 'No candles',
      });
    }

    const aggregated = aggregateCandles(baseCandles, interval);
    const candles = [];
    for (let i = 0; i < aggregated.length; i++) {
      const c = aggregated[i];
      candles.push({
        timeSec: c.timeSec,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        timeET: c.timeET,
      });
    }

    const payload = { symbol, date: endDate, interval, range, dates, candles };
    candleCache.set(cacheKey, { data: payload, timestamp: Date.now() });
    res.json(payload);
  } catch (err) {
    const msg = err.message || '';
    const status = /future|No chart data|No quote data/i.test(msg) ? 400 : 502;
    if (cached) {
      return res.json({ ...cached.data, stale: true });
    }
    res.status(status).json({ error: msg });
  }
});

ensureIndexerDir();
ensureIndexerSynced();
setInterval(() => {
  ensureIndexerSynced();
}, INDEXER_SYNC_INTERVAL_MS);

app.use((_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const DEFAULT_PORT = 3000;

let PORT = DEFAULT_PORT;
if (process.env.STAGE0_PORT) {
  PORT = Number(process.env.STAGE0_PORT);
}

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
