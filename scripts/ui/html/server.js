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
const ttokenRoleInterface = new ethers.Interface([
  'function MINTER_ROLE() view returns (bytes32)',
  'function hasRole(bytes32 role, address account) view returns (bool)',
  'function grantRole(bytes32 role, address account)',
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
const equityTokenSnapshotInterface = new ethers.Interface([
  'function snapshot() returns (uint256)',
  'function balanceOfAt(address account, uint256 snapshotId) view returns (uint256)',
  'event Snapshot(uint256 id)',
]);
const equityTokenRoleInterface = new ethers.Interface([
  'function SNAPSHOT_ROLE() view returns (bytes32)',
  'function hasRole(bytes32 role, address account) view returns (bool)',
  'function grantRole(bytes32 role, address account)',
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
const dividendsInterface = new ethers.Interface([
  'function epochCount(address equityToken) view returns (uint256)',
  'function epochs(address equityToken, uint256 epochId) view returns (uint256 snapshotId,uint256 divPerShareWei,uint256 declaredAt,uint256 totalClaimedWei,uint256 totalSupplyAtSnapshot)',
  'function previewClaim(address equityToken, uint256 epochId, address account) view returns (uint256)',
  'function isClaimed(address equityToken, uint256 epochId, address account) view returns (bool)',
  'function declareDividendPerShare(address equityToken, uint256 divPerShareWei) returns (uint256 epochId, uint256 snapshotId)',
  'function claimDividend(address equityToken, uint256 epochId) returns (uint256 mintedWei)',
]);
const dividendsMerkleInterface = new ethers.Interface([
  'function merkleEpochCount() view returns (uint256)',
  'function getEpoch(uint256 epochId) view returns ((address equityToken,bytes32 merkleRoot,uint256 declaredAt,uint256 totalEntitledWei,uint256 totalClaimedWei,bytes32 contentHash,string claimsUri))',
  'function isClaimed(uint256 epochId, uint256 leafIndex) view returns (bool)',
  'function previewLeaf(uint256 epochId, address account, uint256 amountWei, uint256 leafIndex, bytes32[] proof) view returns (bool,bool)',
  'function declareMerkleDividend(address equityToken, bytes32 merkleRoot, uint256 totalEntitledWei, bytes32 contentHash, string claimsUri) returns (uint256)',
  'function claim(uint256 epochId, address account, uint256 amountWei, uint256 leafIndex, bytes32[] proof) returns (uint256)',
]);
const awardInterface = new ethers.Interface([
  'function currentEpoch() view returns (uint256)',
  'function EPOCH_DURATION() view returns (uint256)',
  'function REWARD_AMOUNT() view returns (uint256)',
  'function maxQtyByEpoch(uint256 epochId) view returns (uint256)',
  'function qtyByEpochByTrader(uint256 epochId, address trader) view returns (uint256)',
  'function getEpochTraderCount(uint256 epochId) view returns (uint256)',
  'function getEpochTraderAt(uint256 epochId, uint256 index) view returns (address)',
  'function isWinner(uint256 epochId, address trader) view returns (bool)',
  'function hasClaimed(uint256 epochId, address trader) view returns (bool)',
  'function claimAward(uint256 epochId)',
]);
const aggregatorInterface = new ethers.Interface([
  'function getPortfolioSummary(address user) view returns (uint256 cashValueWei,uint256 stockValueWei,uint256 totalValueWei)',
  'function getHoldings(address user) view returns (tuple(address token,string symbol,uint256 balanceWei,uint256 priceCents,uint256 valueWei)[])',
]);
const priceFeedInterface = new ethers.Interface([
  'function getPrice(string symbol) view returns (uint256 priceCents, uint256 timestamp)',
]);
const priceFeedAdminInterface = new ethers.Interface([
  'function setPrice(string symbol, uint256 priceCents)',
]);
const leveragedFactoryInterface = new ethers.Interface([
  'function createLongProduct(string baseSymbol, uint8 leverage) returns (address)',
  'function getProductBySymbol(string productSymbol) view returns (address)',
  'function productCount() view returns (uint256)',
  'function getProductAt(uint256 index) view returns (tuple(string productSymbol,string baseSymbol,address baseToken,uint8 leverage,bool isLong,address token))',
]);
const leveragedRouterInterface = new ethers.Interface([
  'function mintLong(address productToken, uint256 ttokenInWei, uint256 minProductOutWei) returns (uint256,uint256)',
  'function unwindLong(address productToken, uint256 productQtyWei, uint256 minTTokenOutWei) returns (uint256,uint256)',
  'function previewMint(address productToken, uint256 ttokenInWei) view returns (uint256,uint256)',
  'function previewUnwind(address account, address productToken, uint256 productQtyWei) view returns (uint256,uint256)',
  'function positions(address account, address productToken) view returns (uint256 qtyWei, uint256 avgEntryPriceCents)',
  'event LeveragedMinted(address indexed user,address indexed productToken,string baseSymbol,uint8 leverage,uint256 ttokenInWei,uint256 productOutWei,uint256 navCents)',
  'event LeveragedUnwound(address indexed user,address indexed productToken,string baseSymbol,uint8 leverage,uint256 productInWei,uint256 ttokenOutWei,uint256 navCents)',
]);

const INDEXER_DIR = path.join(__dirname, '../../..', 'cache', 'indexer');
const INDEXER_STATE_FILE = path.join(INDEXER_DIR, 'state.json');
const INDEXER_ORDERS_FILE = path.join(INDEXER_DIR, 'orders.json');
const INDEXER_FILLS_FILE = path.join(INDEXER_DIR, 'fills.json');
const INDEXER_CANCELLATIONS_FILE = path.join(INDEXER_DIR, 'cancellations.json');
const INDEXER_CASHFLOWS_FILE = path.join(INDEXER_DIR, 'cashflows.json');
const INDEXER_TRANSFERS_FILE = path.join(INDEXER_DIR, 'transfers.json');
const INDEXER_LEVERAGED_FILE = path.join(INDEXER_DIR, 'leveraged.json');
const AUTOTRADE_DIR = path.join(__dirname, '../../..', 'cache', 'autotrade');
const AUTOTRADE_STATE_FILE = path.join(AUTOTRADE_DIR, 'state.json');
const SYMBOL_STATUS_FILE = path.join(AUTOTRADE_DIR, 'symbolStatus.json');
const ADMIN_DIR = path.join(__dirname, '../../..', 'cache', 'admin');
const AWARD_SESSION_FILE = path.join(ADMIN_DIR, 'awardSession.json');
const DIVIDENDS_MERKLE_DIR = path.join(__dirname, '../../..', 'cache', 'dividends-merkle');
const AUTOTRADE_POLL_INTERVAL_MS = 3000;

let indexerSyncPromise = null;
const symbolByTokenCache = new Map();
let autoTradeLoopBusy = false;

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

function parseRpcInt(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'string') {
    if (value.startsWith('0x') || value.startsWith('0X')) {
      const parsed = parseInt(value, 16);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
      return 0;
    }
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
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

async function waitForReceipt(txHash, maxTries = 20) {
  for (let i = 0; i < maxTries; i += 1) {
    const receipt = await hardhatRpc('eth_getTransactionReceipt', [txHash]);
    if (receipt) {
      return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`tx not mined yet: ${txHash}`);
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

function parseLeveragedProductSymbol(productSymbol) {
  const upper = String(productSymbol).toUpperCase();
  const match = upper.match(/^([A-Z0-9]+)([35])L$/);
  let baseSymbol = '';
  let leverage = 0;
  if (match) {
    baseSymbol = match[1];
    leverage = Number(match[2]);
  }
  return {
    productSymbol: upper,
    baseSymbol,
    leverage,
  };
}

async function ensureOnchainPriceForSymbol(symbolRaw) {
  const symbol = String(symbolRaw).toUpperCase();
  if (!symbol) {
    return { ok: false, error: 'invalid symbol' };
  }
  const deployments = loadDeployments();
  const priceFeedAddress = deployments.priceFeed;
  if (!priceFeedAddress) {
    return { ok: false, error: 'pricefeed not deployed' };
  }

  let fetchedPrice = 0;
  try {
    const quote = await fetchQuote(symbol);
    if (quote.regularMarketPrice) {
      fetchedPrice = Number(quote.regularMarketPrice);
    }
  } catch {
  }
  if (!(fetchedPrice > 0)) {
    const cached = quoteCache.get(symbol);
    if (cached && cached.data && cached.data.regularMarketPrice) {
      const cachedPrice = Number(cached.data.regularMarketPrice);
      if (cachedPrice > 0) {
        fetchedPrice = cachedPrice;
      }
    }
  }
  if (!(fetchedPrice > 0)) {
    try {
      const todayEt = getETDateString();
      let dateEt = todayEt;
      const marketOpen = isTradingDay(todayEt);
      if (!marketOpen) {
        dateEt = previousTradingDay(todayEt);
      }
      const candles = await fetchIntradayCandles(symbol, '5m', dateEt);
      if (candles.length > 0) {
        const last = candles[candles.length - 1];
        if (last && last.close) {
          const candlePrice = Number(last.close);
          if (candlePrice > 0) {
            fetchedPrice = candlePrice;
          }
        }
      }
    } catch {
    }
  }
  if (fetchedPrice > 0) {
    const livePriceCents = Math.round(fetchedPrice * 100);
    const setResult = await setOnchainPriceForSymbol(symbol, livePriceCents);
    if (!setResult.ok) {
      return setResult;
    }
    return { ok: true, priceCents: livePriceCents };
  }

  try {
    const readData = priceFeedInterface.encodeFunctionData('getPrice', [symbol]);
    const readResult = await hardhatRpc('eth_call', [{ to: priceFeedAddress, data: readData }, 'latest']);
    const [priceCentsRaw] = priceFeedInterface.decodeFunctionResult('getPrice', readResult);
    const existingPrice = Number(priceCentsRaw);
    if (existingPrice > 0) {
      return { ok: true, priceCents: existingPrice };
    }
  } catch {
  }

  return { ok: false, error: `price unavailable for ${symbol}` };
}

async function setOnchainPriceForSymbol(symbolRaw, priceCentsRaw) {
  const symbol = String(symbolRaw).toUpperCase();
  const priceCents = Number(priceCentsRaw);
  if (!symbol) {
    return { ok: false, error: 'invalid symbol' };
  }
  if (!(priceCents > 0)) {
    return { ok: false, error: 'price must be > 0' };
  }

  const deployments = loadDeployments();
  const priceFeedAddress = deployments.priceFeed;
  if (!priceFeedAddress) {
    return { ok: false, error: 'pricefeed not deployed' };
  }

  let sender = '';
  if (deployments.admin) {
    sender = deployments.admin;
  } else {
    const accounts = await hardhatRpc('eth_accounts', []);
    if (Array.isArray(accounts) && accounts.length > 0) {
      sender = accounts[0];
    }
  }
  if (!sender) {
    return { ok: false, error: 'admin account missing for price update' };
  }

  try {
    const writeData = priceFeedAdminInterface.encodeFunctionData('setPrice', [symbol, BigInt(priceCents)]);
    const txHash = await hardhatRpc('eth_sendTransaction', [{
      from: sender,
      to: priceFeedAddress,
      data: writeData,
    }]);
    await waitForReceipt(txHash);
    return { ok: true, priceCents };
  } catch {
    return { ok: false, error: `cannot update onchain price for ${symbol}` };
  }
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

async function ensureIndexerSynced() {
  if (indexerSyncPromise) {
    return indexerSyncPromise;
  }
  indexerSyncPromise = (async function () {
    ensureIndexerDir();
    const deployments = loadDeployments();
    const orderBookAddr = deployments.orderBookDex;
    const registryAddr = deployments.listingsRegistry;
    if (!orderBookAddr || !registryAddr) {
      return {
        synced: false,
        reason: '',
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
    const leveragedEvents = readJsonFile(INDEXER_LEVERAGED_FILE, []);

    if (Number(state.lastIndexedBlock) > latestBlock) {
      const orderIds = Object.keys(orders);
      for (let i = 0; i < orderIds.length; i += 1) {
        const id = orderIds[i];
        delete orders[id];
      }
      fills.length = 0;
      cancellations.length = 0;
      cashflows.length = 0;
      transfers.length = 0;
      leveragedEvents.length = 0;
      state.lastIndexedBlock = -1;
      state.latestKnownBlock = -1;
      state.lastSyncAtMs = Date.now();
      writeJsonFile(INDEXER_STATE_FILE, state);
      writeJsonFile(INDEXER_ORDERS_FILE, orders);
      writeJsonFile(INDEXER_FILLS_FILE, fills);
      writeJsonFile(INDEXER_CANCELLATIONS_FILE, cancellations);
      writeJsonFile(INDEXER_CASHFLOWS_FILE, cashflows);
      writeJsonFile(INDEXER_TRANSFERS_FILE, transfers);
      writeJsonFile(INDEXER_LEVERAGED_FILE, leveragedEvents);
    }

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
    const topics = [
      ethers.id('OrderPlaced(uint256,address,address,uint8,uint256,uint256)'),
      ethers.id('OrderFilled(uint256,uint256,address,uint256,uint256)'),
      ethers.id('OrderCancelled(uint256,address,uint256)'),
    ];
    const logs = await hardhatRpc('eth_getLogs', [{
      fromBlock: fromHex,
      toBlock: toHex,
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

    const addresses = new Set();
    let rawTtoken = '';
    if (deployments.ttoken) {
      rawTtoken = deployments.ttoken;
    } else if (deployments.ttokenAddress) {
      rawTtoken = deployments.ttokenAddress;
    } else if (deployments.TTOKEN_ADDRESS) {
      rawTtoken = deployments.TTOKEN_ADDRESS;
    }
    const ttoken = normalizeAddress(rawTtoken);
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
      const isMissing = !normalized;
      const isZero = normalized === ethers.ZeroAddress;
      if (!(isMissing || isZero)) {
        addresses.add(normalized);
        symbolByTokenCache.set(normalized, symbol);
      }
    }
    const tokenAddresses = Array.from(addresses);

    let leveragedLogs = [];
    const leveragedRouterAddress = normalizeAddress(deployments.leveragedProductRouter);
    if (leveragedRouterAddress) {
      const leveragedTopics = [
        ethers.id('LeveragedMinted(address,address,string,uint8,uint256,uint256,uint256)'),
        ethers.id('LeveragedUnwound(address,address,string,uint8,uint256,uint256,uint256)'),
      ];
      leveragedLogs = await hardhatRpc('eth_getLogs', [{
        fromBlock: fromHex,
        toBlock: toHex,
        address: leveragedRouterAddress,
        topics: [leveragedTopics],
      }]);
      leveragedLogs.sort((a, b) => {
        const blockA = Number(a.blockNumber);
        const blockB = Number(b.blockNumber);
        if (blockA !== blockB) {
          return blockA - blockB;
        }
        return Number(a.logIndex) - Number(b.logIndex);
      });
    }

    let transferLogs = [];
    if (tokenAddresses.length > 0) {
      const transferTopic = ethers.id('Transfer(address,address,uint256)');
      transferLogs = [];
      for (const token of tokenAddresses) {
        const part = await hardhatRpc('eth_getLogs', [{
          fromBlock: fromHex,
          toBlock: toHex,
          address: token,
          topics: [transferTopic],
        }]);
        transferLogs.push(...part);
      }
      transferLogs.sort((a, b) => {
        const blockA = Number(a.blockNumber);
        const blockB = Number(b.blockNumber);
        if (blockA !== blockB) {
          return blockA - blockB;
        }
        return Number(a.logIndex) - Number(b.logIndex);
      });
    }

    const blocksNeeded = new Set();
    for (const log of logs) {
      blocksNeeded.add(log.blockNumber);
    }
    for (const log of transferLogs) {
      blocksNeeded.add(log.blockNumber);
    }
    for (const log of leveragedLogs) {
      blocksNeeded.add(log.blockNumber);
    }

    const blockTimestampsMs = new Map();
    for (const blockHex of blocksNeeded) {
      const block = await hardhatRpc('eth_getBlockByNumber', [blockHex, false]);
      blockTimestampsMs.set(blockHex, Number(block.timestamp) * 1000);
    }

    const existingTransferIds = new Set();
    for (let i = 0; i < transfers.length; i += 1) {
      const entry = transfers[i];
      existingTransferIds.add(entry.id);
    }
    for (const log of transferLogs) {
      const txHash = log.transactionHash;
      const blockNumber = Number(log.blockNumber);
      const logIndex = Number(log.logIndex);
      const id = `${txHash}:${logIndex}`;
      if (!existingTransferIds.has(id)) {
        const parsed = erc20Interface.parseLog(log);
        const tokenAddress = normalizeAddress(log.address);
        let symbol = '';
        const cachedSymbol = symbolByTokenCache.get(tokenAddress);
        if (cachedSymbol) {
          symbol = cachedSymbol;
        }
        if (!symbol || symbol === '') {
          symbol = await lookupSymbolByToken(registryAddr, tokenAddress);
          if (!symbol && deployments.ttoken && normalizeAddress(deployments.ttoken) === tokenAddress) {
            symbol = 'TTOKEN';
          }
        }
        let timestampMs = Date.now();
        const cachedTimestampMs = blockTimestampsMs.get(log.blockNumber);
        if (cachedTimestampMs) {
          timestampMs = cachedTimestampMs;
        }
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
    }

    for (const log of logs) {
      const parsed = orderBookInterface.parseLog(log);
      const eventName = parsed.name;
      const txHash = log.transactionHash;
      const blockNumber = Number(log.blockNumber);
      const logIndex = Number(log.logIndex);
      let timestampMs = Date.now();
      const cachedTimestampMs = blockTimestampsMs.get(log.blockNumber);
      if (cachedTimestampMs) {
        timestampMs = cachedTimestampMs;
      }

      if (eventName === 'OrderPlaced') {
        const id = Number(parsed.args.id);
        const equityToken = normalizeAddress(parsed.args.equityToken);
        const symbol = await lookupSymbolByToken(registryAddr, equityToken);
        let side = 'BUY';
        if (Number(parsed.args.side) === 1) {
          side = 'SELL';
        }
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
      } else if (eventName === 'OrderFilled') {
        const makerId = Number(parsed.args.makerId);
        const takerId = Number(parsed.args.takerId);
        const priceCents = Number(parsed.args.price);
        const qtyWei = parsed.args.qty.toString();
        const equityToken = normalizeAddress(parsed.args.equityToken);
        const symbol = await lookupSymbolByToken(registryAddr, equityToken);
        const makerOrder = orders[String(makerId)];
        let takerOrder = null;
        if (takerId > 0) {
          takerOrder = orders[String(takerId)];
        }

        const makerNextRemaining = BigInt(makerOrder.remainingWei) - BigInt(qtyWei);
        if (makerNextRemaining > 0n) {
          makerOrder.remainingWei = makerNextRemaining.toString();
          makerOrder.active = true;
        } else {
          makerOrder.remainingWei = '0';
          makerOrder.active = false;
        }
        if (!makerOrder.active && makerOrder.remainingWei === '0') {
          if (makerOrder.cancelledAtBlock !== null) {
            makerOrder.status = 'CANCELLED';
          } else {
            makerOrder.status = 'FILLED';
          }
        } else if (makerOrder.remainingWei !== makerOrder.qtyWei) {
          makerOrder.status = 'PARTIAL';
        } else {
          makerOrder.status = 'OPEN';
        }
        makerOrder.updatedAtMs = timestampMs;

        if (takerId > 0) {
          const takerNextRemaining = BigInt(takerOrder.remainingWei) - BigInt(qtyWei);
          if (takerNextRemaining > 0n) {
            takerOrder.remainingWei = takerNextRemaining.toString();
            takerOrder.active = true;
          } else {
            takerOrder.remainingWei = '0';
            takerOrder.active = false;
          }
          if (!takerOrder.active && takerOrder.remainingWei === '0') {
            if (takerOrder.cancelledAtBlock !== null) {
              takerOrder.status = 'CANCELLED';
            } else {
              takerOrder.status = 'FILLED';
            }
          } else if (takerOrder.remainingWei !== takerOrder.qtyWei) {
            takerOrder.status = 'PARTIAL';
          } else {
            takerOrder.status = 'OPEN';
          }
          takerOrder.updatedAtMs = timestampMs;
        }

        let makerTrader = makerOrder.trader;
        let takerTrader = '';
        if (takerId > 0) {
          takerTrader = takerOrder.trader;
        }

        fills.push({
          id: `${txHash}:${logIndex}`,
          makerId,
          takerId,
          makerTrader,
          takerTrader,
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
        if (makerOrder.side === 'BUY') {
          buyerWallet = makerOrder.trader;
        }
        if (makerOrder.side === 'SELL') {
          sellerWallet = makerOrder.trader;
        }
        if (takerId > 0) {
          if (takerOrder.side === 'BUY') {
            buyerWallet = takerOrder.trader;
          }
          if (takerOrder.side === 'SELL') {
            sellerWallet = takerOrder.trader;
          }
        }

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
      } else if (eventName === 'OrderCancelled') {
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

    const existingLeveragedIds = new Set();
    for (let i = 0; i < leveragedEvents.length; i += 1) {
      const entry = leveragedEvents[i];
      existingLeveragedIds.add(entry.id);
    }
    for (const log of leveragedLogs) {
      const txHash = log.transactionHash;
      const blockNumber = Number(log.blockNumber);
      const logIndex = Number(log.logIndex);
      const id = `${txHash}:${logIndex}`;
      if (!existingLeveragedIds.has(id)) {
        const parsed = leveragedRouterInterface.parseLog(log);
        let timestampMs = Date.now();
        const cachedTimestampMs = blockTimestampsMs.get(log.blockNumber);
        if (cachedTimestampMs) {
          timestampMs = cachedTimestampMs;
        }
        if (parsed.name === 'LeveragedMinted') {
          leveragedEvents.push({
            id,
            kind: 'LEVERAGE_MINT',
            wallet: normalizeAddress(parsed.args.user),
            productToken: normalizeAddress(parsed.args.productToken),
            baseSymbol: parsed.args.baseSymbol,
            leverage: Number(parsed.args.leverage),
            ttokenInWei: parsed.args.ttokenInWei.toString(),
            productQtyWei: parsed.args.productOutWei.toString(),
            navCents: parsed.args.navCents.toString(),
            txHash,
            blockNumber,
            logIndex,
            timestampMs,
          });
        } else if (parsed.name === 'LeveragedUnwound') {
          leveragedEvents.push({
            id,
            kind: 'LEVERAGE_UNWIND',
            wallet: normalizeAddress(parsed.args.user),
            productToken: normalizeAddress(parsed.args.productToken),
            baseSymbol: parsed.args.baseSymbol,
            leverage: Number(parsed.args.leverage),
            productQtyWei: parsed.args.productInWei.toString(),
            ttokenOutWei: parsed.args.ttokenOutWei.toString(),
            navCents: parsed.args.navCents.toString(),
            txHash,
            blockNumber,
            logIndex,
            timestampMs,
          });
          leveragedEvents.push({
            id: `${id}:burn`,
            kind: 'LEVERAGE_BURN',
            wallet: normalizeAddress(parsed.args.user),
            productToken: normalizeAddress(parsed.args.productToken),
            baseSymbol: parsed.args.baseSymbol,
            leverage: Number(parsed.args.leverage),
            productQtyWei: parsed.args.productInWei.toString(),
            txHash,
            blockNumber,
            logIndex: logIndex + 1,
            timestampMs,
          });
        }
        existingLeveragedIds.add(id);
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
    writeJsonFile(INDEXER_LEVERAGED_FILE, leveragedEvents);

    return {
      synced: true,
      startBlock,
      latestBlock,
      processedLogs: logs.length,
      processedTransfers: transferLogs.length,
      processedLeveragedLogs: leveragedLogs.length,
    };
  })()
    .catch((error) => ({ synced: false, error: error.message }))
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
    leveragedEvents: readJsonFile(INDEXER_LEVERAGED_FILE, []),
  };
}

function quoteAmountWei(qtyWei, priceCents) {
  return (BigInt(qtyWei) * BigInt(priceCents)) / 100n;
}

async function getListingBySymbol(registryAddr, symbol) {
  const lookupData = listingsRegistryInterface.encodeFunctionData('getListing', [symbol]);
  const lookupResult = await hardhatRpc('eth_call', [{ to: registryAddr, data: lookupData }, 'latest']);
  const [tokenAddr] = listingsRegistryInterface.decodeFunctionResult('getListing', lookupResult);
  return normalizeAddress(tokenAddr);
}

async function getSymbolByToken(registryAddr, tokenAddress) {
  const symbolData = listingsRegistryInterface.encodeFunctionData('getSymbolByToken', [tokenAddress]);
  const symbolResult = await hardhatRpc('eth_call', [{ to: registryAddr, data: symbolData }, 'latest']);
  const [symbol] = listingsRegistryInterface.decodeFunctionResult('getSymbolByToken', symbolResult);
  return String(symbol || '').toUpperCase();
}

function ensureAutoTradeDir() {
  if (!fs.existsSync(AUTOTRADE_DIR)) {
    fs.mkdirSync(AUTOTRADE_DIR, { recursive: true });
  }
}

function ensureAdminDir() {
  if (!fs.existsSync(ADMIN_DIR)) {
    fs.mkdirSync(ADMIN_DIR, { recursive: true });
  }
}

function ensureDividendsMerkleDir() {
  if (!fs.existsSync(DIVIDENDS_MERKLE_DIR)) {
    fs.mkdirSync(DIVIDENDS_MERKLE_DIR, { recursive: true });
  }
}

function getDefaultAwardSessionState() {
  return {
    nextAwardWindowSec: 60,
    nextAwardWindowAppliesAtEpoch: -1,
    terminateNextSession: false,
    terminateAtEpoch: -1,
    updatedAtMs: 0,
  };
}

function readAwardSessionState() {
  ensureAdminDir();
  return readJsonFile(AWARD_SESSION_FILE, getDefaultAwardSessionState());
}

function writeAwardSessionState(state) {
  ensureAdminDir();
  writeJsonFile(AWARD_SESSION_FILE, state);
}

function merkleEpochClaimsFile(epochId) {
  return path.join(DIVIDENDS_MERKLE_DIR, `epoch-${epochId}-claims.json`);
}

function merkleEpochTreeFile(epochId) {
  return path.join(DIVIDENDS_MERKLE_DIR, `epoch-${epochId}-tree.json`);
}

function readMerkleClaims(epochId) {
  ensureDividendsMerkleDir();
  const file = merkleEpochClaimsFile(epochId);
  return readJsonFile(file, { epochId, claims: [] });
}

function readMerkleTree(epochId) {
  ensureDividendsMerkleDir();
  const file = merkleEpochTreeFile(epochId);
  return readJsonFile(file, {});
}

function writeMerkleClaims(epochId, claimsPayload) {
  ensureDividendsMerkleDir();
  const file = merkleEpochClaimsFile(epochId);
  writeJsonFile(file, claimsPayload);
}

function writeMerkleTree(epochId, treePayload) {
  ensureDividendsMerkleDir();
  const file = merkleEpochTreeFile(epochId);
  writeJsonFile(file, treePayload);
}

function buildMerkleLevelsLeftRight(leafHashes) {
  const levels = [];
  const firstLevel = [];
  for (let i = 0; i < leafHashes.length; i += 1) {
    firstLevel.push(leafHashes[i]);
  }
  levels.push(firstLevel);
  let current = firstLevel;
  while (current.length > 1) {
    const next = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i];
      let right = left;
      if (i + 1 < current.length) {
        right = current[i + 1];
      }
      const parent = ethers.keccak256(
        ethers.solidityPacked(['bytes32', 'bytes32'], [left, right])
      );
      next.push(parent);
    }
    levels.push(next);
    current = next;
  }
  return levels;
}

function buildMerkleProofLeftRight(levels, leafIndex) {
  const proof = [];
  let index = leafIndex;
  for (let level = 0; level < levels.length - 1; level += 1) {
    const rows = levels[level];
    let siblingIndex = index + 1;
    if (index % 2 === 1) {
      siblingIndex = index - 1;
    }
    if (siblingIndex >= rows.length) {
      siblingIndex = index;
    }
    proof.push(rows[siblingIndex]);
    index = Math.floor(index / 2);
  }
  return proof;
}

function merkleLeafHash(epochId, tokenAddress, account, amountWei, leafIndex) {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ['uint256', 'address', 'address', 'uint256', 'uint256'],
    [BigInt(epochId), tokenAddress, account, BigInt(amountWei), BigInt(leafIndex)]
  );
  return ethers.keccak256(encoded);
}

function tryParseSnapshotIdFromReceipt(receipt) {
  if (!receipt || !Array.isArray(receipt.logs)) {
    return 0;
  }
  for (let i = 0; i < receipt.logs.length; i += 1) {
    const log = receipt.logs[i];
    try {
      const parsed = equityTokenSnapshotInterface.parseLog(log);
      if (parsed && parsed.name === 'Snapshot') {
        return Number(parsed.args.id);
      }
    } catch {
    }
  }
  return 0;
}

async function collectHolderCandidatesFromChain(tokenAddress, toBlockHex) {
  const transferTopic = ethers.id('Transfer(address,address,uint256)');
  const logs = await hardhatRpc('eth_getLogs', [{
    fromBlock: '0x0',
    toBlock: toBlockHex,
    address: tokenAddress,
    topics: [transferTopic],
  }]);
  const seen = new Set();
  for (let i = 0; i < logs.length; i += 1) {
    const log = logs[i];
    try {
      const parsed = erc20Interface.parseLog(log);
      const from = normalizeAddress(parsed.args.from);
      const to = normalizeAddress(parsed.args.to);
      if (from && from !== ethers.ZeroAddress) {
        seen.add(from.toLowerCase());
      }
      if (to && to !== ethers.ZeroAddress) {
        seen.add(to.toLowerCase());
      }
    } catch {
    }
  }
  const rows = [];
  const values = Array.from(seen.values());
  for (let i = 0; i < values.length; i += 1) {
    rows.push(normalizeAddress(values[i]));
  }
  rows.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return rows;
}

function getDefaultAutoTradeState() {
  return {
    listenerRunning: true,
    nextRuleId: 1,
    nextExecutionId: 1,
    rules: [],
    executions: [],
    lastTickAtMs: 0,
  };
}

function readAutoTradeState() {
  ensureAutoTradeDir();
  return readJsonFile(AUTOTRADE_STATE_FILE, getDefaultAutoTradeState());
}

function writeAutoTradeState(state) {
  ensureAutoTradeDir();
  writeJsonFile(AUTOTRADE_STATE_FILE, state);
}

function getDefaultSymbolStatusState() {
  return {
    symbols: {},
  };
}

function readSymbolStatusState() {
  ensureAutoTradeDir();
  return readJsonFile(SYMBOL_STATUS_FILE, getDefaultSymbolStatusState());
}

function writeSymbolStatusState(state) {
  ensureAutoTradeDir();
  writeJsonFile(SYMBOL_STATUS_FILE, state);
}

function getSymbolLifecycleStatus(symbolRaw) {
  const state = readSymbolStatusState();
  const symbol = String(symbolRaw).toUpperCase();
  const entry = state.symbols[symbol];
  if (entry && entry.status) {
    return String(entry.status).toUpperCase();
  }
  return 'ACTIVE';
}

function setSymbolLifecycleStatus(symbolRaw, statusRaw) {
  const symbol = String(symbolRaw).toUpperCase();
  const status = String(statusRaw).toUpperCase();
  const state = readSymbolStatusState();
  state.symbols[symbol] = {
    symbol,
    status,
    updatedAtMs: Date.now(),
  };
  writeSymbolStatusState(state);
  return state.symbols[symbol];
}

async function listAllSymbolsFromRegistry() {
  const deployments = loadDeployments();
  const registryAddr = deployments.listingsRegistry;
  const data = registryListInterface.encodeFunctionData('getAllSymbols', []);
  const result = await hardhatRpc('eth_call', [{ to: registryAddr, data }, 'latest']);
  const [symbols] = registryListInterface.decodeFunctionResult('getAllSymbols', result);
  return symbols;
}

async function getBestBookPrices(symbolRaw) {
  const symbol = String(symbolRaw).toUpperCase();
  const deployments = loadDeployments();
  const tokenAddress = await getListingBySymbol(deployments.listingsRegistry, symbol);
  if (!tokenAddress || tokenAddress === ethers.ZeroAddress) {
    return {
      symbol,
      tokenAddress: '',
      bestBidCents: 0,
      bestAskCents: 0,
      hasBid: false,
      hasAsk: false,
    };
  }

  const buyData = orderBookInterface.encodeFunctionData('getBuyOrders', [tokenAddress]);
  const buyResult = await hardhatRpc('eth_call', [{ to: deployments.orderBookDex, data: buyData }, 'latest']);
  const [buyOrders] = orderBookInterface.decodeFunctionResult('getBuyOrders', buyResult);

  const sellData = orderBookInterface.encodeFunctionData('getSellOrders', [tokenAddress]);
  const sellResult = await hardhatRpc('eth_call', [{ to: deployments.orderBookDex, data: sellData }, 'latest']);
  const [sellOrders] = orderBookInterface.decodeFunctionResult('getSellOrders', sellResult);

  let bestBidCents = 0;
  let bestAskCents = 0;
  let hasBid = false;
  let hasAsk = false;

  for (let i = 0; i < buyOrders.length; i += 1) {
    const row = buyOrders[i];
    const isActive = row.active === true;
    const remainingWei = BigInt(row.remaining.toString());
    if (isActive && remainingWei > 0n) {
      const cents = Number(row.price);
      if (!hasBid || cents > bestBidCents) {
        hasBid = true;
        bestBidCents = cents;
      }
    }
  }

  for (let i = 0; i < sellOrders.length; i += 1) {
    const row = sellOrders[i];
    const isActive = row.active === true;
    const remainingWei = BigInt(row.remaining.toString());
    if (isActive && remainingWei > 0n) {
      const cents = Number(row.price);
      if (!hasAsk || cents < bestAskCents) {
        hasAsk = true;
        bestAskCents = cents;
      }
    }
  }

  return {
    symbol,
    tokenAddress,
    bestBidCents,
    bestAskCents,
    hasBid,
    hasAsk,
  };
}

function shouldRuleTrigger(rule, book) {
  const side = String(rule.side).toUpperCase();
  const triggerPriceCents = Number(rule.triggerPriceCents);
  if (side === 'BUY') {
    if (!book.hasAsk) {
      return false;
    }
    return book.bestAskCents <= triggerPriceCents;
  }
  if (side === 'SELL') {
    if (!book.hasBid) {
      return false;
    }
    return book.bestBidCents >= triggerPriceCents;
  }
  return false;
}

function isRulePausedByLifecycle(rule) {
  const symbolStatus = getSymbolLifecycleStatus(rule.symbol);
  return symbolStatus === 'FROZEN' || symbolStatus === 'DELISTED';
}

function normalizeRuleForResponse(rule) {
  return {
    id: Number(rule.id),
    wallet: rule.wallet,
    symbol: rule.symbol,
    side: rule.side,
    triggerPriceCents: Number(rule.triggerPriceCents),
    qtyWei: String(rule.qtyWei),
    maxSlippageBps: Number(rule.maxSlippageBps),
    enabled: Boolean(rule.enabled),
    cooldownSec: Number(rule.cooldownSec || 0),
    maxExecutionsPerDay: Number(rule.maxExecutionsPerDay || 0),
    createdAtMs: Number(rule.createdAtMs || 0),
    updatedAtMs: Number(rule.updatedAtMs || 0),
    lastExecutedAtMs: Number(rule.lastExecutedAtMs || 0),
    pausedByLifecycle: isRulePausedByLifecycle(rule),
  };
}

function normalizeExecutionForResponse(entry) {
  return {
    id: Number(entry.id),
    ruleId: Number(entry.ruleId),
    wallet: entry.wallet,
    symbol: entry.symbol,
    side: entry.side,
    triggerPriceCents: Number(entry.triggerPriceCents),
    observedBestBidCents: Number(entry.observedBestBidCents || 0),
    observedBestAskCents: Number(entry.observedBestAskCents || 0),
    qtyWei: String(entry.qtyWei),
    txHash: entry.txHash,
    status: entry.status,
    error: entry.error || '',
    executedAtMs: Number(entry.executedAtMs),
  };
}

async function executeAutoTradeRule(rule, book) {
  const deployments = loadDeployments();
  const orderBookAddr = deployments.orderBookDex;
  const wallet = rule.wallet;
  const symbol = rule.symbol;
  const qtyWei = BigInt(rule.qtyWei);
  const qtyUi = Number(ethers.formatUnits(qtyWei, 18));
  const side = String(rule.side).toUpperCase();
  const triggerPriceCents = Number(rule.triggerPriceCents);

  if (!(qtyUi > 0)) {
    throw new Error('rule qty is zero');
  }

  let data = '';
  if (side === 'BUY') {
    const ttokenAddr = deployments.ttoken;
    const quoteWei = quoteAmountWei(qtyWei, triggerPriceCents);
    const approveData = equityTokenInterface.encodeFunctionData('approve', [orderBookAddr, quoteWei]);
    const approveTxHash = await hardhatRpc('eth_sendTransaction', [{
      from: wallet,
      to: ttokenAddr,
      data: approveData,
    }]);
    await waitForReceipt(approveTxHash);
    data = orderBookInterface.encodeFunctionData('placeLimitOrder', [
      book.tokenAddress,
      0,
      triggerPriceCents,
      qtyWei,
    ]);
  } else {
    const approveData = equityTokenInterface.encodeFunctionData('approve', [orderBookAddr, qtyWei]);
    const approveTxHash = await hardhatRpc('eth_sendTransaction', [{
      from: wallet,
      to: book.tokenAddress,
      data: approveData,
    }]);
    await waitForReceipt(approveTxHash);
    data = orderBookInterface.encodeFunctionData('placeLimitOrder', [
      book.tokenAddress,
      1,
      triggerPriceCents,
      qtyWei,
    ]);
  }

  const txHash = await hardhatRpc('eth_sendTransaction', [{
    from: wallet,
    to: orderBookAddr,
    data,
  }]);
  await waitForReceipt(txHash);

  return {
    txHash,
    symbol,
    side,
    qtyWei: qtyWei.toString(),
  };
}

function getDateKeyEt() {
  const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
  const y = etNow.getFullYear();
  const m = String(etNow.getMonth() + 1).padStart(2, '0');
  const d = String(etNow.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function runAutoTradeTick() {
  if (autoTradeLoopBusy) {
    return;
  }
  autoTradeLoopBusy = true;

  try {
    const state = readAutoTradeState();
    if (!state.listenerRunning) {
      return;
    }
    state.lastTickAtMs = Date.now();

    for (let i = 0; i < state.rules.length; i += 1) {
      const rule = state.rules[i];
      if (!rule.enabled) {
        continue;
      }
      if (isRulePausedByLifecycle(rule)) {
        continue;
      }

      const nowMs = Date.now();
      const cooldownSec = Number(rule.cooldownSec || 0);
      if (cooldownSec > 0 && Number(rule.lastExecutedAtMs || 0) > 0) {
        const elapsedMs = nowMs - Number(rule.lastExecutedAtMs);
        if (elapsedMs < (cooldownSec * 1000)) {
          continue;
        }
      }

      const maxExecutionsPerDay = Number(rule.maxExecutionsPerDay || 0);
      const currentDay = getDateKeyEt();
      if (rule.executionsDay !== currentDay) {
        rule.executionsDay = currentDay;
        rule.executionsDayCount = 0;
      }
      if (maxExecutionsPerDay > 0 && Number(rule.executionsDayCount || 0) >= maxExecutionsPerDay) {
        continue;
      }

      const book = await getBestBookPrices(rule.symbol);
      if (!book.tokenAddress) {
        continue;
      }
      const triggerNow = shouldRuleTrigger(rule, book);
      if (!triggerNow) {
        continue;
      }

      const executionId = state.nextExecutionId;
      state.nextExecutionId = Number(state.nextExecutionId) + 1;
      const entry = {
        id: executionId,
        ruleId: Number(rule.id),
        wallet: rule.wallet,
        symbol: rule.symbol,
        side: rule.side,
        triggerPriceCents: Number(rule.triggerPriceCents),
        observedBestBidCents: Number(book.bestBidCents || 0),
        observedBestAskCents: Number(book.bestAskCents || 0),
        qtyWei: String(rule.qtyWei),
        txHash: '',
        status: 'FAILED',
        error: '',
        executedAtMs: Date.now(),
      };

      try {
        const result = await executeAutoTradeRule(rule, book);
        entry.txHash = result.txHash;
        entry.status = 'EXECUTED';
        rule.lastExecutedAtMs = Date.now();
        rule.updatedAtMs = Date.now();
        rule.executionsDayCount = Number(rule.executionsDayCount || 0) + 1;
        state.rules.splice(i, 1);
        i -= 1;
      } catch (err) {
        entry.error = err.message || 'execution failed';
      }

      state.executions.push(entry);
    }

    writeAutoTradeState(state);
  } catch (err) {
    let msg = 'auto trade tick failed';
    if (err && err.message) {
      msg = err.message;
    }
    console.error('[autotrade]', msg);
  } finally {
    autoTradeLoopBusy = false;
  }
}

function computeSymbolCostBasis(lots) {
  
}
// check trading day for candle
function isTradingDay(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  let weekend = false;
  if (weekday === 0 || weekday === 6) {
    weekend = true;
  }
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
  let symbol = 'AAPL';
  if (req.params.symbol) {
    symbol = req.params.symbol;
  }
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
  let symbolRaw = 'TSLA';
  if (req.query.symbol) {
    symbolRaw = String(req.query.symbol);
  }
  const symbol = symbolRaw.toUpperCase();
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

    let msg = '';
    if (err.message) {
      msg = err.message;
    }
    res.status(502).json({ error: msg });
  }
});
// quote short with fmp's stock price
app.get('/api/fmp/quote-short', async (req, res) => {
  let symbolRaw = 'TSLA';
  if (req.query.symbol) {
    symbolRaw = String(req.query.symbol);
  }
  const symbol = symbolRaw.toUpperCase();
  const cached = fmpQuoteCache.get(symbol);

  try {
    if (cached && (Date.now() - cached.timestamp) < FMP_QUOTE_TTL_MS) {
      return res.json(cached.data);
    }

    const url = getFmpUrl('quote', { symbol });
    const payload = await fetchFmpJson(url);
    let quote = payload;
    if (Array.isArray(payload)) {
      quote = payload[0];
    }
    const price = asNumber(pick(quote, ['price', 'regularMarketPrice']));
    const volume = quote.volume;
    const previousClose = asNumber(pick(quote, ['previousClose', 'prevClose']));
    let changePercent = asNumber(pick(quote, ['changesPercentage', 'changePercent']));
    if (Number.isFinite(changePercent) && Math.abs(changePercent) > 1) {
      changePercent = changePercent / 100;
    }
    let responseSymbol = symbol;
    if (quote.symbol) {
      responseSymbol = quote.symbol;
    }
    const data = {
      symbol: responseSymbol,
      price,
      volume,
      previousClose,
      changePercent,
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
        previousClose: fallbackQuote.regularMarketPreviousClose,
        changePercent: fallbackQuote.regularMarketChangePercent,
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
            previousClose: candleData.open,
            changePercent: asNumber((candleData.close - candleData.open) / candleData.open),
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
      let msg = '';
      if (err.message) {
        msg = err.message;
      }
      res.status(502).json({ error: msg });
    }
  }
});

// get stock info with fmp
app.get('/api/fmp/stock-info', async (req, res) => {
  let symbolRaw = 'TSLA';
  if (req.query.symbol) {
    symbolRaw = String(req.query.symbol);
  }
  const symbol = symbolRaw.toUpperCase();
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
      const price = summary.price;
      const sd = summary.summaryDetail;
      const stats = summary.defaultKeyStatistics;
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
      const msg = err.message;
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
    res.status(502).json({ error: err.message });
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
  const address = String(req.query.address);
  try {
    const ttokenAddress = process.env.TTOKEN_ADDRESS || getTTokenAddressFromDeployments();
    const data = equityTokenInterface.encodeFunctionData('balanceOf', [address]);
    const result = await hardhatRpc('eth_call', [{ to: ttokenAddress, data }, 'latest']);
    const [balanceWei] = equityTokenInterface.decodeFunctionResult('balanceOf', result);
    res.json({ address, ttokenAddress, balanceWei: balanceWei.toString() });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// mint api with validation and fallback
app.post('/api/ttoken/mint', async (req, res) => {
  const body = req.body;
  const to = String(body.to);
  const amount = Number(body.amount);
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
    res.status(502).json({ error: err.message });
  }
});

// api for orderbook and matching engine
app.post('/api/orderbook/limit', async (req, res) => {
  try {
    const body = req.body;
    const symbol = String(body.symbol).toUpperCase();
    const symbolLifecycle = getSymbolLifecycleStatus(symbol);
    if (symbolLifecycle === 'FROZEN' || symbolLifecycle === 'DELISTED') {
      return res.status(400).json({ error: `symbol ${symbol} is ${symbolLifecycle}` });
    }
    const sideText = String(body.side).toUpperCase();
    const priceCents = Number(body.priceCents);
    const qty = Number(body.qty);
    const from = normalizeAddress(String(body.from || ''));
    if (!from) {
      return res.status(400).json({ error: 'wallet is required' });
    }
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
    if (sideText !== 'BUY' && sideText !== 'SELL') {
      return res.status(400).json({ error: 'side must be BUY or SELL' });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/indexer/status', async (_req, res) => {
  try {
    const sync = await ensureIndexerSynced();
    const snapshot = readIndexerSnapshot();
    const orderIds = [];
    const orderValues = Object.values(snapshot.orders);
    for (let i = 0; i < orderValues.length; i += 1) {
      const order = orderValues[i];
      const orderId = Number(order.id);
      orderIds.push(orderId);
    }
    orderIds.sort((a, b) => a - b);
    const lastOrderIds = orderIds.slice(-20);
    const transferIds = [];
    for (let i = 0; i < snapshot.transfers.length; i += 1) {
      const transfer = snapshot.transfers[i];
      transferIds.push(transfer.id);
    }
    transferIds.sort();
    const lastTransferIds = transferIds.slice(-20);
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
      leveragedCount: snapshot.leveragedEvents.length,
      lastOrderIds,
      lastTransferIds,
    };
    const checksum = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
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
        leveragedEvents: snapshot.leveragedEvents.length,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/indexer/rebuild', async (_req, res) => {
  try {
    ensureIndexerDir();
    writeJsonFile(INDEXER_STATE_FILE, { lastIndexedBlock: -1, latestKnownBlock: -1, lastSyncAtMs: 0 });
    writeJsonFile(INDEXER_ORDERS_FILE, {});
    writeJsonFile(INDEXER_FILLS_FILE, []);
    writeJsonFile(INDEXER_CANCELLATIONS_FILE, []);
    writeJsonFile(INDEXER_CASHFLOWS_FILE, []);
    writeJsonFile(INDEXER_TRANSFERS_FILE, []);
    writeJsonFile(INDEXER_LEVERAGED_FILE, []);
    const sync = await ensureIndexerSynced();
    const snapshot = readIndexerSnapshot();
    const orderIds = [];
    const orderValues = Object.values(snapshot.orders);
    for (let i = 0; i < orderValues.length; i += 1) {
      const order = orderValues[i];
      const orderId = Number(order.id);
      orderIds.push(orderId);
    }
    orderIds.sort((a, b) => a - b);
    const lastOrderIds = orderIds.slice(-20);
    const transferIds = [];
    for (let i = 0; i < snapshot.transfers.length; i += 1) {
      const transfer = snapshot.transfers[i];
      transferIds.push(transfer.id);
    }
    transferIds.sort();
    const lastTransferIds = transferIds.slice(-20);
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
      leveragedCount: snapshot.leveragedEvents.length,
      lastOrderIds,
      lastTransferIds,
    };
    const checksum = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
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
        leveragedEvents: snapshot.leveragedEvents.length,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/orders/open', async (req, res) => {
  let walletParam = '';
  if (req.query.wallet) {
    walletParam = String(req.query.wallet);
  }
  const wallet = normalizeAddress(walletParam);
  if (!wallet) {
    return res.status(400).json({ error: 'wallet is required' });
  }
  try {
    await ensureIndexerSynced();
    const { orders } = readIndexerSnapshot();
    const items = [];
    const orderValues = Object.values(orders);
    for (let i = 0; i < orderValues.length; i += 1) {
      const order = orderValues[i];
      const isOwner = order.trader === wallet;
      let isOpen = false;
      if (order.status === 'OPEN' || order.status === 'PARTIAL') {
        isOpen = true;
      }
      if (isOwner && isOpen) {
        const item = {
          ...order,
          cancellable: true,
        };
        items.push(item);
      }
    }
    items.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
    res.json({ wallet, orders: items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/orders/:orderId', async (req, res) => {
  let walletParam = '';
  if (req.query.wallet) {
    walletParam = String(req.query.wallet);
  }
  const wallet = normalizeAddress(walletParam);
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
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/orders/cancel', async (req, res) => {
  let body = {};
  if (req.body) {
    body = req.body;
  }
  let walletRaw = '';
  if (body.wallet) {
    walletRaw = String(body.wallet);
  }
  const wallet = normalizeAddress(walletRaw);
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
    let isCancellable = false;
    if (order.status === 'OPEN' || order.status === 'PARTIAL') {
      isCancellable = true;
    }
    if (!isCancellable) {
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
    let nextOrder = null;
    if (nextOrders[String(orderId)]) {
      nextOrder = nextOrders[String(orderId)];
    }
    res.json({ txHash, order: nextOrder });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/txs', async (req, res) => {
  let walletRaw = '';
  if (req.query.wallet) {
    walletRaw = String(req.query.wallet);
  }
  const wallet = normalizeAddress(walletRaw);

  let typeRaw = 'ALL';
  if (req.query.type) {
    typeRaw = String(req.query.type);
  }
  const type = typeRaw.toUpperCase();

  let cursorRaw = 0;
  if (req.query.cursor) {
    cursorRaw = req.query.cursor;
  }
  const parsedCursor = Number(cursorRaw);
  let cursor = 0;
  if (Number.isFinite(parsedCursor) && parsedCursor >= 0) {
    cursor = parsedCursor;
  }
  let limitRaw = 50;
  if (req.query.limit) {
    limitRaw = req.query.limit;
  }
  const numericLimit = Number(limitRaw);
  const limit = Math.min(200, Math.max(1, numericLimit));

  if (!wallet) {
    return res.status(400).json({ error: 'wallet is required' });
  }

  try {
    await ensureIndexerSynced();
    const snapshot = readIndexerSnapshot();
    const { orders, fills, cancellations, cashflows, transfers, leveragedEvents } = snapshot;
    const items = [];

    if (type === 'ALL' || type === 'ORDERS') {
      for (const order of Object.values(orders)) {
        if (order.trader === wallet) {
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
      }
      for (const cancel of cancellations) {
        if (cancel.trader === wallet) {
          const order = orders[String(cancel.orderId)];
          let symbol = '';
          if (order && order.symbol) {
            symbol = order.symbol;
          }
          let side = '';
          if (order && order.side) {
            side = order.side;
          }
          items.push({
            kind: 'ORDER_CANCELLED',
            wallet,
            symbol,
            side,
            orderId: cancel.orderId,
            refundWei: cancel.refundWei,
            txHash: cancel.txHash,
            blockNumber: cancel.blockNumber,
            timestampMs: cancel.timestampMs,
          });
        }
      }
    }

    if (type === 'ALL' || type === 'FILLS') {
      for (const fill of fills) {
        let side = '';
        if (fill.makerTrader === wallet) {
          const makerOrder = orders[String(fill.makerId)];
          if (makerOrder && makerOrder.side) {
            side = makerOrder.side;
          }
        } else if (fill.takerTrader === wallet) {
          const takerOrder = orders[String(fill.takerId)];
          if (takerOrder && takerOrder.side) {
            side = takerOrder.side;
          }
        } else {
          side = '';
        }
        if (side !== '') {
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
    }

    if (type === 'ALL' || type === 'CASHFLOW') {
      for (const cashflow of cashflows) {
        if (cashflow.wallet === wallet) {
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
    }

    if (type === 'ALL' || type === 'TRANSFERS') {
      for (const transfer of transfers) {
        if (transfer.from === wallet || transfer.to === wallet) {
          let direction = 'OUT';
          if (transfer.to === wallet) {
            direction = 'IN';
          }
          let symbol = '';
          if (transfer.symbol) {
            symbol = transfer.symbol;
          }
          items.push({
            kind: 'TRANSFER',
            wallet,
            symbol,
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
    }

    if (type === 'ALL' || type === 'LEVERAGE') {
      for (const entry of leveragedEvents) {
        if (entry.wallet === wallet) {
          const row = {
            kind: entry.kind,
            wallet,
            symbol: entry.baseSymbol,
            productToken: entry.productToken,
            leverage: entry.leverage,
            navCents: entry.navCents,
            txHash: entry.txHash,
            blockNumber: entry.blockNumber,
            timestampMs: entry.timestampMs,
          };
          if (entry.kind === 'LEVERAGE_MINT') {
            row.ttokenInWei = entry.ttokenInWei;
            row.productQtyWei = entry.productQtyWei;
          } else if (entry.kind === 'LEVERAGE_UNWIND') {
            row.ttokenOutWei = entry.ttokenOutWei;
            row.productQtyWei = entry.productQtyWei;
          } else if (entry.kind === 'LEVERAGE_BURN') {
            row.productQtyWei = entry.productQtyWei;
          }
          items.push(row);
        }
      }
    }

    items.sort((a, b) => b.timestampMs - a.timestampMs || b.blockNumber - a.blockNumber);
    const offset = Math.max(0, cursor);
    const paged = items.slice(offset, offset + limit);
    let nextCursor = null;
    if (offset + paged.length < items.length) {
      nextCursor = offset + paged.length;
    }

    res.json({
      wallet,
      type,
      items: paged,
      nextCursor,
      total: items.length,
      indexerState: snapshot.state,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/portfolio/positions', async (req, res) => {
  let walletRaw = '';
  if (req.query.wallet) {
    walletRaw = String(req.query.wallet);
  } else if (req.query.address) {
    walletRaw = String(req.query.address);
  }
  const wallet = normalizeAddress(walletRaw);
  if (!wallet) {
    return res.status(400).json({ error: 'wallet is required' });
  }

  try {
    await ensureIndexerSynced();
    const snapshot = readIndexerSnapshot();
    const deployments = loadDeployments();
    const listData = registryListInterface.encodeFunctionData('getAllSymbols', []);
    const listResult = await hardhatRpc('eth_call', [{ to: deployments.listingsRegistry, data: listData }, 'latest']);
    const [symbols] = registryListInterface.decodeFunctionResult('getAllSymbols', listResult);
    const listings = [];
    for (const symbol of symbols) {
      const token = await getListingBySymbol(deployments.listingsRegistry, symbol);
      const hasToken = Boolean(token);
      const isNonZero = token !== ethers.ZeroAddress;
      if (hasToken && isNonZero) {
        listings.push({ symbol, tokenAddress: token });
      }
    }
    const fillRows = [];
    const walletNorm = normalizeAddress(wallet);
    for (const fill of snapshot.fills) {
      if (fill.makerTrader === walletNorm || fill.takerTrader === walletNorm) {
        let side = '';
        if (fill.makerTrader === walletNorm) {
          const makerOrder = snapshot.orders[String(fill.makerId)];
          if (makerOrder) {
            side = makerOrder.side;
          } else {
            side = '';
          }
        } else {
          const takerOrder = snapshot.orders[String(fill.takerId)];
          if (takerOrder) {
            side = takerOrder.side;
          } else {
            side = '';
          }
        }
        fillRows.push({
          symbol: fill.symbol,
          side,
          qtyWei: fill.qtyWei,
          priceCents: fill.priceCents,
          timestampMs: fill.timestampMs,
          blockNumber: fill.blockNumber,
          txHash: fill.txHash,
          logIndex: fill.logIndex,
        });
      }
    }
    fillRows.sort((a, b) => {
      const timestampDiff = a.timestampMs - b.timestampMs;
      if (timestampDiff !== 0) {
        return timestampDiff;
      }
      const blockDiff = a.blockNumber - b.blockNumber;
      if (blockDiff !== 0) {
        return blockDiff;
      }
      const logDiff = a.logIndex - b.logIndex;
      return logDiff;
    });
    const lotsBySymbol = new Map();
    const realizedBySymbol = new Map();
    for (const row of fillRows) {
      if (!lotsBySymbol.has(row.symbol)) {
        lotsBySymbol.set(row.symbol, []);
      }
      if (!realizedBySymbol.has(row.symbol)) {
        realizedBySymbol.set(row.symbol, 0n);
      }
      const lots = lotsBySymbol.get(row.symbol);
      if (row.side === 'BUY') {
        lots.push({ qtyWei: BigInt(row.qtyWei), priceCents: row.priceCents });
      } else if (row.side === 'SELL') {
        let remainingSell = BigInt(row.qtyWei);
        while (remainingSell > 0n && lots.length > 0) {
          const lot = lots[0];
          let consume = lot.qtyWei;
          if (remainingSell < lot.qtyWei) {
            consume = remainingSell;
          }
          const sellQuote = quoteAmountWei(consume, row.priceCents);
          const buyQuote = quoteAmountWei(consume, lot.priceCents);
          const previousRealized = realizedBySymbol.get(row.symbol);
          const nextRealized = previousRealized + (sellQuote - buyQuote);
          realizedBySymbol.set(row.symbol, nextRealized);
          lot.qtyWei -= consume;
          remainingSell -= consume;
          if (lot.qtyWei === 0n) {
            lots.shift();
          }
        }
      }
    }
    const positions = [];
    for (const listing of listings) {
      const balData = equityTokenInterface.encodeFunctionData('balanceOf', [wallet]);
      const balResult = await hardhatRpc('eth_call', [{ to: listing.tokenAddress, data: balData }, 'latest']);
      const [balanceWeiRaw] = equityTokenInterface.decodeFunctionResult('balanceOf', balResult);
      const balanceWei = BigInt(balanceWeiRaw.toString());
      let lots = [];
      const existingLots = lotsBySymbol.get(listing.symbol);
      if (existingLots) {
        lots = existingLots;
      }
      let remaining = BigInt(balanceWei);
      let usedQty = 0n;
      let usedCostWei = 0n;
      for (const lot of lots) {
        if (remaining === 0n) {
          break;
        }
        let useQty = lot.qtyWei;
        if (remaining < lot.qtyWei) {
          useQty = remaining;
        }
        usedQty += useQty;
        usedCostWei += quoteAmountWei(useQty, lot.priceCents);
        remaining -= useQty;
      }
      let unmatchedQtyWei = 0n;
      if (balanceWei > usedQty) {
        unmatchedQtyWei = balanceWei - usedQty;
      }
      let liveCents = 0;
      let symbolText = '';
      if (listing.symbol) {
        symbolText = String(listing.symbol);
      }
      const upper = symbolText.toUpperCase();
      if (upper) {
        const cached = fmpQuoteCache.get(upper);
        if (cached && (Date.now() - cached.timestamp) < FMP_QUOTE_TTL_MS) {
          let cachedPriceRaw = 0;
          if (cached.data.price) {
            cachedPriceRaw = cached.data.price;
          }
          liveCents = Math.round(Number(cachedPriceRaw) * 100);
        } else {
          try {
            const payload = await fetchFmpJson(getFmpUrl('quote-short', { symbol: upper }));
            let quote = payload;
            if (Array.isArray(payload)) {
              quote = payload[0];
            }
            let quotePriceRaw = 0;
            if (quote.price) {
              quotePriceRaw = quote.price;
            }
            const price = Number(quotePriceRaw);
            const data = { symbol: upper, price };
            fmpQuoteCache.set(upper, { data, timestamp: Date.now() });
            liveCents = Math.round(price * 100);
          } catch {
            try {
              const yahoo = await fetchQuote(upper);
              let yahooPriceRaw = 0;
              if (yahoo.regularMarketPrice) {
                yahooPriceRaw = yahoo.regularMarketPrice;
              }
              const price = Number(yahooPriceRaw);
              if (price > 0) {
                const data = { symbol: upper, price, source: 'yahoo' };
                fmpQuoteCache.set(upper, { data, timestamp: Date.now() });
                liveCents = Math.round(price * 100);
              } else {
                try {
                  const candle = await buildCandleFallback(upper);
                  let candlePriceRaw = 0;
                  if (candle.close) {
                    candlePriceRaw = candle.close;
                  }
                  const candlePrice = Number(candlePriceRaw);
                  if (candlePrice > 0) {
                    const data = { symbol: upper, price: candlePrice, source: 'candles' };
                    fmpQuoteCache.set(upper, { data, timestamp: Date.now() });
                    liveCents = Math.round(candlePrice * 100);
                  } else {
                    liveCents = 0;
                  }
                } catch {
                  liveCents = 0;
                }
              }
            } catch {
              try {
                const candle = await buildCandleFallback(upper);
                let candlePriceRaw = 0;
                if (candle.close) {
                  candlePriceRaw = candle.close;
                }
                const candlePrice = Number(candlePriceRaw);
                if (candlePrice > 0) {
                  const data = { symbol: upper, price: candlePrice, source: 'candles' };
                  fmpQuoteCache.set(upper, { data, timestamp: Date.now() });
                  liveCents = Math.round(candlePrice * 100);
                } else {
                  liveCents = 0;
                }
              } catch {
                liveCents = 0;
              }
            }
          }
        }
      }
      const lifecycleStatus = getSymbolLifecycleStatus(listing.symbol);
      let valuation = { priceCents: 0, priceSource: 'NONE' };
      if (lifecycleStatus === 'DELISTED') {
        valuation = { priceCents: 0, priceSource: 'DELISTED' };
      } else if (liveCents > 0) {
        valuation = { priceCents: liveCents, priceSource: 'LIVE' };
      } else {
        const priceFeedAddr = normalizeAddress(deployments.priceFeed);
        if (priceFeedAddr) {
          try {
            const feedData = priceFeedInterface.encodeFunctionData('getPrice', [listing.symbol]);
            const feedResult = await hardhatRpc('eth_call', [{ to: priceFeedAddr, data: feedData }, 'latest']);
            const [onchainPriceRaw] = priceFeedInterface.decodeFunctionResult('getPrice', feedResult);
            const onchainPrice = Number(onchainPriceRaw);
            if (onchainPrice > 0) {
              valuation = { priceCents: onchainPrice, priceSource: 'ONCHAIN_PRICEFEED' };
            }
          } catch {
            // best-effort fallback chain
          }
        }
        if (valuation.priceCents === 0) {
          let latest = null;
          for (const fill of snapshot.fills) {
            if (fill.symbol === listing.symbol) {
              if (!latest) {
                latest = fill;
              } else if (fill.timestampMs > latest.timestampMs) {
                latest = fill;
              } else if (fill.timestampMs === latest.timestampMs && fill.blockNumber > latest.blockNumber) {
                latest = fill;
              }
            }
          }
          let lastFillCents = 0;
          if (latest) {
            let latestPriceRaw = 0;
            if (latest.priceCents) {
              latestPriceRaw = latest.priceCents;
            }
            lastFillCents = Number(latestPriceRaw);
          }
          if (lastFillCents > 0) {
            valuation = { priceCents: lastFillCents, priceSource: 'LAST_FILL' };
          }
        }
      }
      const priceCents = valuation.priceCents;
      let currentValueWei = 0n;
      if (priceCents > 0) {
        currentValueWei = quoteAmountWei(balanceWei, priceCents);
      }
      let unmatchedCostWei = 0n;
      if (priceCents > 0) {
        unmatchedCostWei = quoteAmountWei(unmatchedQtyWei, priceCents);
      }
      const effectiveCostBasisWei = usedCostWei + unmatchedCostWei;
      let avgCostCents = 0;
      if (balanceWei > 0n) {
        avgCostCents = Number((effectiveCostBasisWei * 100n) / balanceWei);
      }
      let realizedPnlWei = 0n;
      const realizedFound = realizedBySymbol.get(listing.symbol);
      if (realizedFound) {
        realizedPnlWei = realizedFound;
      }
      const unrealizedPnlWei = currentValueWei - effectiveCostBasisWei;
      let unrealizedPnlPct = null;
      if (effectiveCostBasisWei > 0n) {
        unrealizedPnlPct = Number(unrealizedPnlWei * 10000n / effectiveCostBasisWei) / 100;
      }
      if (!(balanceWei === 0n && realizedPnlWei === 0n)) {
        const qtyValueWeiText = balanceWei.toString();
        const qtyNegative = String(qtyValueWeiText).startsWith('-');
        let qtyRaw = String(qtyValueWeiText);
        if (qtyNegative) {
          qtyRaw = String(qtyValueWeiText).slice(1);
        }
        const qtyPadded = qtyRaw.padStart(19, '0');
        const qtyWhole = qtyPadded.slice(0, -18);
        const qtyFraction = qtyPadded.slice(-18, -12);
        let qtyNumber = Number(`${qtyWhole}.${qtyFraction}`);
        if (qtyNegative) {
          qtyNumber = -qtyNumber;
        }
        positions.push({
          symbol: listing.symbol,
          tokenAddress: listing.tokenAddress,
          balanceWei: balanceWei.toString(),
          qty: qtyNumber,
          avgCostCents,
          costBasisWei: effectiveCostBasisWei.toString(),
          priceCents,
          priceSource: valuation.priceSource,
          currentValueWei: currentValueWei.toString(),
          realizedPnlWei: realizedPnlWei.toString(),
          unrealizedPnlWei: unrealizedPnlWei.toString(),
          unrealizedPnlPct,
          totalPnlWei: (realizedPnlWei + unrealizedPnlWei).toString(),
          unmatchedQtyWei: unmatchedQtyWei.toString(),
        });
      }
    }
    positions.sort((a, b) => a.symbol.localeCompare(b.symbol));
    res.json({ wallet, positions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/portfolio/summary', async (req, res) => {
  let walletRaw = '';
  if (req.query.wallet) {
    walletRaw = String(req.query.wallet);
  } else if (req.query.address) {
    walletRaw = String(req.query.address);
  }
  const wallet = normalizeAddress(walletRaw);
  if (!wallet) {
    return res.status(400).json({ error: 'wallet is required' });
  }

  try {
    await ensureIndexerSynced();
    const snapshot = readIndexerSnapshot();
    const deployments = loadDeployments();
    const ttokenAddr = deployments.ttoken;
    const ttokenData = equityTokenInterface.encodeFunctionData('balanceOf', [wallet]);
    const ttokenResult = await hardhatRpc('eth_call', [{ to: ttokenAddr, data: ttokenData }, 'latest']);
    const [cashWeiRaw] = equityTokenInterface.decodeFunctionResult('balanceOf', ttokenResult);
    const cashWei = BigInt(cashWeiRaw.toString());
    const listData = registryListInterface.encodeFunctionData('getAllSymbols', []);
    const listResult = await hardhatRpc('eth_call', [{ to: deployments.listingsRegistry, data: listData }, 'latest']);
    const [symbols] = registryListInterface.decodeFunctionResult('getAllSymbols', listResult);
    const listings = [];
    for (const symbol of symbols) {
      const token = await getListingBySymbol(deployments.listingsRegistry, symbol);
      const hasToken = Boolean(token);
      const isNonZero = token !== ethers.ZeroAddress;
      if (hasToken && isNonZero) {
        listings.push({ symbol, tokenAddress: token });
      }
    }
    const fillRows = [];
    const walletNorm = normalizeAddress(wallet);
    for (const fill of snapshot.fills) {
      if (fill.makerTrader === walletNorm || fill.takerTrader === walletNorm) {
        let side = '';
        if (fill.makerTrader === walletNorm) {
          const makerOrder = snapshot.orders[String(fill.makerId)];
          if (makerOrder) {
            side = makerOrder.side;
          } else {
            side = '';
          }
        } else {
          const takerOrder = snapshot.orders[String(fill.takerId)];
          if (takerOrder) {
            side = takerOrder.side;
          } else {
            side = '';
          }
        }
        fillRows.push({
          symbol: fill.symbol,
          side,
          qtyWei: fill.qtyWei,
          priceCents: fill.priceCents,
          timestampMs: fill.timestampMs,
          blockNumber: fill.blockNumber,
          txHash: fill.txHash,
          logIndex: fill.logIndex,
        });
      }
    }
    fillRows.sort((a, b) => {
      const timestampDiff = a.timestampMs - b.timestampMs;
      if (timestampDiff !== 0) {
        return timestampDiff;
      }
      const blockDiff = a.blockNumber - b.blockNumber;
      if (blockDiff !== 0) {
        return blockDiff;
      }
      const logDiff = a.logIndex - b.logIndex;
      return logDiff;
    });
    const lotsBySymbol = new Map();
    const realizedBySymbol = new Map();
    for (const row of fillRows) {
      if (!lotsBySymbol.has(row.symbol)) {
        lotsBySymbol.set(row.symbol, []);
      }
      if (!realizedBySymbol.has(row.symbol)) {
        realizedBySymbol.set(row.symbol, 0n);
      }
      const lots = lotsBySymbol.get(row.symbol);
      if (row.side === 'BUY') {
        lots.push({ qtyWei: BigInt(row.qtyWei), priceCents: row.priceCents });
      } else if (row.side === 'SELL') {
        let remainingSell = BigInt(row.qtyWei);
        while (remainingSell > 0n && lots.length > 0) {
          const lot = lots[0];
          let consume = lot.qtyWei;
          if (remainingSell < lot.qtyWei) {
            consume = remainingSell;
          }
          const sellQuote = quoteAmountWei(consume, row.priceCents);
          const buyQuote = quoteAmountWei(consume, lot.priceCents);
          const previousRealized = realizedBySymbol.get(row.symbol);
          const nextRealized = previousRealized + (sellQuote - buyQuote);
          realizedBySymbol.set(row.symbol, nextRealized);
          lot.qtyWei -= consume;
          remainingSell -= consume;
          if (lot.qtyWei === 0n) {
            lots.shift();
          }
        }
      }
    }
    const positions = [];
    for (const listing of listings) {
      const balData = equityTokenInterface.encodeFunctionData('balanceOf', [wallet]);
      const balResult = await hardhatRpc('eth_call', [{ to: listing.tokenAddress, data: balData }, 'latest']);
      const [balanceWeiRaw] = equityTokenInterface.decodeFunctionResult('balanceOf', balResult);
      const balanceWei = BigInt(balanceWeiRaw.toString());
      let lots = [];
      const existingLots = lotsBySymbol.get(listing.symbol);
      if (existingLots) {
        lots = existingLots;
      }
      let remaining = BigInt(balanceWei);
      let usedQty = 0n;
      let usedCostWei = 0n;
      for (const lot of lots) {
        if (remaining === 0n) {
          break;
        }
        let useQty = lot.qtyWei;
        if (remaining < lot.qtyWei) {
          useQty = remaining;
        }
        usedQty += useQty;
        usedCostWei += quoteAmountWei(useQty, lot.priceCents);
        remaining -= useQty;
      }
      let unmatchedQtyWei = 0n;
      if (balanceWei > usedQty) {
        unmatchedQtyWei = balanceWei - usedQty;
      }
      let liveCents = 0;
      let symbolText = '';
      if (listing.symbol) {
        symbolText = String(listing.symbol);
      }
      const upper = symbolText.toUpperCase();
      if (upper) {
        const cached = fmpQuoteCache.get(upper);
        if (cached && (Date.now() - cached.timestamp) < FMP_QUOTE_TTL_MS) {
          let cachedPriceRaw = 0;
          if (cached.data.price) {
            cachedPriceRaw = cached.data.price;
          }
          liveCents = Math.round(Number(cachedPriceRaw) * 100);
        } else {
          try {
            const payload = await fetchFmpJson(getFmpUrl('quote-short', { symbol: upper }));
            let quote = payload;
            if (Array.isArray(payload)) {
              quote = payload[0];
            }
            let quotePriceRaw = 0;
            if (quote.price) {
              quotePriceRaw = quote.price;
            }
            const price = Number(quotePriceRaw);
            const data = { symbol: upper, price };
            fmpQuoteCache.set(upper, { data, timestamp: Date.now() });
            liveCents = Math.round(price * 100);
          } catch {
            try {
              const yahoo = await fetchQuote(upper);
              let yahooPriceRaw = 0;
              if (yahoo.regularMarketPrice) {
                yahooPriceRaw = yahoo.regularMarketPrice;
              }
              const price = Number(yahooPriceRaw);
              if (price > 0) {
                const data = { symbol: upper, price, source: 'yahoo' };
                fmpQuoteCache.set(upper, { data, timestamp: Date.now() });
                liveCents = Math.round(price * 100);
              } else {
                try {
                  const candle = await buildCandleFallback(upper);
                  let candlePriceRaw = 0;
                  if (candle.close) {
                    candlePriceRaw = candle.close;
                  }
                  const candlePrice = Number(candlePriceRaw);
                  if (candlePrice > 0) {
                    const data = { symbol: upper, price: candlePrice, source: 'candles' };
                    fmpQuoteCache.set(upper, { data, timestamp: Date.now() });
                    liveCents = Math.round(candlePrice * 100);
                  } else {
                    liveCents = 0;
                  }
                } catch {
                  liveCents = 0;
                }
              }
            } catch {
              try {
                const candle = await buildCandleFallback(upper);
                let candlePriceRaw = 0;
                if (candle.close) {
                  candlePriceRaw = candle.close;
                }
                const candlePrice = Number(candlePriceRaw);
                if (candlePrice > 0) {
                  const data = { symbol: upper, price: candlePrice, source: 'candles' };
                  fmpQuoteCache.set(upper, { data, timestamp: Date.now() });
                  liveCents = Math.round(candlePrice * 100);
                } else {
                  liveCents = 0;
                }
              } catch {
                liveCents = 0;
              }
            }
          }
        }
      }
      const lifecycleStatus = getSymbolLifecycleStatus(listing.symbol);
      let valuation = { priceCents: 0, priceSource: 'NONE' };
      if (lifecycleStatus === 'DELISTED') {
        valuation = { priceCents: 0, priceSource: 'DELISTED' };
      } else if (liveCents > 0) {
        valuation = { priceCents: liveCents, priceSource: 'LIVE' };
      } else {
        const priceFeedAddr = normalizeAddress(deployments.priceFeed);
        if (priceFeedAddr) {
          try {
            const feedData = priceFeedInterface.encodeFunctionData('getPrice', [listing.symbol]);
            const feedResult = await hardhatRpc('eth_call', [{ to: priceFeedAddr, data: feedData }, 'latest']);
            const [onchainPriceRaw] = priceFeedInterface.decodeFunctionResult('getPrice', feedResult);
            const onchainPrice = Number(onchainPriceRaw);
            if (onchainPrice > 0) {
              valuation = { priceCents: onchainPrice, priceSource: 'ONCHAIN_PRICEFEED' };
            }
          } catch {
            // best-effort fallback chain
          }
        }
        if (valuation.priceCents === 0) {
          let latest = null;
          for (const fill of snapshot.fills) {
            if (fill.symbol === listing.symbol) {
              if (!latest) {
                latest = fill;
              } else if (fill.timestampMs > latest.timestampMs) {
                latest = fill;
              } else if (fill.timestampMs === latest.timestampMs && fill.blockNumber > latest.blockNumber) {
                latest = fill;
              }
            }
          }
          let lastFillCents = 0;
          if (latest) {
            let latestPriceRaw = 0;
            if (latest.priceCents) {
              latestPriceRaw = latest.priceCents;
            }
            lastFillCents = Number(latestPriceRaw);
          }
          if (lastFillCents > 0) {
            valuation = { priceCents: lastFillCents, priceSource: 'LAST_FILL' };
          }
        }
      }
      const priceCents = valuation.priceCents;
      let currentValueWei = 0n;
      if (priceCents > 0) {
        currentValueWei = quoteAmountWei(balanceWei, priceCents);
      }
      let unmatchedCostWei = 0n;
      if (priceCents > 0) {
        unmatchedCostWei = quoteAmountWei(unmatchedQtyWei, priceCents);
      }
      const effectiveCostBasisWei = usedCostWei + unmatchedCostWei;
      let avgCostCents = 0;
      if (balanceWei > 0n) {
        avgCostCents = Number((effectiveCostBasisWei * 100n) / balanceWei);
      }
      let realizedPnlWei = 0n;
      const realizedFound = realizedBySymbol.get(listing.symbol);
      if (realizedFound) {
        realizedPnlWei = realizedFound;
      }
      const unrealizedPnlWei = currentValueWei - effectiveCostBasisWei;
      let unrealizedPnlPct = null;
      if (effectiveCostBasisWei > 0n) {
        unrealizedPnlPct = Number(unrealizedPnlWei * 10000n / effectiveCostBasisWei) / 100;
      }
      if (!(balanceWei === 0n && realizedPnlWei === 0n)) {
        const qtyValueWeiText = balanceWei.toString();
        const qtyNegative = String(qtyValueWeiText).startsWith('-');
        let qtyRaw = String(qtyValueWeiText);
        if (qtyNegative) {
          qtyRaw = String(qtyValueWeiText).slice(1);
        }
        const qtyPadded = qtyRaw.padStart(19, '0');
        const qtyWhole = qtyPadded.slice(0, -18);
        const qtyFraction = qtyPadded.slice(-18, -12);
        let qtyNumber = Number(`${qtyWhole}.${qtyFraction}`);
        if (qtyNegative) {
          qtyNumber = -qtyNumber;
        }
        positions.push({
          symbol: listing.symbol,
          tokenAddress: listing.tokenAddress,
          balanceWei: balanceWei.toString(),
          qty: qtyNumber,
          avgCostCents,
          costBasisWei: effectiveCostBasisWei.toString(),
          priceCents,
          priceSource: valuation.priceSource,
          currentValueWei: currentValueWei.toString(),
          realizedPnlWei: realizedPnlWei.toString(),
          unrealizedPnlWei: unrealizedPnlWei.toString(),
          unrealizedPnlPct,
          totalPnlWei: (realizedPnlWei + unrealizedPnlWei).toString(),
          unmatchedQtyWei: unmatchedQtyWei.toString(),
        });
      }
    }
    positions.sort((a, b) => a.symbol.localeCompare(b.symbol));

    let stockValueWei = 0n;
    let totalCostBasisWei = 0n;
    let realizedPnlWei = 0n;
    let unrealizedPnlWei = 0n;
    for (const p of positions) {
      stockValueWei += BigInt(p.currentValueWei);
      totalCostBasisWei += BigInt(p.costBasisWei);
      realizedPnlWei += BigInt(p.realizedPnlWei);
      unrealizedPnlWei += BigInt(p.unrealizedPnlWei);
    }
    let leveragedValueWei = 0n;
    if (deployments.leveragedTokenFactory && deployments.leveragedProductRouter) {
      const countData = leveragedFactoryInterface.encodeFunctionData('productCount', []);
      const countResult = await hardhatRpc('eth_call', [{ to: deployments.leveragedTokenFactory, data: countData }, 'latest']);
      const [countRaw] = leveragedFactoryInterface.decodeFunctionResult('productCount', countResult);
      const count = Number(countRaw);
      for (let i = 0; i < count; i += 1) {
        const itemData = leveragedFactoryInterface.encodeFunctionData('getProductAt', [i]);
        const itemResult = await hardhatRpc('eth_call', [{ to: deployments.leveragedTokenFactory, data: itemData }, 'latest']);
        const [item] = leveragedFactoryInterface.decodeFunctionResult('getProductAt', itemResult);
        const positionData = leveragedRouterInterface.encodeFunctionData('positions', [wallet, item.token]);
        const positionResult = await hardhatRpc('eth_call', [{ to: deployments.leveragedProductRouter, data: positionData }, 'latest']);
        const [qtyWeiRaw] = leveragedRouterInterface.decodeFunctionResult('positions', positionResult);
        const qtyWei = qtyWeiRaw.toString();
        if (BigInt(qtyWei) > 0n) {
          const quoteData = leveragedRouterInterface.encodeFunctionData('previewUnwind', [wallet, item.token, BigInt(qtyWei)]);
          const quoteResult = await hardhatRpc('eth_call', [{ to: deployments.leveragedProductRouter, data: quoteData }, 'latest']);
          const [ttokenOutWeiRaw] = leveragedRouterInterface.decodeFunctionResult('previewUnwind', quoteResult);
          leveragedValueWei += BigInt(ttokenOutWeiRaw.toString());
        }
      }
    }
    const totalValueWei = cashWei + stockValueWei + leveragedValueWei;

    let aggregator = null;
    let drift = null;
    if (deployments.portfolioAggregator) {
      try {
        const aggData = aggregatorInterface.encodeFunctionData('getPortfolioSummary', [wallet]);
        const aggResult = await hardhatRpc('eth_call', [{ to: deployments.portfolioAggregator, data: aggData }, 'latest']);
        const [cashValueWei, stockValueWeiOnchain, totalValueWeiOnchain] = aggregatorInterface.decodeFunctionResult('getPortfolioSummary', aggResult);
        aggregator = {
          cashValueWei: cashValueWei.toString(),
          stockValueWei: stockValueWeiOnchain.toString(),
          totalValueWei: totalValueWeiOnchain.toString(),
        };
        const cashDeltaWei = BigInt(aggregator.cashValueWei) - cashWei;
        const stockDeltaWei = BigInt(aggregator.stockValueWei) - stockValueWei;
        const totalDeltaWei = BigInt(aggregator.totalValueWei) - totalValueWei;
        const toleranceWei = 1n;
        let cashAbs = cashDeltaWei;
        if (cashDeltaWei < 0n) {
          cashAbs = -cashDeltaWei;
        }
        let stockAbs = stockDeltaWei;
        if (stockDeltaWei < 0n) {
          stockAbs = -stockDeltaWei;
        }
        let totalAbs = totalDeltaWei;
        if (totalDeltaWei < 0n) {
          totalAbs = -totalDeltaWei;
        }
        const cashWithin = cashAbs <= toleranceWei;
        const stockWithin = stockAbs <= toleranceWei;
        const totalWithin = totalAbs <= toleranceWei;
        drift = {
          cashDeltaWei: cashDeltaWei.toString(),
          stockDeltaWei: stockDeltaWei.toString(),
          totalDeltaWei: totalDeltaWei.toString(),
          toleranceWei: toleranceWei.toString(),
          withinTolerance: cashWithin && stockWithin && totalWithin,
        };
      } catch {
        aggregator = null;
        drift = null;
      }
    }

    res.json({
      wallet,
      cashValueWei: cashWei.toString(),
      stockValueWei: stockValueWei.toString(),
      leveragedValueWei: leveragedValueWei.toString(),
      totalValueWei: totalValueWei.toString(),
      totalCostBasisWei: totalCostBasisWei.toString(),
      realizedPnlWei: realizedPnlWei.toString(),
      unrealizedPnlWei: unrealizedPnlWei.toString(),
      aggregator,
      drift,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/portfolio/rebuild-audit', async (req, res) => {
  let walletRaw = '';
  if (req.query.wallet) {
    walletRaw = String(req.query.wallet);
  } else if (req.query.address) {
    walletRaw = String(req.query.address);
  }
  const wallet = normalizeAddress(walletRaw);
  if (!wallet) {
    return res.status(400).json({ error: 'wallet is required' });
  }
  try {
    await ensureIndexerSynced();
    const snapshot = readIndexerSnapshot();
    const fillRows = [];
    const walletNorm = normalizeAddress(wallet);
    for (const fill of snapshot.fills) {
      if (fill.makerTrader === walletNorm || fill.takerTrader === walletNorm) {
        let side = '';
        if (fill.makerTrader === walletNorm) {
          const makerOrder = snapshot.orders[String(fill.makerId)];
          if (makerOrder) {
            side = makerOrder.side;
          } else {
            side = '';
          }
        } else {
          const takerOrder = snapshot.orders[String(fill.takerId)];
          if (takerOrder) {
            side = takerOrder.side;
          } else {
            side = '';
          }
        }
        fillRows.push({
          symbol: fill.symbol,
          side,
          qtyWei: fill.qtyWei,
          priceCents: fill.priceCents,
          timestampMs: fill.timestampMs,
          blockNumber: fill.blockNumber,
          txHash: fill.txHash,
          logIndex: fill.logIndex,
        });
      }
    }
    fillRows.sort((a, b) => {
      const timestampDiff = a.timestampMs - b.timestampMs;
      if (timestampDiff !== 0) {
        return timestampDiff;
      }
      const blockDiff = a.blockNumber - b.blockNumber;
      if (blockDiff !== 0) {
        return blockDiff;
      }
      const logDiff = a.logIndex - b.logIndex;
      return logDiff;
    });

    const lotsBySymbol = new Map();
    const realizedBySymbol = new Map();
    for (const row of fillRows) {
      if (!lotsBySymbol.has(row.symbol)) {
        lotsBySymbol.set(row.symbol, []);
      }
      if (!realizedBySymbol.has(row.symbol)) {
        realizedBySymbol.set(row.symbol, 0n);
      }
      const lots = lotsBySymbol.get(row.symbol);
      if (row.side === 'BUY') {
        lots.push({ qtyWei: BigInt(row.qtyWei), priceCents: row.priceCents });
      } else if (row.side === 'SELL') {
        let remainingSell = BigInt(row.qtyWei);
        while (remainingSell > 0n && lots.length > 0) {
          const lot = lots[0];
          let consume = lot.qtyWei;
          if (remainingSell < lot.qtyWei) {
            consume = remainingSell;
          }
          const sellQuote = quoteAmountWei(consume, row.priceCents);
          const buyQuote = quoteAmountWei(consume, lot.priceCents);
          const previousRealized = realizedBySymbol.get(row.symbol);
          const nextRealized = previousRealized + (sellQuote - buyQuote);
          realizedBySymbol.set(row.symbol, nextRealized);
          lot.qtyWei -= consume;
          remainingSell -= consume;
          if (lot.qtyWei === 0n) {
            lots.shift();
          }
        }
      }
    }
    const lotStates = [];
    for (const [symbol, lots] of lotsBySymbol.entries()) {
      const openLots = [];
      for (let i = 0; i < lots.length; i += 1) {
        const lot = lots[i];
        openLots.push({
          qtyWei: lot.qtyWei.toString(),
          priceCents: lot.priceCents,
          lotCostWei: quoteAmountWei(lot.qtyWei, lot.priceCents).toString(),
        });
      }

      let realizedValue = 0n;
      const foundRealized = realizedBySymbol.get(symbol);
      if (foundRealized) {
        realizedValue = foundRealized;
      }

      lotStates.push({
        symbol,
        openLots,
        realizedPnlWei: realizedValue.toString(),
      });
    }
    lotStates.sort((a, b) => a.symbol.localeCompare(b.symbol));
    const payload = {
      wallet,
      fillCount: fillRows.length,
      lotStates,
      lastIndexedBlock: snapshot.state.lastIndexedBlock,
    };
    const checksum = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    res.json({
      wallet,
      processedFillCount: fillRows.length,
      lotStates,
      lastIndexedBlock: snapshot.state.lastIndexedBlock,
      checksum,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dividends/epochs', async (req, res) => {
  let symbolRaw = '';
  if (req.query.symbol) {
    symbolRaw = String(req.query.symbol);
  }
  const symbol = symbolRaw.toUpperCase();
  if (!symbol) {
    return res.status(400).json({ error: 'symbol is required' });
  }
  try {
    const deployments = loadDeployments();
    if (!deployments.dividends) {
      return res.status(400).json({ error: 'dividends contract not deployed' });
    }
    const tokenAddress = await getListingBySymbol(deployments.listingsRegistry, symbol);
    if (!tokenAddress || tokenAddress === ethers.ZeroAddress) {
      return res.status(404).json({ error: 'symbol not listed' });
    }

    const countData = dividendsInterface.encodeFunctionData('epochCount', [tokenAddress]);
    const countResult = await hardhatRpc('eth_call', [{ to: deployments.dividends, data: countData }, 'latest']);
    const [countRaw] = dividendsInterface.decodeFunctionResult('epochCount', countResult);
    const count = Number(countRaw);
    const epochs = [];
    for (let epochId = 1; epochId <= count; epochId++) {
      const epochData = dividendsInterface.encodeFunctionData('epochs', [tokenAddress, epochId]);
      const epochResult = await hardhatRpc('eth_call', [{ to: deployments.dividends, data: epochData }, 'latest']);
      const [snapshotId, divPerShareWei, declaredAt, totalClaimedWei, totalSupplyAtSnapshot] =
        dividendsInterface.decodeFunctionResult('epochs', epochResult);
      epochs.push({
        epochId,
        snapshotId: snapshotId.toString(),
        divPerShareWei: divPerShareWei.toString(),
        declaredAt: Number(declaredAt),
        totalClaimedWei: totalClaimedWei.toString(),
        totalSupplyAtSnapshot: totalSupplyAtSnapshot.toString(),
      });
    }
    res.json({ symbol, tokenAddress, epochs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/dividends/merkle/declare', async (req, res) => {
  try {
    const body = req.body || {};
    const symbol = String(body.symbol || '').toUpperCase();
    const merkleRoot = String(body.merkleRoot || '');
    const totalEntitledWei = String(body.totalEntitledWei || '');
    const claimsUri = String(body.claimsUri || '');
    const contentHash = String(body.contentHash || ethers.ZeroHash);
    const claims = Array.isArray(body.claims) ? body.claims : [];

    if (!symbol || !merkleRoot || !totalEntitledWei) {
      return res.status(400).json({ error: 'symbol, merkleRoot, totalEntitledWei are required' });
    }
    if (!/^0x[a-fA-F0-9]{64}$/.test(merkleRoot)) {
      return res.status(400).json({ error: 'merkleRoot must be 32-byte hex string' });
    }
    if (!/^0x[a-fA-F0-9]{64}$/.test(contentHash)) {
      return res.status(400).json({ error: 'contentHash must be 32-byte hex string' });
    }
    if (!(BigInt(totalEntitledWei) > 0n)) {
      return res.status(400).json({ error: 'totalEntitledWei must be > 0' });
    }

    const deployments = loadDeployments();
    if (!deployments.dividendsMerkle) {
      return res.status(400).json({ error: 'dividends merkle contract not deployed' });
    }

    const tokenAddress = await getListingBySymbol(deployments.listingsRegistry, symbol);
    if (!tokenAddress || tokenAddress === ethers.ZeroAddress) {
      return res.status(404).json({ error: 'symbol not listed' });
    }

    let rawTtokenAddr = '';
    if (deployments.ttoken) {
      rawTtokenAddr = deployments.ttoken;
    } else if (deployments.ttokenAddress) {
      rawTtokenAddr = deployments.ttokenAddress;
    } else if (deployments.TTOKEN_ADDRESS) {
      rawTtokenAddr = deployments.TTOKEN_ADDRESS;
    }
    const ttokenAddr = normalizeAddress(rawTtokenAddr);
    if (!ttokenAddr) {
      throw new Error('ttoken address missing in deployments');
    }
    const minterRoleData = ttokenRoleInterface.encodeFunctionData('MINTER_ROLE', []);
    const minterRoleResult = await hardhatRpc('eth_call', [{ to: ttokenAddr, data: minterRoleData }, 'latest']);
    const [minterRole] = ttokenRoleInterface.decodeFunctionResult('MINTER_ROLE', minterRoleResult);
    const hasMinterRoleData = ttokenRoleInterface.encodeFunctionData('hasRole', [minterRole, deployments.dividendsMerkle]);
    const hasMinterRoleResult = await hardhatRpc('eth_call', [{ to: ttokenAddr, data: hasMinterRoleData }, 'latest']);
    const [hasMinterRole] = ttokenRoleInterface.decodeFunctionResult('hasRole', hasMinterRoleResult);
    if (!hasMinterRole) {
      const grantMinterData = ttokenRoleInterface.encodeFunctionData('grantRole', [minterRole, deployments.dividendsMerkle]);
      const txHash = await hardhatRpc('eth_sendTransaction', [{
        from: deployments.admin,
        to: ttokenAddr,
        data: grantMinterData,
      }]);
      await waitForReceipt(txHash);
    }

    const declareData = dividendsMerkleInterface.encodeFunctionData('declareMerkleDividend', [
      tokenAddress,
      merkleRoot,
      BigInt(totalEntitledWei),
      contentHash,
      claimsUri,
    ]);
    const txHash = await hardhatRpc('eth_sendTransaction', [{
      from: deployments.admin,
      to: deployments.dividendsMerkle,
      data: declareData,
    }]);
    await waitForReceipt(txHash);

    const countData = dividendsMerkleInterface.encodeFunctionData('merkleEpochCount', []);
    const countResult = await hardhatRpc('eth_call', [{ to: deployments.dividendsMerkle, data: countData }, 'latest']);
    const [countRaw] = dividendsMerkleInterface.decodeFunctionResult('merkleEpochCount', countResult);
    const epochId = Number(countRaw);

    writeMerkleTree(epochId, {
      epochId,
      symbol,
      tokenAddress,
      merkleRoot,
      totalEntitledWei: String(totalEntitledWei),
      contentHash,
      claimsUri,
      txHash,
      declaredAtMs: Date.now(),
    });

    const normalizedClaims = [];
    for (let i = 0; i < claims.length; i += 1) {
      const row = claims[i];
      const account = normalizeAddress(String(row.account || ''));
      const amountWei = String(row.amountWei || '0');
      const leafIndex = Number(row.leafIndex);
      const proof = Array.isArray(row.proof) ? row.proof : [];
      if (!account) {
        continue;
      }
      if (!(BigInt(amountWei) > 0n)) {
        continue;
      }
      if (!Number.isFinite(leafIndex) || leafIndex < 0) {
        continue;
      }
      normalizedClaims.push({
        account,
        amountWei,
        leafIndex,
        proof,
      });
    }
    if (normalizedClaims.length > 0) {
      writeMerkleClaims(epochId, {
        epochId,
        symbol,
        tokenAddress,
        merkleRoot,
        claims: normalizedClaims,
      });
    }

    res.json({
      txHash,
      epochId,
      symbol,
      tokenAddress,
      merkleRoot,
      totalEntitledWei: String(totalEntitledWei),
      contentHash,
      claimsUri,
      claimCount: normalizedClaims.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/dividends/merkle/declare-auto', async (req, res) => {
  try {
    const body = req.body || {};
    const symbol = String(body.symbol || '').toUpperCase();
    const divPerShareText = String(body.divPerShare || '').trim();
    const claimsUri = String(body.claimsUri || '');
    if (!symbol || !divPerShareText) {
      return res.status(400).json({ error: 'symbol and divPerShare are required' });
    }
    const divPerShareWei = ethers.parseUnits(divPerShareText, 18);
    if (!(divPerShareWei > 0n)) {
      return res.status(400).json({ error: 'divPerShare must be > 0' });
    }

    const deployments = loadDeployments();
    if (!deployments.dividendsMerkle) {
      return res.status(400).json({ error: 'dividends merkle contract not deployed' });
    }
    const tokenAddress = await getListingBySymbol(deployments.listingsRegistry, symbol);
    if (!tokenAddress || tokenAddress === ethers.ZeroAddress) {
      return res.status(404).json({ error: 'symbol not listed' });
    }

    const snapshotData = equityTokenSnapshotInterface.encodeFunctionData('snapshot', []);
    const snapshotTxHash = await hardhatRpc('eth_sendTransaction', [{
      from: deployments.admin,
      to: tokenAddress,
      data: snapshotData,
    }]);
    const snapshotReceipt = await waitForReceipt(snapshotTxHash);
    const snapshotId = tryParseSnapshotIdFromReceipt(snapshotReceipt);
    if (!(snapshotId > 0)) {
      throw new Error('could not parse snapshot id');
    }

    const latestBlockHex = await hardhatRpc('eth_blockNumber', []);
    const holders = await collectHolderCandidatesFromChain(tokenAddress, latestBlockHex);

    const countData = dividendsMerkleInterface.encodeFunctionData('merkleEpochCount', []);
    const countResult = await hardhatRpc('eth_call', [{ to: deployments.dividendsMerkle, data: countData }, 'latest']);
    const [countRaw] = dividendsMerkleInterface.decodeFunctionResult('merkleEpochCount', countResult);
    const nextEpochId = Number(countRaw) + 1;

    const claims = [];
    for (let i = 0; i < holders.length; i += 1) {
      const account = holders[i];
      const balData = equityTokenSnapshotInterface.encodeFunctionData('balanceOfAt', [account, BigInt(snapshotId)]);
      const balResult = await hardhatRpc('eth_call', [{ to: tokenAddress, data: balData }, 'latest']);
      const [balanceRaw] = equityTokenSnapshotInterface.decodeFunctionResult('balanceOfAt', balResult);
      const balanceWei = BigInt(balanceRaw.toString());
      if (balanceWei <= 0n) {
        continue;
      }
      const amountWei = (balanceWei * divPerShareWei) / (10n ** 18n);
      if (amountWei <= 0n) {
        continue;
      }
      claims.push({
        account,
        amountWei: amountWei.toString(),
      });
    }
    claims.sort((a, b) => a.account.toLowerCase().localeCompare(b.account.toLowerCase()));
    for (let i = 0; i < claims.length; i += 1) {
      claims[i].leafIndex = i;
    }
    if (claims.length === 0) {
      return res.status(400).json({ error: 'no eligible holders at snapshot for merkle declare' });
    }

    const leafHashes = [];
    let totalEntitledWei = 0n;
    for (let i = 0; i < claims.length; i += 1) {
      const row = claims[i];
      const leaf = merkleLeafHash(nextEpochId, tokenAddress, row.account, row.amountWei, row.leafIndex);
      leafHashes.push(leaf);
      totalEntitledWei += BigInt(row.amountWei);
    }
    const levels = buildMerkleLevelsLeftRight(leafHashes);
    const root = levels[levels.length - 1][0];
    for (let i = 0; i < claims.length; i += 1) {
      claims[i].proof = buildMerkleProofLeftRight(levels, i);
    }

    const contentSource = JSON.stringify({
      epochId: nextEpochId,
      symbol,
      tokenAddress,
      snapshotId,
      claims,
    });
    const contentHash = ethers.keccak256(ethers.toUtf8Bytes(contentSource));

    let rawTtokenAddr = '';
    if (deployments.ttoken) {
      rawTtokenAddr = deployments.ttoken;
    } else if (deployments.ttokenAddress) {
      rawTtokenAddr = deployments.ttokenAddress;
    } else if (deployments.TTOKEN_ADDRESS) {
      rawTtokenAddr = deployments.TTOKEN_ADDRESS;
    }
    const ttokenAddr = normalizeAddress(rawTtokenAddr);
    if (!ttokenAddr) {
      throw new Error('ttoken address missing in deployments');
    }
    const minterRoleData = ttokenRoleInterface.encodeFunctionData('MINTER_ROLE', []);
    const minterRoleResult = await hardhatRpc('eth_call', [{ to: ttokenAddr, data: minterRoleData }, 'latest']);
    const [minterRole] = ttokenRoleInterface.decodeFunctionResult('MINTER_ROLE', minterRoleResult);
    const hasMinterRoleData = ttokenRoleInterface.encodeFunctionData('hasRole', [minterRole, deployments.dividendsMerkle]);
    const hasMinterRoleResult = await hardhatRpc('eth_call', [{ to: ttokenAddr, data: hasMinterRoleData }, 'latest']);
    const [hasMinterRole] = ttokenRoleInterface.decodeFunctionResult('hasRole', hasMinterRoleResult);
    if (!hasMinterRole) {
      const grantMinterData = ttokenRoleInterface.encodeFunctionData('grantRole', [minterRole, deployments.dividendsMerkle]);
      const txHash = await hardhatRpc('eth_sendTransaction', [{
        from: deployments.admin,
        to: ttokenAddr,
        data: grantMinterData,
      }]);
      await waitForReceipt(txHash);
    }

    const declareData = dividendsMerkleInterface.encodeFunctionData('declareMerkleDividend', [
      tokenAddress,
      root,
      totalEntitledWei,
      contentHash,
      claimsUri,
    ]);
    const declareTxHash = await hardhatRpc('eth_sendTransaction', [{
      from: deployments.admin,
      to: deployments.dividendsMerkle,
      data: declareData,
    }]);
    await waitForReceipt(declareTxHash);

    const epochId = nextEpochId;
    writeMerkleTree(epochId, {
      epochId,
      symbol,
      tokenAddress,
      snapshotId,
      merkleRoot: root,
      totalEntitledWei: totalEntitledWei.toString(),
      contentHash,
      claimsUri,
      txHash: declareTxHash,
      declaredAtMs: Date.now(),
      levelSizes: levels.map((rows) => rows.length),
      levels,
    });
    writeMerkleClaims(epochId, {
      epochId,
      symbol,
      tokenAddress,
      snapshotId,
      merkleRoot: root,
      claims,
    });

    res.json({
      txHash: declareTxHash,
      epochId,
      symbol,
      tokenAddress,
      snapshotId,
      divPerShareWei: divPerShareWei.toString(),
      merkleRoot: root,
      totalEntitledWei: totalEntitledWei.toString(),
      contentHash,
      claimCount: claims.length,
      levelSizes: levels.map((rows) => rows.length),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dividends/merkle/epochs', async (req, res) => {
  const symbol = String(req.query.symbol || '').toUpperCase();
  try {
    const deployments = loadDeployments();
    if (!deployments.dividendsMerkle) {
      return res.json({ epochs: [] });
    }

    const countData = dividendsMerkleInterface.encodeFunctionData('merkleEpochCount', []);
    const countResult = await hardhatRpc('eth_call', [{ to: deployments.dividendsMerkle, data: countData }, 'latest']);
    const [countRaw] = dividendsMerkleInterface.decodeFunctionResult('merkleEpochCount', countResult);
    const count = Number(countRaw);
    const epochs = [];
    for (let epochId = 1; epochId <= count; epochId += 1) {
      const epochData = dividendsMerkleInterface.encodeFunctionData('getEpoch', [BigInt(epochId)]);
      const epochResult = await hardhatRpc('eth_call', [{ to: deployments.dividendsMerkle, data: epochData }, 'latest']);
      const [row] = dividendsMerkleInterface.decodeFunctionResult('getEpoch', epochResult);
      const epochSymbol = await getSymbolByToken(deployments.listingsRegistry, row.equityToken);
      if (symbol && epochSymbol !== symbol) {
        continue;
      }
      epochs.push({
        epochId,
        symbol: epochSymbol,
        tokenAddress: normalizeAddress(row.equityToken),
        merkleRoot: row.merkleRoot,
        declaredAt: Number(row.declaredAt),
        totalEntitledWei: row.totalEntitledWei.toString(),
        totalClaimedWei: row.totalClaimedWei.toString(),
        contentHash: row.contentHash,
        claimsUri: String(row.claimsUri),
      });
    }
    res.json({ symbol, epochs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dividends/merkle/tree', async (req, res) => {
  const epochId = Number(req.query.epochId);
  if (!Number.isFinite(epochId) || epochId <= 0) {
    return res.status(400).json({ error: 'epochId is required' });
  }
  try {
    const tree = readMerkleTree(epochId);
    const claims = readMerkleClaims(epochId);
    const levels = Array.isArray(tree.levels) ? tree.levels : [];
    const levelSizes = Array.isArray(tree.levelSizes) ? tree.levelSizes : [];
    const previewLevels = [];
    for (let i = 0; i < levels.length; i += 1) {
      const hashes = levels[i];
      const levelRows = [];
      for (let j = 0; j < hashes.length; j += 1) {
        const hash = String(hashes[j]);
        levelRows.push({
          index: j,
          hash,
          shortHash: `${hash.slice(0, 10)}...${hash.slice(-8)}`,
        });
      }
      previewLevels.push({
        level: i,
        size: hashes.length,
        nodes: levelRows,
      });
    }
    res.json({
      epochId,
      symbol: String(tree.symbol || ''),
      tokenAddress: String(tree.tokenAddress || ''),
      snapshotId: Number(tree.snapshotId || 0),
      merkleRoot: String(tree.merkleRoot || ''),
      totalEntitledWei: String(tree.totalEntitledWei || '0'),
      contentHash: String(tree.contentHash || ethers.ZeroHash),
      claimsUri: String(tree.claimsUri || ''),
      claimCount: Array.isArray(claims.claims) ? claims.claims.length : 0,
      levelSizes,
      levels: previewLevels,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dividends/merkle/claimable', async (req, res) => {
  const wallet = normalizeAddress(String(req.query.wallet || ''));
  if (!wallet) {
    return res.status(400).json({ error: 'wallet is required' });
  }
  try {
    const deployments = loadDeployments();
    if (!deployments.dividendsMerkle) {
      return res.json({ wallet, claimables: [] });
    }
    const countData = dividendsMerkleInterface.encodeFunctionData('merkleEpochCount', []);
    const countResult = await hardhatRpc('eth_call', [{ to: deployments.dividendsMerkle, data: countData }, 'latest']);
    const [countRaw] = dividendsMerkleInterface.decodeFunctionResult('merkleEpochCount', countResult);
    const count = Number(countRaw);
    const claimables = [];

    for (let epochId = 1; epochId <= count; epochId += 1) {
      const tree = readMerkleTree(epochId);
      const claimsPayload = readMerkleClaims(epochId);
      const rows = Array.isArray(claimsPayload.claims) ? claimsPayload.claims : [];
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        const account = normalizeAddress(String(row.account || ''));
        if (account !== wallet) {
          continue;
        }
        const leafIndex = Number(row.leafIndex);
        const amountWei = String(row.amountWei || '0');
        const proof = Array.isArray(row.proof) ? row.proof : [];
        const claimedData = dividendsMerkleInterface.encodeFunctionData('isClaimed', [BigInt(epochId), BigInt(leafIndex)]);
        const claimedResult = await hardhatRpc('eth_call', [{ to: deployments.dividendsMerkle, data: claimedData }, 'latest']);
        const [claimed] = dividendsMerkleInterface.decodeFunctionResult('isClaimed', claimedResult);
        claimables.push({
          claimType: 'MERKLE',
          epochId,
          symbol: String(tree.symbol || ''),
          tokenAddress: String(tree.tokenAddress || ''),
          claimableWei: amountWei,
          amountWei,
          leafIndex,
          proof,
          claimed,
          canClaim: !claimed && BigInt(amountWei) > 0n,
          merkleRoot: String(tree.merkleRoot || ''),
          contentHash: String(tree.contentHash || ethers.ZeroHash),
          claimsUri: String(tree.claimsUri || ''),
        });
      }
    }

    res.json({ wallet, claimables });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/dividends/merkle/claim', async (req, res) => {
  try {
    const body = req.body || {};
    const wallet = normalizeAddress(String(body.wallet || ''));
    const account = normalizeAddress(String(body.account || ''));
    const epochId = Number(body.epochId);
    const amountWei = String(body.amountWei || '0');
    const leafIndex = Number(body.leafIndex);
    const proof = Array.isArray(body.proof) ? body.proof : [];

    if (!wallet || !account || wallet !== account) {
      return res.status(400).json({ error: 'wallet and account must match and be valid address' });
    }
    if (!Number.isFinite(epochId) || epochId <= 0) {
      return res.status(400).json({ error: 'epochId must be > 0' });
    }
    if (!(BigInt(amountWei) > 0n)) {
      return res.status(400).json({ error: 'amountWei must be > 0' });
    }
    if (!Number.isFinite(leafIndex) || leafIndex < 0) {
      return res.status(400).json({ error: 'leafIndex must be >= 0' });
    }

    const deployments = loadDeployments();
    if (!deployments.dividendsMerkle) {
      return res.status(400).json({ error: 'dividends merkle contract not deployed' });
    }
    const data = dividendsMerkleInterface.encodeFunctionData('claim', [
      BigInt(epochId),
      account,
      BigInt(amountWei),
      BigInt(leafIndex),
      proof,
    ]);
    const txHash = await hardhatRpc('eth_sendTransaction', [{
      from: wallet,
      to: deployments.dividendsMerkle,
      data,
    }]);
    await waitForReceipt(txHash);
    res.json({ txHash, wallet, account, epochId, amountWei, leafIndex });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dividends/claimables', async (req, res) => {
  const wallet = normalizeAddress(String(req.query.wallet));
  if (!wallet) {
    return res.status(400).json({ error: 'wallet is required' });
  }
  try {
    const deployments = loadDeployments();
    if (!deployments.dividends) {
      return res.json({ wallet, claimables: [] });
    }
    const listData = registryListInterface.encodeFunctionData('getAllSymbols', []);
    const listResult = await hardhatRpc('eth_call', [{ to: deployments.listingsRegistry, data: listData }, 'latest']);
    const [symbols] = registryListInterface.decodeFunctionResult('getAllSymbols', listResult);
    const listings = [];
    for (const symbol of symbols) {
      const token = await getListingBySymbol(deployments.listingsRegistry, symbol);
      const hasToken = Boolean(token);
      const isNonZero = token !== ethers.ZeroAddress;
      if (hasToken && isNonZero) {
        listings.push({ symbol, tokenAddress: token });
      }
    }
    const claimables = [];

    for (const listing of listings) {
      const countData = dividendsInterface.encodeFunctionData('epochCount', [listing.tokenAddress]);
      const countResult = await hardhatRpc('eth_call', [{ to: deployments.dividends, data: countData }, 'latest']);
      const [countRaw] = dividendsInterface.decodeFunctionResult('epochCount', countResult);
      const count = Number(countRaw);
      for (let epochId = 1; epochId <= count; epochId++) {
        const previewData = dividendsInterface.encodeFunctionData('previewClaim', [listing.tokenAddress, epochId, wallet]);
        const previewResult = await hardhatRpc('eth_call', [{ to: deployments.dividends, data: previewData }, 'latest']);
        const [claimableWeiRaw] = dividendsInterface.decodeFunctionResult('previewClaim', previewResult);
        const claimableWei = claimableWeiRaw.toString();
        const claimedData = dividendsInterface.encodeFunctionData('isClaimed', [listing.tokenAddress, epochId, wallet]);
        const claimedResult = await hardhatRpc('eth_call', [{ to: deployments.dividends, data: claimedData }, 'latest']);
        const [claimed] = dividendsInterface.decodeFunctionResult('isClaimed', claimedResult);
        claimables.push({
          claimType: 'SNAPSHOT',
          symbol: listing.symbol,
          tokenAddress: listing.tokenAddress,
          epochId,
          claimableWei,
          claimed,
          canClaim: BigInt(claimableWei) > 0n && !claimed,
        });
      }
    }

    if (deployments.dividendsMerkle) {
      const countData = dividendsMerkleInterface.encodeFunctionData('merkleEpochCount', []);
      const countResult = await hardhatRpc('eth_call', [{ to: deployments.dividendsMerkle, data: countData }, 'latest']);
      const [countRaw] = dividendsMerkleInterface.decodeFunctionResult('merkleEpochCount', countResult);
      const count = Number(countRaw);
      for (let epochId = 1; epochId <= count; epochId += 1) {
        const tree = readMerkleTree(epochId);
        const claimsPayload = readMerkleClaims(epochId);
        const rows = Array.isArray(claimsPayload.claims) ? claimsPayload.claims : [];
        for (let i = 0; i < rows.length; i += 1) {
          const row = rows[i];
          const account = normalizeAddress(String(row.account || ''));
          if (account !== wallet) {
            continue;
          }
          const amountWei = String(row.amountWei || '0');
          const leafIndex = Number(row.leafIndex);
          const proof = Array.isArray(row.proof) ? row.proof : [];
          const claimedData = dividendsMerkleInterface.encodeFunctionData('isClaimed', [BigInt(epochId), BigInt(leafIndex)]);
          const claimedResult = await hardhatRpc('eth_call', [{ to: deployments.dividendsMerkle, data: claimedData }, 'latest']);
          const [claimed] = dividendsMerkleInterface.decodeFunctionResult('isClaimed', claimedResult);
          claimables.push({
            claimType: 'MERKLE',
            symbol: String(tree.symbol || ''),
            tokenAddress: String(tree.tokenAddress || ''),
            epochId,
            claimableWei: amountWei,
            amountWei,
            leafIndex,
            proof,
            claimed,
            canClaim: BigInt(amountWei) > 0n && !claimed,
            merkleRoot: String(tree.merkleRoot || ''),
            contentHash: String(tree.contentHash || ethers.ZeroHash),
            claimsUri: String(tree.claimsUri || ''),
          });
        }
      }
    }

    res.json({ wallet, claimables });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dividends/claimable', async (req, res) => {
  const wallet = normalizeAddress(String(req.query.wallet));
  const symbol = String(req.query.symbol).toUpperCase();
  const epochId = Number(req.query.epochId);
  if (!wallet || !symbol || !Number.isFinite(epochId) || epochId <= 0) {
    return res.status(400).json({ error: 'wallet, symbol, epochId are required' });
  }
  try {
    const deployments = loadDeployments();
    if (!deployments.dividends) {
      return res.status(400).json({ error: 'dividends contract not deployed' });
    }
    const tokenAddress = await getListingBySymbol(deployments.listingsRegistry, symbol);
    if (!tokenAddress || tokenAddress === ethers.ZeroAddress) {
      return res.status(404).json({ error: 'symbol not listed' });
    }
    const previewData = dividendsInterface.encodeFunctionData('previewClaim', [tokenAddress, epochId, wallet]);
    const previewResult = await hardhatRpc('eth_call', [{ to: deployments.dividends, data: previewData }, 'latest']);
    const [claimableWeiRaw] = dividendsInterface.decodeFunctionResult('previewClaim', previewResult);
    const claimableWei = claimableWeiRaw.toString();
    const claimedData = dividendsInterface.encodeFunctionData('isClaimed', [tokenAddress, epochId, wallet]);
    const claimedResult = await hardhatRpc('eth_call', [{ to: deployments.dividends, data: claimedData }, 'latest']);
    const [claimed] = dividendsInterface.decodeFunctionResult('isClaimed', claimedResult);
    res.json({
      wallet,
      symbol,
      tokenAddress,
      epochId,
      claimableWei,
      claimed,
      canClaim: BigInt(claimableWei) > 0n && !claimed,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/dividends/declare', async (req, res) => {
  try {
    const body = req.body;
    const symbol = String(body.symbol).toUpperCase();
    const divPerShare = String(body.divPerShare);
    if (!symbol || !divPerShare) {
      return res.status(400).json({ error: 'symbol and divPerShare are required' });
    }
    const deployments = loadDeployments();
    if (!deployments.dividends) {
      return res.status(400).json({ error: 'dividends contract not deployed' });
    }
    const tokenAddress = await getListingBySymbol(deployments.listingsRegistry, symbol);
    if (!tokenAddress || tokenAddress === ethers.ZeroAddress) {
      return res.status(404).json({ error: 'symbol not listed' });
    }
    const dividendsAddr = deployments.dividends;
    if (!dividendsAddr) {
      throw new Error('dividends contract not deployed');
    }
    const snapshotRoleData = equityTokenRoleInterface.encodeFunctionData('SNAPSHOT_ROLE', []);
    const snapshotRoleResult = await hardhatRpc('eth_call', [{ to: tokenAddress, data: snapshotRoleData }, 'latest']);
    const [snapshotRole] = equityTokenRoleInterface.decodeFunctionResult('SNAPSHOT_ROLE', snapshotRoleResult);
    const hasSnapshotRoleData = equityTokenRoleInterface.encodeFunctionData('hasRole', [snapshotRole, dividendsAddr]);
    const hasSnapshotRoleResult = await hardhatRpc('eth_call', [{ to: tokenAddress, data: hasSnapshotRoleData }, 'latest']);
    const [hasSnapshotRole] = equityTokenRoleInterface.decodeFunctionResult('hasRole', hasSnapshotRoleResult);
    if (!hasSnapshotRole) {
      const grantSnapshotData = equityTokenRoleInterface.encodeFunctionData('grantRole', [snapshotRole, dividendsAddr]);
      const txHash = await hardhatRpc('eth_sendTransaction', [{
        from: deployments.admin,
        to: tokenAddress,
        data: grantSnapshotData,
      }]);
      await waitForReceipt(txHash);
    }
    let rawTtokenAddr = '';
    if (deployments.ttoken) {
      rawTtokenAddr = deployments.ttoken;
    } else if (deployments.ttokenAddress) {
      rawTtokenAddr = deployments.ttokenAddress;
    } else if (deployments.TTOKEN_ADDRESS) {
      rawTtokenAddr = deployments.TTOKEN_ADDRESS;
    }
    const ttokenAddr = normalizeAddress(rawTtokenAddr);
    if (!ttokenAddr) {
      throw new Error('ttoken address missing in deployments');
    }
    const minterRoleData = ttokenRoleInterface.encodeFunctionData('MINTER_ROLE', []);
    const minterRoleResult = await hardhatRpc('eth_call', [{ to: ttokenAddr, data: minterRoleData }, 'latest']);
    const [minterRole] = ttokenRoleInterface.decodeFunctionResult('MINTER_ROLE', minterRoleResult);
    const hasMinterRoleData = ttokenRoleInterface.encodeFunctionData('hasRole', [minterRole, dividendsAddr]);
    const hasMinterRoleResult = await hardhatRpc('eth_call', [{ to: ttokenAddr, data: hasMinterRoleData }, 'latest']);
    const [hasMinterRole] = ttokenRoleInterface.decodeFunctionResult('hasRole', hasMinterRoleResult);
    if (!hasMinterRole) {
      const grantMinterData = ttokenRoleInterface.encodeFunctionData('grantRole', [minterRole, dividendsAddr]);
      const txHash = await hardhatRpc('eth_sendTransaction', [{
        from: deployments.admin,
        to: ttokenAddr,
        data: grantMinterData,
      }]);
      await waitForReceipt(txHash);
    }

    const divPerShareText = String(divPerShare).trim();
    const divPerShareWei = ethers.parseUnits(divPerShareText, 18);
    const data = dividendsInterface.encodeFunctionData('declareDividendPerShare', [tokenAddress, divPerShareWei]);
    const txHash = await hardhatRpc('eth_sendTransaction', [{
      from: deployments.admin,
      to: deployments.dividends,
      data,
    }]);
    await waitForReceipt(txHash);
    res.json({ txHash, symbol, tokenAddress, divPerShareWei: divPerShareWei.toString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/dividends/claim', async (req, res) => {
  try {
    const body = req.body;
    const wallet = normalizeAddress(String(body.wallet));
    const symbol = String(body.symbol).toUpperCase();
    const epochId = Number(body.epochId);
    if (!wallet || !symbol || !Number.isFinite(epochId) || epochId <= 0) {
      return res.status(400).json({ error: 'wallet, symbol, epochId are required' });
    }
    const deployments = loadDeployments();
    if (!deployments.dividends) {
      return res.status(400).json({ error: 'dividends contract not deployed' });
    }
    const tokenAddress = await getListingBySymbol(deployments.listingsRegistry, symbol);
    if (!tokenAddress || tokenAddress === ethers.ZeroAddress) {
      return res.status(404).json({ error: 'symbol not listed' });
    }
    const dividendsAddr = deployments.dividends;
    if (!dividendsAddr) {
      throw new Error('dividends contract not deployed');
    }
    const snapshotRoleData = equityTokenRoleInterface.encodeFunctionData('SNAPSHOT_ROLE', []);
    const snapshotRoleResult = await hardhatRpc('eth_call', [{ to: tokenAddress, data: snapshotRoleData }, 'latest']);
    const [snapshotRole] = equityTokenRoleInterface.decodeFunctionResult('SNAPSHOT_ROLE', snapshotRoleResult);
    const hasSnapshotRoleData = equityTokenRoleInterface.encodeFunctionData('hasRole', [snapshotRole, dividendsAddr]);
    const hasSnapshotRoleResult = await hardhatRpc('eth_call', [{ to: tokenAddress, data: hasSnapshotRoleData }, 'latest']);
    const [hasSnapshotRole] = equityTokenRoleInterface.decodeFunctionResult('hasRole', hasSnapshotRoleResult);
    if (!hasSnapshotRole) {
      const grantSnapshotData = equityTokenRoleInterface.encodeFunctionData('grantRole', [snapshotRole, dividendsAddr]);
      const txHash = await hardhatRpc('eth_sendTransaction', [{
        from: deployments.admin,
        to: tokenAddress,
        data: grantSnapshotData,
      }]);
      await waitForReceipt(txHash);
    }
    let rawTtokenAddr = '';
    if (deployments.ttoken) {
      rawTtokenAddr = deployments.ttoken;
    } else if (deployments.ttokenAddress) {
      rawTtokenAddr = deployments.ttokenAddress;
    } else if (deployments.TTOKEN_ADDRESS) {
      rawTtokenAddr = deployments.TTOKEN_ADDRESS;
    }
    const ttokenAddr = normalizeAddress(rawTtokenAddr);
    if (!ttokenAddr) {
      throw new Error('ttoken address missing in deployments');
    }
    const minterRoleData = ttokenRoleInterface.encodeFunctionData('MINTER_ROLE', []);
    const minterRoleResult = await hardhatRpc('eth_call', [{ to: ttokenAddr, data: minterRoleData }, 'latest']);
    const [minterRole] = ttokenRoleInterface.decodeFunctionResult('MINTER_ROLE', minterRoleResult);
    const hasMinterRoleData = ttokenRoleInterface.encodeFunctionData('hasRole', [minterRole, dividendsAddr]);
    const hasMinterRoleResult = await hardhatRpc('eth_call', [{ to: ttokenAddr, data: hasMinterRoleData }, 'latest']);
    const [hasMinterRole] = ttokenRoleInterface.decodeFunctionResult('hasRole', hasMinterRoleResult);
    if (!hasMinterRole) {
      const grantMinterData = ttokenRoleInterface.encodeFunctionData('grantRole', [minterRole, dividendsAddr]);
      const txHash = await hardhatRpc('eth_sendTransaction', [{
        from: deployments.admin,
        to: ttokenAddr,
        data: grantMinterData,
      }]);
      await waitForReceipt(txHash);
    }
    const data = dividendsInterface.encodeFunctionData('claimDividend', [tokenAddress, BigInt(epochId)]);
    const txHash = await hardhatRpc('eth_sendTransaction', [{
      from: wallet,
      to: deployments.dividends,
      data,
    }]);
    await waitForReceipt(txHash);
    res.json({ txHash, wallet, symbol, epochId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function buildAwardLeaderboardForEpoch(awardAddress, epochId) {
  const maxData = awardInterface.encodeFunctionData('maxQtyByEpoch', [BigInt(epochId)]);
  const maxResult = await hardhatRpc('eth_call', [{ to: awardAddress, data: maxData }, 'latest']);
  const [maxQtyRaw] = awardInterface.decodeFunctionResult('maxQtyByEpoch', maxResult);
  const maxQtyWei = maxQtyRaw.toString();

  const countData = awardInterface.encodeFunctionData('getEpochTraderCount', [BigInt(epochId)]);
  const countResult = await hardhatRpc('eth_call', [{ to: awardAddress, data: countData }, 'latest']);
  const [countRaw] = awardInterface.decodeFunctionResult('getEpochTraderCount', countResult);
  const count = Number(countRaw);

  const items = [];
  for (let i = 0; i < count; i += 1) {
    const traderData = awardInterface.encodeFunctionData('getEpochTraderAt', [BigInt(epochId), BigInt(i)]);
    const traderResult = await hardhatRpc('eth_call', [{ to: awardAddress, data: traderData }, 'latest']);
    const [traderRaw] = awardInterface.decodeFunctionResult('getEpochTraderAt', traderResult);
    const trader = normalizeAddress(traderRaw);

    const qtyData = awardInterface.encodeFunctionData('qtyByEpochByTrader', [BigInt(epochId), trader]);
    const qtyResult = await hardhatRpc('eth_call', [{ to: awardAddress, data: qtyData }, 'latest']);
    const [qtyRaw] = awardInterface.decodeFunctionResult('qtyByEpochByTrader', qtyResult);
    const qtyWei = qtyRaw.toString();

    const winnerData = awardInterface.encodeFunctionData('isWinner', [BigInt(epochId), trader]);
    const winnerResult = await hardhatRpc('eth_call', [{ to: awardAddress, data: winnerData }, 'latest']);
    const [isWinner] = awardInterface.decodeFunctionResult('isWinner', winnerResult);

    items.push({
      epochId,
      trader,
      qtyWei,
      isWinner,
    });
  }

  items.sort((a, b) => {
    const qtyDiff = BigInt(b.qtyWei) - BigInt(a.qtyWei);
    if (qtyDiff > 0n) {
      return 1;
    }
    if (qtyDiff < 0n) {
      return -1;
    }
    return a.trader.localeCompare(b.trader);
  });

  for (let i = 0; i < items.length; i += 1) {
    items[i].rank = i + 1;
  }

  return {
    epochId,
    maxQtyWei,
    items,
  };
}

async function getAwardStatusSnapshot() {
  const deployments = loadDeployments();
  if (!deployments.award) {
    return { available: false };
  }

  const epochData = awardInterface.encodeFunctionData('currentEpoch', []);
  const epochResult = await hardhatRpc('eth_call', [{ to: deployments.award, data: epochData }, 'latest']);
  const [currentEpochRaw] = awardInterface.decodeFunctionResult('currentEpoch', epochResult);
  const chainCurrentEpoch = Number(currentEpochRaw);

  const epochDurationData = awardInterface.encodeFunctionData('EPOCH_DURATION', []);
  const epochDurationResult = await hardhatRpc('eth_call', [{ to: deployments.award, data: epochDurationData }, 'latest']);
  const [epochDurationRaw] = awardInterface.decodeFunctionResult('EPOCH_DURATION', epochDurationResult);
  const chainEpochDurationSec = Number(epochDurationRaw);

  const rewardData = awardInterface.encodeFunctionData('REWARD_AMOUNT', []);
  const rewardResult = await hardhatRpc('eth_call', [{ to: deployments.award, data: rewardData }, 'latest']);
  const [rewardAmountRaw] = awardInterface.decodeFunctionResult('REWARD_AMOUNT', rewardResult);

  const latestBlock = await hardhatRpc('eth_getBlockByNumber', ['latest', false]);
  const chainNowSec = parseRpcInt(latestBlock.timestamp);
  const wallNowSec = Math.floor(Date.now() / 1000);
  let nowSec = wallNowSec;
  if (chainNowSec > wallNowSec + 120) {
    nowSec = chainNowSec;
  }

  const sessionState = readAwardSessionState();
  let effectiveCurrentEpoch = chainCurrentEpoch;
  if (chainEpochDurationSec > 0) {
    const wallEpoch = Math.floor(nowSec / chainEpochDurationSec);
    if (wallEpoch > effectiveCurrentEpoch) {
      effectiveCurrentEpoch = wallEpoch;
    }
  }
  let epochDurationSec = chainEpochDurationSec;
  if (
    Number.isFinite(sessionState.nextAwardWindowSec)
    && sessionState.nextAwardWindowSec > 0
    && Number.isFinite(sessionState.nextAwardWindowAppliesAtEpoch)
    && sessionState.nextAwardWindowAppliesAtEpoch >= 0
    && effectiveCurrentEpoch >= sessionState.nextAwardWindowAppliesAtEpoch
  ) {
    epochDurationSec = Number(sessionState.nextAwardWindowSec);
  }

  let secondsRemaining = 0;
  if (epochDurationSec > 0) {
    const elapsedSec = nowSec % epochDurationSec;
    secondsRemaining = epochDurationSec - elapsedSec;
    if (secondsRemaining === epochDurationSec) {
      secondsRemaining = 0;
    }
  }

  let sessionTerminated = false;
  if (
    sessionState.terminateNextSession === true
    && Number.isFinite(sessionState.terminateAtEpoch)
    && sessionState.terminateAtEpoch >= 0
    && effectiveCurrentEpoch >= sessionState.terminateAtEpoch
  ) {
    sessionTerminated = true;
    secondsRemaining = 0;
  }

  const currentEpochStartSec = effectiveCurrentEpoch * epochDurationSec;
  const currentEpochEndSec = currentEpochStartSec + epochDurationSec;

  return {
    available: true,
    deployments,
    currentEpoch: effectiveCurrentEpoch,
    chainCurrentEpoch,
    nowSec,
    epochDurationSec,
    chainEpochDurationSec,
    rewardAmountWei: rewardAmountRaw.toString(),
    currentEpochStartSec,
    currentEpochEndSec,
    secondsRemaining,
    sessionTerminated,
    sessionControl: {
      nextAwardWindowSec: Number(sessionState.nextAwardWindowSec),
      nextAwardWindowAppliesAtEpoch: Number(sessionState.nextAwardWindowAppliesAtEpoch),
      terminateNextSession: Boolean(sessionState.terminateNextSession),
      terminateAtEpoch: Number(sessionState.terminateAtEpoch),
      updatedAtMs: Number(sessionState.updatedAtMs || 0),
    },
  };
}

app.get('/api/award/status', async (_req, res) => {
  try {
    const snapshot = await getAwardStatusSnapshot();
    if (!snapshot.available) {
      return res.json({ available: false });
    }

    res.json({
      available: true,
      currentEpoch: snapshot.currentEpoch,
      nowSec: snapshot.nowSec,
      epochDurationSec: snapshot.epochDurationSec,
      chainEpochDurationSec: snapshot.chainEpochDurationSec,
      rewardAmountWei: snapshot.rewardAmountWei,
      currentEpochStartSec: snapshot.currentEpochStartSec,
      currentEpochEndSec: snapshot.currentEpochEndSec,
      secondsRemaining: snapshot.secondsRemaining,
      sessionTerminated: snapshot.sessionTerminated,
      sessionControl: snapshot.sessionControl,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/award/leaderboard', async (req, res) => {
  try {
    const deployments = loadDeployments();
    if (!deployments.award) {
      return res.json({ available: false, items: [] });
    }

    let epochId = Number(req.query.epochId);
    const epochData = awardInterface.encodeFunctionData('currentEpoch', []);
    const epochResult = await hardhatRpc('eth_call', [{ to: deployments.award, data: epochData }, 'latest']);
    const [currentEpochRaw] = awardInterface.decodeFunctionResult('currentEpoch', epochResult);
    const currentEpoch = Number(currentEpochRaw);
    if (!Number.isFinite(epochId) || epochId < 0) {
      epochId = Math.max(0, currentEpoch - 1);
    }

    const leaderboard = await buildAwardLeaderboardForEpoch(deployments.award, epochId);
    res.json({
      available: true,
      epochId,
      currentEpoch,
      maxQtyWei: leaderboard.maxQtyWei,
      items: leaderboard.items,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/award/claimable', async (req, res) => {
  try {
    const wallet = normalizeAddress(String(req.query.wallet || ''));
    if (!wallet) {
      return res.status(400).json({ error: 'wallet is required' });
    }

    const deployments = loadDeployments();
    if (!deployments.award) {
      return res.json({ available: false, wallet, items: [] });
    }

    const epochData = awardInterface.encodeFunctionData('currentEpoch', []);
    const epochResult = await hardhatRpc('eth_call', [{ to: deployments.award, data: epochData }, 'latest']);
    const [currentEpochRaw] = awardInterface.decodeFunctionResult('currentEpoch', epochResult);
    const currentEpoch = Number(currentEpochRaw);

    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const startEpoch = Math.max(0, currentEpoch - limit);
    const items = [];

    for (let epochId = startEpoch; epochId < currentEpoch; epochId += 1) {
      const winnerData = awardInterface.encodeFunctionData('isWinner', [BigInt(epochId), wallet]);
      const winnerResult = await hardhatRpc('eth_call', [{ to: deployments.award, data: winnerData }, 'latest']);
      const [isWinner] = awardInterface.decodeFunctionResult('isWinner', winnerResult);

      const claimedData = awardInterface.encodeFunctionData('hasClaimed', [BigInt(epochId), wallet]);
      const claimedResult = await hardhatRpc('eth_call', [{ to: deployments.award, data: claimedData }, 'latest']);
      const [claimed] = awardInterface.decodeFunctionResult('hasClaimed', claimedResult);

      if (isWinner && !claimed) {
        const qtyData = awardInterface.encodeFunctionData('qtyByEpochByTrader', [BigInt(epochId), wallet]);
        const qtyResult = await hardhatRpc('eth_call', [{ to: deployments.award, data: qtyData }, 'latest']);
        const [qtyWeiRaw] = awardInterface.decodeFunctionResult('qtyByEpochByTrader', qtyResult);

        const maxData = awardInterface.encodeFunctionData('maxQtyByEpoch', [BigInt(epochId)]);
        const maxResult = await hardhatRpc('eth_call', [{ to: deployments.award, data: maxData }, 'latest']);
        const [maxQtyWeiRaw] = awardInterface.decodeFunctionResult('maxQtyByEpoch', maxResult);

        items.push({
          epochId,
          qtyWei: qtyWeiRaw.toString(),
          maxQtyWei: maxQtyWeiRaw.toString(),
          isWinner,
          claimed,
          canClaim: isWinner && !claimed,
        });
      }
    }

    items.sort((a, b) => b.epochId - a.epochId);
    res.json({ available: true, wallet, currentEpoch, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/award/claim', async (req, res) => {
  try {
    const wallet = normalizeAddress(String(req.body.wallet || ''));
    const epochId = Number(req.body.epochId);
    if (!wallet) {
      return res.status(400).json({ error: 'wallet is required' });
    }
    if (!Number.isFinite(epochId) || epochId < 0) {
      return res.status(400).json({ error: 'epochId is required' });
    }

    const deployments = loadDeployments();
    if (!deployments.award) {
      return res.status(400).json({ error: 'award contract not deployed' });
    }

    const data = awardInterface.encodeFunctionData('claimAward', [BigInt(epochId)]);
    const txHash = await hardhatRpc('eth_sendTransaction', [{
      from: wallet,
      to: deployments.award,
      data,
    }]);
    await waitForReceipt(txHash);
    res.json({ txHash, wallet, epochId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/award/current', async (_req, res) => {
  try {
    const deployments = loadDeployments();
    if (!deployments.award) {
      return res.json({ available: false });
    }
    const statusRes = await fetch(`http://127.0.0.1:${PORT}/api/award/status`);
    const statusData = await statusRes.json();
    if (!statusRes.ok) {
      return res.status(500).json({ error: statusData.error || 'failed to load status' });
    }
    const leaderboardRes = await fetch(`http://127.0.0.1:${PORT}/api/award/leaderboard?epochId=${Math.max(0, statusData.currentEpoch - 1)}`);
    const leaderboardData = await leaderboardRes.json();
    const topRow = leaderboardData.items && leaderboardData.items.length > 0 ? leaderboardData.items[0] : null;
    res.json({
      available: true,
      currentEpoch: statusData.currentEpoch,
      previousEpoch: Math.max(0, statusData.currentEpoch - 1),
      topTrader: topRow ? topRow.trader : ethers.ZeroAddress,
      topVolumeWei: topRow ? topRow.qtyWei : "0",
      rewarded: false,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/award/history', async (req, res) => {
  try {
    const deployments = loadDeployments();
    if (!deployments.award) {
      return res.json({ available: false, items: [] });
    }
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
    const epochData = awardInterface.encodeFunctionData('currentEpoch', []);
    const epochResult = await hardhatRpc('eth_call', [{ to: deployments.award, data: epochData }, 'latest']);
    const [currentEpochRaw] = awardInterface.decodeFunctionResult('currentEpoch', epochResult);
    const currentEpoch = Number(currentEpochRaw);
    const rows = [];
    for (let epochId = Math.max(0, currentEpoch - limit); epochId < currentEpoch; epochId += 1) {
      const leaderboard = await buildAwardLeaderboardForEpoch(deployments.award, epochId);
      const topRow = leaderboard.items.length > 0 ? leaderboard.items[0] : null;
      rows.push({
        epochId,
        topTrader: topRow ? topRow.trader : ethers.ZeroAddress,
        topVolumeWei: topRow ? topRow.qtyWei : "0",
        rewarded: false,
      });
    }
    rows.sort((a, b) => b.epochId - a.epochId);
    res.json({ available: true, items: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/award/finalize', async (_req, res) => {
  return res.status(400).json({ error: 'finalize removed in stage 13.5 use /api/award/claim' });
});

app.get('/api/aggregator/summary', async (req, res) => {
  const wallet = normalizeAddress(String(req.query.wallet));
  if (!wallet) {
    return res.status(400).json({ error: 'wallet is required' });
  }
  try {
    const deployments = loadDeployments();
    if (!deployments.portfolioAggregator) {
      return res.json({ available: false });
    }
    const data = aggregatorInterface.encodeFunctionData('getPortfolioSummary', [wallet]);
    const result = await hardhatRpc('eth_call', [{ to: deployments.portfolioAggregator, data }, 'latest']);
    const [cashValueWei, stockValueWei, totalValueWei] = aggregatorInterface.decodeFunctionResult('getPortfolioSummary', result);
    res.json({
      available: true,
      wallet,
      cashValueWei: cashValueWei.toString(),
      stockValueWei: stockValueWei.toString(),
      totalValueWei: totalValueWei.toString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/leveraged/products/create', async (req, res) => {
  try {
    const body = req.body;
    const baseSymbol = String(body.baseSymbol).toUpperCase();
    const leverage = Number(body.leverage);
    if (!baseSymbol || !Number.isFinite(leverage)) {
      return res.status(400).json({ error: 'baseSymbol and leverage are required' });
    }

    const deployments = loadDeployments();
    const factoryAddress = deployments.leveragedTokenFactory;
    if (!factoryAddress) {
      return res.status(400).json({ error: 'leveraged factory not deployed' });
    }

    const data = leveragedFactoryInterface.encodeFunctionData('createLongProduct', [baseSymbol, leverage]);
    const txHash = await hardhatRpc('eth_sendTransaction', [{
      from: deployments.admin,
      to: factoryAddress,
      data,
    }]);
    await waitForReceipt(txHash);

    const lookupData = leveragedFactoryInterface.encodeFunctionData('getProductBySymbol', [`${baseSymbol}${leverage}L`]);
    const lookupResult = await hardhatRpc('eth_call', [{ to: factoryAddress, data: lookupData }, 'latest']);
    const [productToken] = leveragedFactoryInterface.decodeFunctionResult('getProductBySymbol', lookupResult);

    res.json({
      txHash,
      baseSymbol,
      leverage,
      productSymbol: `${baseSymbol}${leverage}L`,
      productToken,
    });
  } catch (err) {
    const message = String(err.message || '');
    let cleanedError = message;
    const reasonMatch = message.match(/reverted with reason string '([^']+)'/);
    if (reasonMatch) {
      cleanedError = reasonMatch[1];
    }
    let statusCode = 500;
    if (cleanedError.includes('product exists')) {
      statusCode = 400;
    } else if (cleanedError.includes('base not listed')) {
      statusCode = 400;
    } else if (cleanedError.includes('leverage not allowed')) {
      statusCode = 400;
    } else if (cleanedError.includes('router not set')) {
      statusCode = 400;
    }
    res.status(statusCode).json({ error: cleanedError });
  }
});

app.get('/api/leveraged/products', async (_req, res) => {
  try {
    const deployments = loadDeployments();
    const factoryAddress = deployments.leveragedTokenFactory;
    if (!factoryAddress) {
      return res.json({ products: [] });
    }

    const countData = leveragedFactoryInterface.encodeFunctionData('productCount', []);
    const countResult = await hardhatRpc('eth_call', [{ to: factoryAddress, data: countData }, 'latest']);
    const [countRaw] = leveragedFactoryInterface.decodeFunctionResult('productCount', countResult);
    const count = Number(countRaw);

    const products = [];
    for (let i = 0; i < count; i += 1) {
      const itemData = leveragedFactoryInterface.encodeFunctionData('getProductAt', [i]);
      const itemResult = await hardhatRpc('eth_call', [{ to: factoryAddress, data: itemData }, 'latest']);
      const [item] = leveragedFactoryInterface.decodeFunctionResult('getProductAt', itemResult);
      products.push({
        productSymbol: item.productSymbol,
        baseSymbol: item.baseSymbol,
        baseToken: item.baseToken,
        leverage: Number(item.leverage),
        isLong: item.isLong,
        token: item.token,
      });
    }
    res.json({ products });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/leveraged/mint', async (req, res) => {
  try {
    const body = req.body;
    const wallet = normalizeAddress(String(body.wallet));
    const productSymbol = String(body.productSymbol).toUpperCase();
    const ttokenInWei = BigInt(String(body.ttokenInWei));
    let minOutWei = 0n;
    if (body.minOutWei) {
      minOutWei = BigInt(String(body.minOutWei));
    }
    if (!wallet || !productSymbol || ttokenInWei <= 0n) {
      return res.status(400).json({ error: 'wallet, productSymbol, ttokenInWei are required' });
    }

    const deployments = loadDeployments();
    const factoryAddress = deployments.leveragedTokenFactory;
    const routerAddress = deployments.leveragedProductRouter;
    const ttokenAddress = getTTokenAddressFromDeployments();
    if (!factoryAddress || !routerAddress || !ttokenAddress) {
      return res.status(400).json({ error: 'leveraged contracts not deployed' });
    }

    const lookupData = leveragedFactoryInterface.encodeFunctionData('getProductBySymbol', [productSymbol]);
    const lookupResult = await hardhatRpc('eth_call', [{ to: factoryAddress, data: lookupData }, 'latest']);
    const [productTokenRaw] = leveragedFactoryInterface.decodeFunctionResult('getProductBySymbol', lookupResult);
    const productToken = normalizeAddress(productTokenRaw);
    if (!productToken || productToken === ethers.ZeroAddress) {
      return res.status(404).json({ error: 'product not found' });
    }

    const parsedProduct = parseLeveragedProductSymbol(productSymbol);
    if (parsedProduct.baseSymbol) {
      const ensurePriceResult = await ensureOnchainPriceForSymbol(parsedProduct.baseSymbol);
      if (!ensurePriceResult.ok) {
        return res.status(400).json({ error: ensurePriceResult.error });
      }
    }

    const approveData = equityTokenInterface.encodeFunctionData('approve', [routerAddress, ttokenInWei]);
    const approveTxHash = await hardhatRpc('eth_sendTransaction', [{
      from: wallet,
      to: ttokenAddress,
      data: approveData,
    }]);
    await waitForReceipt(approveTxHash);

    const mintData = leveragedRouterInterface.encodeFunctionData('mintLong', [productToken, ttokenInWei, minOutWei]);
    const txHash = await hardhatRpc('eth_sendTransaction', [{
      from: wallet,
      to: routerAddress,
      data: mintData,
    }]);
    await waitForReceipt(txHash);

    res.json({ txHash, approveTxHash, wallet, productSymbol, productToken, ttokenInWei: ttokenInWei.toString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/leveraged/unwind', async (req, res) => {
  try {
    const body = req.body;
    const wallet = normalizeAddress(String(body.wallet));
    const productSymbol = String(body.productSymbol).toUpperCase();
    const qtyWei = BigInt(String(body.qtyWei));
    let minOutWei = 0n;
    if (body.minOutWei) {
      minOutWei = BigInt(String(body.minOutWei));
    }
    if (!wallet || !productSymbol || qtyWei <= 0n) {
      return res.status(400).json({ error: 'wallet, productSymbol, qtyWei are required' });
    }

    const deployments = loadDeployments();
    const factoryAddress = deployments.leveragedTokenFactory;
    const routerAddress = deployments.leveragedProductRouter;
    const ttokenAddress = getTTokenAddressFromDeployments();
    if (!factoryAddress || !routerAddress || !ttokenAddress) {
      return res.status(400).json({ error: 'leveraged contracts not deployed' });
    }

    const lookupData = leveragedFactoryInterface.encodeFunctionData('getProductBySymbol', [productSymbol]);
    const lookupResult = await hardhatRpc('eth_call', [{ to: factoryAddress, data: lookupData }, 'latest']);
    const [productTokenRaw] = leveragedFactoryInterface.decodeFunctionResult('getProductBySymbol', lookupResult);
    const productToken = normalizeAddress(productTokenRaw);
    if (!productToken || productToken === ethers.ZeroAddress) {
      return res.status(404).json({ error: 'product not found' });
    }

    const parsedProduct = parseLeveragedProductSymbol(productSymbol);
    if (parsedProduct.baseSymbol) {
      const ensurePriceResult = await ensureOnchainPriceForSymbol(parsedProduct.baseSymbol);
      if (!ensurePriceResult.ok) {
        return res.status(400).json({ error: ensurePriceResult.error });
      }
    }

    const previewData = leveragedRouterInterface.encodeFunctionData('previewUnwind', [wallet, productToken, qtyWei]);
    const previewResult = await hardhatRpc('eth_call', [{ to: routerAddress, data: previewData }, 'latest']);
    const [ttokenOutWeiRaw] = leveragedRouterInterface.decodeFunctionResult('previewUnwind', previewResult);
    const expectedOutWei = BigInt(ttokenOutWeiRaw.toString());

    const routerBalanceData = equityTokenInterface.encodeFunctionData('balanceOf', [routerAddress]);
    const routerBalanceResult = await hardhatRpc('eth_call', [{ to: ttokenAddress, data: routerBalanceData }, 'latest']);
    const [routerBalanceRaw] = equityTokenInterface.decodeFunctionResult('balanceOf', routerBalanceResult);
    const routerBalanceWei = BigInt(routerBalanceRaw.toString());

    if (routerBalanceWei < expectedOutWei) {
      const topUpWei = expectedOutWei - routerBalanceWei;
      const mintData = equityTokenInterface.encodeFunctionData('mint', [routerAddress, topUpWei]);
      const mintTxHash = await hardhatRpc('eth_sendTransaction', [{
        from: deployments.admin,
        to: ttokenAddress,
        data: mintData,
      }]);
      await waitForReceipt(mintTxHash);
    }

    const unwindData = leveragedRouterInterface.encodeFunctionData('unwindLong', [productToken, qtyWei, minOutWei]);
    const txHash = await hardhatRpc('eth_sendTransaction', [{
      from: wallet,
      to: routerAddress,
      data: unwindData,
    }]);
    await waitForReceipt(txHash);

    res.json({ txHash, wallet, productSymbol, productToken, qtyWei: qtyWei.toString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/leveraged/quote', async (req, res) => {
  try {
    const mode = String(req.query.mode).toUpperCase();
    const productSymbol = String(req.query.productSymbol).toUpperCase();
    const deployments = loadDeployments();
    const factoryAddress = deployments.leveragedTokenFactory;
    const routerAddress = deployments.leveragedProductRouter;
    if (!factoryAddress || !routerAddress) {
      return res.status(400).json({ error: 'leveraged contracts not deployed' });
    }

    const lookupData = leveragedFactoryInterface.encodeFunctionData('getProductBySymbol', [productSymbol]);
    const lookupResult = await hardhatRpc('eth_call', [{ to: factoryAddress, data: lookupData }, 'latest']);
    const [productTokenRaw] = leveragedFactoryInterface.decodeFunctionResult('getProductBySymbol', lookupResult);
    const productToken = normalizeAddress(productTokenRaw);
    if (!productToken || productToken === ethers.ZeroAddress) {
      return res.status(404).json({ error: 'product not found' });
    }

    const parsedProduct = parseLeveragedProductSymbol(productSymbol);
    if (parsedProduct.baseSymbol) {
      const ensurePriceResult = await ensureOnchainPriceForSymbol(parsedProduct.baseSymbol);
      if (!ensurePriceResult.ok) {
        return res.status(400).json({ error: ensurePriceResult.error });
      }
    }

    if (mode === 'MINT') {
      const ttokenInWei = BigInt(String(req.query.ttokenInWei));
      const data = leveragedRouterInterface.encodeFunctionData('previewMint', [productToken, ttokenInWei]);
      const result = await hardhatRpc('eth_call', [{ to: routerAddress, data }, 'latest']);
      const [productOutWei, navCents] = leveragedRouterInterface.decodeFunctionResult('previewMint', result);
      return res.json({
        mode: 'MINT',
        productSymbol,
        productToken,
        productOutWei: productOutWei.toString(),
        navCents: navCents.toString(),
      });
    }

    if (mode === 'UNWIND') {
      const wallet = normalizeAddress(String(req.query.wallet));
      const qtyWei = BigInt(String(req.query.qtyWei));
      const data = leveragedRouterInterface.encodeFunctionData('previewUnwind', [wallet, productToken, qtyWei]);
      const result = await hardhatRpc('eth_call', [{ to: routerAddress, data }, 'latest']);
      const [ttokenOutWei, navCents] = leveragedRouterInterface.decodeFunctionResult('previewUnwind', result);
      return res.json({
        mode: 'UNWIND',
        wallet,
        productSymbol,
        productToken,
        ttokenOutWei: ttokenOutWei.toString(),
        navCents: navCents.toString(),
      });
    }

    return res.status(400).json({ error: 'mode must be MINT or UNWIND' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/leveraged/price-adjust', async (req, res) => {
  try {
    const body = req.body;
    const productSymbol = String(body.productSymbol || '').toUpperCase();
    const changePct = Number(body.changePct);
    if (!productSymbol || !Number.isFinite(changePct)) {
      return res.status(400).json({ error: 'productSymbol and changePct are required' });
    }

    const parsed = parseLeveragedProductSymbol(productSymbol);
    if (!parsed.baseSymbol) {
      return res.status(400).json({ error: 'invalid productSymbol' });
    }

    const currentPriceResult = await ensureOnchainPriceForSymbol(parsed.baseSymbol);
    if (!currentPriceResult.ok) {
      return res.status(400).json({ error: currentPriceResult.error });
    }

    const currentPriceCents = Number(currentPriceResult.priceCents);
    const nextPriceFloat = currentPriceCents * (1 + (changePct / 100));
    let nextPriceCents = Math.round(nextPriceFloat);
    if (nextPriceCents < 1) {
      nextPriceCents = 1;
    }

    const updateResult = await setOnchainPriceForSymbol(parsed.baseSymbol, nextPriceCents);
    if (!updateResult.ok) {
      return res.status(400).json({ error: updateResult.error });
    }

    res.json({
      productSymbol,
      baseSymbol: parsed.baseSymbol,
      changePct,
      previousPriceCents: currentPriceCents,
      nextPriceCents,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/leveraged/positions', async (req, res) => {
  try {
    const wallet = normalizeAddress(String(req.query.wallet));
    if (!wallet) {
      return res.status(400).json({ error: 'wallet is required' });
    }
    const deployments = loadDeployments();
    const factoryAddress = deployments.leveragedTokenFactory;
    const routerAddress = deployments.leveragedProductRouter;
    if (!factoryAddress || !routerAddress) {
      return res.json({ wallet, positions: [] });
    }

    const countData = leveragedFactoryInterface.encodeFunctionData('productCount', []);
    const countResult = await hardhatRpc('eth_call', [{ to: factoryAddress, data: countData }, 'latest']);
    const [countRaw] = leveragedFactoryInterface.decodeFunctionResult('productCount', countResult);
    const count = Number(countRaw);

    const positions = [];
    for (let i = 0; i < count; i += 1) {
      const itemData = leveragedFactoryInterface.encodeFunctionData('getProductAt', [i]);
      const itemResult = await hardhatRpc('eth_call', [{ to: factoryAddress, data: itemData }, 'latest']);
      const [item] = leveragedFactoryInterface.decodeFunctionResult('getProductAt', itemResult);

      const positionData = leveragedRouterInterface.encodeFunctionData('positions', [wallet, item.token]);
      const positionResult = await hardhatRpc('eth_call', [{ to: routerAddress, data: positionData }, 'latest']);
      const [qtyWeiRaw, avgEntryPriceCentsRaw] = leveragedRouterInterface.decodeFunctionResult('positions', positionResult);
      const qtyWei = qtyWeiRaw.toString();
      const avgEntryPriceCents = avgEntryPriceCentsRaw.toString();
      if (BigInt(qtyWei) > 0n) {
        const quoteData = leveragedRouterInterface.encodeFunctionData('previewUnwind', [wallet, item.token, BigInt(qtyWei)]);
        const quoteResult = await hardhatRpc('eth_call', [{ to: routerAddress, data: quoteData }, 'latest']);
        const [ttokenOutWeiRaw, navCentsRaw] = leveragedRouterInterface.decodeFunctionResult('previewUnwind', quoteResult);
        const currentValueWei = ttokenOutWeiRaw.toString();
        const navCents = navCentsRaw.toString();
        const costBasisWei = (BigInt(qtyWei) / BigInt(Number(item.leverage))).toString();
        const unrealizedPnlWei = (BigInt(currentValueWei) - BigInt(costBasisWei)).toString();
        const currentPriceWei = ((BigInt(currentValueWei) * 1000000000000000000n) / BigInt(qtyWei)).toString();
        let basePriceCents = 0;
        let baseChangePct = 0;
        try {
          const quote = await fetchQuote(String(item.baseSymbol).toUpperCase());
          if (quote.regularMarketPrice) {
            basePriceCents = Math.round(Number(quote.regularMarketPrice) * 100);
          }
          if (quote.regularMarketChangePercent) {
            baseChangePct = Number(quote.regularMarketChangePercent) * 100;
          }
        } catch {
        }
        if (!(basePriceCents > 0)) {
          basePriceCents = Number(navCents);
        }
        positions.push({
          productSymbol: item.productSymbol,
          baseSymbol: item.baseSymbol,
          leverage: Number(item.leverage),
          token: item.token,
          qtyWei,
          avgEntryPriceCents,
          navCents,
          currentValueWei,
          currentPriceWei,
          costBasisWei,
          unrealizedPnlWei,
          basePriceCents,
          baseChangePct,
        });
      }
    }

    res.json({ wallet, positions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/symbols/freeze', async (req, res) => {
  try {
    const symbol = String(req.body.symbol || '').toUpperCase();
    if (!symbol) {
      return res.status(400).json({ error: 'symbol is required' });
    }
    const entry = setSymbolLifecycleStatus(symbol, 'FROZEN');
    res.json({ symbol, status: 'FROZEN', entry });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/symbols/unfreeze', async (req, res) => {
  try {
    const symbol = String(req.body.symbol || '').toUpperCase();
    if (!symbol) {
      return res.status(400).json({ error: 'symbol is required' });
    }
    const entry = setSymbolLifecycleStatus(symbol, 'ACTIVE');
    res.json({ symbol, status: 'ACTIVE', entry });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/symbols/delist', async (req, res) => {
  try {
    const symbol = String(req.body.symbol || '').toUpperCase();
    if (!symbol) {
      return res.status(400).json({ error: 'symbol is required' });
    }
    const entry = setSymbolLifecycleStatus(symbol, 'DELISTED');
    res.json({ symbol, status: 'DELISTED', entry });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/symbols/list', async (req, res) => {
  try {
    const symbol = String(req.body.symbol || '').toUpperCase();
    if (!symbol) {
      return res.status(400).json({ error: 'symbol is required' });
    }
    const entry = setSymbolLifecycleStatus(symbol, 'ACTIVE');
    res.json({ symbol, status: 'ACTIVE', entry });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/symbols/status', async (_req, res) => {
  try {
    const symbols = await listAllSymbolsFromRegistry();
    const rows = [];
    for (let i = 0; i < symbols.length; i += 1) {
      const symbol = symbols[i];
      const status = getSymbolLifecycleStatus(symbol);
      const visibleOnMarkets = status !== 'DELISTED';
      const tradable = status === 'ACTIVE';
      rows.push({
        symbol,
        status,
        visibleOnMarkets,
        tradable,
      });
    }
    rows.sort((a, b) => a.symbol.localeCompare(b.symbol));
    res.json({ symbols: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/award/session', async (_req, res) => {
  try {
    const snapshot = await getAwardStatusSnapshot();
    const state = readAwardSessionState();
    res.json({
      available: Boolean(snapshot.available),
      currentEpoch: Number(snapshot.currentEpoch || 0),
      chainEpochDurationSec: Number(snapshot.chainEpochDurationSec || 0),
      activeEpochDurationSec: Number(snapshot.epochDurationSec || 0),
      sessionTerminated: Boolean(snapshot.sessionTerminated),
      nextAwardWindowSec: Number(state.nextAwardWindowSec || 60),
      nextAwardWindowAppliesAtEpoch: Number(state.nextAwardWindowAppliesAtEpoch || -1),
      terminateNextSession: Boolean(state.terminateNextSession),
      terminateAtEpoch: Number(state.terminateAtEpoch || -1),
      updatedAtMs: Number(state.updatedAtMs || 0),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/award/session', async (req, res) => {
  try {
    const body = req.body || {};
    const snapshot = await getAwardStatusSnapshot();
    if (!snapshot.available) {
      return res.status(400).json({ error: 'award contract not deployed' });
    }

    const nextAwardWindowSecRaw = Number(body.nextAwardWindowSec);
    const terminateNextSessionRaw = Boolean(body.terminateNextSession);
    if (!Number.isFinite(nextAwardWindowSecRaw) || nextAwardWindowSecRaw <= 0 || nextAwardWindowSecRaw > 3600) {
      return res.status(400).json({ error: 'nextAwardWindowSec must be between 1 and 3600' });
    }

    const state = readAwardSessionState();
    state.nextAwardWindowSec = Math.floor(nextAwardWindowSecRaw);
    state.nextAwardWindowAppliesAtEpoch = Number(snapshot.currentEpoch) + 1;
    state.terminateNextSession = terminateNextSessionRaw;
    if (terminateNextSessionRaw) {
      state.terminateAtEpoch = Number(snapshot.currentEpoch) + 1;
    } else {
      state.terminateAtEpoch = -1;
    }
    state.updatedAtMs = Date.now();
    writeAwardSessionState(state);

    res.json({
      ok: true,
      nextAwardWindowSec: state.nextAwardWindowSec,
      nextAwardWindowAppliesAtEpoch: state.nextAwardWindowAppliesAtEpoch,
      terminateNextSession: state.terminateNextSession,
      terminateAtEpoch: state.terminateAtEpoch,
      updatedAtMs: state.updatedAtMs,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/autotrade/rules/create', async (req, res) => {
  try {
    const body = req.body || {};
    const wallet = normalizeAddress(String(body.wallet || ''));
    const symbol = String(body.symbol || '').toUpperCase();
    const side = String(body.side || '').toUpperCase();
    const triggerPriceCents = Number(body.triggerPriceCents);
    const qtyWei = String(body.qtyWei || '');
    const maxSlippageBps = Number(body.maxSlippageBps || 0);
    const enabled = Boolean(body.enabled !== false);
    const cooldownSec = Number(body.cooldownSec || 0);
    const maxExecutionsPerDay = Number(body.maxExecutionsPerDay || 0);

    if (!wallet) {
      return res.status(400).json({ error: 'wallet is required' });
    }
    if (!symbol) {
      return res.status(400).json({ error: 'symbol is required' });
    }
    if (side !== 'BUY' && side !== 'SELL') {
      return res.status(400).json({ error: 'side must be BUY or SELL' });
    }
    if (!Number.isFinite(triggerPriceCents) || triggerPriceCents <= 0) {
      return res.status(400).json({ error: 'triggerPriceCents must be > 0' });
    }
    if (!(BigInt(qtyWei) > 0n)) {
      return res.status(400).json({ error: 'qtyWei must be > 0' });
    }

    const state = readAutoTradeState();
    const newRule = {
      id: Number(state.nextRuleId),
      wallet,
      symbol,
      side,
      triggerPriceCents: Number(triggerPriceCents),
      qtyWei: String(qtyWei),
      maxSlippageBps,
      enabled,
      cooldownSec,
      maxExecutionsPerDay,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      lastExecutedAtMs: 0,
      executionsDay: getDateKeyEt(),
      executionsDayCount: 0,
    };
    state.nextRuleId = Number(state.nextRuleId) + 1;
    state.rules.push(newRule);
    state.listenerRunning = true;
    writeAutoTradeState(state);
    await runAutoTradeTick();
    res.json({ rule: normalizeRuleForResponse(newRule) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/autotrade/rules/update', async (req, res) => {
  try {
    const body = req.body || {};
    const ruleId = Number(body.ruleId);
    if (!Number.isFinite(ruleId) || ruleId <= 0) {
      return res.status(400).json({ error: 'ruleId is required' });
    }
    const state = readAutoTradeState();
    let rule = null;
    for (let i = 0; i < state.rules.length; i += 1) {
      if (Number(state.rules[i].id) === ruleId) {
        rule = state.rules[i];
      }
    }
    if (!rule) {
      return res.status(404).json({ error: 'rule not found' });
    }

    if (body.triggerPriceCents !== undefined) {
      const nextTriggerPrice = Number(body.triggerPriceCents);
      if (!Number.isFinite(nextTriggerPrice) || nextTriggerPrice <= 0) {
        return res.status(400).json({ error: 'triggerPriceCents must be > 0' });
      }
      rule.triggerPriceCents = nextTriggerPrice;
    }
    if (body.qtyWei !== undefined) {
      const nextQtyWei = String(body.qtyWei);
      if (!(BigInt(nextQtyWei) > 0n)) {
        return res.status(400).json({ error: 'qtyWei must be > 0' });
      }
      rule.qtyWei = nextQtyWei;
    }
    if (body.maxSlippageBps !== undefined) {
      rule.maxSlippageBps = Number(body.maxSlippageBps);
    }
    if (body.cooldownSec !== undefined) {
      rule.cooldownSec = Number(body.cooldownSec);
    }
    if (body.maxExecutionsPerDay !== undefined) {
      rule.maxExecutionsPerDay = Number(body.maxExecutionsPerDay);
    }
    if (body.enabled !== undefined) {
      rule.enabled = Boolean(body.enabled);
    }
    rule.updatedAtMs = Date.now();

    writeAutoTradeState(state);
    res.json({ rule: normalizeRuleForResponse(rule) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/autotrade/rules/enable', async (req, res) => {
  try {
    const ruleId = Number(req.body.ruleId);
    const state = readAutoTradeState();
    let found = null;
    for (let i = 0; i < state.rules.length; i += 1) {
      const row = state.rules[i];
      if (Number(row.id) === ruleId) {
        row.enabled = true;
        row.updatedAtMs = Date.now();
        found = row;
      }
    }
    if (!found) {
      return res.status(404).json({ error: 'rule not found' });
    }
    writeAutoTradeState(state);
    res.json({ rule: normalizeRuleForResponse(found) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/autotrade/rules/disable', async (req, res) => {
  try {
    const ruleId = Number(req.body.ruleId);
    const state = readAutoTradeState();
    let found = null;
    for (let i = 0; i < state.rules.length; i += 1) {
      const row = state.rules[i];
      if (Number(row.id) === ruleId) {
        row.enabled = false;
        row.updatedAtMs = Date.now();
        found = row;
      }
    }
    if (!found) {
      return res.status(404).json({ error: 'rule not found' });
    }
    writeAutoTradeState(state);
    res.json({ rule: normalizeRuleForResponse(found) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/autotrade/rules/delete', async (req, res) => {
  try {
    const ruleId = Number(req.body.ruleId);
    const state = readAutoTradeState();
    const nextRules = [];
    let removed = false;
    for (let i = 0; i < state.rules.length; i += 1) {
      const row = state.rules[i];
      if (Number(row.id) === ruleId) {
        removed = true;
      } else {
        nextRules.push(row);
      }
    }
    if (!removed) {
      return res.status(404).json({ error: 'rule not found' });
    }
    state.rules = nextRules;
    writeAutoTradeState(state);
    res.json({ removed: true, ruleId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/autotrade/rules', async (req, res) => {
  try {
    const walletRaw = String(req.query.wallet || '');
    const wallet = normalizeAddress(walletRaw);
    const state = readAutoTradeState();
    const rows = [];
    for (let i = 0; i < state.rules.length; i += 1) {
      const row = state.rules[i];
      if (!wallet || row.wallet === wallet) {
        rows.push(normalizeRuleForResponse(row));
      }
    }
    rows.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
    res.json({ wallet, rules: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/autotrade/executions', async (req, res) => {
  try {
    const walletRaw = String(req.query.wallet || '');
    const wallet = normalizeAddress(walletRaw);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const state = readAutoTradeState();
    const rows = [];
    for (let i = 0; i < state.executions.length; i += 1) {
      const row = state.executions[i];
      if (!wallet || row.wallet === wallet) {
        rows.push(normalizeExecutionForResponse(row));
      }
    }
    rows.sort((a, b) => b.executedAtMs - a.executedAtMs);
    res.json({ wallet, executions: rows.slice(0, limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/autotrade/status', async (_req, res) => {
  try {
    const state = readAutoTradeState();
    let enabledCount = 0;
    for (let i = 0; i < state.rules.length; i += 1) {
      if (state.rules[i].enabled) {
        enabledCount += 1;
      }
    }
    res.json({
      listenerRunning: Boolean(state.listenerRunning),
      lastTickAtMs: Number(state.lastTickAtMs || 0),
      ruleCount: state.rules.length,
      enabledRuleCount: enabledCount,
      executionCount: state.executions.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/autotrade/listener/start', async (_req, res) => {
  try {
    const state = readAutoTradeState();
    state.listenerRunning = true;
    state.lastTickAtMs = Number(state.lastTickAtMs || 0);
    writeAutoTradeState(state);
    await runAutoTradeTick();
    res.json({ listenerRunning: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/autotrade/listener/stop', async (_req, res) => {
  try {
    const state = readAutoTradeState();
    state.listenerRunning = false;
    writeAutoTradeState(state);
    res.json({ listenerRunning: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// create equity token
app.post('/api/equity/create', async (req, res) => {
  const body = req.body;
  const symbol = String(body.symbol).toUpperCase();
  const name = String(body.name).trim();
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
    res.status(502).json({ error: err.message });
  }
});
// mint equity token
app.post('/api/equity/mint', async (req, res) => {
  const body = req.body;
  const symbol = String(body.symbol).toUpperCase();
  const to = String(body.to);
  const amount = Number(body.amount);
  if (symbol.length === 0) {
    return res.status(400).json({ error: '' });
  }
  const recipientValid = isValidAddress(to);
  if (!recipientValid) {
    return res.status(400).json({ error: '' });
  }
  const amountIsNumber = Number.isFinite(amount);
  if (!amountIsNumber || amount < 100) {
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
    res.status(502).json({ error: err.message });
  }
});
// create and mint for equity tokens that was not deployed
app.post('/api/equity/create-mint', async (req, res) => {
  const body = req.body;
  const symbol = String(body.symbol).toUpperCase();
  const name = String(body.name).trim();
  const to = String(body.to);
  const amount = Number(body.amount);
  if (symbol.length === 0 || name.length === 0) {
    return res.status(400).json({ error: '' });
  }
  const recipientValid = isValidAddress(to);
  if (!recipientValid) {
    return res.status(400).json({ error: '' });
  }
  const amountIsNumber = Number.isFinite(amount);
  if (!amountIsNumber || amount < 100) {
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
    res.status(502).json({ error: err.message });
  }
});

// rest api to get all the listings and addresses
app.get('/api/registry/listings', async (req, res) => {
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

    let includeDelisted = false;
    if (String(req.query.includeDelisted || '') === '1') {
      includeDelisted = true;
    }

    const listings = [];
    for (const symbol of symbols) {
      const lookup = listingsRegistryInterface.encodeFunctionData('getListing', [symbol]);
      const lookupResult = await hardhatRpc('eth_call', [{ to: registryAddr, data: lookup }, 'latest']);
      const [tokenAddr] = listingsRegistryInterface.decodeFunctionResult('getListing', lookupResult);
      if (tokenAddr !== ethers.ZeroAddress) {
        const lifecycle = getSymbolLifecycleStatus(symbol);
        const shouldHide = lifecycle === 'DELISTED' && !includeDelisted;
        if (!shouldHide) {
          listings.push({ symbol, tokenAddress: tokenAddr, lifecycleStatus: lifecycle });
        }
      }
    }
    res.json({ listings });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// check the balance of all equity tokens
app.get('/api/equity/balances', async (req, res) => {
  const address = String(req.query.address);
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
      if (tokenAddr !== ethers.ZeroAddress) {
        const balData = equityTokenInterface.encodeFunctionData('balanceOf', [address]);
        const balResult = await hardhatRpc('eth_call', [{ to: tokenAddr, data: balData }, 'latest']);
        const [balanceWei] = equityTokenInterface.decodeFunctionResult('balanceOf', balResult);
        balances.push({ symbol, tokenAddress: tokenAddr, balanceWei: balanceWei.toString() });
      }
    }
    res.json({ balances });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// get equity token address by symbol
app.get('/api/equity/address', async (req, res) => {
  const symbol = String(req.query.symbol).toUpperCase();
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
    res.status(502).json({ error: err.message });
  }
});

// get candle info
app.get('/api/candles', async (req, res) => {
  let symbolRaw = 'TSLA';
  if (req.query.symbol) {
    symbolRaw = String(req.query.symbol);
  }
  const symbol = symbolRaw.toUpperCase();

  let dateRaw = '';
  if (req.query.date) {
    dateRaw = String(req.query.date);
  }
  const date = dateRaw;

  let intervalRaw = 5;
  if (req.query.interval) {
    intervalRaw = req.query.interval;
  }
  const interval = Number(intervalRaw);

  let rangeRaw = '1d';
  if (req.query.range) {
    rangeRaw = String(req.query.range);
  }
  const range = rangeRaw;
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
    const msg = err.message;
    let status = 502;
    if (/future|No chart data|No quote data/i.test(msg)) {
      status = 400;
    }
    if (cached) {
      return res.json({ ...cached.data, stale: true });
    }
    res.status(status).json({ error: msg });
  }
});

ensureIndexerDir();
ensureIndexerSynced();
ensureAutoTradeDir();
ensureAdminDir();
ensureDividendsMerkleDir();
if (!fs.existsSync(AUTOTRADE_STATE_FILE)) {
  writeAutoTradeState(getDefaultAutoTradeState());
}
if (!fs.existsSync(SYMBOL_STATUS_FILE)) {
  writeSymbolStatusState(getDefaultSymbolStatusState());
}
if (!fs.existsSync(AWARD_SESSION_FILE)) {
  writeAwardSessionState(getDefaultAwardSessionState());
}
if (fs.existsSync(AUTOTRADE_STATE_FILE)) {
  const autoState = readAutoTradeState();
  autoState.listenerRunning = true;
  writeAutoTradeState(autoState);
}
setInterval(() => {
  ensureIndexerSynced();
}, INDEXER_SYNC_INTERVAL_MS);
setInterval(() => {
  runAutoTradeTick().catch((err) => {
    let msg = 'auto trade interval failed';
    if (err && err.message) {
      msg = err.message;
    }
    console.error('[autotrade]', msg);
  });
}, AUTOTRADE_POLL_INTERVAL_MS);

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
