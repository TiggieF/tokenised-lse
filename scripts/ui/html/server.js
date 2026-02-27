const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { ethers } = require('ethers');
const YahooFinance = require('yahoo-finance2').default;
const { fetchIntradayCandles, aggregateCandles, fetchQuote } = require('./yahoo');

const app = express();
app.use(express.json());
const yahooFinance = new YahooFinance({
  suppressNotices: ['yahooSurvey'],
  queue: { concurrency: 1 },
});
const candleCache = new Map();
const CANDLE_TTL_MS = 300000;
const quoteCache = new Map();
const QUOTE_TTL_MS = 2000;
const fmpQuoteCache = new Map();
const FMP_QUOTE_TTL_MS = 1000;
const fmpInfoCache = new Map();
const FMP_INFO_TTL_MS = 60000;
const fmpDetailsCache = new Map();
const FMP_DETAILS_TTL_MS = 30000;
const fmpIndexTickerCache = new Map();
const FMP_INDEX_TTL_MS = 2000;
const INDEXER_SYNC_INTERVAL_MS = 5000;
// fmp caches
let FMP_API_KEY = 'TNQATNqowKe9Owu1zL9QurgZCXx9Q1BS';
if (process.env.FMP_API_KEY) {
  FMP_API_KEY = process.env.FMP_API_KEY;
}
let HARDHAT_RPC_URL = 'http://127.0.0.1:8545';
if (process.env.RPC_URL) {
  HARDHAT_RPC_URL = process.env.RPC_URL;
}
if (process.env.HARDHAT_RPC_URL) {
  HARDHAT_RPC_URL = process.env.HARDHAT_RPC_URL;
}
let DEPLOYMENTS_NETWORK = 'localhost';
if (process.env.DEFAULT_NETWORK) {
  DEPLOYMENTS_NETWORK = process.env.DEFAULT_NETWORK;
}
if (process.env.DEPLOYMENTS_NETWORK) {
  DEPLOYMENTS_NETWORK = process.env.DEPLOYMENTS_NETWORK;
}
const NETWORK_NAME = String(DEPLOYMENTS_NETWORK || '').toLowerCase();
const DEFAULT_ENABLE_BACKGROUND = NETWORK_NAME !== 'sepolia';
const ENABLE_AUTOTRADE = process.env.ENABLE_AUTOTRADE
  ? String(process.env.ENABLE_AUTOTRADE).toLowerCase() === 'true'
  : DEFAULT_ENABLE_BACKGROUND;
const ENABLE_GAS_PACK = process.env.ENABLE_GAS_PACK
  ? String(process.env.ENABLE_GAS_PACK).toLowerCase() === 'true'
  : DEFAULT_ENABLE_BACKGROUND;
let DEPLOYMENTS_FILE = path.join(__dirname, '../../..', 'deployments', `${DEPLOYMENTS_NETWORK}.json`);
if (process.env.DEPLOYMENTS_FILE) {
  DEPLOYMENTS_FILE = process.env.DEPLOYMENTS_FILE;
}
const RPC_SIGNERS = new Map();
let RPC_RELAYER_SIGNER = null;
const RPC_PROVIDER = new ethers.JsonRpcProvider(HARDHAT_RPC_URL);
function addRpcSigner(privateKeyRaw) {
  let privateKey = '';
  if (privateKeyRaw) {
    privateKey = String(privateKeyRaw).trim();
  }
  if (!privateKey) {
    return;
  }
  try {
    const wallet = new ethers.Wallet(privateKey, RPC_PROVIDER);
    RPC_SIGNERS.set(wallet.address.toLowerCase(), wallet);
  } catch {
  }
}
if (process.env.TX_SIGNER_PRIVATE_KEYS) {
  const all = String(process.env.TX_SIGNER_PRIVATE_KEYS)
    .split(',')
    .map((one) => one.trim())
    .filter(Boolean);
  for (let i = 0; i < all.length; i += 1) {
    addRpcSigner(all[i]);
  }
}
if (process.env.DEPLOYER_PRIVATE_KEY) {
  addRpcSigner(process.env.DEPLOYER_PRIVATE_KEY);
}
if (process.env.MINTER_PRIVATE_KEY) {
  addRpcSigner(process.env.MINTER_PRIVATE_KEY);
}
if (process.env.RPC_RELAYER_PRIVATE_KEY) {
  try {
    RPC_RELAYER_SIGNER = new ethers.Wallet(String(process.env.RPC_RELAYER_PRIVATE_KEY).trim(), RPC_PROVIDER);
    RPC_SIGNERS.set(RPC_RELAYER_SIGNER.address.toLowerCase(), RPC_RELAYER_SIGNER);
  } catch {
    RPC_RELAYER_SIGNER = null;
  }
}
const FMP_US_TOP_SYMBOLS = [
  'AAPL',
  'MSFT',
  'NVDA',
  'AMZN',
  'GOOGL',
  'META',
  'TSLA',
  'BRK-B',
  'AVGO',
  'JPM',
  'WMT',
  'LLY',
  'V',
  'XOM',
  'MA',
  'UNH',
  'JNJ',
  'COST',
  'PG',
  'HD',
];
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
  if (!obj || typeof obj !== 'object') {
    return undefined;
  }
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) {
      const value = obj[k];
      if (value !== undefined && value !== null) {
        return value;
      }
    }
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

async function fetchFmpSpotPrice(symbolRaw) {
  const symbol = String(symbolRaw).toUpperCase().trim();
  if (!symbol) {
    return 0;
  }
  const url = getFmpUrl('quote', { symbol });
  const payload = await fetchFmpJson(url);
  let quote = payload;
  if (Array.isArray(payload)) {
    quote = payload[0];
  }
  const price = asNumber(pick(quote || {}, ['price', 'regularMarketPrice']));
  if (Number.isFinite(price) && price > 0) {
    return price;
  }
  return 0;
}

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
  'function isFresh(string symbol) view returns (bool)',
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
const LIVE_UPDATES_STATE_FILE = path.join(ADMIN_DIR, 'liveUpdates.json');
const ADMIN_WALLETS_STATE_FILE = path.join(ADMIN_DIR, 'adminWallets.json');
const DIVIDENDS_MERKLE_DIR = path.join(__dirname, '../../..', 'cache', 'dividends-merkle');
const MERKLE_HOLDER_SCAN_STATE_FILE = path.join(DIVIDENDS_MERKLE_DIR, 'holder-scan-state.json');
const MERKLE_HOLDER_REORG_LOOKBACK_BLOCKS = (() => {
  const raw = Number(process.env.MERKLE_HOLDER_REORG_LOOKBACK_BLOCKS || '');
  if (Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }
  return 2;
})();
const MERKLE_HOLDER_INITIAL_LOOKBACK_BLOCKS = (() => {
  const raw = Number(process.env.MERKLE_HOLDER_INITIAL_LOOKBACK_BLOCKS || '');
  if (Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }
  if (NETWORK_NAME === 'sepolia') {
    return 5000;
  }
  return 0;
})();
const MIN_STOCK_QTY_UNITS = 10;
const IMMUTABLE_ADMIN_WALLET = normalizeAddress('0x831B6E09dD00D2Cf2f37fe400Fe721DadD044945');
const AUTOTRADE_POLL_INTERVAL_MS = (() => {
  const raw = Number(process.env.AUTOTRADE_POLL_INTERVAL_MS || '');
  if (Number.isFinite(raw) && raw >= 1000) {
    return Math.floor(raw);
  }
  return 3000;
})();
const GAS_WARN_THRESHOLD_PCT = 15;
const GAS_AUTO_RUN_INTERVAL_MS = (() => {
  const raw = Number(process.env.GAS_AUTO_RUN_INTERVAL_MS || '');
  if (Number.isFinite(raw) && raw >= 1000) {
    return Math.floor(raw);
  }
  return 60000;
})();
const GAS_PAGE_POLL_MS = 1500;
const INDEXER_BOOTSTRAP_LOOKBACK_BLOCKS = (() => {
  const raw = Number(process.env.INDEXER_BOOTSTRAP_LOOKBACK_BLOCKS || '');
  if (Number.isFinite(raw) && raw >= 1) {
    return Math.floor(raw);
  }
  if (NETWORK_NAME === 'sepolia') {
    return 300;
  }
  return 5000;
})();
const GET_LOGS_BLOCK_RANGE = (() => {
  const raw = Number(process.env.GET_LOGS_BLOCK_RANGE || '');
  if (Number.isFinite(raw) && raw >= 1) {
    return Math.floor(raw);
  }
  if (NETWORK_NAME === 'sepolia') {
    return 10;
  }
  return 2000;
})();
const INDEXER_ENABLE_TRANSFERS = process.env.INDEXER_ENABLE_TRANSFERS
  ? String(process.env.INDEXER_ENABLE_TRANSFERS).toLowerCase() === 'true'
  : NETWORK_NAME !== 'sepolia';
const INDEXER_ENABLE_LEVERAGED = process.env.INDEXER_ENABLE_LEVERAGED
  ? String(process.env.INDEXER_ENABLE_LEVERAGED).toLowerCase() === 'true'
  : true;
const TXS_ENABLE_LEVERAGE_FALLBACK_SCAN = process.env.TXS_ENABLE_LEVERAGE_FALLBACK_SCAN
  ? String(process.env.TXS_ENABLE_LEVERAGE_FALLBACK_SCAN).toLowerCase() === 'true'
  : false;
const INDEXER_SYNC_WAIT_MS = (() => {
  const raw = Number(process.env.INDEXER_SYNC_WAIT_MS || '');
  if (Number.isFinite(raw) && raw >= 500) {
    return Math.floor(raw);
  }
  if (NETWORK_NAME === 'sepolia') {
    return 4000;
  }
  return 8000;
})();

let indexerSyncPromise = null;
const symbolByTokenCache = new Map();
let autoTradeLoopBusy = false;
let autoTradeLoopStartedAtMs = 0;
let gasRunInFlight = null;
const gasRuntimeState = {
  lastRunAtMs: 0,
  latest: null,
  baseline: {},
};
const AWARD_CACHE_TTL_MS = 3000;
const awardCache = {
  status: null,
  leaderboard: new Map(),
  claimable: new Map(),
};
const txReceiptGasCache = new Map();
const signerTxQueues = new Map();

async function enqueueSignerSend(address, job) {
  const key = String(address || '').toLowerCase();
  const previous = signerTxQueues.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(job);
  signerTxQueues.set(key, next);
  try {
    const result = await next;
    return result;
  } finally {
    if (signerTxQueues.get(key) === next) {
      signerTxQueues.delete(key);
    }
  }
}

async function ensureContract(address) {
  const code = await hardhatRpc('eth_getCode', [address, 'latest']);
  return code !== '0x';
}

// load deployment and get token addresses from local file
function loadDeployments() {
  const raw = fs.readFileSync(DEPLOYMENTS_FILE, 'utf8');
  return JSON.parse(raw);
}

function getBaseAdminWalletAllowlist() {
  const wallets = new Set();
  if (IMMUTABLE_ADMIN_WALLET) {
    wallets.add(IMMUTABLE_ADMIN_WALLET.toLowerCase());
  }
  if (process.env.ADMIN_WALLETS) {
    const rawValues = String(process.env.ADMIN_WALLETS)
      .split(',')
      .map((value) => String(value || '').trim())
      .filter(Boolean);
    for (let i = 0; i < rawValues.length; i += 1) {
      const normalized = normalizeAddress(rawValues[i]);
      if (normalized) {
        wallets.add(normalized.toLowerCase());
      }
    }
  }
  try {
    const deployments = loadDeployments();
    const deployedAdmin = normalizeAddress(deployments.admin);
    if (deployedAdmin) {
      wallets.add(deployedAdmin.toLowerCase());
    }
  } catch {
  }
  return wallets;
}

function getDefaultAdminWalletState() {
  const base = Array.from(getBaseAdminWalletAllowlist())
    .map((item) => normalizeAddress(item))
    .filter(Boolean);
  base.sort((a, b) => a.localeCompare(b));
  return {
    wallets: base,
    updatedAtMs: 0,
  };
}

function readAdminWalletState() {
  ensureAdminDir();
  return readJsonFile(ADMIN_WALLETS_STATE_FILE, getDefaultAdminWalletState());
}

function writeAdminWalletState(state) {
  ensureAdminDir();
  writeJsonFile(ADMIN_WALLETS_STATE_FILE, state);
}

function getAdminWalletAllowlist() {
  const wallets = getBaseAdminWalletAllowlist();
  const state = readAdminWalletState();
  const rows = Array.isArray(state.wallets) ? state.wallets : [];
  for (let i = 0; i < rows.length; i += 1) {
    const normalized = normalizeAddress(rows[i]);
    if (normalized) {
      wallets.add(normalized.toLowerCase());
    }
  }
  return wallets;
}

function isAdminWallet(walletAddress) {
  const normalized = normalizeAddress(walletAddress);
  if (!normalized) {
    return false;
  }
  const allowlist = getAdminWalletAllowlist();
  return allowlist.has(normalized.toLowerCase());
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
    if (Number.isFinite(value)) {
      return value;
    }
    return 0;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'string') {
    const startsWithLowerHex = value.startsWith('0x');
    const startsWithUpperHex = value.startsWith('0X');
    let isHexPrefix = false;
    if (startsWithLowerHex) {
      isHexPrefix = true;
    }
    if (startsWithUpperHex) {
      isHexPrefix = true;
    }
    if (isHexPrefix) {
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

function toOptionalBigInt(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
}

function toOptionalNumber(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  const parsed = parseRpcInt(value);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return undefined;
}

function wantsClientSign(body) {
  if (!body || typeof body !== 'object') {
    return false;
  }
  if (body.clientSign === true) {
    return true;
  }
  if (String(body.clientSign || '').toLowerCase() === 'true') {
    return true;
  }
  return false;
}

async function rpcRequest(method, params = []) {
  let lastError = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const res = await fetch(HARDHAT_RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const text = await res.text();
      if (res.status === 429) {
        let retryAfterSec = 0;
        try {
          const retryHeader = res.headers.get('retry-after');
          if (retryHeader) {
            const parsedRetry = Number(retryHeader);
            if (Number.isFinite(parsedRetry) && parsedRetry > 0) {
              retryAfterSec = parsedRetry;
            }
          }
        } catch {
        }
        let msg = 'RPC rate limit (status 429)';
        if (retryAfterSec > 0) {
          msg += ` retry-after=${retryAfterSec}s`;
        }
        throw new Error(msg);
      }
      let payload = null;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error(`RPC non-JSON response (status ${res.status}): ${String(text).slice(0, 160)}`);
      }
      let hasHttpError = false;
      let hasRpcError = false;
      if (!res.ok) {
        hasHttpError = true;
      }
      if (payload.error) {
        hasRpcError = true;
      }
      let hasAnyError = false;
      if (hasHttpError) {
        hasAnyError = true;
      }
      if (hasRpcError) {
        hasAnyError = true;
      }
      if (hasAnyError) {
        let msg = `RPC ${res.status}`;
        if (payload.error && payload.error.message) {
          msg = payload.error.message;
        }
        throw new Error(msg);
      }
      return payload.result;
    } catch (err) {
      lastError = err;
      const message = String(err && err.message ? err.message : err);
      const retryable = isRpcRateLimitError(message)
        || message.includes('RPC non-JSON response')
        || message.includes('Unexpected end of JSON input');
      if (!retryable || attempt >= 9) {
        throw err;
      }
      let waitMs = 250 * (attempt + 1);
      if (isRpcRateLimitError(message)) {
        waitMs = Math.min(10000, 1000 * (attempt + 1));
      }
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  if (lastError) {
    throw lastError;
  }
  throw new Error('RPC request failed');
}

async function sendSignedRpcTransaction(txRequest) {
  if (!txRequest || typeof txRequest !== 'object') {
    throw new Error('invalid transaction input');
  }
  let from = '';
  if (txRequest.from) {
    from = normalizeAddress(String(txRequest.from));
  }
  let signer = null;
  if (from) {
    signer = RPC_SIGNERS.get(from.toLowerCase()) || null;
  }
  if (!signer && !from && RPC_RELAYER_SIGNER) {
    signer = RPC_RELAYER_SIGNER;
  }
  if (!signer && RPC_RELAYER_SIGNER) {
    const relayerAddress = RPC_RELAYER_SIGNER.address.toLowerCase();
    if (from.toLowerCase() === relayerAddress) {
      signer = RPC_RELAYER_SIGNER;
    }
  }
  if (!signer) {
    throw new Error(`cannot sign tx for ${from || 'unknown sender'}; add key in TX_SIGNER_PRIVATE_KEYS`);
  }

  const tx = {};
  if (txRequest.to) {
    tx.to = txRequest.to;
  }
  if (txRequest.data) {
    tx.data = txRequest.data;
  }
  if (txRequest.value !== undefined) {
    tx.value = toOptionalBigInt(txRequest.value);
  }
  if (txRequest.gas !== undefined) {
    tx.gasLimit = toOptionalBigInt(txRequest.gas);
  }
  if (txRequest.gasLimit !== undefined) {
    tx.gasLimit = toOptionalBigInt(txRequest.gasLimit);
  }
  if (txRequest.gasPrice !== undefined) {
    tx.gasPrice = toOptionalBigInt(txRequest.gasPrice);
  }
  if (txRequest.maxFeePerGas !== undefined) {
    tx.maxFeePerGas = toOptionalBigInt(txRequest.maxFeePerGas);
  }
  if (txRequest.maxPriorityFeePerGas !== undefined) {
    tx.maxPriorityFeePerGas = toOptionalBigInt(txRequest.maxPriorityFeePerGas);
  }
  if (txRequest.nonce !== undefined) {
    tx.nonce = toOptionalNumber(txRequest.nonce);
  }
  if (txRequest.chainId !== undefined) {
    tx.chainId = toOptionalNumber(txRequest.chainId);
  }

  const txHash = await enqueueSignerSend(signer.address, async () => {
    const txResponse = await signer.sendTransaction(tx);
    return txResponse.hash;
  });
  return txHash;
}

// connect to rpc and contracts
async function hardhatRpc(method, params = []) {
  if (method === 'eth_sendTransaction') {
    try {
      return await rpcRequest(method, params);
    } catch (error) {
      const txRequest = Array.isArray(params) ? params[0] : null;
      if (!txRequest) {
        throw error;
      }
      return sendSignedRpcTransaction(txRequest);
    }
  }
  return rpcRequest(method, params);
}

async function canServerSendFromAddress(addressRaw) {
  const address = normalizeAddress(addressRaw);
  if (!address) {
    return false;
  }
  if (RPC_SIGNERS.has(address.toLowerCase())) {
    return true;
  }
  try {
    const accounts = await rpcRequest('eth_accounts', []);
    if (Array.isArray(accounts)) {
      for (let i = 0; i < accounts.length; i += 1) {
        const account = normalizeAddress(accounts[i]);
        if (account && account.toLowerCase() === address.toLowerCase()) {
          return true;
        }
      }
    }
  } catch {
  }
  return false;
}

async function waitForReceipt(txHash, maxTries = 120, pollMs = 1000) {
  for (let i = 0; i < maxTries; i += 1) {
    const receipt = await hardhatRpc('eth_getTransactionReceipt', [txHash]);
    if (receipt) {
      return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`tx not mined yet: ${txHash}`);
}

function parseMaxGetLogsRangeFromError(messageRaw) {
  const message = String(messageRaw || '');
  const direct = message.match(/up to a\s+(\d+)\s+block range/i);
  if (direct && direct[1]) {
    const parsed = Number(direct[1]);
    if (Number.isFinite(parsed) && parsed >= 1) {
      return Math.floor(parsed);
    }
  }
  const hint = message.match(/\[(0x[0-9a-fA-F]+)\s*,\s*(0x[0-9a-fA-F]+)\]/);
  if (hint && hint[1] && hint[2]) {
    const start = parseInt(hint[1], 16);
    const end = parseInt(hint[2], 16);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      return (end - start) + 1;
    }
  }
  return null;
}

function isGetLogsRangeError(messageRaw) {
  const message = String(messageRaw || '').toLowerCase();
  if (!message.includes('eth_getlogs')) {
    return false;
  }
  if (message.includes('block range')) {
    return true;
  }
  if (message.includes('up to a')) {
    return true;
  }
  return false;
}

function isRpcRateLimitError(messageRaw) {
  const message = String(messageRaw || '').toLowerCase();
  if (message.includes('status 429')) {
    return true;
  }
  if (message.includes('rpc rate limit')) {
    return true;
  }
  if (message.includes('exceeded its compute units per second')) {
    return true;
  }
  if (message.includes('rate limit')) {
    return true;
  }
  if (message.includes('too many requests')) {
    return true;
  }
  return false;
}

async function getLogsChunked(baseFilter, startBlock, endBlock) {
  const allLogs = [];
  let from = Number(startBlock);
  const end = Number(endBlock);
  let chunkSize = Math.max(1, GET_LOGS_BLOCK_RANGE);
  let rateRetryCount = 0;
  while (from <= end) {
    const to = Math.min(end, from + chunkSize - 1);
    try {
      const part = await hardhatRpc('eth_getLogs', [{
        ...baseFilter,
        fromBlock: ethers.toQuantity(from),
        toBlock: ethers.toQuantity(to),
      }]);
      allLogs.push(...part);
      from = to + 1;
      rateRetryCount = 0;
    } catch (err) {
      if (isRpcRateLimitError(err.message)) {
        rateRetryCount += 1;
        if (rateRetryCount > 20) {
          throw err;
        }
        const delayMs = Math.min(3000, 300 * rateRetryCount);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      if (!isGetLogsRangeError(err.message) || chunkSize <= 1) {
        throw err;
      }
      const hinted = parseMaxGetLogsRangeFromError(err.message);
      if (hinted && hinted >= 1) {
        chunkSize = Math.max(1, Math.min(chunkSize, hinted));
      } else {
        chunkSize = Math.max(1, Math.floor(chunkSize / 2));
      }
    }
  }
  return allLogs;
}

async function mapWithConcurrency(items, limit, worker) {
  const rows = Array.isArray(items) ? items : [];
  const max = Math.max(1, Number(limit) || 1);
  const results = new Array(rows.length);
  let cursor = 0;
  const workers = [];
  const run = async function () {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= rows.length) {
        return;
      }
      results[index] = await worker(rows[index], index);
    }
  };
  for (let i = 0; i < Math.min(max, rows.length); i += 1) {
    workers.push(run());
  }
  await Promise.all(workers);
  return results;
}

function readAwardCacheEntry(store, key) {
  if (!store || !key) {
    return null;
  }
  const row = store.get(key);
  if (!row) {
    return null;
  }
  if ((Date.now() - Number(row.timestampMs)) > AWARD_CACHE_TTL_MS) {
    store.delete(key);
    return null;
  }
  return row.value;
}

function writeAwardCacheEntry(store, key, value) {
  if (!store || !key) {
    return;
  }
  store.set(key, { value, timestampMs: Date.now() });
}

function formatTokenAmountCompact(weiLike, decimals = 18, maxFraction = 4) {
  try {
    const raw = ethers.formatUnits(BigInt(String(weiLike || '0')), decimals);
    const negative = raw.startsWith('-');
    let text = negative ? raw.slice(1) : raw;
    const parts = text.split('.');
    let whole = parts[0] || '0';
    let fraction = parts[1] || '';
    if (fraction.length > maxFraction) {
      fraction = fraction.slice(0, maxFraction);
    }
    fraction = fraction.replace(/0+$/, '');
    let out = whole;
    if (fraction) {
      out = `${whole}.${fraction}`;
    }
    if (negative) {
      return `-${out}`;
    }
    return out;
  } catch {
    return String(weiLike || '0');
  }
}

async function fetchRecentLeveragedEventsForWallet(wallet, lookbackBlocksInput) {
  const deployments = loadDeployments();
  const leveragedRouterAddress = normalizeAddress(deployments.leveragedProductRouter);
  if (!leveragedRouterAddress) {
    return [];
  }
  const latestBlockHex = await hardhatRpc('eth_blockNumber', []);
  const latestBlock = parseRpcInt(latestBlockHex);
  const lookbackBlocks = Math.max(1, Number(lookbackBlocksInput) || 5000);
  const fromBlock = Math.max(0, latestBlock - lookbackBlocks + 1);
  const leveragedTopics = [
    ethers.id('LeveragedMinted(address,address,string,uint8,uint256,uint256,uint256)'),
    ethers.id('LeveragedUnwound(address,address,string,uint8,uint256,uint256,uint256)'),
  ];
  const logs = await getLogsChunked({
    address: leveragedRouterAddress,
    topics: [leveragedTopics],
  }, fromBlock, latestBlock);
  logs.sort((a, b) => {
    const aBlock = Number(a.blockNumber);
    const bBlock = Number(b.blockNumber);
    if (aBlock !== bBlock) {
      return aBlock - bBlock;
    }
    return Number(a.logIndex) - Number(b.logIndex);
  });
  const walletNorm = normalizeAddress(wallet);
  const blockTimestampCache = new Map();
  const events = [];
  for (let i = 0; i < logs.length; i += 1) {
    const log = logs[i];
    let parsed = null;
    try {
      parsed = leveragedRouterInterface.parseLog(log);
    } catch {
      parsed = null;
    }
    if (!parsed) {
      continue;
    }
    const rowWallet = normalizeAddress(parsed.args.user);
    if (rowWallet !== walletNorm) {
      continue;
    }
    const txHash = String(log.transactionHash);
    const blockNumber = Number(log.blockNumber);
    const logIndex = Number(log.logIndex);
    let timestampMs = Date.now();
    if (blockTimestampCache.has(blockNumber)) {
      timestampMs = blockTimestampCache.get(blockNumber);
    } else {
      const ts = await getBlockTimestampMs(blockNumber);
      blockTimestampCache.set(blockNumber, ts);
      timestampMs = ts;
    }
    const id = `${txHash}:${logIndex}`;
    if (parsed.name === 'LeveragedMinted') {
      events.push({
        id,
        kind: 'LEVERAGE_MINT',
        wallet: rowWallet,
        productToken: normalizeAddress(parsed.args.productToken),
        baseSymbol: String(parsed.args.baseSymbol),
        leverage: Number(parsed.args.leverage),
        ttokenInWei: parsed.args.ttokenInWei.toString(),
        productQtyWei: parsed.args.productOutWei.toString(),
        navCents: parsed.args.navCents.toString(),
        txHash,
        blockNumber,
        logIndex,
        timestampMs,
      });
      continue;
    }
    if (parsed.name === 'LeveragedUnwound') {
      events.push({
        id,
        kind: 'LEVERAGE_UNWIND',
        wallet: rowWallet,
        productToken: normalizeAddress(parsed.args.productToken),
        baseSymbol: String(parsed.args.baseSymbol),
        leverage: Number(parsed.args.leverage),
        productQtyWei: parsed.args.productInWei.toString(),
        ttokenOutWei: parsed.args.ttokenOutWei.toString(),
        navCents: parsed.args.navCents.toString(),
        txHash,
        blockNumber,
        logIndex,
        timestampMs,
      });
      events.push({
        id: `${id}:burn`,
        kind: 'LEVERAGE_BURN',
        wallet: rowWallet,
        productToken: normalizeAddress(parsed.args.productToken),
        baseSymbol: String(parsed.args.baseSymbol),
        leverage: Number(parsed.args.leverage),
        productQtyWei: parsed.args.productInWei.toString(),
        txHash,
        blockNumber,
        logIndex: logIndex + 1,
        timestampMs,
      });
    }
  }
  return events;
}

function collectWalletTxRowsFromSnapshot(snapshot, wallet, maxCount) {
  const rowsOut = [];
  const seen = new Set();
  const pushRow = (txHash, label, timestampMs, qtyText) => {
    const hash = String(txHash || '');
    if (!hash) {
      return;
    }
    if (seen.has(hash)) {
      return;
    }
    seen.add(hash);
    rowsOut.push({
      txHash: hash,
      label: String(label || 'wallet_tx'),
      timestampMs: Number(timestampMs) || 0,
      qtyText: String(qtyText || '-'),
    });
  };
  const walletNorm = normalizeAddress(wallet);
  const limit = Math.max(1, Number(maxCount) || 20);
  const rows = [];

  const orderValues = Object.values(snapshot.orders || {});
  for (let i = 0; i < orderValues.length; i += 1) {
    const row = orderValues[i];
    if (row && row.trader === walletNorm) {
      const side = String(row.side || '').toUpperCase();
      const symbol = String(row.symbol || '').toUpperCase();
      const label = `ORDER ${side} ${symbol}`.trim();
      const qtyText = `${formatTokenAmountCompact(row.qtyWei)} ${symbol || 'UNITS'}`;
      rows.push({ timestampMs: Number(row.placedAtMs) || 0, txHash: row.placedTxHash, label, qtyText });
    }
  }
  const fills = Array.isArray(snapshot.fills) ? snapshot.fills : [];
  for (let i = 0; i < fills.length; i += 1) {
    const row = fills[i];
    if (!row) {
      continue;
    }
    if (row.makerTrader === walletNorm || row.takerTrader === walletNorm) {
      const isMaker = row.makerTrader === walletNorm;
      const side = isMaker ? 'SELL' : 'BUY';
      const symbol = String(row.symbol || '').toUpperCase();
      const label = `FILL ${side} ${symbol}`.trim();
      const qtyText = `${formatTokenAmountCompact(row.qtyWei)} ${symbol || 'UNITS'}`;
      rows.push({ timestampMs: Number(row.timestampMs) || 0, txHash: row.txHash, label, qtyText });
    }
  }
  const cancellations = Array.isArray(snapshot.cancellations) ? snapshot.cancellations : [];
  for (let i = 0; i < cancellations.length; i += 1) {
    const row = cancellations[i];
    if (row && row.trader === walletNorm) {
      const qtyText = `${formatTokenAmountCompact(row.refundWei)} TTOKEN`;
      rows.push({ timestampMs: Number(row.timestampMs) || 0, txHash: row.txHash, label: 'CANCEL ORDER', qtyText });
    }
  }
  const cashflows = Array.isArray(snapshot.cashflows) ? snapshot.cashflows : [];
  for (let i = 0; i < cashflows.length; i += 1) {
    const row = cashflows[i];
    if (row && row.wallet === walletNorm) {
      const direction = String(row.direction || '').toUpperCase();
      const symbol = String(row.assetSymbol || row.assetType || 'TOKEN').toUpperCase();
      const reason = String(row.reason || '').toUpperCase();
      const label = `CASHFLOW ${direction} ${reason}`.trim();
      const qtyText = `${formatTokenAmountCompact(row.amountWei)} ${symbol}`;
      rows.push({ timestampMs: Number(row.timestampMs) || 0, txHash: row.txHash, label, qtyText });
    }
  }
  const transfers = Array.isArray(snapshot.transfers) ? snapshot.transfers : [];
  for (let i = 0; i < transfers.length; i += 1) {
    const row = transfers[i];
    if (!row) {
      continue;
    }
    if (row.from === walletNorm || row.to === walletNorm) {
      const direction = row.to === walletNorm ? 'IN' : 'OUT';
      const symbol = String(row.symbol || 'TOKEN').toUpperCase();
      const label = `TRANSFER ${direction} ${symbol}`.trim();
      const qtyText = `${formatTokenAmountCompact(row.amountWei)} ${symbol}`;
      rows.push({ timestampMs: Number(row.timestampMs) || 0, txHash: row.txHash, label, qtyText });
    }
  }
  const leveragedEvents = Array.isArray(snapshot.leveragedEvents) ? snapshot.leveragedEvents : [];
  for (let i = 0; i < leveragedEvents.length; i += 1) {
    const row = leveragedEvents[i];
    if (row && row.wallet === walletNorm) {
      const baseSymbol = String(row.baseSymbol || '').toUpperCase();
      const leverage = Number(row.leverage);
      const productSymbol = (baseSymbol && Number.isFinite(leverage) && leverage > 0)
        ? `${baseSymbol}${leverage}L`
        : 'LEVERAGE';
      let label = String(row.kind || 'LEVERAGE');
      let qtyText = '-';
      if (row.kind === 'LEVERAGE_MINT') {
        label = `LEVERAGE MINT ${productSymbol}`;
        qtyText = `${formatTokenAmountCompact(row.productQtyWei)} ${productSymbol}`;
      } else if (row.kind === 'LEVERAGE_UNWIND') {
        label = `LEVERAGE UNWIND ${productSymbol}`;
        qtyText = `${formatTokenAmountCompact(row.productQtyWei)} ${productSymbol}`;
      } else if (row.kind === 'LEVERAGE_BURN') {
        label = `LEVERAGE BURN ${productSymbol}`;
        qtyText = `${formatTokenAmountCompact(row.productQtyWei)} ${productSymbol}`;
      }
      rows.push({ timestampMs: Number(row.timestampMs) || 0, txHash: row.txHash, label, qtyText });
    }
  }

  rows.sort((a, b) => b.timestampMs - a.timestampMs);
  for (let i = 0; i < rows.length && rowsOut.length < limit; i += 1) {
    pushRow(rows[i].txHash, rows[i].label, rows[i].timestampMs, rows[i].qtyText);
  }
  return rowsOut;
}

async function buildWalletGasRowsFromIndexer(wallet, maxCount) {
  await Promise.race([
    ensureIndexerSynced(),
    new Promise((resolve) => setTimeout(resolve, 2500)),
  ]);
  const snapshot = readIndexerSnapshot();
  const txRows = collectWalletTxRowsFromSnapshot(snapshot, wallet, maxCount);
  const receipts = await mapWithConcurrency(txRows, 4, async (row) => {
    const data = await readReceiptGasData(row.txHash);
    const txName = row.label || 'TX';
    return {
      txHash: row.txHash,
      txName,
      qtyText: row.qtyText || '-',
      from: normalizeAddress(data.from),
      gasUsed: data.gasUsed,
      costWei: data.costWei,
    };
  });
  const walletNorm = normalizeAddress(wallet);
  const rows = [];
  for (let i = 0; i < receipts.length; i += 1) {
    const row = receipts[i];
    if (!row || row.from !== walletNorm) {
      continue;
    }
    rows.push({
      txName: row.txName,
      txHash: row.txHash,
      qtyText: row.qtyText || '-',
      gasUsed: row.gasUsed.toString(),
      effectiveGasPrice: '0',
      costWei: row.costWei.toString(),
      costEth: toEthString(row.costWei),
      baselineGasUsed: '0',
      deltaPct: null,
      status: 'OK',
      skipReason: '',
    });
  }
  return rows;
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

  try {
    const readData = priceFeedInterface.encodeFunctionData('getPrice', [symbol]);
    const readResult = await hardhatRpc('eth_call', [{ to: priceFeedAddress, data: readData }, 'latest']);
    const [priceCentsRaw] = priceFeedInterface.decodeFunctionResult('getPrice', readResult);
    const existingPrice = Number(priceCentsRaw);
    if (existingPrice > 0) {
      const freshData = priceFeedInterface.encodeFunctionData('isFresh', [symbol]);
      const freshResult = await hardhatRpc('eth_call', [{ to: priceFeedAddress, data: freshData }, 'latest']);
      const [isFresh] = priceFeedInterface.decodeFunctionResult('isFresh', freshResult);
      if (isFresh) {
        return { ok: true, priceCents: existingPrice };
      }
    }
  } catch {
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
  if (!(fetchedPrice > 0)) {
    try {
      const fmpPrice = await fetchFmpSpotPrice(symbol);
      if (fmpPrice > 0) {
        fetchedPrice = fmpPrice;
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
    const receipt = await waitForReceipt(txHash);
    const statusInt = parseRpcInt(receipt.status);
    if (statusInt === 0) {
      return { ok: false, error: `price update reverted for ${symbol}` };
    }
    return { ok: true, priceCents };
  } catch {
    return { ok: false, error: `cannot update onchain price for ${symbol}` };
  }
}

function toBigIntSafe(value) {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function toEthString(weiValue) {
  try {
    return ethers.formatEther(weiValue);
  } catch {
    return '0';
  }
}

function calcDeltaPct(gasUsed, baselineGasUsed) {
  const current = Number(gasUsed);
  const baseline = Number(baselineGasUsed);
  if (!(baseline > 0)) {
    return null;
  }
  return ((current - baseline) / baseline) * 100;
}

function getGasStatus(deltaPct) {
  let missingDelta = false;
  if (!Number.isFinite(deltaPct)) {
    missingDelta = true;
  }
  if (missingDelta) {
    return 'OK';
  }
  if (deltaPct > GAS_WARN_THRESHOLD_PCT) {
    return 'WARN';
  }
  return 'OK';
}

function toUserErrorMessage(messageRaw) {
  let message = '';
  if (messageRaw) {
    message = String(messageRaw);
  }
  if (message.includes('leveragedrouter: price unavailable')) {
    return 'Base price is not available yet please wait for oracle update';
  }
  let matchesInsufficientBalance = false;
  if (message.includes('0xe450d38c')) {
    matchesInsufficientBalance = true;
  }
  if (message.includes('ERC20InsufficientBalance')) {
    matchesInsufficientBalance = true;
  }
  if (matchesInsufficientBalance) {
    return 'Insufficient token balance for this transaction';
  }
  let matchesInsufficientAllowance = false;
  if (message.includes('0xfb8f41b2')) {
    matchesInsufficientAllowance = true;
  }
  if (message.includes('ERC20InsufficientAllowance')) {
    matchesInsufficientAllowance = true;
  }
  if (matchesInsufficientAllowance) {
    return 'Token allowance is not enough please approve again';
  }
  if (message.includes('award: epoch not ended')) {
    return 'Award claim is not available until the current epoch ends';
  }
  if (message.includes('product not found')) {
    return 'Selected leveraged product does not exist';
  }
  return message;
}

async function sendMeasuredTx(input) {
  const txHash = await hardhatRpc('eth_sendTransaction', [input.tx]);
  const receipt = await waitForReceipt(txHash, 60);
  const gasUsed = toBigIntSafe(receipt.gasUsed);
  let effectiveGasPrice = 0n;
  if (receipt.effectiveGasPrice) {
    effectiveGasPrice = toBigIntSafe(receipt.effectiveGasPrice);
  } else {
    const latest = await hardhatRpc('eth_gasPrice', []);
    effectiveGasPrice = toBigIntSafe(latest);
  }
  const costWei = gasUsed * effectiveGasPrice;
  return {
    txHash,
    gasUsed,
    effectiveGasPrice,
    costWei,
    receipt,
  };
}

async function runGasPackOnce(suiteRaw) {
  let suiteText = 'core';
  if (suiteRaw) {
    suiteText = String(suiteRaw);
  }
  const suite = suiteText.toLowerCase();
  const startedAtMs = Date.now();
  const deployments = loadDeployments();
  const accounts = await hardhatRpc('eth_accounts', []);
  let invalidAccountsInput = false;
  if (!Array.isArray(accounts)) {
    invalidAccountsInput = true;
  }
  if (accounts.length < 2) {
    invalidAccountsInput = true;
  }
  if (invalidAccountsInput) {
    throw new Error('need at least 2 local accounts');
  }
  const admin = accounts[0];
  const traderA = accounts[0];
  const traderB = accounts[1];

  const registryAddress = normalizeAddress(deployments.listingsRegistry);
  const orderBookAddress = normalizeAddress(deployments.orderBookDex);
  const ttokenAddress = normalizeAddress(getTTokenAddressFromDeployments());
  const dividendsAddress = normalizeAddress(deployments.dividends);
  const merkleDividendsAddress = normalizeAddress(deployments.dividendsMerkle);
  const leveragedFactoryAddress = normalizeAddress(deployments.leveragedTokenFactory);
  const leveragedRouterAddress = normalizeAddress(deployments.leveragedProductRouter);
  const awardAddress = normalizeAddress(deployments.award);

  let missingGasPackCoreContract = false;
  if (!registryAddress) {
    missingGasPackCoreContract = true;
  }
  if (!orderBookAddress) {
    missingGasPackCoreContract = true;
  }
  if (!ttokenAddress) {
    missingGasPackCoreContract = true;
  }
  if (missingGasPackCoreContract) {
    throw new Error('missing deployed contracts for gas pack');
  }

  const allSymbolsData = registryListInterface.encodeFunctionData('getAllSymbols', []);
  const allSymbolsResult = await hardhatRpc('eth_call', [{ to: registryAddress, data: allSymbolsData }, 'latest']);
  const [allSymbols] = registryListInterface.decodeFunctionResult('getAllSymbols', allSymbolsResult);
  let hasNoSymbols = false;
  if (!Array.isArray(allSymbols)) {
    hasNoSymbols = true;
  }
  if (allSymbols.length === 0) {
    hasNoSymbols = true;
  }
  if (hasNoSymbols) {
    throw new Error('no listed symbols for gas pack');
  }
  const symbol = allSymbols[0];
  const listingData = listingsRegistryInterface.encodeFunctionData('getListing', [symbol]);
  const listingResult = await hardhatRpc('eth_call', [{ to: registryAddress, data: listingData }, 'latest']);
  const [equityTokenAddressRaw] = listingsRegistryInterface.decodeFunctionResult('getListing', listingResult);
  const equityTokenAddress = normalizeAddress(equityTokenAddressRaw);
  let missingEquityToken = false;
  if (!equityTokenAddress) {
    missingEquityToken = true;
  }
  if (equityTokenAddress === ethers.ZeroAddress) {
    missingEquityToken = true;
  }
  if (missingEquityToken) {
    throw new Error(`listing missing token address for ${symbol}`);
  }

  const now = Date.now();
  const tempSymbol = `G${String(now).slice(-5)}`;
  const oneShareWei = ethers.parseUnits('1', 18);
  const hundredSharesWei = ethers.parseUnits('100', 18);
  const oneTTokenWei = ethers.parseUnits('1', 18);
  const hundredTTokenWei = ethers.parseUnits('100', 18);

  const rows = [];
  function pushRow(name, measured, extra = {}) {
    let baselineGasUsed = 0;
    if (gasRuntimeState.baseline[name]) {
      baselineGasUsed = gasRuntimeState.baseline[name];
    }
    const deltaPct = calcDeltaPct(measured.gasUsed, baselineGasUsed);
    rows.push({
      txName: name,
      gasUsed: measured.gasUsed.toString(),
      effectiveGasPrice: measured.effectiveGasPrice.toString(),
      costWei: measured.costWei.toString(),
      costEth: toEthString(measured.costWei),
      baselineGasUsed: String(baselineGasUsed),
      deltaPct,
      status: getGasStatus(deltaPct),
      txHash: measured.txHash,
      ...extra,
    });
  }

  function pushSkipped(name, reason) {
    let baselineGasUsed = 0;
    if (gasRuntimeState.baseline[name]) {
      baselineGasUsed = gasRuntimeState.baseline[name];
    }
    rows.push({
      txName: name,
      gasUsed: '0',
      effectiveGasPrice: '0',
      costWei: '0',
      costEth: '0',
      baselineGasUsed: String(baselineGasUsed),
      deltaPct: null,
      status: 'SKIP',
      skipReason: reason,
    });
  }

  const snapshotId = await hardhatRpc('evm_snapshot', []);
  try {
    let canRunBuySide = true;
    let canRunSellSide = true;

    try {
      const buyerBalData = equityTokenInterface.encodeFunctionData('balanceOf', [traderA]);
      const buyerBalResult = await hardhatRpc('eth_call', [{ to: ttokenAddress, data: buyerBalData }, 'latest']);
      const [buyerBalanceRaw] = equityTokenInterface.decodeFunctionResult('balanceOf', buyerBalResult);
      const buyerBalance = toBigIntSafe(buyerBalanceRaw);
      const neededBuyerTToken = ethers.parseUnits('500', 18);
      if (buyerBalance < neededBuyerTToken) {
        await sendMeasuredTx({
          tx: {
            from: admin,
            to: ttokenAddress,
            data: equityTokenInterface.encodeFunctionData('mint', [traderA, neededBuyerTToken - buyerBalance]),
          },
        });
      }
    } catch (err) {
      canRunBuySide = false;
    }

    try {
      const sellerBalData = equityTokenInterface.encodeFunctionData('balanceOf', [traderB]);
      const sellerBalResult = await hardhatRpc('eth_call', [{ to: equityTokenAddress, data: sellerBalData }, 'latest']);
      const [sellerBalanceRaw] = equityTokenInterface.decodeFunctionResult('balanceOf', sellerBalResult);
      const sellerBalance = toBigIntSafe(sellerBalanceRaw);
      const neededSellerQty = hundredSharesWei;
      if (sellerBalance < neededSellerQty) {
        const mintShares = await sendMeasuredTx({
          tx: {
            from: admin,
            to: equityTokenAddress,
            data: equityTokenInterface.encodeFunctionData('mint', [traderB, neededSellerQty - sellerBalance]),
          },
        });
        pushRow('mint_equity_for_seller_setup', mintShares);
      } else {
        pushSkipped('mint_equity_for_seller_setup', 'already funded');
      }
    } catch (err) {
      canRunSellSide = false;
      let reason = 'cannot fund seller equity';
      if (err.message) {
        reason = err.message;
      }
      pushSkipped('mint_equity_for_seller_setup', reason);
    }

    if (canRunBuySide) {
      try {
        const approveBuyer = await sendMeasuredTx({
          tx: {
            from: traderA,
            to: ttokenAddress,
            data: equityTokenInterface.encodeFunctionData('approve', [orderBookAddress, ethers.MaxUint256]),
          },
        });
        pushRow('approve_ttoken_for_dex', approveBuyer);
      } catch (err) {
        canRunBuySide = false;
        let reason = 'cannot approve ttoken';
        if (err.message) {
          reason = err.message;
        }
        pushSkipped('approve_ttoken_for_dex', reason);
      }
    } else {
      pushSkipped('approve_ttoken_for_dex', 'buyer setup failed');
    }

    if (canRunSellSide) {
      try {
        const approveSeller = await sendMeasuredTx({
          tx: {
            from: traderB,
            to: equityTokenAddress,
            data: equityTokenInterface.encodeFunctionData('approve', [orderBookAddress, ethers.MaxUint256]),
          },
        });
        pushRow('approve_equity_for_dex', approveSeller);
      } catch (err) {
        canRunSellSide = false;
        let reason = 'cannot approve equity';
        if (err.message) {
          reason = err.message;
        }
        pushSkipped('approve_equity_for_dex', reason);
      }
    } else {
      pushSkipped('approve_equity_for_dex', 'seller setup failed');
    }

    let runCore = false;
    if (suite === 'core') {
      runCore = true;
    }
    if (suite === 'all') {
      runCore = true;
    }
    if (runCore) {
      const listSymbol = await sendMeasuredTx({
        tx: {
          from: admin,
          to: normalizeAddress(deployments.equityTokenFactory),
          data: equityFactoryInterface.encodeFunctionData('createEquityToken', [tempSymbol, `Gas ${tempSymbol}`]),
        },
      });
      pushRow('list_symbol', listSymbol, { symbol: tempSymbol });

      let placeSell = null;
      if (canRunBuySide) {
        try {
          const placeBuy = await sendMeasuredTx({
            tx: {
              from: traderA,
              to: orderBookAddress,
              data: orderBookInterface.encodeFunctionData('placeLimitOrder', [equityTokenAddress, 0, 100n, hundredSharesWei]),
            },
          });
          pushRow('place_buy_limit', placeBuy, { symbol });
        } catch (err) {
          canRunBuySide = false;
          let reason = 'place buy failed';
          if (err.message) {
            reason = err.message;
          }
          pushSkipped('place_buy_limit', reason);
        }
      } else {
        pushSkipped('place_buy_limit', 'buyer setup failed');
      }

      if (canRunSellSide) {
        try {
          placeSell = await sendMeasuredTx({
            tx: {
              from: traderB,
              to: orderBookAddress,
              data: orderBookInterface.encodeFunctionData('placeLimitOrder', [equityTokenAddress, 1, 120n, hundredSharesWei]),
            },
          });
          pushRow('place_sell_limit', placeSell, { symbol });
        } catch (err) {
          canRunSellSide = false;
          let reason = 'place sell failed';
          if (err.message) {
            reason = err.message;
          }
          pushSkipped('place_sell_limit', reason);
        }
      } else {
        pushSkipped('place_sell_limit', 'seller setup failed');
      }

      if (placeSell) {
        const placedIds = [];
        for (let i = 0; i < placeSell.receipt.logs.length; i += 1) {
          const log = placeSell.receipt.logs[i];
          try {
            const parsed = orderBookInterface.parseLog(log);
            if (parsed && parsed.name === 'OrderPlaced') {
              placedIds.push(toBigIntSafe(parsed.args.id));
            }
          } catch {
          }
        }
        if (placedIds.length > 0) {
          const cancel = await sendMeasuredTx({
            tx: {
              from: traderB,
              to: orderBookAddress,
              data: orderBookInterface.encodeFunctionData('cancelOrder', [placedIds[0]]),
            },
          });
          pushRow('cancel_order', cancel, { symbol });
        } else {
          pushSkipped('cancel_order', 'could not parse order id');
        }
      } else {
        pushSkipped('cancel_order', 'sell order not available for cancel');
      }

      if (dividendsAddress) {
        try {
          const declareSnapshot = await sendMeasuredTx({
            tx: {
              from: admin,
              to: dividendsAddress,
              data: dividendsInterface.encodeFunctionData('declareDividendPerShare', [equityTokenAddress, oneTTokenWei]),
            },
          });
          pushRow('snapshot_dividend_declare', declareSnapshot, { symbol });

          const epochCountCall = dividendsInterface.encodeFunctionData('epochCount', [equityTokenAddress]);
          const epochCountResult = await hardhatRpc('eth_call', [{ to: dividendsAddress, data: epochCountCall }, 'latest']);
          const [epochCount] = dividendsInterface.decodeFunctionResult('epochCount', epochCountResult);
          const epochId = toBigIntSafe(epochCount);
          const claimSnapshot = await sendMeasuredTx({
            tx: {
              from: traderB,
              to: dividendsAddress,
              data: dividendsInterface.encodeFunctionData('claimDividend', [equityTokenAddress, epochId]),
            },
          });
          pushRow('snapshot_dividend_claim', claimSnapshot, { symbol, epochId: epochId.toString() });
        } catch (err) {
          let reason = 'failed';
          if (err.message) {
            reason = err.message;
          }
          pushSkipped('snapshot_dividend_declare', reason);
          pushSkipped('snapshot_dividend_claim', 'declare/claim unavailable');
        }
      } else {
        pushSkipped('snapshot_dividend_declare', 'dividends not deployed');
        pushSkipped('snapshot_dividend_claim', 'dividends not deployed');
      }

      if (merkleDividendsAddress) {
        try {
          const merkleCountCall = dividendsMerkleInterface.encodeFunctionData('merkleEpochCount', []);
          const merkleCountResult = await hardhatRpc('eth_call', [{ to: merkleDividendsAddress, data: merkleCountCall }, 'latest']);
          const [beforeCount] = dividendsMerkleInterface.decodeFunctionResult('merkleEpochCount', merkleCountResult);
          const newEpochId = toBigIntSafe(beforeCount) + 1n;
          const leafAmount = ethers.parseUnits('3', 18);
          const leafIndex = 0n;
          const leaf = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
            ['uint256', 'address', 'address', 'uint256', 'uint256'],
            [newEpochId, equityTokenAddress, traderB, leafAmount, leafIndex],
          ));
          const contentHash = ethers.keccak256(ethers.toUtf8Bytes(`gas-pack-${Date.now()}`));
          const declareMerkle = await sendMeasuredTx({
            tx: {
              from: admin,
              to: merkleDividendsAddress,
              data: dividendsMerkleInterface.encodeFunctionData('declareMerkleDividend', [equityTokenAddress, leaf, leafAmount, contentHash, '']),
            },
          });
          pushRow('merkle_dividend_declare', declareMerkle, { symbol, epochId: newEpochId.toString() });

          const claimMerkle = await sendMeasuredTx({
            tx: {
              from: traderB,
              to: merkleDividendsAddress,
              data: dividendsMerkleInterface.encodeFunctionData('claim', [newEpochId, traderB, leafAmount, leafIndex, []]),
            },
          });
          pushRow('merkle_dividend_claim', claimMerkle, { symbol, epochId: newEpochId.toString() });
        } catch (err) {
          let reason = 'failed';
          if (err.message) {
            reason = err.message;
          }
          pushSkipped('merkle_dividend_declare', reason);
          pushSkipped('merkle_dividend_claim', 'declare/claim unavailable');
        }
      } else {
        pushSkipped('merkle_dividend_declare', 'merkle dividends not deployed');
        pushSkipped('merkle_dividend_claim', 'merkle dividends not deployed');
      }

      if (leveragedFactoryAddress && leveragedRouterAddress) {
        try {
          const productCountCall = leveragedFactoryInterface.encodeFunctionData('productCount', []);
          const productCountResult = await hardhatRpc('eth_call', [{ to: leveragedFactoryAddress, data: productCountCall }, 'latest']);
          const [productCount] = leveragedFactoryInterface.decodeFunctionResult('productCount', productCountResult);
          const productCountNumber = Number(productCount);
          if (productCountNumber > 0) {
            const productAtCall = leveragedFactoryInterface.encodeFunctionData('getProductAt', [0]);
            const productAtResult = await hardhatRpc('eth_call', [{ to: leveragedFactoryAddress, data: productAtCall }, 'latest']);
            const [productTuple] = leveragedFactoryInterface.decodeFunctionResult('getProductAt', productAtResult);
            const productToken = normalizeAddress(productTuple.token);
            let leveragedBaseSymbolRaw = '';
            if (productTuple.baseSymbol) {
              leveragedBaseSymbolRaw = String(productTuple.baseSymbol);
            }
            const leveragedBaseSymbol = leveragedBaseSymbolRaw.toUpperCase();
            if (leveragedBaseSymbol) {
              const ensurePriceResult = await ensureOnchainPriceForSymbol(leveragedBaseSymbol);
              if (!ensurePriceResult.ok) {
                let reason = `price unavailable for ${leveragedBaseSymbol}`;
                if (ensurePriceResult.error) {
                  reason = ensurePriceResult.error;
                }
                throw new Error(reason);
              }
            }

            const approveRouter = await sendMeasuredTx({
              tx: {
                from: traderA,
                to: ttokenAddress,
                data: equityTokenInterface.encodeFunctionData('approve', [leveragedRouterAddress, ethers.MaxUint256]),
              },
            });
            pushRow('approve_ttoken_for_leveraged', approveRouter);

            const mintLeveraged = await sendMeasuredTx({
              tx: {
                from: traderA,
                to: leveragedRouterAddress,
                data: leveragedRouterInterface.encodeFunctionData('mintLong', [productToken, hundredTTokenWei, 0n]),
              },
            });
            pushRow('leveraged_mint', mintLeveraged);

            let mintedOut = 0n;
            for (let i = 0; i < mintLeveraged.receipt.logs.length; i += 1) {
              const log = mintLeveraged.receipt.logs[i];
              try {
                const parsed = leveragedRouterInterface.parseLog(log);
                if (parsed && parsed.name === 'LeveragedMinted') {
                  mintedOut = toBigIntSafe(parsed.args.productOutWei);
                }
              } catch {
              }
            }
            if (mintedOut > 0n) {
              const unwindLeveraged = await sendMeasuredTx({
                tx: {
                  from: traderA,
                  to: leveragedRouterAddress,
                  data: leveragedRouterInterface.encodeFunctionData('unwindLong', [productToken, mintedOut, 0n]),
                },
              });
              pushRow('leveraged_unwind', unwindLeveraged);
            } else {
              pushSkipped('leveraged_unwind', 'minted amount missing from logs');
            }
          } else {
            pushSkipped('leveraged_mint', 'no leveraged products');
            pushSkipped('leveraged_unwind', 'no leveraged products');
          }
        } catch (err) {
          let reason = 'failed';
          if (err.message) {
            reason = err.message;
          }
          pushSkipped('leveraged_mint', reason);
          pushSkipped('leveraged_unwind', 'mint/unwind unavailable');
        }
      } else {
        pushSkipped('leveraged_mint', 'leveraged contracts not deployed');
        pushSkipped('leveraged_unwind', 'leveraged contracts not deployed');
      }

    }

    let runStress = false;
    if (suite === 'stress') {
      runStress = true;
    }
    if (suite === 'all') {
      runStress = true;
    }
    if (runStress) {
      let deepGasUsed = 0n;
      let deepCostWei = 0n;
      let deepTxCount = 0;
      if (canRunBuySide && canRunSellSide) {
        try {
          for (let i = 0; i < 6; i += 1) {
            const price = BigInt(300 + i);
            const buyTx = await sendMeasuredTx({
              tx: {
                from: traderA,
                to: orderBookAddress,
                data: orderBookInterface.encodeFunctionData('placeLimitOrder', [equityTokenAddress, 0, price, oneShareWei]),
              },
            });
            deepGasUsed += buyTx.gasUsed;
            deepCostWei += buyTx.costWei;
            deepTxCount += 1;
          }
          const stressSell = await sendMeasuredTx({
            tx: {
              from: traderB,
              to: orderBookAddress,
              data: orderBookInterface.encodeFunctionData('placeLimitOrder', [equityTokenAddress, 1, 100n, ethers.parseUnits('6', 18)]),
            },
          });
          deepGasUsed += stressSell.gasUsed;
          deepCostWei += stressSell.costWei;
          deepTxCount += 1;
          const stressMeasured = {
            txHash: stressSell.txHash,
            gasUsed: deepGasUsed,
            effectiveGasPrice: (() => {
              let effectiveGasPrice = 0n;
              if (deepGasUsed > 0n) {
                effectiveGasPrice = deepCostWei / deepGasUsed;
              }
              return effectiveGasPrice;
            })(),
            costWei: deepCostWei,
          };
          pushRow('stress_deep_orderbook_match_loop', stressMeasured, { txCount: deepTxCount });
        } catch (err) {
          let reason = 'stress orderbook run failed';
          if (err.message) {
            reason = err.message;
          }
          pushSkipped('stress_deep_orderbook_match_loop', reason);
        }
      } else {
        pushSkipped('stress_deep_orderbook_match_loop', 'buyer or seller setup failed');
      }

      if (merkleDividendsAddress) {
        try {
          const claimants = [accounts[0], accounts[1], accounts[2], accounts[3]];
          const leafAmount = ethers.parseUnits('2', 18);
          let claimGas = 0n;
          let claimCost = 0n;
          let declareGas = 0n;
          let declareCost = 0n;
          let lastTxHash = '';
          for (let i = 0; i < claimants.length; i += 1) {
            const merkleCountCall = dividendsMerkleInterface.encodeFunctionData('merkleEpochCount', []);
            const merkleCountResult = await hardhatRpc('eth_call', [{ to: merkleDividendsAddress, data: merkleCountCall }, 'latest']);
            const [beforeCount] = dividendsMerkleInterface.decodeFunctionResult('merkleEpochCount', merkleCountResult);
            const epochId = toBigIntSafe(beforeCount) + 1n;
            const leafIndex = 0n;
            const leaf = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
              ['uint256', 'address', 'address', 'uint256', 'uint256'],
              [epochId, equityTokenAddress, claimants[i], leafAmount, leafIndex],
            ));
            const declare = await sendMeasuredTx({
              tx: {
                from: admin,
                to: merkleDividendsAddress,
                data: dividendsMerkleInterface.encodeFunctionData('declareMerkleDividend', [equityTokenAddress, leaf, leafAmount, ethers.keccak256(ethers.toUtf8Bytes(`gas-stress-merkle-${i}`)), '']),
              },
            });
            declareGas += declare.gasUsed;
            declareCost += declare.costWei;
            lastTxHash = declare.txHash;
            const proof = [];
            const claimTx = await sendMeasuredTx({
              tx: {
                from: claimants[i],
                to: merkleDividendsAddress,
                data: dividendsMerkleInterface.encodeFunctionData('claim', [epochId, claimants[i], leafAmount, leafIndex, proof]),
              },
            });
            claimGas += claimTx.gasUsed;
            claimCost += claimTx.costWei;
            lastTxHash = claimTx.txHash;
          }
          const summary = {
            txHash: lastTxHash,
            gasUsed: claimGas + declareGas,
            effectiveGasPrice: (() => {
              const totalGas = claimGas + declareGas;
              const totalCost = claimCost + declareCost;
              let effectiveGasPrice = 0n;
              if (totalGas > 0n) {
                effectiveGasPrice = totalCost / totalGas;
              }
              return effectiveGasPrice;
            })(),
            costWei: claimCost + declareCost,
          };
          pushRow('stress_merkle_claim_sequence', summary, { claimants: claimants.length });
        } catch (err) {
          let reason = 'failed';
          if (err.message) {
            reason = err.message;
          }
          pushSkipped('stress_merkle_claim_sequence', reason);
        }
      } else {
        pushSkipped('stress_merkle_claim_sequence', 'merkle contract not deployed');
      }

      let awardStressGas = 0n;
      let awardStressCost = 0n;
      let awardStressTxCount = 0;
      if (canRunBuySide && canRunSellSide) {
        try {
          for (let i = 0; i < 5; i += 1) {
            const buyTx = await sendMeasuredTx({
              tx: {
                from: traderA,
                to: orderBookAddress,
                data: orderBookInterface.encodeFunctionData('placeLimitOrder', [equityTokenAddress, 0, 100n, oneShareWei]),
              },
            });
            awardStressGas += buyTx.gasUsed;
            awardStressCost += buyTx.costWei;
            awardStressTxCount += 1;
            const sellTx = await sendMeasuredTx({
              tx: {
                from: traderB,
                to: orderBookAddress,
                data: orderBookInterface.encodeFunctionData('placeLimitOrder', [equityTokenAddress, 1, 100n, oneShareWei]),
              },
            });
            awardStressGas += sellTx.gasUsed;
            awardStressCost += sellTx.costWei;
            awardStressTxCount += 1;
          }
          pushRow('stress_award_high_fill_density', {
            txHash: '',
            gasUsed: awardStressGas,
            effectiveGasPrice: (() => {
              let effectiveGasPrice = 0n;
              if (awardStressGas > 0n) {
                effectiveGasPrice = awardStressCost / awardStressGas;
              }
              return effectiveGasPrice;
            })(),
            costWei: awardStressCost,
          }, { txCount: awardStressTxCount });
        } catch (err) {
          let reason = 'stress award run failed';
          if (err.message) {
            reason = err.message;
          }
          pushSkipped('stress_award_high_fill_density', reason);
        }
      } else {
        pushSkipped('stress_award_high_fill_density', 'buyer or seller setup failed');
      }
    }
  } finally {
    await hardhatRpc('evm_revert', [snapshotId]);
  }

  const finishedAtMs = Date.now();
  const latestBlockHex = await hardhatRpc('eth_blockNumber', []);
  const chainIdHex = await hardhatRpc('eth_chainId', []);
  const warnCount = rows.filter((one) => one.status === 'WARN').length;
  const skipCount = rows.filter((one) => one.status === 'SKIP').length;
  const report = {
    suite,
    startedAtMs,
    finishedAtMs,
    durationMs: finishedAtMs - startedAtMs,
    chainId: parseRpcInt(chainIdHex),
    latestBlock: parseRpcInt(latestBlockHex),
    thresholdPct: GAS_WARN_THRESHOLD_PCT,
    warnCount,
    skipCount,
    totalRows: rows.length,
    pollMs: GAS_PAGE_POLL_MS,
    rows,
  };
  return report;
}

async function runGasPackGuarded(suite) {
  if (gasRunInFlight) {
    return gasRunInFlight;
  }
  gasRunInFlight = (async function () {
    const report = await runGasPackOnce(suite);
    gasRuntimeState.lastRunAtMs = Date.now();
    gasRuntimeState.latest = report;
    return report;
  })();
  try {
    return await gasRunInFlight;
  } finally {
    gasRunInFlight = null;
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

async function getBlockTimestampMs(blockNumberRaw) {
  let blockTag = blockNumberRaw;
  if (typeof blockTag === 'number') {
    blockTag = ethers.toQuantity(blockTag);
  }
  const block = await hardhatRpc('eth_getBlockByNumber', [blockTag, false]);
  if (!block || !block.timestamp) {
    return Date.now();
  }
  return Number(block.timestamp) * 1000;
}

function appendManualMintActivity(input) {
  ensureIndexerDir();
  const orders = readJsonFile(INDEXER_ORDERS_FILE, {});
  const fills = readJsonFile(INDEXER_FILLS_FILE, []);
  const cashflows = readJsonFile(INDEXER_CASHFLOWS_FILE, []);
  const transfers = readJsonFile(INDEXER_TRANSFERS_FILE, []);
  const transferId = `${input.txHash}:manual-mint-transfer:${input.tokenAddress}:${input.wallet}`;
  let hasTransfer = false;
  for (let i = 0; i < transfers.length; i += 1) {
    if (transfers[i].id === transferId) {
      hasTransfer = true;
      break;
    }
  }
  if (!hasTransfer) {
    transfers.push({
      id: transferId,
      tokenAddress: normalizeAddress(input.tokenAddress),
      symbol: input.symbol,
      from: ethers.ZeroAddress,
      to: normalizeAddress(input.wallet),
      amountWei: String(input.amountWei),
      txHash: input.txHash,
      blockNumber: Number(input.blockNumber),
      logIndex: 0,
      timestampMs: Number(input.timestampMs),
    });
  }

  const reason = input.reason || 'MINT';
  const cashflowId = `${input.txHash}:manual-cashflow:${normalizeAddress(input.wallet)}:${reason}`;
  let hasCashflow = false;
  for (let i = 0; i < cashflows.length; i += 1) {
    if (cashflows[i].id === cashflowId) {
      hasCashflow = true;
      break;
    }
  }
  if (!hasCashflow) {
    cashflows.push({
      id: cashflowId,
      wallet: normalizeAddress(input.wallet),
      assetType: input.assetType || 'TTOKEN',
      assetSymbol: input.symbol,
      direction: 'IN',
      amountWei: String(input.amountWei),
      reason,
      txHash: input.txHash,
      blockNumber: Number(input.blockNumber),
      timestampMs: Number(input.timestampMs),
    });
  }

  const entryPriceCents = Number(input.priceCents);
  if (Number.isFinite(entryPriceCents) && entryPriceCents > 0) {
    const fillId = `${input.txHash}:manual-mint-fill:${normalizeAddress(input.wallet)}:${input.symbol}`;
    let hasFill = false;
    for (let i = 0; i < fills.length; i += 1) {
      if (fills[i].id === fillId) {
        hasFill = true;
        break;
      }
    }
    if (!hasFill) {
      fills.push({
        id: fillId,
        makerId: 0,
        takerId: 0,
        makerTrader: '',
        takerTrader: normalizeAddress(input.wallet),
        side: 'BUY',
        symbol: input.symbol,
        equityToken: normalizeAddress(input.tokenAddress),
        priceCents: Math.round(entryPriceCents),
        qtyWei: String(input.amountWei),
        blockNumber: Number(input.blockNumber),
        txHash: input.txHash,
        logIndex: 1,
        timestampMs: Number(input.timestampMs),
      });
    }
  }

  writeJsonFile(INDEXER_ORDERS_FILE, orders);
  writeJsonFile(INDEXER_FILLS_FILE, fills);
  writeJsonFile(INDEXER_CASHFLOWS_FILE, cashflows);
  writeJsonFile(INDEXER_TRANSFERS_FILE, transfers);
}

async function resolveEntryPriceCentsForSymbol(symbol, deployments) {
  const upper = String(symbol || '').toUpperCase().trim();
  if (!upper) {
    return 0;
  }
  try {
    const payload = await fetchFmpJson(getFmpUrl('quote-short', { symbol: upper }));
    const quote = Array.isArray(payload) ? payload[0] : payload;
    const price = Number(quote && quote.price);
    if (Number.isFinite(price) && price > 0) {
      return Math.round(price * 100);
    }
  } catch {
  }
  try {
    const quote = await fetchQuote(upper);
    const yahooPrice = Number(quote.regularMarketPrice || quote.price || 0);
    if (Number.isFinite(yahooPrice) && yahooPrice > 0) {
      return Math.round(yahooPrice * 100);
    }
  } catch {
  }
  const priceFeedAddr = normalizeAddress(deployments && deployments.priceFeed);
  if (priceFeedAddr) {
    try {
      const feedData = priceFeedInterface.encodeFunctionData('getPrice', [upper]);
      const feedResult = await hardhatRpc('eth_call', [{ to: priceFeedAddr, data: feedData }, 'latest']);
      const [onchainPriceRaw] = priceFeedInterface.decodeFunctionResult('getPrice', feedResult);
      const onchainPrice = Number(onchainPriceRaw);
      if (Number.isFinite(onchainPrice) && onchainPrice > 0) {
        return Math.round(onchainPrice);
      }
    } catch {
    }
  }
  const snapshot = readIndexerSnapshot();
  const rows = Array.isArray(snapshot.fills) ? snapshot.fills : [];
  let latest = null;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (String(row.symbol || '').toUpperCase() !== upper) {
      continue;
    }
    if (!latest) {
      latest = row;
      continue;
    }
    const prevTs = Number(latest.timestampMs) || 0;
    const currTs = Number(row.timestampMs) || 0;
    if (currTs > prevTs) {
      latest = row;
      continue;
    }
    if (currTs === prevTs) {
      const prevBlock = Number(latest.blockNumber) || 0;
      const currBlock = Number(row.blockNumber) || 0;
      if (currBlock > prevBlock) {
        latest = row;
      }
    }
  }
  if (latest) {
    const fallback = Number(latest.priceCents);
    if (Number.isFinite(fallback) && fallback > 0) {
      return Math.round(fallback);
    }
  }
  return 0;
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
    let missingAddresses = false;
    if (!orderBookAddr) {
      missingAddresses = true;
    }
    if (!registryAddr) {
      missingAddresses = true;
    }
    if (missingAddresses) {
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

    let startBlock = Math.max(0, Number(state.lastIndexedBlock) + 1);
    if (Number(state.lastIndexedBlock) < 0) {
      const lookbackStart = Math.max(0, latestBlock - INDEXER_BOOTSTRAP_LOOKBACK_BLOCKS + 1);
      startBlock = lookbackStart;
    }
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

    const topics = [
      ethers.id('OrderPlaced(uint256,address,address,uint8,uint256,uint256)'),
      ethers.id('OrderFilled(uint256,uint256,address,uint256,uint256)'),
      ethers.id('OrderCancelled(uint256,address,uint256)'),
    ];
    const logs = await getLogsChunked({
      address: orderBookAddr,
      topics: [topics],
    }, startBlock, latestBlock);
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
      let includeToken = true;
      if (isMissing) {
        includeToken = false;
      }
      if (isZero) {
        includeToken = false;
      }
      if (includeToken) {
        addresses.add(normalized);
        symbolByTokenCache.set(normalized, symbol);
      }
    }
    const tokenAddresses = Array.from(addresses);

    let leveragedLogs = [];
    const leveragedRouterAddress = normalizeAddress(deployments.leveragedProductRouter);
    if (INDEXER_ENABLE_LEVERAGED && leveragedRouterAddress) {
      const leveragedTopics = [
        ethers.id('LeveragedMinted(address,address,string,uint8,uint256,uint256,uint256)'),
        ethers.id('LeveragedUnwound(address,address,string,uint8,uint256,uint256,uint256)'),
      ];
      leveragedLogs = await getLogsChunked({
        address: leveragedRouterAddress,
        topics: [leveragedTopics],
      }, startBlock, latestBlock);
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
    if (INDEXER_ENABLE_TRANSFERS && tokenAddresses.length > 0) {
      const transferTopic = ethers.id('Transfer(address,address,uint256)');
      transferLogs = [];
      for (const token of tokenAddresses) {
        const part = await getLogsChunked({
          address: token,
          topics: [transferTopic],
        }, startBlock, latestBlock);
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
        let missingSymbol = false;
        if (!symbol) {
          missingSymbol = true;
        }
        if (symbol === '') {
          missingSymbol = true;
        }
        if (missingSymbol) {
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
          if (makerOrder.cancelledAtBlock) {
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
            if (takerOrder.cancelledAtBlock) {
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

async function waitForIndexerSyncBounded() {
  await Promise.race([
    ensureIndexerSynced(),
    new Promise((resolve) => setTimeout(resolve, INDEXER_SYNC_WAIT_MS)),
  ]);
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

async function readReceiptGasData(txHashRaw) {
  const txHash = String(txHashRaw);
  if (!txHash) {
    return {
      from: '',
      gasUsed: 0n,
      costWei: 0n,
    };
  }
  if (txReceiptGasCache.has(txHash)) {
    const cached = txReceiptGasCache.get(txHash);
    return {
      from: String(cached.from),
      gasUsed: BigInt(String(cached.gasUsed)),
      costWei: BigInt(String(cached.costWei)),
    };
  }
  const receipt = await hardhatRpc('eth_getTransactionReceipt', [txHash]);
  if (!receipt) {
    return {
      from: '',
      gasUsed: 0n,
      costWei: 0n,
    };
  }
  const from = normalizeAddress(receipt.from);
  const gasUsed = toBigIntSafe(receipt.gasUsed);
  let gasPrice = 0n;
  if (receipt.effectiveGasPrice) {
    gasPrice = toBigIntSafe(receipt.effectiveGasPrice);
  }
  if (gasPrice === 0n && receipt.gasPrice) {
    gasPrice = toBigIntSafe(receipt.gasPrice);
  }
  if (gasPrice === 0n) {
    try {
      const tx = await hardhatRpc('eth_getTransactionByHash', [txHash]);
      if (tx && tx.gasPrice) {
        gasPrice = toBigIntSafe(tx.gasPrice);
      }
    } catch {
      gasPrice = 0n;
    }
  }
  const costWei = gasUsed * gasPrice;
  txReceiptGasCache.set(txHash, {
    from,
    gasUsed: gasUsed.toString(),
    costWei: costWei.toString(),
  });
  return {
    from,
    gasUsed,
    costWei,
  };
}

function collectWalletRelatedTxHashes(snapshot, wallet) {
  const walletNorm = normalizeAddress(wallet);
  const txHashes = new Set();
  const orderIds = Object.keys(snapshot.orders);
  for (let i = 0; i < orderIds.length; i += 1) {
    const order = snapshot.orders[orderIds[i]];
    const trader = normalizeAddress(order.trader);
    if (trader === walletNorm) {
      const txHash = String(order.placedTxHash || '');
      if (txHash) {
        txHashes.add(txHash);
      }
    }
  }
  for (let i = 0; i < snapshot.cancellations.length; i += 1) {
    const row = snapshot.cancellations[i];
    const trader = normalizeAddress(row.trader);
    if (trader === walletNorm) {
      const txHash = String(row.txHash || '');
      if (txHash) {
        txHashes.add(txHash);
      }
    }
  }
  for (let i = 0; i < snapshot.fills.length; i += 1) {
    const row = snapshot.fills[i];
    let include = false;
    if (normalizeAddress(row.makerTrader) === walletNorm) {
      include = true;
    }
    if (normalizeAddress(row.takerTrader) === walletNorm) {
      include = true;
    }
    if (include) {
      const txHash = String(row.txHash || '');
      if (txHash) {
        txHashes.add(txHash);
      }
    }
  }
  for (let i = 0; i < snapshot.leveragedEvents.length; i += 1) {
    const row = snapshot.leveragedEvents[i];
    const eventWallet = normalizeAddress(row.wallet);
    if (eventWallet === walletNorm) {
      const txHash = String(row.txHash || '');
      if (txHash) {
        txHashes.add(txHash);
      }
    }
  }
  for (let i = 0; i < snapshot.transfers.length; i += 1) {
    const row = snapshot.transfers[i];
    const to = normalizeAddress(row.to);
    const from = normalizeAddress(row.from);
    if (to === walletNorm || from === walletNorm) {
      const txHash = String(row.txHash || '');
      if (txHash) {
        txHashes.add(txHash);
      }
    }
  }
  return Array.from(txHashes);
}

async function computeOverallGasForWallet(snapshot, wallet) {
  const walletNorm = normalizeAddress(wallet);
  const txHashes = collectWalletRelatedTxHashes(snapshot, walletNorm);
  let totalGasUsed = 0n;
  let totalCostWei = 0n;
  for (let i = 0; i < txHashes.length; i += 1) {
    const txHash = txHashes[i];
    let receiptData = null;
    try {
      receiptData = await readReceiptGasData(txHash);
    } catch {
      receiptData = null;
    }
    if (receiptData && receiptData.from === walletNorm) {
      totalGasUsed += receiptData.gasUsed;
      totalCostWei += receiptData.costWei;
    }
  }
  return {
    gasUsedUnits: totalGasUsed,
    gasCostWei: totalCostWei,
    txCount: txHashes.length,
  };
}

function quoteAmountWei(qtyWei, priceCents) {
  return (BigInt(qtyWei) * BigInt(priceCents)) / 100n;
}

function getStableUnmatchedCostCents(snapshot, symbol, usedQty, usedCostWei) {
  if (usedQty > 0n && usedCostWei > 0n) {
    const avgKnown = Number((usedCostWei * 100n) / usedQty);
    if (Number.isFinite(avgKnown) && avgKnown > 0) {
      return avgKnown;
    }
  }
  const fills = Array.isArray(snapshot && snapshot.fills) ? snapshot.fills : [];
  let latest = null;
  for (let i = 0; i < fills.length; i += 1) {
    const row = fills[i];
    if (String(row.symbol || '').toUpperCase() !== String(symbol || '').toUpperCase()) {
      continue;
    }
    if (!latest) {
      latest = row;
      continue;
    }
    const prevTs = Number(latest.timestampMs) || 0;
    const currTs = Number(row.timestampMs) || 0;
    if (currTs > prevTs) {
      latest = row;
      continue;
    }
    if (currTs === prevTs) {
      const prevBlock = Number(latest.blockNumber) || 0;
      const currBlock = Number(row.blockNumber) || 0;
      if (currBlock > prevBlock) {
        latest = row;
      }
    }
  }
  if (latest) {
    const fallback = Number(latest.priceCents);
    if (Number.isFinite(fallback) && fallback > 0) {
      return fallback;
    }
  }
  return 0;
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
  let symbolText = '';
  if (symbol) {
    symbolText = String(symbol);
  }
  return symbolText.toUpperCase();
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

function getDefaultLiveUpdatesState() {
  return {
    enabled: true,
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

function readLiveUpdatesState() {
  ensureAdminDir();
  return readJsonFile(LIVE_UPDATES_STATE_FILE, getDefaultLiveUpdatesState());
}

function writeLiveUpdatesState(state) {
  ensureAdminDir();
  writeJsonFile(LIVE_UPDATES_STATE_FILE, state);
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

function readMerkleHolderScanState() {
  ensureDividendsMerkleDir();
  return readJsonFile(MERKLE_HOLDER_SCAN_STATE_FILE, { tokens: {} });
}

function writeMerkleHolderScanState(state) {
  ensureDividendsMerkleDir();
  writeJsonFile(MERKLE_HOLDER_SCAN_STATE_FILE, state);
}

function normalizeHolderArray(rawRows) {
  const seen = new Set();
  const holders = [];
  const rows = Array.isArray(rawRows) ? rawRows : [];
  for (let i = 0; i < rows.length; i += 1) {
    const normalized = normalizeAddress(rows[i]);
    if (!normalized || normalized === ethers.ZeroAddress) {
      continue;
    }
    const lower = normalized.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      holders.push(normalized);
    }
  }
  holders.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return holders;
}

function codeExistsAtBlock(codeRaw) {
  const text = String(codeRaw || '').toLowerCase();
  return text && text !== '0x';
}

async function resolveContractDeploymentBlock(address, latestBlock) {
  const normalized = normalizeAddress(address);
  if (!normalized) {
    return 0;
  }
  let left = 0;
  let right = Math.max(0, Number(latestBlock));
  const latestCode = await hardhatRpc('eth_getCode', [normalized, ethers.toQuantity(right)]);
  if (!codeExistsAtBlock(latestCode)) {
    return 0;
  }
  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    const code = await hardhatRpc('eth_getCode', [normalized, ethers.toQuantity(mid)]);
    if (codeExistsAtBlock(code)) {
      right = mid;
    } else {
      left = mid + 1;
    }
  }
  return left;
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
  let invalidReceiptInput = false;
  if (!receipt) {
    invalidReceiptInput = true;
  }
  if (!Array.isArray(receipt.logs)) {
    invalidReceiptInput = true;
  }
  if (invalidReceiptInput) {
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
  const normalizedToken = normalizeAddress(tokenAddress);
  if (!normalizedToken) {
    return [];
  }
  const transferTopic = ethers.id('Transfer(address,address,uint256)');
  const endBlock = parseRpcInt(toBlockHex);
  if (!Number.isFinite(endBlock) || endBlock < 0) {
    return [];
  }
  const state = readMerkleHolderScanState();
  if (!state.tokens || typeof state.tokens !== 'object') {
    state.tokens = {};
  }
  const tokenKey = normalizedToken.toLowerCase();
  const current = state.tokens[tokenKey] || {};
  let deploymentBlock = Number(current.deploymentBlock);
  if (!Number.isFinite(deploymentBlock) || deploymentBlock < 0 || deploymentBlock > endBlock) {
    deploymentBlock = await resolveContractDeploymentBlock(normalizedToken, endBlock);
  }
  let lastScannedBlock = Number(current.lastScannedBlock);
  const hasPriorScan = Number.isFinite(lastScannedBlock);
  if (!hasPriorScan) {
    if (MERKLE_HOLDER_INITIAL_LOOKBACK_BLOCKS > 0) {
      const initialFrom = Math.max(
        deploymentBlock,
        endBlock - MERKLE_HOLDER_INITIAL_LOOKBACK_BLOCKS + 1,
      );
      lastScannedBlock = initialFrom - 1;
    } else {
      lastScannedBlock = deploymentBlock - 1;
    }
  }
  if (lastScannedBlock < deploymentBlock - 1) {
    lastScannedBlock = deploymentBlock - 1;
  }
  const fromBlock = Math.max(
    deploymentBlock,
    lastScannedBlock + 1 - MERKLE_HOLDER_REORG_LOOKBACK_BLOCKS,
  );
  const seen = new Set();
  const cachedHolders = normalizeHolderArray(current.holders);
  for (let i = 0; i < cachedHolders.length; i += 1) {
    seen.add(cachedHolders[i].toLowerCase());
  }
  let logs = [];
  if (fromBlock <= endBlock) {
    logs = await getLogsChunked({
      address: normalizedToken,
      topics: [transferTopic],
    }, fromBlock, endBlock);
  }
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
    const normalized = normalizeAddress(values[i]);
    if (normalized && normalized !== ethers.ZeroAddress) {
      rows.push(normalized);
    }
  }
  rows.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  state.tokens[tokenKey] = {
    deploymentBlock,
    lastScannedBlock: endBlock,
    holders: rows,
    updatedAtMs: Date.now(),
  };
  writeMerkleHolderScanState(state);
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
  const registryDeployed = await ensureContract(registryAddr);
  if (!registryDeployed) {
    return [];
  }
  const data = registryListInterface.encodeFunctionData('getAllSymbols', []);
  const result = await hardhatRpc('eth_call', [{ to: registryAddr, data }, 'latest']);
  const [symbols] = registryListInterface.decodeFunctionResult('getAllSymbols', result);
  return symbols;
}

async function getBestBookPrices(symbolRaw) {
  const symbol = String(symbolRaw).toUpperCase();
  const deployments = loadDeployments();
  const tokenAddress = await getListingBySymbol(deployments.listingsRegistry, symbol);
  let invalidTokenAddress = false;
  if (!tokenAddress) {
    invalidTokenAddress = true;
  }
  if (tokenAddress === ethers.ZeroAddress) {
    invalidTokenAddress = true;
  }
  if (invalidTokenAddress) {
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
      let shouldSetBid = false;
      if (!hasBid) {
        shouldSetBid = true;
      }
      if (cents > bestBidCents) {
        shouldSetBid = true;
      }
      if (shouldSetBid) {
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
      let shouldSetAsk = false;
      if (!hasAsk) {
        shouldSetAsk = true;
      }
      if (cents < bestAskCents) {
        shouldSetAsk = true;
      }
      if (shouldSetAsk) {
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
  const marketPriceCents = Number(rule.marketPriceCents);
  if (side === 'BUY') {
    if (book.hasAsk && book.bestAskCents <= triggerPriceCents) {
      return true;
    }
    if (Number.isFinite(marketPriceCents) && marketPriceCents > 0) {
      return marketPriceCents <= triggerPriceCents;
    }
    return false;
  }
  if (side === 'SELL') {
    if (book.hasBid && book.bestBidCents >= triggerPriceCents) {
      return true;
    }
    if (Number.isFinite(marketPriceCents) && marketPriceCents > 0) {
      return marketPriceCents >= triggerPriceCents;
    }
    return false;
  }
  return false;
}

async function readMarketPriceCentsForAutoTrade(symbolRaw) {
  const symbol = String(symbolRaw).toUpperCase();
  if (!symbol) {
    return 0;
  }
  try {
    const deployments = loadDeployments();
    const priceFeedAddress = normalizeAddress(deployments.priceFeed);
    if (priceFeedAddress) {
      const data = priceFeedInterface.encodeFunctionData('getPrice', [symbol]);
      const result = await hardhatRpc('eth_call', [{ to: priceFeedAddress, data }, 'latest']);
      const [priceCentsRaw] = priceFeedInterface.decodeFunctionResult('getPrice', result);
      const onchainPriceCents = Number(priceCentsRaw);
      if (Number.isFinite(onchainPriceCents) && onchainPriceCents > 0) {
        return onchainPriceCents;
      }
    }
  } catch {
  }
  try {
    const quote = await fetchQuote(symbol);
    const price = Number(quote.regularMarketPrice || quote.price || 0);
    if (Number.isFinite(price) && price > 0) {
      return Math.round(price * 100);
    }
  } catch {
  }
  try {
    const payload = await fetchFmpJson(getFmpUrl('quote-short', { symbol }));
    let row = null;
    if (Array.isArray(payload) && payload.length > 0) {
      row = payload[0];
    } else if (payload && typeof payload === 'object') {
      row = payload;
    }
    if (row) {
      const price = Number(row.price || 0);
      if (Number.isFinite(price) && price > 0) {
        return Math.round(price * 100);
      }
    }
  } catch {
  }
  return 0;
}

function isRulePausedByLifecycle(rule) {
  const symbolStatus = getSymbolLifecycleStatus(rule.symbol);
  let isPaused = false;
  if (symbolStatus === 'FROZEN') {
    isPaused = true;
  }
  if (symbolStatus === 'DELISTED') {
    isPaused = true;
  }
  return isPaused;
}

function normalizeRuleForResponse(rule) {
  let cooldownSec = 0;
  if (rule.cooldownSec) {
    cooldownSec = Number(rule.cooldownSec);
  }
  let maxExecutionsPerDay = 0;
  if (rule.maxExecutionsPerDay) {
    maxExecutionsPerDay = Number(rule.maxExecutionsPerDay);
  }
  let createdAtMs = 0;
  if (rule.createdAtMs) {
    createdAtMs = Number(rule.createdAtMs);
  }
  let updatedAtMs = 0;
  if (rule.updatedAtMs) {
    updatedAtMs = Number(rule.updatedAtMs);
  }
  let lastExecutedAtMs = 0;
  if (rule.lastExecutedAtMs) {
    lastExecutedAtMs = Number(rule.lastExecutedAtMs);
  }
  return {
    id: Number(rule.id),
    wallet: rule.wallet,
    symbol: rule.symbol,
    side: rule.side,
    triggerPriceCents: Number(rule.triggerPriceCents),
    qtyWei: String(rule.qtyWei),
    maxSlippageBps: Number(rule.maxSlippageBps),
    enabled: Boolean(rule.enabled),
    cooldownSec,
    maxExecutionsPerDay,
    createdAtMs,
    updatedAtMs,
    lastExecutedAtMs,
    pausedByLifecycle: isRulePausedByLifecycle(rule),
  };
}

function normalizeExecutionForResponse(entry) {
  let observedBestBidCents = 0;
  if (entry.observedBestBidCents) {
    observedBestBidCents = Number(entry.observedBestBidCents);
  }
  let observedBestAskCents = 0;
  if (entry.observedBestAskCents) {
    observedBestAskCents = Number(entry.observedBestAskCents);
  }
  let observedMarketPriceCents = 0;
  if (entry.observedMarketPriceCents) {
    observedMarketPriceCents = Number(entry.observedMarketPriceCents);
  }
  let error = '';
  if (entry.error) {
    error = entry.error;
  }
  return {
    id: Number(entry.id),
    ruleId: Number(entry.ruleId),
    wallet: entry.wallet,
    symbol: entry.symbol,
    side: entry.side,
    triggerPriceCents: Number(entry.triggerPriceCents),
    observedBestBidCents,
    observedBestAskCents,
    observedMarketPriceCents,
    qtyWei: String(entry.qtyWei),
    txHash: entry.txHash,
    status: entry.status,
    error,
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
  const canSend = await canServerSendFromAddress(wallet);
  if (!canSend) {
    throw new Error(`autotrade wallet ${wallet} is not available on server signer set`);
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
    const busyForMs = Date.now() - autoTradeLoopStartedAtMs;
    if (busyForMs > 45000) {
      autoTradeLoopBusy = false;
      autoTradeLoopStartedAtMs = 0;
    } else {
      return;
    }
  }
  autoTradeLoopBusy = true;
  autoTradeLoopStartedAtMs = Date.now();

  try {
    const state = readAutoTradeState();
    if (!state.listenerRunning) {
      return;
    }
    state.lastTickAtMs = Date.now();

    for (let i = 0; i < state.rules.length; i += 1) {
      const rule = state.rules[i];
      let shouldRunRule = true;
      if (!rule.enabled || isRulePausedByLifecycle(rule)) {
        shouldRunRule = false;
      }

      const nowMs = Date.now();
      if (shouldRunRule) {
        let cooldownSec = 0;
        if (rule.cooldownSec) {
          cooldownSec = Number(rule.cooldownSec);
        }
        let lastExecutedAtMs = 0;
        if (rule.lastExecutedAtMs) {
          lastExecutedAtMs = Number(rule.lastExecutedAtMs);
        }
        if (cooldownSec > 0 && lastExecutedAtMs > 0) {
          const elapsedMs = nowMs - Number(rule.lastExecutedAtMs);
          if (elapsedMs < (cooldownSec * 1000)) {
            shouldRunRule = false;
          }
        }
      }

      if (shouldRunRule) {
        let maxExecutionsPerDay = 0;
        if (rule.maxExecutionsPerDay) {
          maxExecutionsPerDay = Number(rule.maxExecutionsPerDay);
        }
        const currentDay = getDateKeyEt();
        if (rule.executionsDay !== currentDay) {
          rule.executionsDay = currentDay;
          rule.executionsDayCount = 0;
        }
        let executionsDayCount = 0;
        if (rule.executionsDayCount) {
          executionsDayCount = Number(rule.executionsDayCount);
        }
        if (maxExecutionsPerDay > 0 && executionsDayCount >= maxExecutionsPerDay) {
          shouldRunRule = false;
        }
      }

      let book = { tokenAddress: '' };
      if (shouldRunRule) {
        book = await getBestBookPrices(rule.symbol);
        if (!book.tokenAddress) {
          shouldRunRule = false;
        }
      }
      if (shouldRunRule) {
        const marketPriceCents = await readMarketPriceCentsForAutoTrade(rule.symbol);
        rule.marketPriceCents = marketPriceCents;
        const triggerNow = shouldRuleTrigger(rule, book);
        if (!triggerNow) {
          shouldRunRule = false;
        }
      }
      if (!shouldRunRule) {
        // skip this rule this tick
      } else {

      const executionId = state.nextExecutionId;
      state.nextExecutionId = Number(state.nextExecutionId) + 1;
      const entry = {
        id: executionId,
        ruleId: Number(rule.id),
        wallet: rule.wallet,
        symbol: rule.symbol,
        side: rule.side,
        triggerPriceCents: Number(rule.triggerPriceCents),
        observedBestBidCents: (() => {
          let value = 0;
          if (book.bestBidCents) {
            value = Number(book.bestBidCents);
          }
          return value;
        })(),
        observedBestAskCents: (() => {
          let value = 0;
          if (book.bestAskCents) {
            value = Number(book.bestAskCents);
          }
          return value;
        })(),
        observedMarketPriceCents: (() => {
          let value = 0;
          if (rule.marketPriceCents) {
            value = Number(rule.marketPriceCents);
          }
          return value;
        })(),
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
        let currentExecutionsDayCount = 0;
        if (rule.executionsDayCount) {
          currentExecutionsDayCount = Number(rule.executionsDayCount);
        }
        rule.executionsDayCount = currentExecutionsDayCount + 1;
        state.rules.splice(i, 1);
        i -= 1;
      } catch (err) {
        let reason = 'execution failed';
        if (err.message) {
          reason = err.message;
        }
        entry.error = reason;
        if (reason.includes('not available on server signer set')) {
          rule.enabled = false;
          rule.updatedAtMs = Date.now();
        }
      }

      state.executions.push(entry);
      }
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
    autoTradeLoopStartedAtMs = 0;
  }
}

function computeSymbolCostBasis(lots) {
  
}
// check trading day for candle
function isTradingDay(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  let weekend = false;
  let isWeekend = false;
  if (weekday === 0) {
    isWeekend = true;
  }
  if (weekday === 6) {
    isWeekend = true;
  }
  if (isWeekend) {
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
    let cacheFresh = false;
    if (cached) {
      const ageMs = Date.now() - cached.timestamp;
      if (ageMs < FMP_QUOTE_TTL_MS) {
        cacheFresh = true;
      }
    }
    if (cacheFresh) {
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
        const staleData = {
          symbol: cached.data.symbol,
          price: cached.data.price,
          volume: cached.data.volume,
          previousClose: cached.data.previousClose,
          changePercent: cached.data.changePercent,
          stale: true,
        };
        return res.json(staleData);
      }
      let msg = '';
      if (err.message) {
        msg = err.message;
      }
      res.status(502).json({ error: msg });
    }
  }
});

app.get('/api/fmp/index-ticker', async (_req, res) => {
  const now = Date.now();
  const rows = [];

  for (let i = 0; i < FMP_US_TOP_SYMBOLS.length; i += 1) {
    const symbol = String(FMP_US_TOP_SYMBOLS[i]).toUpperCase();
    const cached = fmpIndexTickerCache.get(symbol);
    let shouldUseCache = false;
    if (cached) {
      const ageMs = now - cached.timestamp;
      if (ageMs < FMP_INDEX_TTL_MS) {
        shouldUseCache = true;
      }
    }
    if (shouldUseCache) {
      rows.push(cached.data);
    } else {
      try {
        const payload = await fetchFmpJson(getFmpUrl('quote', { symbol }));
        let quote = payload;
        if (Array.isArray(payload)) {
          quote = payload[0];
        }
        const price = Number(pick(quote, ['price', 'regularMarketPrice']));
        const previousClose = Number(quote.previousClose);
        const change = Number(quote.change);

        let changePercentRaw = quote.changePercentage;
        if (!Number.isFinite(Number(changePercentRaw))) {
          changePercentRaw = quote.changesPercentage;
        }
        if (!Number.isFinite(Number(changePercentRaw))) {
          changePercentRaw = quote.changePercent;
        }

        let changePercent = NaN;
        if (typeof changePercentRaw === 'string') {
          const cleaned = changePercentRaw.replace('%', '').trim();
          changePercent = Number(cleaned);
        } else {
          changePercent = Number(changePercentRaw);
        }

        // FMP returns percent units (0.53 = 0.53%), UI expects ratio (0.0053)
        if (Number.isFinite(changePercent)) {
          changePercent = changePercent / 100;
        } else if (Number.isFinite(change) && Number.isFinite(previousClose) && previousClose > 0) {
          changePercent = change / previousClose;
        }
        let label = '';
        if (quote.name) {
          label = String(quote.name);
        }
        if (!label && quote.symbol) {
          label = String(quote.symbol);
        }
        if (!label) {
          label = symbol;
        }

        let outputSymbol = symbol;
        if (quote.symbol) {
          outputSymbol = String(quote.symbol);
        }
        const next = {
          symbol: outputSymbol,
          label,
          price,
          changePercent,
        };
        fmpIndexTickerCache.set(symbol, { data: next, timestamp: now });
        rows.push(next);
      } catch (err) {
        if (cached) {
          rows.push(cached.data);
        }
      }
    }
  }

  if (rows.length === 0) {
    return res.status(502).json({ error: 'failed to load stock ticker' });
  }

  res.json({
    ok: true,
    updatedAtMs: now,
    rows,
  });
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
      let currency = 'USD';
      if (price.currency) {
        currency = price.currency;
      }
      const fallbackData = {
        symbol,
        currency,
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

app.get('/api/fmp/market-details', async (req, res) => {
  let symbolRaw = 'TSLA';
  if (req.query.symbol) {
    symbolRaw = String(req.query.symbol);
  }
  const symbol = symbolRaw.toUpperCase();
  const cached = fmpDetailsCache.get(symbol);

  try {
    if (cached && (Date.now() - cached.timestamp) < FMP_DETAILS_TTL_MS) {
      return res.json(cached.data);
    }

    const endpointJobs = [
      ['searchExchangeVariants', getFmpUrl('search-exchange-variants', { symbol })],
      ['companyScreener', getFmpUrl('company-screener', { limit: '200' })],
      ['stockPeers', getFmpUrl('stock-peers', { symbol })],
      ['profile', getFmpUrl('profile', { symbol })],
      ['employeeCount', getFmpUrl('employee-count', { symbol })],
      ['historicalEmployeeCount', getFmpUrl('historical-employee-count', { symbol })],
      ['keyExecutives', getFmpUrl('key-executives', { symbol })],
      ['governanceExecutiveCompensation', getFmpUrl('governance-executive-compensation', { symbol })],
      ['quote', getFmpUrl('quote', { symbol })],
      ['stockPriceChange', getFmpUrl('stock-price-change', { symbol })],
      ['marketCapitalization', getFmpUrl('market-capitalization', { symbol })],
      ['historicalMarketCapitalization', getFmpUrl('historical-market-capitalization', { symbol })],
      ['sharesFloat', getFmpUrl('shares-float', { symbol })],
      ['balanceSheet', getFmpUrl('balance-sheet-statement', { symbol, limit: '4' })],
      ['balanceSheetQuarterly', getFmpUrl('balance-sheet-statement', { symbol, period: 'quarter', limit: '8' })],
      ['incomeStatementQuarterly', getFmpUrl('income-statement', { symbol, period: 'quarter', limit: '8' })],
      ['cashFlowStatementQuarterly', getFmpUrl('cash-flow-statement', { symbol, period: 'quarter', limit: '8' })],
      ['keyMetrics', getFmpUrl('key-metrics', { symbol, limit: '4' })],
      ['ratios', getFmpUrl('ratios', { symbol, limit: '4' })],
      ['keyMetricsTtm', getFmpUrl('key-metrics-ttm', { symbol })],
      ['ratiosTtm', getFmpUrl('ratios-ttm', { symbol })],
      ['enterpriseValues', getFmpUrl('enterprise-values', { symbol, limit: '4' })],
      ['newsLatest', getFmpUrl('news/stock-latest', { page: '0', limit: '50' })],
      ['ratingsHistorical', getFmpUrl('ratings-historical', { symbol, limit: '20' })],
      ['analystEstimates', getFmpUrl('analyst-estimates', { symbol, period: 'annual', page: '0', limit: '20' })],
      ['priceTargetSummary', getFmpUrl('price-target-summary', { symbol })],
      ['priceTargetHistory', getFmpUrl('price-target', { symbol, page: '0', limit: '20' })],
      ['earningsSurprises', getFmpUrl('earnings-surprises', { symbol, limit: '20' })],
      ['grades', getFmpUrl('grades', { symbol, limit: '20' })],
      ['insiderLatest', getFmpUrl('insider-trading/latest', { page: '0', limit: '200' })],
      ['mergersAcquisitionsLatest', getFmpUrl('mergers-acquisitions-latest', { page: '0', limit: '100' })],
    ];

    const collected = {};
    const sourceErrors = {};
    const settled = await Promise.all(endpointJobs.map(async (job) => {
      const key = job[0];
      const url = job[1];
      try {
        const payload = await fetchFmpJson(url);
        return [key, payload];
      } catch (err) {
        let reason = 'request failed';
        if (err.message) {
          reason = err.message;
        }
        sourceErrors[key] = reason;
        return [key, []];
      }
    }));
    for (let i = 0; i < settled.length; i += 1) {
      const entry = settled[i];
      const key = entry[0];
      const payload = entry[1];
      collected[key] = payload;
    }

    function asArray(payload) {
      if (Array.isArray(payload)) {
        return payload;
      }
      return [payload];
    }

    function first(payload) {
      const rows = asArray(payload);
      if (rows.length > 0) {
        return rows[0];
      }
      return {};
    }

    function keepNumber(value) {
      const n = Number(value);
      if (Number.isFinite(n)) {
        return n;
      }
      return null;
    }

    const quoteRow = first(collected.quote);
    const profileRow = first(collected.profile);
    const changeRow = first(collected.stockPriceChange);
    const employeeRow = first(collected.employeeCount);
    const keyMetricsTtmRow = first(collected.keyMetricsTtm);
    const ratiosTtmRow = first(collected.ratiosTtm);
    const priceTargetRow = first(collected.priceTargetSummary);
    const screenerRows = asArray(collected.companyScreener);
    let screenerRow = {};
    for (let i = 0; i < screenerRows.length; i += 1) {
      const row = screenerRows[i];
      let rowSymbolText = '';
      if (row.symbol) {
        rowSymbolText = String(row.symbol);
      } else if (row.ticker) {
        rowSymbolText = String(row.ticker);
      }
      const rowSymbol = rowSymbolText.toUpperCase();
      if (rowSymbol === symbol) {
        screenerRow = row;
      }
    }

    const executivesRows = [];
    const keyExecutivesRows = asArray(collected.keyExecutives);
    const keyExecutivesLimit = Math.min(10, keyExecutivesRows.length);
    for (let i = 0; i < keyExecutivesLimit; i += 1) {
      const row = keyExecutivesRows[i];
      let name = '';
      if (row.name) {
        name = String(row.name);
      }
      let title = '';
      if (row.title) {
        title = String(row.title);
      } else if (row.position) {
        title = String(row.position);
      }
      let currency = '';
      if (row.currency) {
        currency = String(row.currency);
      }
      let year = '';
      if (row.year) {
        year = String(row.year);
      }
      executivesRows.push({
        name,
        title,
        pay: keepNumber(row.pay),
        currency,
        year,
      });
    }

    const executiveCompRows = [];
    const executiveCompSourceRows = asArray(collected.governanceExecutiveCompensation);
    const executiveCompLimit = Math.min(10, executiveCompSourceRows.length);
    for (let i = 0; i < executiveCompLimit; i += 1) {
      const row = executiveCompSourceRows[i];
      let name = '';
      if (row.name) {
        name = String(row.name);
      } else if (row.executive) {
        name = String(row.executive);
      }
      let title = '';
      if (row.title) {
        title = String(row.title);
      } else if (row.position) {
        title = String(row.position);
      }
      let totalSource = row.total;
      if (!totalSource) {
        totalSource = row.totalCompensation;
      }
      if (!totalSource) {
        totalSource = row.totalPay;
      }
      let stockAwardsSource = row.stockAwards;
      if (!stockAwardsSource) {
        stockAwardsSource = row.stockAward;
      }
      let year = '';
      if (row.year) {
        year = String(row.year);
      } else if (row.fiscalYear) {
        year = String(row.fiscalYear);
      }
      executiveCompRows.push({
        name,
        title,
        total: keepNumber(totalSource),
        salary: keepNumber(row.salary),
        bonus: keepNumber(row.bonus),
        stockAwards: keepNumber(stockAwardsSource),
        year,
      });
    }

    const employeeHistoryRows = [];
    const employeeHistorySourceRows = asArray(collected.historicalEmployeeCount);
    const employeeHistoryLimit = Math.min(12, employeeHistorySourceRows.length);
    for (let i = 0; i < employeeHistoryLimit; i += 1) {
      const row = employeeHistorySourceRows[i];
      let date = '';
      if (row.date) {
        date = String(row.date);
      } else if (row.period) {
        date = String(row.period);
      }
      let employeeCountSource = row.employeeCount;
      if (!employeeCountSource) {
        employeeCountSource = row.employees;
      }
      employeeHistoryRows.push({
        date,
        employeeCount: keepNumber(employeeCountSource),
      });
    }
    const sharesFloatRow = first(collected.sharesFloat);
    const marketCapRows = [];
    const marketCapSourceRows = asArray(collected.marketCapitalization);
    const marketCapLimit = Math.min(1, marketCapSourceRows.length);
    for (let i = 0; i < marketCapLimit; i += 1) {
      const row = marketCapSourceRows[i];
      let date = '';
      if (row.date) {
        date = String(row.date);
      }
      let marketCapSource = row.marketCap;
      if (!marketCapSource) {
        marketCapSource = row.marketCapitalization;
      }
      marketCapRows.push({
        date,
        marketCap: keepNumber(marketCapSource),
      });
    }

    const marketCapHistoryRows = [];
    const marketCapHistorySourceRows = asArray(collected.historicalMarketCapitalization);
    const marketCapHistoryLimit = Math.min(30, marketCapHistorySourceRows.length);
    for (let i = 0; i < marketCapHistoryLimit; i += 1) {
      const row = marketCapHistorySourceRows[i];
      let date = '';
      if (row.date) {
        date = String(row.date);
      }
      let marketCapSource = row.marketCap;
      if (!marketCapSource) {
        marketCapSource = row.marketCapitalization;
      }
      marketCapHistoryRows.push({
        date,
        marketCap: keepNumber(marketCapSource),
      });
    }

    const peerRows = [];
    const stockPeerSourceRows = asArray(collected.stockPeers);
    const stockPeerLimit = Math.min(20, stockPeerSourceRows.length);
    for (let i = 0; i < stockPeerLimit; i += 1) {
      const row = stockPeerSourceRows[i];
      let peerText = '';
      if (row.symbol) {
        peerText = String(row.symbol);
      } else if (row.ticker) {
        peerText = String(row.ticker);
      } else if (row) {
        peerText = String(row);
      }
      const peerSymbol = peerText.toUpperCase();
      if (peerSymbol) {
        peerRows.push(peerSymbol);
      }
    }

    const balanceRows = [];
    const balanceSourceRows = asArray(collected.balanceSheet);
    const balanceLimit = Math.min(4, balanceSourceRows.length);
    for (let i = 0; i < balanceLimit; i += 1) {
      const row = balanceSourceRows[i];
      let date = '';
      if (row.date) {
        date = String(row.date);
      } else if (row.fillingDate) {
        date = String(row.fillingDate);
      }
      balanceRows.push({
        date,
        totalAssets: keepNumber(row.totalAssets),
        totalLiabilities: keepNumber(row.totalLiabilities),
        totalStockholdersEquity: keepNumber(row.totalStockholdersEquity),
        cashAndCashEquivalents: keepNumber(row.cashAndCashEquivalents),
        totalDebt: keepNumber(row.totalDebt),
      });
    }

    const balanceQuarterlyRows = [];
    const balanceQuarterlySourceRows = asArray(collected.balanceSheetQuarterly);
    const balanceQuarterlyLimit = Math.min(8, balanceQuarterlySourceRows.length);
    for (let i = 0; i < balanceQuarterlyLimit; i += 1) {
      const row = balanceQuarterlySourceRows[i];
      let date = '';
      if (row.date) {
        date = String(row.date);
      } else if (row.fillingDate) {
        date = String(row.fillingDate);
      }
      balanceQuarterlyRows.push({
        date,
        totalAssets: keepNumber(row.totalAssets),
        totalLiabilities: keepNumber(row.totalLiabilities),
        totalDebt: keepNumber(row.totalDebt),
      });
    }

    const incomeQuarterlyRows = [];
    const incomeQuarterlySourceRows = asArray(collected.incomeStatementQuarterly);
    const incomeQuarterlyLimit = Math.min(8, incomeQuarterlySourceRows.length);
    for (let i = 0; i < incomeQuarterlyLimit; i += 1) {
      const row = incomeQuarterlySourceRows[i];
      let date = '';
      if (row.date) {
        date = String(row.date);
      } else if (row.fillingDate) {
        date = String(row.fillingDate);
      }
      incomeQuarterlyRows.push({
        date,
        revenue: keepNumber(row.revenue),
        netIncome: keepNumber(row.netIncome),
        ebitda: keepNumber(row.ebitda),
        eps: keepNumber(row.eps),
      });
    }

    const cashFlowQuarterlyRows = [];
    const cashFlowQuarterlySourceRows = asArray(collected.cashFlowStatementQuarterly);
    const cashFlowQuarterlyLimit = Math.min(8, cashFlowQuarterlySourceRows.length);
    for (let i = 0; i < cashFlowQuarterlyLimit; i += 1) {
      const row = cashFlowQuarterlySourceRows[i];
      let date = '';
      if (row.date) {
        date = String(row.date);
      } else if (row.fillingDate) {
        date = String(row.fillingDate);
      }
      cashFlowQuarterlyRows.push({
        date,
        operatingCashFlow: keepNumber(row.operatingCashFlow),
        freeCashFlow: keepNumber(row.freeCashFlow),
        capitalExpenditure: keepNumber(row.capitalExpenditure),
      });
    }

    const metricsRows = [];
    const metricsSourceRows = asArray(collected.keyMetrics);
    const metricsLimit = Math.min(4, metricsSourceRows.length);
    for (let i = 0; i < metricsLimit; i += 1) {
      const row = metricsSourceRows[i];
      let date = '';
      if (row.date) {
        date = String(row.date);
      }
      metricsRows.push({
        date,
        peRatio: keepNumber(row.peRatio),
        pbRatio: keepNumber(row.pbRatio),
        roe: keepNumber(row.roe),
        roa: keepNumber(row.roa),
        debtToEquity: keepNumber(row.debtToEquity),
      });
    }

    const ratiosRows = [];
    const ratiosSourceRows = asArray(collected.ratios);
    const ratiosLimit = Math.min(4, ratiosSourceRows.length);
    for (let i = 0; i < ratiosLimit; i += 1) {
      const row = ratiosSourceRows[i];
      let date = '';
      if (row.date) {
        date = String(row.date);
      }
      ratiosRows.push({
        date,
        currentRatio: keepNumber(row.currentRatio),
        quickRatio: keepNumber(row.quickRatio),
        netProfitMargin: keepNumber(row.netProfitMargin),
        grossProfitMargin: keepNumber(row.grossProfitMargin),
        returnOnEquity: keepNumber(row.returnOnEquity),
      });
    }

    const enterpriseRows = [];
    const enterpriseSourceRows = asArray(collected.enterpriseValues);
    const enterpriseLimit = Math.min(4, enterpriseSourceRows.length);
    for (let i = 0; i < enterpriseLimit; i += 1) {
      const row = enterpriseSourceRows[i];
      let date = '';
      if (row.date) {
        date = String(row.date);
      }
      enterpriseRows.push({
        date,
        stockPrice: keepNumber(row.stockPrice),
        marketCapitalization: keepNumber(row.marketCapitalization),
        enterpriseValue: keepNumber(row.enterpriseValue),
        numberOfShares: keepNumber(row.numberOfShares),
      });
    }

    const ratingsRows = [];
    const ratingsSourceRows = asArray(collected.ratingsHistorical);
    const ratingsLimit = Math.min(10, ratingsSourceRows.length);
    for (let i = 0; i < ratingsLimit; i += 1) {
      const row = ratingsSourceRows[i];
      let date = '';
      if (row.date) {
        date = String(row.date);
      }
      let rating = '';
      if (row.rating) {
        rating = String(row.rating);
      } else if (row.ratingRecommendation) {
        rating = String(row.ratingRecommendation);
      }
      ratingsRows.push({
        date,
        rating,
        score: keepNumber(row.ratingScore),
      });
    }

    const estimatesRows = [];
    const estimatesSourceRows = asArray(collected.analystEstimates);
    const estimatesLimit = Math.min(10, estimatesSourceRows.length);
    for (let i = 0; i < estimatesLimit; i += 1) {
      const row = estimatesSourceRows[i];
      let date = '';
      if (row.date) {
        date = String(row.date);
      } else if (row.period) {
        date = String(row.period);
      }
      estimatesRows.push({
        date,
        estimatedRevenueAvg: keepNumber(row.estimatedRevenueAvg),
        estimatedEbitdaAvg: keepNumber(row.estimatedEbitdaAvg),
        estimatedNetIncomeAvg: keepNumber(row.estimatedNetIncomeAvg),
        estimatedEpsAvg: keepNumber(row.estimatedEpsAvg),
      });
    }

    const gradesRows = [];
    const gradesSourceRows = asArray(collected.grades);
    const gradesLimit = Math.min(10, gradesSourceRows.length);
    for (let i = 0; i < gradesLimit; i += 1) {
      const row = gradesSourceRows[i];
      let date = '';
      if (row.date) {
        date = String(row.date);
      }
      let gradingCompany = '';
      if (row.gradingCompany) {
        gradingCompany = String(row.gradingCompany);
      }
      let previousGrade = '';
      if (row.previousGrade) {
        previousGrade = String(row.previousGrade);
      }
      let newGrade = '';
      if (row.newGrade) {
        newGrade = String(row.newGrade);
      }
      let action = '';
      if (row.action) {
        action = String(row.action);
      }
      gradesRows.push({
        date,
        gradingCompany,
        previousGrade,
        newGrade,
        action,
      });
    }

    const priceTargetHistoryRows = [];
    const priceTargetHistorySourceRows = asArray(collected.priceTargetHistory);
    const priceTargetHistoryLimit = Math.min(20, priceTargetHistorySourceRows.length);
    for (let i = 0; i < priceTargetHistoryLimit; i += 1) {
      const row = priceTargetHistorySourceRows[i];
      let date = '';
      if (row.publishedDate) {
        date = String(row.publishedDate);
      } else if (row.date) {
        date = String(row.date);
      }
      let analyst = '';
      if (row.analystName) {
        analyst = String(row.analystName);
      } else if (row.analyst) {
        analyst = String(row.analyst);
      } else if (row.gradingCompany) {
        analyst = String(row.gradingCompany);
      }
      let newsUrl = '';
      if (row.newsURL) {
        newsUrl = String(row.newsURL);
      } else if (row.url) {
        newsUrl = String(row.url);
      }
      let targetSource = row.priceTarget;
      if (!targetSource) {
        targetSource = row.targetPrice;
      }
      if (!targetSource) {
        targetSource = row.target;
      }
      priceTargetHistoryRows.push({
        date,
        analyst,
        targetPrice: keepNumber(targetSource),
        newsUrl,
      });
    }

    const earningsSurpriseRows = [];
    const earningsSurpriseSourceRows = asArray(collected.earningsSurprises);
    const earningsSurpriseLimit = Math.min(20, earningsSurpriseSourceRows.length);
    for (let i = 0; i < earningsSurpriseLimit; i += 1) {
      const row = earningsSurpriseSourceRows[i];
      let date = '';
      if (row.date) {
        date = String(row.date);
      } else if (row.fiscalDateEnding) {
        date = String(row.fiscalDateEnding);
      }
      let actualSource = row.actualEarningResult;
      if (!actualSource) {
        actualSource = row.actualEPS;
      }
      if (!actualSource) {
        actualSource = row.actual;
      }
      let estimateSource = row.estimatedEarning;
      if (!estimateSource) {
        estimateSource = row.consensusEPS;
      }
      if (!estimateSource) {
        estimateSource = row.estimated;
      }
      let surpriseSource = row.earningsSurprise;
      if (!surpriseSource) {
        surpriseSource = row.surprise;
      }
      let surprisePctSource = row.earningsSurprisePercentage;
      if (!surprisePctSource) {
        surprisePctSource = row.surprisePercentage;
      }
      earningsSurpriseRows.push({
        date,
        actual: keepNumber(actualSource),
        estimate: keepNumber(estimateSource),
        surprise: keepNumber(surpriseSource),
        surprisePct: keepNumber(surprisePctSource),
      });
    }

    const newsAllRows = [];
    const newsSourceRows = asArray(collected.newsLatest);
    for (let i = 0; i < newsSourceRows.length; i += 1) {
      const row = newsSourceRows[i];
      let rowSymbol = '';
      if (row.symbol) {
        rowSymbol = String(row.symbol);
      } else if (row.ticker) {
        rowSymbol = String(row.ticker);
      }
      let title = '';
      if (row.title) {
        title = String(row.title);
      }
      let publisher = '';
      if (row.site) {
        publisher = String(row.site);
      } else if (row.publisher) {
        publisher = String(row.publisher);
      }
      let publishedDate = '';
      if (row.publishedDate) {
        publishedDate = String(row.publishedDate);
      } else if (row.date) {
        publishedDate = String(row.date);
      }
      let url = '';
      if (row.url) {
        url = String(row.url);
      }
      newsAllRows.push({
        symbol: rowSymbol,
        title,
        publisher,
        publishedDate,
        url,
      });
    }
    const newsFiltered = newsAllRows.filter((row) => {
      let rowSymbolText = '';
      if (row.symbol) {
        rowSymbolText = String(row.symbol);
      }
      const rowSymbol = rowSymbolText.toUpperCase();
      let allowRow = false;
      if (!rowSymbol) {
        allowRow = true;
      }
      if (rowSymbol === symbol) {
        allowRow = true;
      }
      return allowRow;
    });
    let newsBaseRows = newsAllRows;
    if (newsFiltered.length > 0) {
      newsBaseRows = newsFiltered;
    }
    const newsRows = [];
    const newsRowsLimit = Math.min(20, newsBaseRows.length);
    for (let i = 0; i < newsRowsLimit; i += 1) {
      const row = newsBaseRows[i];
      newsRows.push({
        symbol: String(row.symbol),
        title: String(row.title),
        publisher: String(row.publisher),
        publishedDate: String(row.publishedDate),
        url: String(row.url),
      });
    }

    const insiderAllRows = [];
    const insiderSourceRows = asArray(collected.insiderLatest);
    for (let i = 0; i < insiderSourceRows.length; i += 1) {
      const row = insiderSourceRows[i];
      let rowSymbol = '';
      if (row.symbol) {
        rowSymbol = String(row.symbol);
      } else if (row.ticker) {
        rowSymbol = String(row.ticker);
      }
      let date = '';
      if (row.transactionDate) {
        date = String(row.transactionDate);
      } else if (row.filingDate) {
        date = String(row.filingDate);
      } else if (row.date) {
        date = String(row.date);
      }
      let reportingName = '';
      if (row.reportingName) {
        reportingName = String(row.reportingName);
      } else if (row.reporterName) {
        reportingName = String(row.reporterName);
      }
      let securitiesTransactedSource = row.securitiesTransacted;
      if (!securitiesTransactedSource) {
        securitiesTransactedSource = row.shares;
      }
      insiderAllRows.push({
        symbol: rowSymbol,
        date,
        reportingName,
        transactionType: String(row.transactionType),
        securitiesTransacted: keepNumber(securitiesTransactedSource),
        price: keepNumber(row.price),
      });
    }
    const insiderFiltered = insiderAllRows.filter((row) => {
      let rowSymbolText = '';
      if (row.symbol) {
        rowSymbolText = String(row.symbol);
      }
      const rowSymbol = rowSymbolText.toUpperCase();
      return rowSymbol === symbol;
    });
    let insiderBaseRows = insiderAllRows;
    if (insiderFiltered.length > 0) {
      insiderBaseRows = insiderFiltered;
    }
    const insiderRows = [];
    const insiderRowsLimit = Math.min(20, insiderBaseRows.length);
    for (let i = 0; i < insiderRowsLimit; i += 1) {
      const row = insiderBaseRows[i];
      insiderRows.push({
        symbol: String(row.symbol),
        date: String(row.date),
        reportingName: String(row.reportingName),
        transactionType: String(row.transactionType),
        securitiesTransacted: keepNumber(row.securitiesTransacted),
        price: keepNumber(row.price),
      });
    }

    let overviewName = '';
    if (profileRow.companyName) {
      overviewName = String(profileRow.companyName);
    } else if (profileRow.name) {
      overviewName = String(profileRow.name);
    }
    let overviewDescription = '';
    if (profileRow.description) {
      overviewDescription = String(profileRow.description);
    }
    let overviewExchange = '';
    if (profileRow.exchange) {
      overviewExchange = String(profileRow.exchange);
    } else if (profileRow.exchangeShortName) {
      overviewExchange = String(profileRow.exchangeShortName);
    }
    let overviewSector = '';
    if (profileRow.sector) {
      overviewSector = String(profileRow.sector);
    } else if (screenerRow.sector) {
      overviewSector = String(screenerRow.sector);
    }
    let overviewIndustry = '';
    if (profileRow.industry) {
      overviewIndustry = String(profileRow.industry);
    } else if (screenerRow.industry) {
      overviewIndustry = String(screenerRow.industry);
    }
    let overviewCeo = '';
    if (profileRow.ceo) {
      overviewCeo = String(profileRow.ceo);
    }
    let overviewCountry = '';
    if (profileRow.country) {
      overviewCountry = String(profileRow.country);
    }
    let overviewCity = '';
    if (profileRow.city) {
      overviewCity = String(profileRow.city);
    }
    let overviewState = '';
    if (profileRow.state) {
      overviewState = String(profileRow.state);
    }
    let overviewWebsite = '';
    if (profileRow.website) {
      overviewWebsite = String(profileRow.website);
    }
    let overviewCurrency = '';
    if (quoteRow.currency) {
      overviewCurrency = String(quoteRow.currency);
    }
    let overviewIpoDate = '';
    if (profileRow.ipoDate) {
      overviewIpoDate = String(profileRow.ipoDate);
    }

    const searchExchangeVariants = [];
    const searchExchangeVariantsSource = asArray(collected.searchExchangeVariants);
    const searchExchangeVariantsLimit = Math.min(8, searchExchangeVariantsSource.length);
    for (let i = 0; i < searchExchangeVariantsLimit; i += 1) {
      searchExchangeVariants.push(searchExchangeVariantsSource[i]);
    }

    let companyPhone = '';
    if (profileRow.phone) {
      companyPhone = String(profileRow.phone);
    }
    let companyIsin = '';
    if (profileRow.isin) {
      companyIsin = String(profileRow.isin);
    }
    let companyCusip = '';
    if (profileRow.cusip) {
      companyCusip = String(profileRow.cusip);
    }
    let screenerCompanyName = '';
    if (screenerRow.companyName) {
      screenerCompanyName = String(screenerRow.companyName);
    }
    let screenerExchangeShortName = '';
    if (screenerRow.exchangeShortName) {
      screenerExchangeShortName = String(screenerRow.exchangeShortName);
    }
    let screenerCountry = '';
    if (screenerRow.country) {
      screenerCountry = String(screenerRow.country);
    }
    let screenerIpoDate = '';
    if (screenerRow.ipoDate) {
      screenerIpoDate = String(screenerRow.ipoDate);
    }

    let floatSharesSource = sharesFloatRow.floatShares;
    if (!floatSharesSource) {
      floatSharesSource = sharesFloatRow.outstandingSharesFloat;
    }

    const mergersAcquisitions = [];
    const mergersAcquisitionsSourceRows = asArray(collected.mergersAcquisitionsLatest);
    const mergersAcquisitionsLimit = Math.min(20, mergersAcquisitionsSourceRows.length);
    for (let i = 0; i < mergersAcquisitionsLimit; i += 1) {
      const row = mergersAcquisitionsSourceRows[i];
      let companyName = '';
      if (row.companyName) {
        companyName = String(row.companyName);
      } else if (row.targetCompany) {
        companyName = String(row.targetCompany);
      }
      let acquiringCompany = '';
      if (row.acquiringCompany) {
        acquiringCompany = String(row.acquiringCompany);
      }
      let announcedDate = '';
      if (row.announcedDate) {
        announcedDate = String(row.announcedDate);
      } else if (row.date) {
        announcedDate = String(row.date);
      }
      let status = '';
      if (row.status) {
        status = String(row.status);
      }
      mergersAcquisitions.push({
        companyName,
        acquiringCompany,
        announcedDate,
        status,
      });
    }

    const payload = {
      symbol,
      asOfMs: Date.now(),
      sections: {
        overview: {
          name: overviewName,
          description: overviewDescription,
          exchange: overviewExchange,
          sector: overviewSector,
          industry: overviewIndustry,
          ceo: overviewCeo,
          country: overviewCountry,
          city: overviewCity,
          state: overviewState,
          website: overviewWebsite,
          currency: overviewCurrency,
          ipoDate: overviewIpoDate,
          price: keepNumber(pick(quoteRow, ['price'])),
          previousClose: keepNumber(pick(quoteRow, ['previousClose', 'prevClose'])),
          open: keepNumber(pick(quoteRow, ['open'])),
          dayLow: keepNumber(pick(quoteRow, ['dayLow', 'low'])),
          dayHigh: keepNumber(pick(quoteRow, ['dayHigh', 'high'])),
          yearLow: keepNumber(pick(quoteRow, ['yearLow', 'fiftyTwoWeekLow', '52WeekLow'])),
          yearHigh: keepNumber(pick(quoteRow, ['yearHigh', 'fiftyTwoWeekHigh', '52WeekHigh'])),
          marketCap: keepNumber(pick(quoteRow, ['marketCap', 'mktCap'])),
          volume: keepNumber(pick(quoteRow, ['volume'])),
          avgVolume: keepNumber(pick(quoteRow, ['avgVolume', 'averageVolume'])),
          beta: keepNumber(pick(quoteRow, ['beta'])),
          pe: keepNumber(pick(quoteRow, ['pe', 'peTTM'])),
          eps: keepNumber(pick(quoteRow, ['eps', 'epsTTM'])),
          stockPriceChange1D: keepNumber(pick(changeRow, ['1D', 'changesPercentage', 'changePercent'])),
        },
        company: {
          searchExchangeVariants,
          employeeCount: keepNumber(pick(employeeRow, ['employeeCount', 'employees'])),
          employeeCountHistory: employeeHistoryRows,
          peers: peerRows,
          phone: companyPhone,
          isin: companyIsin,
          cusip: companyCusip,
          screener: {
            companyName: screenerCompanyName,
            exchangeShortName: screenerExchangeShortName,
            marketCap: keepNumber(screenerRow.marketCap),
            country: screenerCountry,
            ipoDate: screenerIpoDate,
            isEtf: Boolean(screenerRow.isEtf),
            isActivelyTrading: Boolean(screenerRow.isActivelyTrading),
          },
        },
        people: {
          keyExecutives: executivesRows,
          executiveCompensation: executiveCompRows,
        },
        financial: {
          balanceSheet: balanceRows,
          balanceSheetQuarterly: balanceQuarterlyRows,
          incomeStatementQuarterly: incomeQuarterlyRows,
          cashFlowStatementQuarterly: cashFlowQuarterlyRows,
          keyMetrics: metricsRows,
          ratios: ratiosRows,
          keyMetricsTtm: keyMetricsTtmRow,
          ratiosTtm: ratiosTtmRow,
          enterpriseValues: enterpriseRows,
          sharesFloat: {
            freeFloat: keepNumber(sharesFloatRow.freeFloat),
            floatShares: keepNumber(floatSharesSource),
            outstandingShares: keepNumber(sharesFloatRow.outstandingShares),
          },
          marketCapitalization: marketCapRows,
          historicalMarketCapitalization: marketCapHistoryRows,
        },
        analysis: {
          ratingsHistorical: ratingsRows,
          analystEstimates: estimatesRows,
          priceTargetSummary: priceTargetRow,
          priceTargetHistory: priceTargetHistoryRows,
          earningsSurprises: earningsSurpriseRows,
          grades: gradesRows,
        },
        news: newsRows,
        insider: insiderRows,
        mergersAcquisitions,
      },
      sourceErrors,
    };

    fmpDetailsCache.set(symbol, { data: payload, timestamp: Date.now() });
    res.json(payload);
  } catch (err) {
    let msg = '';
    if (err.message) {
      msg = err.message;
    }
    res.status(502).json({ error: msg });
  }
});
// rest api to get hardhat accounts
app.get('/api/hardhat/accounts', async (_req, res) => {
  try {
    let accounts = await hardhatRpc('eth_accounts');
    if (!Array.isArray(accounts) || accounts.length === 0) {
      accounts = [];
      const signerValues = Array.from(RPC_SIGNERS.values());
      for (let i = 0; i < signerValues.length; i += 1) {
        accounts.push(signerValues[i].address);
      }
    }
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

app.get('/api/ui/permissions', (req, res) => {
  let walletRaw = '';
  if (req.query && req.query.wallet) {
    walletRaw = String(req.query.wallet);
  }
  const wallet = normalizeAddress(walletRaw);
  const isAdmin = isAdminWallet(wallet);
  res.json({
    wallet,
    isAdmin,
    canAccessAdminPage: isAdmin,
    canUseLiveUpdates: isAdmin,
  });
});

app.get('/api/admin/wallets', (req, res) => {
  try {
    let walletRaw = '';
    if (req.query && req.query.wallet) {
      walletRaw = String(req.query.wallet);
    }
    const wallet = normalizeAddress(walletRaw);
    if (!wallet) {
      return res.status(400).json({ error: 'wallet is required' });
    }
    if (!isAdminWallet(wallet)) {
      return res.status(403).json({ error: 'admin wallet required' });
    }
    const state = readAdminWalletState();
    const rows = Array.isArray(state.wallets) ? state.wallets : [];
    const set = new Set();
    if (IMMUTABLE_ADMIN_WALLET) {
      set.add(IMMUTABLE_ADMIN_WALLET.toLowerCase());
    }
    for (let i = 0; i < rows.length; i += 1) {
      const normalized = normalizeAddress(rows[i]);
      if (normalized) {
        set.add(normalized.toLowerCase());
      }
    }
    const wallets = Array.from(set).map((item) => normalizeAddress(item)).filter(Boolean);
    wallets.sort((a, b) => a.localeCompare(b));
    res.json({
      wallets,
      immutableAdminWallet: IMMUTABLE_ADMIN_WALLET || '',
      updatedAtMs: Number(state.updatedAtMs || 0),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/wallets/add', (req, res) => {
  try {
    const body = req.body || {};
    const actorWallet = normalizeAddress(String(body.wallet || ''));
    const targetWallet = normalizeAddress(String(body.targetWallet || ''));
    if (!actorWallet) {
      return res.status(400).json({ error: 'wallet is required' });
    }
    if (!isAdminWallet(actorWallet)) {
      return res.status(403).json({ error: 'admin wallet required' });
    }
    if (!targetWallet) {
      return res.status(400).json({ error: 'targetWallet must be a valid address' });
    }
    const state = readAdminWalletState();
    const set = new Set();
    if (IMMUTABLE_ADMIN_WALLET) {
      set.add(IMMUTABLE_ADMIN_WALLET.toLowerCase());
    }
    const rows = Array.isArray(state.wallets) ? state.wallets : [];
    for (let i = 0; i < rows.length; i += 1) {
      const normalized = normalizeAddress(rows[i]);
      if (normalized) {
        set.add(normalized.toLowerCase());
      }
    }
    set.add(targetWallet.toLowerCase());
    const wallets = Array.from(set).map((item) => normalizeAddress(item)).filter(Boolean);
    wallets.sort((a, b) => a.localeCompare(b));
    const next = {
      wallets,
      updatedAtMs: Date.now(),
    };
    writeAdminWalletState(next);
    res.json({
      wallets,
      immutableAdminWallet: IMMUTABLE_ADMIN_WALLET || '',
      updatedAtMs: next.updatedAtMs,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/wallets/remove', (req, res) => {
  try {
    const body = req.body || {};
    const actorWallet = normalizeAddress(String(body.wallet || ''));
    const targetWallet = normalizeAddress(String(body.targetWallet || ''));
    if (!actorWallet) {
      return res.status(400).json({ error: 'wallet is required' });
    }
    if (!isAdminWallet(actorWallet)) {
      return res.status(403).json({ error: 'admin wallet required' });
    }
    if (!targetWallet) {
      return res.status(400).json({ error: 'targetWallet must be a valid address' });
    }
    if (IMMUTABLE_ADMIN_WALLET && targetWallet.toLowerCase() === IMMUTABLE_ADMIN_WALLET.toLowerCase()) {
      return res.status(400).json({ error: 'cannot remove immutable admin wallet' });
    }
    const state = readAdminWalletState();
    const set = new Set();
    if (IMMUTABLE_ADMIN_WALLET) {
      set.add(IMMUTABLE_ADMIN_WALLET.toLowerCase());
    }
    const rows = Array.isArray(state.wallets) ? state.wallets : [];
    for (let i = 0; i < rows.length; i += 1) {
      const normalized = normalizeAddress(rows[i]);
      if (normalized) {
        const key = normalized.toLowerCase();
        if (key !== targetWallet.toLowerCase()) {
          set.add(key);
        }
      }
    }
    const wallets = Array.from(set).map((item) => normalizeAddress(item)).filter(Boolean);
    wallets.sort((a, b) => a.localeCompare(b));
    const next = {
      wallets,
      updatedAtMs: Date.now(),
    };
    writeAdminWalletState(next);
    res.json({
      wallets,
      immutableAdminWallet: IMMUTABLE_ADMIN_WALLET || '',
      updatedAtMs: next.updatedAtMs,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/live-updates/status', (_req, res) => {
  const state = readLiveUpdatesState();
  const enabled = state && state.enabled !== false;
  res.json({
    enabled,
    updatedAtMs: Number(state.updatedAtMs || 0),
  });
});

// rest api to get balances with fallback if none fetched
app.get('/api/ttoken/balance', async (req, res) => {
  const address = String(req.query.address);
  try {
    let ttokenAddress = getTTokenAddressFromDeployments();
    if (process.env.TTOKEN_ADDRESS) {
      ttokenAddress = process.env.TTOKEN_ADDRESS;
    }
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
  const amountRaw = String(body.amount);
  const amount = Number(amountRaw);
  const recipientValid = isValidAddress(to);
  if (!recipientValid) {
    return res.status(400).json({ error: 'invalid recipient address' });
  }
  const amountIsNumber = Number.isFinite(amount);
  let invalidAmount = false;
  if (!amountIsNumber) {
    invalidAmount = true;
  }
  if (!(amount > 0)) {
    invalidAmount = true;
  }
  if (invalidAmount) {
    return res.status(400).json({ error: 'amount must be greater than 0' });
  }

  let ttokenAddress = getTTokenAddressFromDeployments();
  if (process.env.TTOKEN_ADDRESS) {
    ttokenAddress = process.env.TTOKEN_ADDRESS;
  }

  try {
    const deployments = loadDeployments();
    const from = deployments.admin;
    const fromValid = isValidAddress(from);
    if (!fromValid) {
      return res.status(500).json({ error: 'Admin address missing in deployments' });
    }

    let amountWei = 0n;
    try {
      amountWei = ethers.parseUnits(amountRaw, 18);
    } catch {
      return res.status(400).json({ error: 'amount must be a valid number' });
    }
    if (!(amountWei > 0n)) {
      return res.status(400).json({ error: 'amount must be greater than 0' });
    }
    const data = equityTokenInterface.encodeFunctionData('mint', [to, amountWei]);
    const txHash = await hardhatRpc('eth_sendTransaction', [{
      from,
      to: ttokenAddress,
      data,
    }]);
    const receipt = await waitForReceipt(txHash);
    const blockNumber = parseRpcInt(receipt.blockNumber);
    const timestampMs = await getBlockTimestampMs(receipt.blockNumber);
    appendManualMintActivity({
      wallet: to,
      tokenAddress: ttokenAddress,
      symbol: 'TTOKEN',
      assetType: 'TTOKEN',
      amountWei: amountWei.toString(),
      reason: 'MINT_TTOKEN',
      txHash,
      blockNumber,
      timestampMs,
    });
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
    const ensurePriceResult = await ensureOnchainPriceForSymbol(symbol);
    if (!ensurePriceResult.ok) {
      return res.status(400).json({ error: ensurePriceResult.error });
    }
    const symbolLifecycle = getSymbolLifecycleStatus(symbol);
    let blockedByLifecycle = false;
    if (symbolLifecycle === 'FROZEN') {
      blockedByLifecycle = true;
    }
    if (symbolLifecycle === 'DELISTED') {
      blockedByLifecycle = true;
    }
    if (blockedByLifecycle) {
      return res.status(400).json({ error: `symbol ${symbol} is ${symbolLifecycle}` });
    }
    const sideText = String(body.side).toUpperCase();
    const priceCents = Number(body.priceCents);
    const qty = Number(body.qty);
    let fromText = '';
    if (body.from) {
      fromText = String(body.from);
    }
    const from = normalizeAddress(fromText);
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
    if (!Number.isFinite(qty)) {
      return res.status(400).json({ error: 'qty must be a number' });
    }
    if (!Number.isInteger(qty)) {
      return res.status(400).json({ error: 'qty must be a whole number' });
    }
    if (qty < MIN_STOCK_QTY_UNITS) {
      return res.status(400).json({ error: `qty must be at least ${MIN_STOCK_QTY_UNITS}` });
    }
    if (qty % MIN_STOCK_QTY_UNITS !== 0) {
      return res.status(400).json({ error: `qty must be in steps of ${MIN_STOCK_QTY_UNITS}` });
    }

    const qtyWei = BigInt(qty) * 10n ** 18n;
    // decimal of 18 for tokens
    const clientSign = wantsClientSign(body);
    const orderData = orderBookInterface.encodeFunctionData('placeLimitOrder', [
      tokenAddr,
      side,
      priceCents,
      qtyWei,
    ]);

    if (side === 0) {
      const quoteWei = (qtyWei * BigInt(priceCents)) / 100n;
      const approveData = equityTokenInterface.encodeFunctionData('approve', [orderBookAddr, quoteWei]);
      if (clientSign) {
        return res.json({
          clientSign: true,
          txs: [
            { label: 'approve_ttoken', from, to: ttokenAddr, data: approveData },
            { label: 'place_limit_order', from, to: orderBookAddr, data: orderData },
          ],
        });
      }
      const approveTxHash = await hardhatRpc('eth_sendTransaction', [{
        from: from,
        to: ttokenAddr,
        data: approveData,
      }]);
      await waitForReceipt(approveTxHash);
    } else {
      const approveData = equityTokenInterface.encodeFunctionData('approve', [orderBookAddr, qtyWei]);
      if (clientSign) {
        return res.json({
          clientSign: true,
          txs: [
            { label: 'approve_equity', from, to: tokenAddr, data: approveData },
            { label: 'place_limit_order', from, to: orderBookAddr, data: orderData },
          ],
        });
      }
      const approveTxHash = await hardhatRpc('eth_sendTransaction', [{
        from: from,
        to: tokenAddr,
        data: approveData,
      }]);
      await waitForReceipt(approveTxHash);
    }

    const txHash = await hardhatRpc('eth_sendTransaction', [{
      from: from,
      to: orderBookAddr,
      data: orderData,
    }]);
    await waitForReceipt(txHash);

    res.json({ txHash: txHash });
  } catch (err) {
    res.status(500).json({ error: toUserErrorMessage(err.message) });
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
    res.status(500).json({ error: toUserErrorMessage(err.message) });
  }
});

// rest api to get all the filled orders
app.get('/api/orderbook/fills', async (_req, res) => {
  try {
    await ensureIndexerSynced();
    const snapshot = readIndexerSnapshot();
    const fills = [];
    for (const row of snapshot.fills) {
      fills.push({
        makerId: Number(row.makerId),
        takerId: Number(row.takerId),
        makerTrader: row.makerTrader,
        takerTrader: row.takerTrader,
        symbol: row.symbol,
        priceCents: Number(row.priceCents),
        qty: row.qtyWei,
        blockNumber: Number(row.blockNumber),
        txHash: row.txHash,
        timestampMs: Number(row.timestampMs),
      });
    }
    fills.sort((a, b) => b.timestampMs - a.timestampMs);
    res.json({ fills: fills });
  } catch (err) {
    res.status(500).json({ error: toUserErrorMessage(err.message) });
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
    res.status(500).json({ error: toUserErrorMessage(err.message) });
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
      let isOpenStatus = false;
      if (order.status === 'OPEN') {
        isOpenStatus = true;
      }
      if (order.status === 'PARTIAL') {
        isOpenStatus = true;
      }
      if (isOpenStatus) {
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
  let invalidOrderId = false;
  if (!Number.isFinite(orderId)) {
    invalidOrderId = true;
  }
  if (orderId <= 0) {
    invalidOrderId = true;
  }
  if (invalidOrderId) {
    return res.status(400).json({ error: 'invalid order id' });
  }

  try {
    await ensureIndexerSynced();
    const { orders } = readIndexerSnapshot();
    const order = orders[String(orderId)];
    let missingOrder = false;
    if (!order) {
      missingOrder = true;
    }
    if (order && order.trader !== wallet) {
      missingOrder = true;
    }
    if (missingOrder) {
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
  let invalidCancelOrderId = false;
  if (!Number.isFinite(orderId)) {
    invalidCancelOrderId = true;
  }
  if (orderId <= 0) {
    invalidCancelOrderId = true;
  }
  if (invalidCancelOrderId) {
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
    let openOrPartial = false;
    if (order.status === 'OPEN') {
      openOrPartial = true;
    }
    if (order.status === 'PARTIAL') {
      openOrPartial = true;
    }
    if (openOrPartial) {
      isCancellable = true;
    }
    if (!isCancellable) {
      return res.status(400).json({ error: 'order is not cancellable' });
    }

    const deployments = loadDeployments();
    const orderBookAddr = deployments.orderBookDex;
    const data = orderBookInterface.encodeFunctionData('cancelOrder', [BigInt(orderId)]);
    const clientSign = wantsClientSign(body);
    if (clientSign) {
      return res.json({
        clientSign: true,
        txs: [
          { label: 'cancel_order', from: wallet, to: orderBookAddr, data },
        ],
      });
    }
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
  const allowedTypes = new Set(['ALL', 'ORDERS', 'FILLS', 'CASHFLOW', 'TRANSFERS', 'LEVERAGE']);
  if (!allowedTypes.has(type)) {
    return res.status(400).json({ error: 'invalid type' });
  }

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
  let limit = 50;
  if (Number.isFinite(numericLimit)) {
    limit = Math.min(200, Math.max(1, Math.floor(numericLimit)));
  }

  if (!wallet) {
    return res.status(400).json({ error: 'wallet is required' });
  }

  try {
    await waitForIndexerSyncBounded();
    const snapshot = readIndexerSnapshot();
    const { orders, fills, cancellations, cashflows, transfers, leveragedEvents } = snapshot;
    const items = [];

    let includeOrders = false;
    if (type === 'ALL') {
      includeOrders = true;
    }
    if (type === 'ORDERS') {
      includeOrders = true;
    }
    if (includeOrders) {
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

    let includeFills = false;
    if (type === 'ALL') {
      includeFills = true;
    }
    if (type === 'FILLS') {
      includeFills = true;
    }
    if (includeFills) {
      for (const fill of fills) {
        let side = '';
        if (fill.side) {
          side = String(fill.side).toUpperCase();
        } else if (fill.makerTrader === wallet) {
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

    let includeCashflow = false;
    if (type === 'ALL') {
      includeCashflow = true;
    }
    if (type === 'CASHFLOW') {
      includeCashflow = true;
    }
    if (includeCashflow) {
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

    let includeTransfers = false;
    if (type === 'ALL') {
      includeTransfers = true;
    }
    if (type === 'TRANSFERS') {
      includeTransfers = true;
    }
    if (includeTransfers) {
      for (const transfer of transfers) {
        let isWalletTransfer = false;
        if (transfer.from === wallet) {
          isWalletTransfer = true;
        }
        if (transfer.to === wallet) {
          isWalletTransfer = true;
        }
        if (isWalletTransfer) {
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

    let includeLeverage = false;
    if (type === 'ALL') {
      includeLeverage = true;
    }
    if (type === 'LEVERAGE') {
      includeLeverage = true;
    }
    if (includeLeverage) {
      const leveragedRows = [];
      const seenLeveragedIds = new Set();
      for (const entry of leveragedEvents) {
        if (entry.wallet === wallet) {
          seenLeveragedIds.add(String(entry.id));
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
          leveragedRows.push(row);
        }
      }
      if (leveragedRows.length === 0 && type === 'LEVERAGE' && TXS_ENABLE_LEVERAGE_FALLBACK_SCAN) {
        try {
          const fallbackRows = await fetchRecentLeveragedEventsForWallet(wallet, INDEXER_BOOTSTRAP_LOOKBACK_BLOCKS);
          for (let i = 0; i < fallbackRows.length; i += 1) {
            const entry = fallbackRows[i];
            const entryId = String(entry.id);
            if (seenLeveragedIds.has(entryId)) {
              continue;
            }
            seenLeveragedIds.add(entryId);
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
            leveragedRows.push(row);
          }
        } catch {
        }
      }
      for (let i = 0; i < leveragedRows.length; i += 1) {
        items.push(leveragedRows[i]);
      }
    }

    items.sort((a, b) => {
      const timestampDiff = b.timestampMs - a.timestampMs;
      if (timestampDiff !== 0) {
        return timestampDiff;
      }
      const blockNumberDiff = b.blockNumber - a.blockNumber;
      return blockNumberDiff;
    });
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
    await waitForIndexerSyncBounded();
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
      let isWalletFill = false;
      if (fill.makerTrader === walletNorm) {
        isWalletFill = true;
      }
      if (fill.takerTrader === walletNorm) {
        isWalletFill = true;
      }
      if (isWalletFill) {
        let side = '';
        if (fill.side) {
          side = String(fill.side).toUpperCase();
        } else if (fill.makerTrader === walletNorm) {
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
      if (unmatchedQtyWei > 0n) {
        const unmatchedCostCents = getStableUnmatchedCostCents(snapshot, listing.symbol, usedQty, usedCostWei);
        if (unmatchedCostCents > 0) {
          unmatchedCostWei = quoteAmountWei(unmatchedQtyWei, unmatchedCostCents);
        }
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
    await waitForIndexerSyncBounded();
    const snapshot = readIndexerSnapshot();
    const deployments = loadDeployments();
    const chainIdHex = await hardhatRpc('eth_chainId', []);
    const chainId = parseRpcInt(chainIdHex);
    const nativeEthWeiHex = await hardhatRpc('eth_getBalance', [wallet, 'latest']);
    const nativeEthWei = BigInt(nativeEthWeiHex).toString();
    let nativeSymbol = 'ETH';
    if (chainId === 11155111) {
      nativeSymbol = 'SepoliaETH';
    }
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
      let matchesFillWallet = false;
      if (fill.makerTrader === walletNorm) {
        matchesFillWallet = true;
      }
      if (fill.takerTrader === walletNorm) {
        matchesFillWallet = true;
      }
      if (matchesFillWallet) {
        let side = '';
        if (fill.side) {
          side = String(fill.side).toUpperCase();
        } else if (fill.makerTrader === walletNorm) {
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
      if (unmatchedQtyWei > 0n) {
        const unmatchedCostCents = getStableUnmatchedCostCents(snapshot, listing.symbol, usedQty, usedCostWei);
        if (unmatchedCostCents > 0) {
          unmatchedCostWei = quoteAmountWei(unmatchedQtyWei, unmatchedCostCents);
        }
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
    const gasSummary = await computeOverallGasForWallet(snapshot, wallet);

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
      chainId,
      nativeSymbol,
      nativeEthWei,
      cashValueWei: cashWei.toString(),
      stockValueWei: stockValueWei.toString(),
      leveragedValueWei: leveragedValueWei.toString(),
      totalValueWei: totalValueWei.toString(),
      totalCostBasisWei: totalCostBasisWei.toString(),
      realizedPnlWei: realizedPnlWei.toString(),
      unrealizedPnlWei: unrealizedPnlWei.toString(),
      overallGasUsedUnits: gasSummary.gasUsedUnits.toString(),
      overallGasCostWei: gasSummary.gasCostWei.toString(),
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
      let relatedToWallet = false;
      if (fill.makerTrader === walletNorm) {
        relatedToWallet = true;
      }
      if (fill.takerTrader === walletNorm) {
        relatedToWallet = true;
      }
      if (relatedToWallet) {
        let side = '';
        if (fill.side) {
          side = String(fill.side).toUpperCase();
        } else if (fill.makerTrader === walletNorm) {
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
    let missingEpochTokenAddress = false;
    if (!tokenAddress) {
      missingEpochTokenAddress = true;
    }
    if (tokenAddress === ethers.ZeroAddress) {
      missingEpochTokenAddress = true;
    }
    if (missingEpochTokenAddress) {
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
    let body = {};
    if (req.body) {
      body = req.body;
    }
    let symbolText = '';
    if (body.symbol) {
      symbolText = String(body.symbol);
    }
    const symbol = symbolText.toUpperCase();
    let merkleRoot = '';
    if (body.merkleRoot) {
      merkleRoot = String(body.merkleRoot);
    }
    let totalEntitledWei = '';
    if (body.totalEntitledWei) {
      totalEntitledWei = String(body.totalEntitledWei);
    }
    let claimsUri = '';
    if (body.claimsUri) {
      claimsUri = String(body.claimsUri);
    }
    let contentHash = ethers.ZeroHash;
    if (body.contentHash) {
      contentHash = String(body.contentHash);
    }
    let claims = [];
    if (Array.isArray(body.claims)) {
      claims = body.claims;
    }

    let hasMissingInput = false;
    if (!symbol) {
      hasMissingInput = true;
    }
    if (!merkleRoot) {
      hasMissingInput = true;
    }
    if (!totalEntitledWei) {
      hasMissingInput = true;
    }
    if (hasMissingInput) {
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
    let tokenAddressMissing = false;
    if (!tokenAddress) {
      tokenAddressMissing = true;
    }
    if (tokenAddress === ethers.ZeroAddress) {
      tokenAddressMissing = true;
    }
    if (tokenAddressMissing) {
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
      let accountText = '';
      if (row.account) {
        accountText = String(row.account);
      }
      const account = normalizeAddress(accountText);
      let amountWei = '0';
      if (row.amountWei) {
        amountWei = String(row.amountWei);
      }
      const leafIndex = Number(row.leafIndex);
      let proof = [];
      if (Array.isArray(row.proof)) {
        proof = row.proof;
      }
      let canUseClaim = true;
      if (!account || !(BigInt(amountWei) > 0n)) {
        canUseClaim = false;
      }
      let invalidLeafIndex = false;
      if (!Number.isFinite(leafIndex)) {
        invalidLeafIndex = true;
      }
      if (leafIndex < 0) {
        invalidLeafIndex = true;
      }
      if (invalidLeafIndex) {
        canUseClaim = false;
      }
      if (canUseClaim) {
        normalizedClaims.push({
          account,
          amountWei,
          leafIndex,
          proof,
        });
      }
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
    const message = String(err && err.message ? err.message : err);
    if (isRpcRateLimitError(message) || message.includes('RPC non-JSON response')) {
      return res.status(429).json({ error: 'RPC rate limited while declaring merkle dividend. Please retry in a few seconds.' });
    }
    res.status(500).json({ error: message });
  }
});

app.post('/api/dividends/merkle/declare-auto', async (req, res) => {
  try {
    let body = {};
    if (req.body) {
      body = req.body;
    }
    let symbolText = '';
    if (body.symbol) {
      symbolText = String(body.symbol);
    }
    const symbol = symbolText.toUpperCase();
    let divPerShareText = '';
    if (body.divPerShare) {
      divPerShareText = String(body.divPerShare).trim();
    }
    let claimsUri = '';
    if (body.claimsUri) {
      claimsUri = String(body.claimsUri);
    }
    let missingDeclareAutoInput = false;
    if (!symbol) {
      missingDeclareAutoInput = true;
    }
    if (!divPerShareText) {
      missingDeclareAutoInput = true;
    }
    if (missingDeclareAutoInput) {
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
    let missingTokenAddress = false;
    if (!tokenAddress) {
      missingTokenAddress = true;
    }
    if (tokenAddress === ethers.ZeroAddress) {
      missingTokenAddress = true;
    }
    if (missingTokenAddress) {
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

    const claimRows = await mapWithConcurrency(holders, 4, async (account) => {
      const balData = equityTokenSnapshotInterface.encodeFunctionData('balanceOfAt', [account, BigInt(snapshotId)]);
      const balResult = await hardhatRpc('eth_call', [{ to: tokenAddress, data: balData }, 'latest']);
      const [balanceRaw] = equityTokenSnapshotInterface.decodeFunctionResult('balanceOfAt', balResult);
      const balanceWei = BigInt(balanceRaw.toString());
      if (!(balanceWei > 0n)) {
        return null;
      }
      const amountWei = (balanceWei * divPerShareWei) / (10n ** 18n);
      if (!(amountWei > 0n)) {
        return null;
      }
      return {
        account,
        amountWei: amountWei.toString(),
      };
    });
    const claims = [];
    for (let i = 0; i < claimRows.length; i += 1) {
      if (claimRows[i]) {
        claims.push(claimRows[i]);
      }
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
    const message = String(err && err.message ? err.message : err);
    if (isRpcRateLimitError(message) || message.includes('RPC non-JSON response')) {
      return res.status(429).json({ error: 'RPC rate limited while building merkle tree. Please retry in a few seconds.' });
    }
    res.status(500).json({ error: message });
  }
});

app.get('/api/dividends/merkle/epochs', async (req, res) => {
  let symbolText = '';
  if (req.query.symbol) {
    symbolText = String(req.query.symbol);
  }
  const symbol = symbolText.toUpperCase();
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
      let hasSymbolFilter = false;
      if (symbol) {
        hasSymbolFilter = true;
      }
      let allowEpoch = true;
      if (hasSymbolFilter && epochSymbol !== symbol) {
        allowEpoch = false;
      }
      if (allowEpoch) {
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
    }
    res.json({ symbol, epochs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dividends/merkle/tree', async (req, res) => {
  const epochId = Number(req.query.epochId);
  let invalidMerkleEpochId = false;
  if (!Number.isFinite(epochId)) {
    invalidMerkleEpochId = true;
  }
  if (epochId <= 0) {
    invalidMerkleEpochId = true;
  }
  if (invalidMerkleEpochId) {
    return res.status(400).json({ error: 'epochId is required' });
  }
  try {
    const tree = readMerkleTree(epochId);
    const claims = readMerkleClaims(epochId);
    let levels = [];
    if (Array.isArray(tree.levels)) {
      levels = tree.levels;
    }
    let levelSizes = [];
    if (Array.isArray(tree.levelSizes)) {
      levelSizes = tree.levelSizes;
    }
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
      symbol: (() => {
        let value = '';
        if (tree.symbol) {
          value = String(tree.symbol);
        }
        return value;
      })(),
      tokenAddress: (() => {
        let value = '';
        if (tree.tokenAddress) {
          value = String(tree.tokenAddress);
        }
        return value;
      })(),
      snapshotId: (() => {
        let value = 0;
        if (tree.snapshotId) {
          value = Number(tree.snapshotId);
        }
        return value;
      })(),
      merkleRoot: (() => {
        let value = '';
        if (tree.merkleRoot) {
          value = String(tree.merkleRoot);
        }
        return value;
      })(),
      totalEntitledWei: (() => {
        let value = '0';
        if (tree.totalEntitledWei) {
          value = String(tree.totalEntitledWei);
        }
        return value;
      })(),
      contentHash: (() => {
        let value = ethers.ZeroHash;
        if (tree.contentHash) {
          value = String(tree.contentHash);
        }
        return value;
      })(),
      claimsUri: (() => {
        let value = '';
        if (tree.claimsUri) {
          value = String(tree.claimsUri);
        }
        return value;
      })(),
      claimCount: (() => {
        let value = 0;
        if (Array.isArray(claims.claims)) {
          value = claims.claims.length;
        }
        return value;
      })(),
      levelSizes,
      levels: previewLevels,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dividends/merkle/claimable', async (req, res) => {
  let walletText = '';
  if (req.query.wallet) {
    walletText = String(req.query.wallet);
  }
  const wallet = normalizeAddress(walletText);
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
      let rows = [];
      if (Array.isArray(claimsPayload.claims)) {
        rows = claimsPayload.claims;
      }
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        let accountText = '';
        if (row.account) {
          accountText = String(row.account);
        }
        const account = normalizeAddress(accountText);
        if (account === wallet) {
          const leafIndex = Number(row.leafIndex);
          let amountWei = '0';
          if (row.amountWei) {
            amountWei = String(row.amountWei);
          }
          let proof = [];
          if (Array.isArray(row.proof)) {
            proof = row.proof;
          }
          const claimedData = dividendsMerkleInterface.encodeFunctionData('isClaimed', [BigInt(epochId), BigInt(leafIndex)]);
          const claimedResult = await hardhatRpc('eth_call', [{ to: deployments.dividendsMerkle, data: claimedData }, 'latest']);
          const [claimed] = dividendsMerkleInterface.decodeFunctionResult('isClaimed', claimedResult);
          claimables.push({
            claimType: 'MERKLE',
            epochId,
            symbol: (() => {
              let value = '';
              if (tree.symbol) {
                value = String(tree.symbol);
              }
              return value;
            })(),
            tokenAddress: (() => {
              let value = '';
              if (tree.tokenAddress) {
                value = String(tree.tokenAddress);
              }
              return value;
            })(),
            claimableWei: amountWei,
            amountWei,
            leafIndex,
            proof,
            claimed,
            canClaim: !claimed && BigInt(amountWei) > 0n,
            merkleRoot: (() => {
              let value = '';
              if (tree.merkleRoot) {
                value = String(tree.merkleRoot);
              }
              return value;
            })(),
            contentHash: (() => {
              let value = ethers.ZeroHash;
              if (tree.contentHash) {
                value = String(tree.contentHash);
              }
              return value;
            })(),
            claimsUri: (() => {
              let value = '';
              if (tree.claimsUri) {
                value = String(tree.claimsUri);
              }
              return value;
            })(),
          });
        }
      }
    }

    res.json({ wallet, claimables });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/dividends/merkle/claim', async (req, res) => {
  try {
    let body = {};
    if (req.body) {
      body = req.body;
    }
    let walletText = '';
    if (body.wallet) {
      walletText = String(body.wallet);
    }
    const wallet = normalizeAddress(walletText);
    let accountText = '';
    if (body.account) {
      accountText = String(body.account);
    }
    const account = normalizeAddress(accountText);
    const epochId = Number(body.epochId);
    let amountWei = '0';
    if (body.amountWei) {
      amountWei = String(body.amountWei);
    }
    const leafIndex = Number(body.leafIndex);
    let proof = [];
    if (Array.isArray(body.proof)) {
      proof = body.proof;
    }

    let invalidWalletAccountPair = false;
    if (!wallet) {
      invalidWalletAccountPair = true;
    }
    if (!account) {
      invalidWalletAccountPair = true;
    }
    if (wallet !== account) {
      invalidWalletAccountPair = true;
    }
    if (invalidWalletAccountPair) {
      return res.status(400).json({ error: 'wallet and account must match and be valid address' });
    }
    let invalidClaimEpochId = false;
    if (!Number.isFinite(epochId)) {
      invalidClaimEpochId = true;
    }
    if (epochId <= 0) {
      invalidClaimEpochId = true;
    }
    if (invalidClaimEpochId) {
      return res.status(400).json({ error: 'epochId must be > 0' });
    }
    if (!(BigInt(amountWei) > 0n)) {
      return res.status(400).json({ error: 'amountWei must be > 0' });
    }
    let invalidClaimLeafIndex = false;
    if (!Number.isFinite(leafIndex)) {
      invalidClaimLeafIndex = true;
    }
    if (leafIndex < 0) {
      invalidClaimLeafIndex = true;
    }
    if (invalidClaimLeafIndex) {
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
    const clientSign = wantsClientSign(body);
    if (clientSign) {
      return res.json({
        clientSign: true,
        txs: [
          { label: 'claim_merkle_dividend', from: wallet, to: deployments.dividendsMerkle, data },
        ],
      });
    }
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
          canClaim: (() => {
            let canClaim = false;
            if (BigInt(claimableWei) > 0n) {
              if (!claimed) {
                canClaim = true;
              }
            }
            return canClaim;
          })(),
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
        let rows = [];
        if (Array.isArray(claimsPayload.claims)) {
          rows = claimsPayload.claims;
        }
        for (let i = 0; i < rows.length; i += 1) {
          const row = rows[i];
          let accountText = '';
          if (row.account) {
            accountText = String(row.account);
          }
          const account = normalizeAddress(accountText);
          if (account === wallet) {
            let amountWei = '0';
            if (row.amountWei) {
              amountWei = String(row.amountWei);
            }
            const leafIndex = Number(row.leafIndex);
            let proof = [];
            if (Array.isArray(row.proof)) {
              proof = row.proof;
            }
            const claimedData = dividendsMerkleInterface.encodeFunctionData('isClaimed', [BigInt(epochId), BigInt(leafIndex)]);
            const claimedResult = await hardhatRpc('eth_call', [{ to: deployments.dividendsMerkle, data: claimedData }, 'latest']);
            const [claimed] = dividendsMerkleInterface.decodeFunctionResult('isClaimed', claimedResult);
            let treeSymbol = '';
            if (tree.symbol) {
              treeSymbol = String(tree.symbol);
            }
            let treeTokenAddress = '';
            if (tree.tokenAddress) {
              treeTokenAddress = String(tree.tokenAddress);
            }
            let treeMerkleRoot = '';
            if (tree.merkleRoot) {
              treeMerkleRoot = String(tree.merkleRoot);
            }
            let treeContentHash = ethers.ZeroHash;
            if (tree.contentHash) {
              treeContentHash = String(tree.contentHash);
            }
            let treeClaimsUri = '';
            if (tree.claimsUri) {
              treeClaimsUri = String(tree.claimsUri);
            }
            claimables.push({
              claimType: 'MERKLE',
              symbol: treeSymbol,
              tokenAddress: treeTokenAddress,
              epochId,
              claimableWei: amountWei,
              amountWei,
              leafIndex,
              proof,
              claimed,
              canClaim: (() => {
                let canClaim = false;
                if (BigInt(amountWei) > 0n) {
                  if (!claimed) {
                    canClaim = true;
                  }
                }
                return canClaim;
              })(),
              merkleRoot: treeMerkleRoot,
              contentHash: treeContentHash,
              claimsUri: treeClaimsUri,
            });
          }
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
  let claimableInputInvalid = false;
  if (!wallet) {
    claimableInputInvalid = true;
  }
  if (!symbol) {
    claimableInputInvalid = true;
  }
  if (!Number.isFinite(epochId)) {
    claimableInputInvalid = true;
  }
  if (epochId <= 0) {
    claimableInputInvalid = true;
  }
  if (claimableInputInvalid) {
    return res.status(400).json({ error: 'wallet, symbol, epochId are required' });
  }
  try {
    const deployments = loadDeployments();
    if (!deployments.dividends) {
      return res.status(400).json({ error: 'dividends contract not deployed' });
    }
    const tokenAddress = await getListingBySymbol(deployments.listingsRegistry, symbol);
    let tokenAddressMissing = false;
    if (!tokenAddress) {
      tokenAddressMissing = true;
    }
    if (tokenAddress === ethers.ZeroAddress) {
      tokenAddressMissing = true;
    }
    if (tokenAddressMissing) {
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
      canClaim: (() => {
        let canClaim = false;
        if (BigInt(claimableWei) > 0n) {
          if (!claimed) {
            canClaim = true;
          }
        }
        return canClaim;
      })(),
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
    let missingDeclareInput = false;
    if (!symbol) {
      missingDeclareInput = true;
    }
    if (!divPerShare) {
      missingDeclareInput = true;
    }
    if (missingDeclareInput) {
      return res.status(400).json({ error: 'symbol and divPerShare are required' });
    }
    const deployments = loadDeployments();
    if (!deployments.dividends) {
      return res.status(400).json({ error: 'dividends contract not deployed' });
    }
    const tokenAddress = await getListingBySymbol(deployments.listingsRegistry, symbol);
    let tokenAddressMissing = false;
    if (!tokenAddress) {
      tokenAddressMissing = true;
    }
    if (tokenAddress === ethers.ZeroAddress) {
      tokenAddressMissing = true;
    }
    if (tokenAddressMissing) {
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
    const clientSign = wantsClientSign(body);
    const wallet = normalizeAddress(String(body.wallet));
    const symbol = String(body.symbol).toUpperCase();
    const epochId = Number(body.epochId);
    let invalidClaimInput = false;
    if (!wallet) {
      invalidClaimInput = true;
    }
    if (!symbol) {
      invalidClaimInput = true;
    }
    if (!Number.isFinite(epochId)) {
      invalidClaimInput = true;
    }
    if (epochId <= 0) {
      invalidClaimInput = true;
    }
    if (invalidClaimInput) {
      return res.status(400).json({ error: 'wallet, symbol, epochId are required' });
    }
    const deployments = loadDeployments();
    if (!deployments.dividends) {
      return res.status(400).json({ error: 'dividends contract not deployed' });
    }
    const tokenAddress = await getListingBySymbol(deployments.listingsRegistry, symbol);
    let missingClaimTokenAddress = false;
    if (!tokenAddress) {
      missingClaimTokenAddress = true;
    }
    if (tokenAddress === ethers.ZeroAddress) {
      missingClaimTokenAddress = true;
    }
    if (missingClaimTokenAddress) {
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
    if (clientSign) {
      return res.json({
        clientSign: true,
        txs: [
          { label: 'claim_snapshot_dividend', from: wallet, to: deployments.dividends, data },
        ],
      });
    }
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

  const indexes = [];
  for (let i = 0; i < count; i += 1) {
    indexes.push(i);
  }
  const itemRows = await mapWithConcurrency(indexes, 4, async (i) => {
    const traderData = awardInterface.encodeFunctionData('getEpochTraderAt', [BigInt(epochId), BigInt(i)]);
    const traderResult = await hardhatRpc('eth_call', [{ to: awardAddress, data: traderData }, 'latest']);
    const [traderRaw] = awardInterface.decodeFunctionResult('getEpochTraderAt', traderResult);
    const trader = normalizeAddress(traderRaw);

    const qtyData = awardInterface.encodeFunctionData('qtyByEpochByTrader', [BigInt(epochId), trader]);
    const winnerData = awardInterface.encodeFunctionData('isWinner', [BigInt(epochId), trader]);
    const [qtyResult, winnerResult] = await Promise.all([
      hardhatRpc('eth_call', [{ to: awardAddress, data: qtyData }, 'latest']),
      hardhatRpc('eth_call', [{ to: awardAddress, data: winnerData }, 'latest']),
    ]);
    const [qtyRaw] = awardInterface.decodeFunctionResult('qtyByEpochByTrader', qtyResult);
    const [isWinner] = awardInterface.decodeFunctionResult('isWinner', winnerResult);

    return {
      epochId,
      trader,
      qtyWei: qtyRaw.toString(),
      isWinner,
    };
  });
  const items = [];
  for (let i = 0; i < itemRows.length; i += 1) {
    if (itemRows[i]) {
      items.push(itemRows[i]);
    }
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
  const awardDeployed = await ensureContract(deployments.award);
  if (!awardDeployed) {
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
      updatedAtMs: (() => {
        let updatedAtMs = 0;
        if (sessionState.updatedAtMs) {
          updatedAtMs = Number(sessionState.updatedAtMs);
        }
        return updatedAtMs;
      })(),
    },
  };
}

app.get('/api/award/status', async (_req, res) => {
  try {
    if (
      awardCache.status
      && (Date.now() - Number(awardCache.status.timestampMs)) <= AWARD_CACHE_TTL_MS
    ) {
      return res.json(awardCache.status.value);
    }
    const snapshot = await getAwardStatusSnapshot();
    if (!snapshot.available) {
      const unavailable = { available: false };
      awardCache.status = { value: unavailable, timestampMs: Date.now() };
      return res.json(unavailable);
    }

    const payload = {
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
    };
    awardCache.status = { value: payload, timestampMs: Date.now() };
    res.json(payload);
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
    let invalidEpochId = false;
    if (!Number.isFinite(epochId)) {
      invalidEpochId = true;
    }
    if (epochId < 0) {
      invalidEpochId = true;
    }
    if (invalidEpochId) {
      epochId = Math.max(0, currentEpoch - 1);
    }

    const cacheKey = `${epochId}:${currentEpoch}`;
    const cached = readAwardCacheEntry(awardCache.leaderboard, cacheKey);
    if (cached) {
      return res.json(cached);
    }
    const leaderboard = await buildAwardLeaderboardForEpoch(deployments.award, epochId);
    const payload = {
      available: true,
      epochId,
      currentEpoch,
      maxQtyWei: leaderboard.maxQtyWei,
      items: leaderboard.items,
    };
    writeAwardCacheEntry(awardCache.leaderboard, cacheKey, payload);
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/award/claimable', async (req, res) => {
  try {
    let walletText = '';
    if (req.query.wallet) {
      walletText = String(req.query.wallet);
    }
    const wallet = normalizeAddress(walletText);
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

    let limitRaw = 50;
    if (req.query.limit) {
      limitRaw = Number(req.query.limit);
    }
    const limit = Math.min(200, Math.max(1, Number(limitRaw)));
    const startEpoch = Math.max(0, currentEpoch - limit);
    const cacheKey = `${wallet.toLowerCase()}:${currentEpoch}:${limit}`;
    const cached = readAwardCacheEntry(awardCache.claimable, cacheKey);
    if (cached) {
      return res.json(cached);
    }
    const epochs = [];
    for (let epochId = startEpoch; epochId < currentEpoch; epochId += 1) {
      epochs.push(epochId);
    }
    const claimRows = await mapWithConcurrency(epochs, 4, async (epochId) => {
      const winnerData = awardInterface.encodeFunctionData('isWinner', [BigInt(epochId), wallet]);
      const claimedData = awardInterface.encodeFunctionData('hasClaimed', [BigInt(epochId), wallet]);
      const [winnerResult, claimedResult] = await Promise.all([
        hardhatRpc('eth_call', [{ to: deployments.award, data: winnerData }, 'latest']),
        hardhatRpc('eth_call', [{ to: deployments.award, data: claimedData }, 'latest']),
      ]);
      const [isWinner] = awardInterface.decodeFunctionResult('isWinner', winnerResult);
      const [claimed] = awardInterface.decodeFunctionResult('hasClaimed', claimedResult);
      if (!(isWinner && !claimed)) {
        return null;
      }

      const qtyData = awardInterface.encodeFunctionData('qtyByEpochByTrader', [BigInt(epochId), wallet]);
      const maxData = awardInterface.encodeFunctionData('maxQtyByEpoch', [BigInt(epochId)]);
      const [qtyResult, maxResult] = await Promise.all([
        hardhatRpc('eth_call', [{ to: deployments.award, data: qtyData }, 'latest']),
        hardhatRpc('eth_call', [{ to: deployments.award, data: maxData }, 'latest']),
      ]);
      const [qtyWeiRaw] = awardInterface.decodeFunctionResult('qtyByEpochByTrader', qtyResult);
      const [maxQtyWeiRaw] = awardInterface.decodeFunctionResult('maxQtyByEpoch', maxResult);

      return {
        epochId,
        qtyWei: qtyWeiRaw.toString(),
        maxQtyWei: maxQtyWeiRaw.toString(),
        isWinner,
        claimed,
        canClaim: true,
      };
    });
    const items = [];
    for (let i = 0; i < claimRows.length; i += 1) {
      if (claimRows[i]) {
        items.push(claimRows[i]);
      }
    }

    items.sort((a, b) => b.epochId - a.epochId);
    const payload = { available: true, wallet, currentEpoch, items };
    writeAwardCacheEntry(awardCache.claimable, cacheKey, payload);
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/award/claim', async (req, res) => {
  try {
    let walletText = '';
    if (req.body.wallet) {
      walletText = String(req.body.wallet);
    }
    const wallet = normalizeAddress(walletText);
    const epochId = Number(req.body.epochId);
    if (!wallet) {
      return res.status(400).json({ error: 'wallet is required' });
    }
    let invalidEpochId = false;
    if (!Number.isFinite(epochId)) {
      invalidEpochId = true;
    }
    if (epochId < 0) {
      invalidEpochId = true;
    }
    if (invalidEpochId) {
      return res.status(400).json({ error: 'epochId is required' });
    }

    const deployments = loadDeployments();
    if (!deployments.award) {
      return res.status(400).json({ error: 'award contract not deployed' });
    }

    const data = awardInterface.encodeFunctionData('claimAward', [BigInt(epochId)]);
    const clientSign = wantsClientSign(req.body);
    if (clientSign) {
      return res.json({
        clientSign: true,
        txs: [
          { label: 'claim_award', from: wallet, to: deployments.award, data },
        ],
      });
    }
    const txHash = await hardhatRpc('eth_sendTransaction', [{
      from: wallet,
      to: deployments.award,
      data,
    }]);
    await waitForReceipt(txHash);
    awardCache.claimable.clear();
    awardCache.leaderboard.clear();
    awardCache.status = null;
    res.json({ txHash, wallet, epochId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/award/current', async (_req, res) => {
  try {
    const snapshot = await getAwardStatusSnapshot();
    if (!snapshot.available) {
      return res.json({ available: false });
    }
    const previousEpoch = Math.max(0, snapshot.currentEpoch - 1);
    const leaderboard = await buildAwardLeaderboardForEpoch(snapshot.deployments.award, previousEpoch);
    let topRow = null;
    if (Array.isArray(leaderboard.items) && leaderboard.items.length > 0) {
      topRow = leaderboard.items[0];
    }
    res.json({
      available: true,
      currentEpoch: snapshot.currentEpoch,
      previousEpoch,
      topTrader: (() => {
        let topTrader = ethers.ZeroAddress;
        if (topRow) {
          topTrader = topRow.trader;
        }
        return topTrader;
      })(),
      topVolumeWei: (() => {
        let topVolumeWei = '0';
        if (topRow) {
          topVolumeWei = topRow.qtyWei;
        }
        return topVolumeWei;
      })(),
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
    let limitRaw = 20;
    if (req.query.limit) {
      limitRaw = Number(req.query.limit);
    }
    const limit = Math.min(100, Math.max(1, Number(limitRaw)));
    const epochData = awardInterface.encodeFunctionData('currentEpoch', []);
    const epochResult = await hardhatRpc('eth_call', [{ to: deployments.award, data: epochData }, 'latest']);
    const [currentEpochRaw] = awardInterface.decodeFunctionResult('currentEpoch', epochResult);
    const currentEpoch = Number(currentEpochRaw);
    const rows = [];
    for (let epochId = Math.max(0, currentEpoch - limit); epochId < currentEpoch; epochId += 1) {
      const leaderboard = await buildAwardLeaderboardForEpoch(deployments.award, epochId);
      let topRow = null;
      if (leaderboard.items.length > 0) {
        topRow = leaderboard.items[0];
      }
      rows.push({
        epochId,
        topTrader: (() => {
          let topTrader = ethers.ZeroAddress;
          if (topRow) {
            topTrader = topRow.trader;
          }
          return topTrader;
        })(),
        topVolumeWei: (() => {
          let topVolumeWei = '0';
          if (topRow) {
            topVolumeWei = topRow.qtyWei;
          }
          return topVolumeWei;
        })(),
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
    let invalidProductInput = false;
    if (!baseSymbol) {
      invalidProductInput = true;
    }
    if (!Number.isFinite(leverage)) {
      invalidProductInput = true;
    }
    if (invalidProductInput) {
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
    let message = '';
    if (err.message) {
      message = String(err.message);
    }
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
    const clientSign = wantsClientSign(body);
    const wallet = normalizeAddress(String(body.wallet));
    const productSymbol = String(body.productSymbol).toUpperCase();
    const ttokenInWei = BigInt(String(body.ttokenInWei));
    let minOutWei = 0n;
    if (body.minOutWei) {
      minOutWei = BigInt(String(body.minOutWei));
    }
    let invalidMintInput = false;
    if (!wallet) {
      invalidMintInput = true;
    }
    if (!productSymbol) {
      invalidMintInput = true;
    }
    if (ttokenInWei <= 0n) {
      invalidMintInput = true;
    }
    if (invalidMintInput) {
      return res.status(400).json({ error: 'wallet, productSymbol, ttokenInWei are required' });
    }

    const deployments = loadDeployments();
    const factoryAddress = deployments.leveragedTokenFactory;
    const routerAddress = deployments.leveragedProductRouter;
    const ttokenAddress = getTTokenAddressFromDeployments();
    let missingLeveragedDeployment = false;
    if (!factoryAddress) {
      missingLeveragedDeployment = true;
    }
    if (!routerAddress) {
      missingLeveragedDeployment = true;
    }
    if (!ttokenAddress) {
      missingLeveragedDeployment = true;
    }
    if (missingLeveragedDeployment) {
      return res.status(400).json({ error: 'leveraged contracts not deployed' });
    }

    const lookupData = leveragedFactoryInterface.encodeFunctionData('getProductBySymbol', [productSymbol]);
    const lookupResult = await hardhatRpc('eth_call', [{ to: factoryAddress, data: lookupData }, 'latest']);
    const [productTokenRaw] = leveragedFactoryInterface.decodeFunctionResult('getProductBySymbol', lookupResult);
    const productToken = normalizeAddress(productTokenRaw);
    let missingProductToken = false;
    if (!productToken) {
      missingProductToken = true;
    }
    if (productToken === ethers.ZeroAddress) {
      missingProductToken = true;
    }
    if (missingProductToken) {
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
    if (clientSign) {
      const mintDataPrepared = leveragedRouterInterface.encodeFunctionData('mintLong', [productToken, ttokenInWei, minOutWei]);
      return res.json({
        clientSign: true,
        txs: [
          { label: 'approve_ttoken_for_leveraged', from: wallet, to: ttokenAddress, data: approveData },
          { label: 'mint_leveraged', from: wallet, to: routerAddress, data: mintDataPrepared },
        ],
        wallet,
        productSymbol,
        productToken,
        ttokenInWei: ttokenInWei.toString(),
      });
    }
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
    const clientSign = wantsClientSign(body);
    const wallet = normalizeAddress(String(body.wallet));
    const productSymbol = String(body.productSymbol).toUpperCase();
    const qtyWei = BigInt(String(body.qtyWei));
    let minOutWei = 0n;
    if (body.minOutWei) {
      minOutWei = BigInt(String(body.minOutWei));
    }
    let invalidUnwindInput = false;
    if (!wallet) {
      invalidUnwindInput = true;
    }
    if (!productSymbol) {
      invalidUnwindInput = true;
    }
    if (qtyWei <= 0n) {
      invalidUnwindInput = true;
    }
    if (invalidUnwindInput) {
      return res.status(400).json({ error: 'wallet, productSymbol, qtyWei are required' });
    }

    const deployments = loadDeployments();
    const factoryAddress = deployments.leveragedTokenFactory;
    const routerAddress = deployments.leveragedProductRouter;
    const ttokenAddress = getTTokenAddressFromDeployments();
    let missingUnwindDeployment = false;
    if (!factoryAddress) {
      missingUnwindDeployment = true;
    }
    if (!routerAddress) {
      missingUnwindDeployment = true;
    }
    if (!ttokenAddress) {
      missingUnwindDeployment = true;
    }
    if (missingUnwindDeployment) {
      return res.status(400).json({ error: 'leveraged contracts not deployed' });
    }

    const lookupData = leveragedFactoryInterface.encodeFunctionData('getProductBySymbol', [productSymbol]);
    const lookupResult = await hardhatRpc('eth_call', [{ to: factoryAddress, data: lookupData }, 'latest']);
    const [productTokenRaw] = leveragedFactoryInterface.decodeFunctionResult('getProductBySymbol', lookupResult);
    const productToken = normalizeAddress(productTokenRaw);
    let missingUnwindProductToken = false;
    if (!productToken) {
      missingUnwindProductToken = true;
    }
    if (productToken === ethers.ZeroAddress) {
      missingUnwindProductToken = true;
    }
    if (missingUnwindProductToken) {
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
    if (clientSign) {
      return res.json({
        clientSign: true,
        txs: [
          { label: 'unwind_leveraged', from: wallet, to: routerAddress, data: unwindData },
        ],
        wallet,
        productSymbol,
        productToken,
        qtyWei: qtyWei.toString(),
      });
    }
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
    let missingQuoteDeployment = false;
    if (!factoryAddress) {
      missingQuoteDeployment = true;
    }
    if (!routerAddress) {
      missingQuoteDeployment = true;
    }
    if (missingQuoteDeployment) {
      return res.status(400).json({ error: 'leveraged contracts not deployed' });
    }

    const lookupData = leveragedFactoryInterface.encodeFunctionData('getProductBySymbol', [productSymbol]);
    const lookupResult = await hardhatRpc('eth_call', [{ to: factoryAddress, data: lookupData }, 'latest']);
    const [productTokenRaw] = leveragedFactoryInterface.decodeFunctionResult('getProductBySymbol', lookupResult);
    const productToken = normalizeAddress(productTokenRaw);
    let missingQuoteProduct = false;
    if (!productToken) {
      missingQuoteProduct = true;
    }
    if (productToken === ethers.ZeroAddress) {
      missingQuoteProduct = true;
    }
    if (missingQuoteProduct) {
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
    let productSymbolText = '';
    if (body.productSymbol) {
      productSymbolText = String(body.productSymbol);
    }
    const productSymbol = productSymbolText.toUpperCase();
    const changePct = Number(body.changePct);
    let invalidPriceAdjustInput = false;
    if (!productSymbol) {
      invalidPriceAdjustInput = true;
    }
    if (!Number.isFinite(changePct)) {
      invalidPriceAdjustInput = true;
    }
    if (invalidPriceAdjustInput) {
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
    let missingPositionsDeployment = false;
    if (!factoryAddress) {
      missingPositionsDeployment = true;
    }
    if (!routerAddress) {
      missingPositionsDeployment = true;
    }
    if (missingPositionsDeployment) {
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
        let baseChangePct = Number.NaN;
        try {
          const fmpShort = await fetchFmpJson(getFmpUrl('quote', { symbol: String(item.baseSymbol).toUpperCase() }));
          let first = null;
          if (Array.isArray(fmpShort) && fmpShort.length > 0) {
            first = fmpShort[0];
          } else if (fmpShort && typeof fmpShort === 'object') {
            first = fmpShort;
          }
          if (first) {
            const fmpPrice = Number(first.price);
            if (Number.isFinite(fmpPrice) && fmpPrice > 0) {
              basePriceCents = Math.round(fmpPrice * 100);
            }
            const fmpPrevClose = Number(first.previousClose);
            if (Number.isFinite(fmpPrevClose) && fmpPrevClose > 0 && Number.isFinite(fmpPrice) && fmpPrice > 0) {
              baseChangePct = ((fmpPrice - fmpPrevClose) / fmpPrevClose) * 100;
            } else {
              let fmpPctRaw = Number.NaN;
              if (first.changePercent !== undefined && first.changePercent !== null) {
                fmpPctRaw = Number(first.changePercent);
              } else if (first.changesPercentage !== undefined && first.changesPercentage !== null) {
                fmpPctRaw = Number(first.changesPercentage);
              }
              if (Number.isFinite(fmpPctRaw)) {
                if (Math.abs(fmpPctRaw) <= 1) {
                  baseChangePct = fmpPctRaw * 100;
                } else {
                  baseChangePct = fmpPctRaw;
                }
              }
            }
          }
        } catch {
          try {
            const quote = await fetchQuote(String(item.baseSymbol).toUpperCase());
            const yahooPrice = Number(quote.regularMarketPrice || quote.price || 0);
            if (Number.isFinite(yahooPrice) && yahooPrice > 0) {
              basePriceCents = Math.round(yahooPrice * 100);
            }
            const yahooPrevClose = Number(quote.regularMarketPreviousClose);
            if (
              Number.isFinite(yahooPrevClose)
              && yahooPrevClose > 0
              && Number.isFinite(yahooPrice)
              && yahooPrice > 0
            ) {
              baseChangePct = ((yahooPrice - yahooPrevClose) / yahooPrevClose) * 100;
            } else {
              const yahooChangeRaw = Number(quote.regularMarketChangePercent);
              if (Number.isFinite(yahooChangeRaw)) {
                if (Math.abs(yahooChangeRaw) <= 1) {
                  baseChangePct = yahooChangeRaw * 100;
                } else {
                  baseChangePct = yahooChangeRaw;
                }
              }
            }
          } catch {
          }
        }
        if (!(basePriceCents > 0)) {
          const navNum = Number(navCents);
          if (Number.isFinite(navNum) && navNum > 0) {
            basePriceCents = navNum;
          }
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
    let symbolText = '';
    if (req.body.symbol) {
      symbolText = String(req.body.symbol);
    }
    const symbol = symbolText.toUpperCase();
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
    let symbolText = '';
    if (req.body.symbol) {
      symbolText = String(req.body.symbol);
    }
    const symbol = symbolText.toUpperCase();
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
    let symbolText = '';
    if (req.body.symbol) {
      symbolText = String(req.body.symbol);
    }
    const symbol = symbolText.toUpperCase();
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
    let symbolText = '';
    if (req.body.symbol) {
      symbolText = String(req.body.symbol);
    }
    const symbol = symbolText.toUpperCase();
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

app.post('/api/admin/price/set', async (req, res) => {
  try {
    let symbolText = '';
    if (req.body.symbol) {
      symbolText = String(req.body.symbol);
    }
    const symbol = symbolText.toUpperCase().trim();
    const priceCents = Number(req.body.priceCents);
    if (!symbol) {
      return res.status(400).json({ error: 'symbol is required' });
    }
    if (!Number.isFinite(priceCents) || priceCents <= 0) {
      return res.status(400).json({ error: 'priceCents must be > 0' });
    }
    const updateResult = await setOnchainPriceForSymbol(symbol, Math.round(priceCents));
    if (!updateResult.ok) {
      return res.status(400).json({ error: updateResult.error });
    }
    res.json({
      symbol,
      priceCents: Math.round(priceCents),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/price-set', async (req, res) => {
  try {
    let symbolText = '';
    if (req.body.symbol) {
      symbolText = String(req.body.symbol);
    }
    const symbol = symbolText.toUpperCase().trim();
    const priceCents = Number(req.body.priceCents);
    if (!symbol) {
      return res.status(400).json({ error: 'symbol is required' });
    }
    if (!Number.isFinite(priceCents) || priceCents <= 0) {
      return res.status(400).json({ error: 'priceCents must be > 0' });
    }
    const updateResult = await setOnchainPriceForSymbol(symbol, Math.round(priceCents));
    if (!updateResult.ok) {
      return res.status(400).json({ error: updateResult.error });
    }
    res.json({
      symbol,
      priceCents: Math.round(priceCents),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/live-updates', async (_req, res) => {
  try {
    const state = readLiveUpdatesState();
    const enabled = state && state.enabled !== false;
    res.json({
      enabled,
      updatedAtMs: Number(state.updatedAtMs || 0),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/live-updates', async (req, res) => {
  try {
    let body = {};
    if (req.body) {
      body = req.body;
    }
    let walletText = '';
    if (body.wallet) {
      walletText = String(body.wallet);
    }
    const wallet = normalizeAddress(walletText);
    if (!wallet) {
      return res.status(400).json({ error: 'wallet is required' });
    }
    if (!isAdminWallet(wallet)) {
      return res.status(403).json({ error: 'admin wallet required' });
    }
    const enabled = body.enabled !== false;
    const next = {
      enabled,
      updatedAtMs: Date.now(),
    };
    writeLiveUpdatesState(next);
    res.json(next);
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
      currentEpoch: (() => {
        let value = 0;
        if (snapshot.currentEpoch) {
          value = Number(snapshot.currentEpoch);
        }
        return value;
      })(),
      chainEpochDurationSec: (() => {
        let value = 0;
        if (snapshot.chainEpochDurationSec) {
          value = Number(snapshot.chainEpochDurationSec);
        }
        return value;
      })(),
      activeEpochDurationSec: (() => {
        let value = 0;
        if (snapshot.epochDurationSec) {
          value = Number(snapshot.epochDurationSec);
        }
        return value;
      })(),
      sessionTerminated: Boolean(snapshot.sessionTerminated),
      nextAwardWindowSec: (() => {
        let value = 60;
        if (state.nextAwardWindowSec) {
          value = Number(state.nextAwardWindowSec);
        }
        return value;
      })(),
      nextAwardWindowAppliesAtEpoch: (() => {
        let value = -1;
        if (state.nextAwardWindowAppliesAtEpoch) {
          value = Number(state.nextAwardWindowAppliesAtEpoch);
        }
        return value;
      })(),
      terminateNextSession: Boolean(state.terminateNextSession),
      terminateAtEpoch: (() => {
        let terminateAtEpoch = -1;
        if (state.terminateAtEpoch) {
          terminateAtEpoch = Number(state.terminateAtEpoch);
        }
        return terminateAtEpoch;
      })(),
      updatedAtMs: (() => {
        let updatedAtMs = 0;
        if (state.updatedAtMs) {
          updatedAtMs = Number(state.updatedAtMs);
        }
        return updatedAtMs;
      })(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/award/session', async (req, res) => {
  try {
    let body = {};
    if (req.body) {
      body = req.body;
    }
    const snapshot = await getAwardStatusSnapshot();
    if (!snapshot.available) {
      return res.status(400).json({ error: 'award contract not deployed' });
    }

    const nextAwardWindowSecRaw = Number(body.nextAwardWindowSec);
    const terminateNextSessionRaw = Boolean(body.terminateNextSession);
    let nextAwardWindowSecInvalid = false;
    if (!Number.isFinite(nextAwardWindowSecRaw)) {
      nextAwardWindowSecInvalid = true;
    }
    if (nextAwardWindowSecRaw <= 0) {
      nextAwardWindowSecInvalid = true;
    }
    if (nextAwardWindowSecRaw > 3600) {
      nextAwardWindowSecInvalid = true;
    }
    if (nextAwardWindowSecInvalid) {
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
    awardCache.status = null;

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

app.post('/api/gas/run', async (req, res) => {
  let suite = 'core';
  if (req.body && req.body.suite) {
    suite = String(req.body.suite).toLowerCase();
  }
  let isValidSuite = false;
  switch (suite) {
    case 'core':
    case 'stress':
    case 'all':
      isValidSuite = true;
      break;
    default:
      break;
  }
  if (!isValidSuite) {
    return res.status(400).json({ error: 'suite must be core, stress, or all' });
  }
  try {
    const report = await runGasPackGuarded(suite);
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/gas/latest', async (_req, res) => {
  try {
    let walletText = '';
    if (_req.query && _req.query.wallet) {
      walletText = String(_req.query.wallet);
    }
    const wallet = normalizeAddress(walletText);
    if (wallet) {
      const walletRows = await buildWalletGasRowsFromIndexer(wallet, 20);
      const walletReport = {
        suite: 'wallet',
        startedAtMs: Date.now(),
        finishedAtMs: Date.now(),
        durationMs: 0,
        chainId: 0,
        latestBlock: 0,
        thresholdPct: GAS_WARN_THRESHOLD_PCT,
        warnCount: 0,
        skipCount: 0,
        totalRows: walletRows.length,
        pollMs: GAS_PAGE_POLL_MS,
        rows: walletRows,
      };
      return res.json({
        ok: true,
        source: 'wallet_indexed_receipts',
        lastRunAtMs: gasRuntimeState.lastRunAtMs,
        report: walletReport,
      });
    }
    if (!ENABLE_GAS_PACK) {
      const disabledReport = {
        suite: 'core',
        startedAtMs: Date.now(),
        finishedAtMs: Date.now(),
        durationMs: 0,
        chainId: 0,
        latestBlock: 0,
        thresholdPct: GAS_WARN_THRESHOLD_PCT,
        warnCount: 0,
        skipCount: 1,
        totalRows: 1,
        pollMs: GAS_PAGE_POLL_MS,
        rows: [{
          txName: 'gas_pack_disabled',
          gasUsed: '0',
          effectiveGasPrice: '0',
          costWei: '0',
          costEth: '0',
          baselineGasUsed: '0',
          deltaPct: null,
          status: 'SKIP',
          skipReason: 'disabled on this network',
        }],
      };
      return res.json({
        ok: true,
        disabled: true,
        lastRunAtMs: gasRuntimeState.lastRunAtMs,
        report: disabledReport,
      });
    }
    if (!gasRuntimeState.latest) {
      await runGasPackGuarded('core');
    }
    res.json({
      ok: true,
      lastRunAtMs: gasRuntimeState.lastRunAtMs,
      report: gasRuntimeState.latest,
    });
  } catch (err) {
    const fallbackReport = {
      suite: 'core',
      startedAtMs: Date.now(),
      finishedAtMs: Date.now(),
      durationMs: 0,
      chainId: 0,
      latestBlock: 0,
      thresholdPct: GAS_WARN_THRESHOLD_PCT,
      warnCount: 0,
      skipCount: 0,
      totalRows: 1,
      pollMs: GAS_PAGE_POLL_MS,
      rows: [{
        txName: 'gas_pack_error',
        gasUsed: '0',
        effectiveGasPrice: '0',
        costWei: '0',
        costEth: '0',
        baselineGasUsed: '0',
        deltaPct: null,
        status: 'SKIP',
        skipReason: (() => {
          let reason = 'gas pack failed';
          if (err.message) {
            reason = err.message;
          }
          return reason;
        })(),
      }],
    };
    res.json({
      ok: false,
      error: err.message,
      lastRunAtMs: gasRuntimeState.lastRunAtMs,
      report: fallbackReport,
    });
  }
});

app.get('/api/gas/baseline', async (_req, res) => {
  res.json({
    thresholdPct: GAS_WARN_THRESHOLD_PCT,
    baseline: gasRuntimeState.baseline,
  });
});

app.post('/api/gas/baseline/accept', async (_req, res) => {
  let missingLatestGasState = false;
  if (!gasRuntimeState.latest) {
    missingLatestGasState = true;
  }
  if (!Array.isArray(gasRuntimeState.latest.rows)) {
    missingLatestGasState = true;
  }
  if (missingLatestGasState) {
    return res.status(400).json({ error: 'no latest gas report available' });
  }
  const next = {};
  for (let i = 0; i < gasRuntimeState.latest.rows.length; i += 1) {
    const row = gasRuntimeState.latest.rows[i];
    if (row.status !== 'SKIP') {
      next[row.txName] = Number(row.gasUsed);
    }
  }
  gasRuntimeState.baseline = next;
  res.json({
    ok: true,
    baseline: gasRuntimeState.baseline,
  });
});

app.post('/api/autotrade/rules/create', async (req, res) => {
  try {
    let body = {};
    if (req.body) {
      body = req.body;
    }
    let walletText = '';
    if (body.wallet) {
      walletText = String(body.wallet);
    }
    const wallet = normalizeAddress(walletText);
    let symbolText = '';
    if (body.symbol) {
      symbolText = String(body.symbol);
    }
    const symbol = symbolText.toUpperCase();
    let sideText = '';
    if (body.side) {
      sideText = String(body.side);
    }
    const side = sideText.toUpperCase();
    const triggerPriceCents = Number(body.triggerPriceCents);
    let qtyWei = '';
    if (body.qtyWei) {
      qtyWei = String(body.qtyWei);
    }
    let maxSlippageBpsRaw = 0;
    if (body.maxSlippageBps) {
      maxSlippageBpsRaw = body.maxSlippageBps;
    }
    const maxSlippageBps = Number(maxSlippageBpsRaw);
    const enabled = Boolean(body.enabled !== false);
    let cooldownSecRaw = 0;
    if (body.cooldownSec) {
      cooldownSecRaw = body.cooldownSec;
    }
    const cooldownSec = Number(cooldownSecRaw);
    let maxExecutionsPerDayRaw = 0;
    if (body.maxExecutionsPerDay) {
      maxExecutionsPerDayRaw = body.maxExecutionsPerDay;
    }
    const maxExecutionsPerDay = Number(maxExecutionsPerDayRaw);

    if (!wallet) {
      return res.status(400).json({ error: 'wallet is required' });
    }
    if (!symbol) {
      return res.status(400).json({ error: 'symbol is required' });
    }
    if (side !== 'BUY' && side !== 'SELL') {
      return res.status(400).json({ error: 'side must be BUY or SELL' });
    }
    let invalidTriggerPrice = false;
    if (!Number.isFinite(triggerPriceCents)) {
      invalidTriggerPrice = true;
    }
    if (triggerPriceCents <= 0) {
      invalidTriggerPrice = true;
    }
    if (invalidTriggerPrice) {
      return res.status(400).json({ error: 'triggerPriceCents must be > 0' });
    }
    const qtyWeiBig = BigInt(qtyWei);
    if (!(qtyWeiBig > 0n)) {
      return res.status(400).json({ error: 'qtyWei must be > 0' });
    }
    const oneTokenWei = 10n ** 18n;
    if (qtyWeiBig % oneTokenWei !== 0n) {
      return res.status(400).json({ error: 'qtyWei must be whole tokens (18 decimals)' });
    }
    const qtyUnits = qtyWeiBig / oneTokenWei;
    if (qtyUnits < BigInt(MIN_STOCK_QTY_UNITS)) {
      return res.status(400).json({ error: `qty must be at least ${MIN_STOCK_QTY_UNITS}` });
    }
    if (qtyUnits % BigInt(MIN_STOCK_QTY_UNITS) !== 0n) {
      return res.status(400).json({ error: `qty must be in steps of ${MIN_STOCK_QTY_UNITS}` });
    }
    if (side === 'BUY') {
      const deployments = loadDeployments();
      const ttokenAddr = normalizeAddress(getTTokenAddressFromDeployments());
      if (ttokenAddr) {
        const requiredQuoteWei = quoteAmountWei(qtyWeiBig, triggerPriceCents);
        const balanceData = equityTokenInterface.encodeFunctionData('balanceOf', [wallet]);
        const balanceResult = await hardhatRpc('eth_call', [{ to: ttokenAddr, data: balanceData }, 'latest']);
        const [balanceWeiRaw] = equityTokenInterface.decodeFunctionResult('balanceOf', balanceResult);
        const balanceWei = BigInt(balanceWeiRaw.toString());
        if (balanceWei < requiredQuoteWei) {
          return res.status(400).json({
            error: `insufficient TToken for auto buy: need ${ethers.formatUnits(requiredQuoteWei, 18)}, have ${ethers.formatUnits(balanceWei, 18)}`,
          });
        }
      }
    }
    const canSend = await canServerSendFromAddress(wallet);
    if (!canSend) {
      return res.status(400).json({
        error: `autotrade requires server signer for ${wallet}; add wallet key in TX_SIGNER_PRIVATE_KEYS`,
      });
    }

    const state = readAutoTradeState();
    const newRule = {
      id: Number(state.nextRuleId),
      wallet,
      symbol,
      side,
      triggerPriceCents: Number(triggerPriceCents),
      qtyWei: qtyWeiBig.toString(),
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
    let body = {};
    if (req.body) {
      body = req.body;
    }
    const ruleId = Number(body.ruleId);
    let invalidRuleId = false;
    if (!Number.isFinite(ruleId)) {
      invalidRuleId = true;
    }
    if (ruleId <= 0) {
      invalidRuleId = true;
    }
    if (invalidRuleId) {
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

    if ('triggerPriceCents' in body) {
      const nextTriggerPrice = Number(body.triggerPriceCents);
      let invalidNextTriggerPrice = false;
      if (!Number.isFinite(nextTriggerPrice)) {
        invalidNextTriggerPrice = true;
      }
      if (nextTriggerPrice <= 0) {
        invalidNextTriggerPrice = true;
      }
      if (invalidNextTriggerPrice) {
        return res.status(400).json({ error: 'triggerPriceCents must be > 0' });
      }
      rule.triggerPriceCents = nextTriggerPrice;
    }
    if ('qtyWei' in body) {
      const nextQtyWei = String(body.qtyWei);
      if (!(BigInt(nextQtyWei) > 0n)) {
        return res.status(400).json({ error: 'qtyWei must be > 0' });
      }
      rule.qtyWei = nextQtyWei;
    }
    if ('maxSlippageBps' in body) {
      rule.maxSlippageBps = Number(body.maxSlippageBps);
    }
    if ('cooldownSec' in body) {
      rule.cooldownSec = Number(body.cooldownSec);
    }
    if ('maxExecutionsPerDay' in body) {
      rule.maxExecutionsPerDay = Number(body.maxExecutionsPerDay);
    }
    if ('enabled' in body) {
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
    let walletRaw = '';
    if (req.query.wallet) {
      walletRaw = String(req.query.wallet);
    }
    const wallet = normalizeAddress(walletRaw);
    const state = readAutoTradeState();
    const rows = [];
    for (let i = 0; i < state.rules.length; i += 1) {
      const row = state.rules[i];
      let includeRow = false;
      if (!wallet) {
        includeRow = true;
      }
      if (row.wallet === wallet) {
        includeRow = true;
      }
      if (includeRow) {
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
    let walletRaw = '';
    if (req.query.wallet) {
      walletRaw = String(req.query.wallet);
    }
    const wallet = normalizeAddress(walletRaw);
    let limitRaw = 50;
    if (req.query.limit) {
      limitRaw = Number(req.query.limit);
    }
    const limit = Math.min(200, Math.max(1, Number(limitRaw)));
    const state = readAutoTradeState();
    const rows = [];
    for (let i = 0; i < state.executions.length; i += 1) {
      const row = state.executions[i];
      let includeRow = false;
      if (!wallet) {
        includeRow = true;
      }
      if (row.wallet === wallet) {
        includeRow = true;
      }
      if (includeRow) {
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
      lastTickAtMs: (() => {
        let lastTickAtMs = 0;
        if (state.lastTickAtMs) {
          lastTickAtMs = Number(state.lastTickAtMs);
        }
        return lastTickAtMs;
      })(),
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
    if (state.lastTickAtMs) {
      state.lastTickAtMs = Number(state.lastTickAtMs);
    } else {
      state.lastTickAtMs = 0;
    }
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
  let missingCreateFields = false;
  if (symbol.length === 0) {
    missingCreateFields = true;
  }
  if (name.length === 0) {
    missingCreateFields = true;
  }
  if (missingCreateFields) {
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
  let invalidAmount = false;
  if (!amountIsNumber) {
    invalidAmount = true;
  }
  if (amount < 100) {
    invalidAmount = true;
  }
  if (invalidAmount) {
    return res.status(400).json({ error: '' });
  }

  try {
    const deployments = loadDeployments();
    const registryAddr = deployments.listingsRegistry;
    let minter = deployments.admin;
    if (deployments.defaultMinter) {
      minter = deployments.defaultMinter;
    }
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
    const receipt = await waitForReceipt(txHash);
    const blockNumber = parseRpcInt(receipt.blockNumber);
    const timestampMs = await getBlockTimestampMs(receipt.blockNumber);
    const entryPriceCents = await resolveEntryPriceCentsForSymbol(symbol, deployments);
    appendManualMintActivity({
      wallet: to,
      tokenAddress: tokenAddr,
      symbol,
      assetType: 'EQUITY',
      amountWei: amountWei.toString(),
      priceCents: entryPriceCents,
      reason: 'MINT_EQUITY',
      txHash,
      blockNumber,
      timestampMs,
    });
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
  let missingCreateMintFields = false;
  if (symbol.length === 0) {
    missingCreateMintFields = true;
  }
  if (name.length === 0) {
    missingCreateMintFields = true;
  }
  if (missingCreateMintFields) {
    return res.status(400).json({ error: '' });
  }
  const recipientValid = isValidAddress(to);
  if (!recipientValid) {
    return res.status(400).json({ error: '' });
  }
  const amountIsNumber = Number.isFinite(amount);
  let invalidCreateMintAmount = false;
  if (!amountIsNumber) {
    invalidCreateMintAmount = true;
  }
  if (amount < 100) {
    invalidCreateMintAmount = true;
  }
  if (invalidCreateMintAmount) {
    return res.status(400).json({ error: '' });
  }

  try {
    const deployments = loadDeployments();
    const factoryAddr = deployments.equityTokenFactory;
    const registryAddr = deployments.listingsRegistry;
    const admin = deployments.admin;
    let minter = deployments.admin;
    if (deployments.defaultMinter) {
      minter = deployments.defaultMinter;
    }
    const factoryDeployed = await ensureContract(factoryAddr);
    const registryDeployed = await ensureContract(registryAddr);
    let missingCoreDeployment = false;
    if (!factoryDeployed) {
      missingCoreDeployment = true;
    }
    if (!registryDeployed) {
      missingCoreDeployment = true;
    }
    if (missingCoreDeployment) {
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
    const receipt = await waitForReceipt(mintTx);
    const blockNumber = parseRpcInt(receipt.blockNumber);
    const timestampMs = await getBlockTimestampMs(receipt.blockNumber);
    const entryPriceCents = await resolveEntryPriceCentsForSymbol(symbol, deployments);
    appendManualMintActivity({
      wallet: to,
      tokenAddress: tokenAddr,
      symbol,
      assetType: 'EQUITY',
      amountWei: amountWei.toString(),
      priceCents: entryPriceCents,
      reason: 'MINT_EQUITY',
      txHash: mintTx,
      blockNumber,
      timestampMs,
    });
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
      return res.json({ listings: [] });
    }
    const data = registryListInterface.encodeFunctionData('getAllSymbols', []);
    const result = await hardhatRpc('eth_call', [{ to: registryAddr, data }, 'latest']);
    const [symbols] = registryListInterface.decodeFunctionResult('getAllSymbols', result);

    let includeDelisted = false;
    let includeDelistedRaw = '';
    if (req.query.includeDelisted) {
      includeDelistedRaw = String(req.query.includeDelisted);
    }
    if (includeDelistedRaw === '1') {
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
  let invalidInterval = false;
  if (!intervalValid) {
    invalidInterval = true;
  }
  if (interval < 5) {
    invalidInterval = true;
  }
  if (interval % 5 !== 0) {
    invalidInterval = true;
  }
  if (invalidInterval) {
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
if (!fs.existsSync(LIVE_UPDATES_STATE_FILE)) {
  writeLiveUpdatesState(getDefaultLiveUpdatesState());
}
if (!fs.existsSync(ADMIN_WALLETS_STATE_FILE)) {
  writeAdminWalletState(getDefaultAdminWalletState());
}
if (fs.existsSync(AUTOTRADE_STATE_FILE)) {
  const autoState = readAutoTradeState();
  autoState.listenerRunning = ENABLE_AUTOTRADE;
  writeAutoTradeState(autoState);
}
setInterval(() => {
  ensureIndexerSynced();
}, INDEXER_SYNC_INTERVAL_MS);
if (ENABLE_AUTOTRADE) {
  setInterval(() => {
    runAutoTradeTick().catch((err) => {
      let msg = 'auto trade interval failed';
      if (err && err.message) {
        msg = err.message;
      }
      console.error('[autotrade]', msg);
    });
  }, AUTOTRADE_POLL_INTERVAL_MS);
}
if (ENABLE_GAS_PACK) {
  if (NETWORK_NAME === 'sepolia') {
    console.log('[gas] benchmark gas pack is skipped on Sepolia; wallet gas rows remain available');
  } else {
    const gasIntervalId = setInterval(() => {
      runGasPackGuarded('core').catch((err) => {
        let msg = 'gas pack interval failed';
        if (err && err.message) {
          msg = err.message;
        }
        if (msg.includes('need at least 2 local accounts')) {
          console.error('[gas] disabled background gas loop: Sepolia RPC does not expose local unlocked accounts');
          clearInterval(gasIntervalId);
          return;
        }
        console.error('[gas]', msg);
      });
    }, GAS_AUTO_RUN_INTERVAL_MS);
  }
}

app.use((_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const DEFAULT_PORT = 3000;

let PORT = DEFAULT_PORT;
if (process.env.PORT) {
  PORT = Number(process.env.PORT);
} else if (process.env.STAGE0_PORT) {
  PORT = Number(process.env.STAGE0_PORT);
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`RPC URL: ${HARDHAT_RPC_URL}`);
  console.log(`Deployments file: ${DEPLOYMENTS_FILE}`);
  console.log(`Signer keys loaded: ${RPC_SIGNERS.size}`);
  console.log(`Autotrade loop enabled: ${ENABLE_AUTOTRADE}`);
  console.log(`Autotrade interval ms: ${AUTOTRADE_POLL_INTERVAL_MS}`);
  console.log(`Gas loop enabled: ${ENABLE_GAS_PACK}`);
  console.log(`Gas interval ms: ${GAS_AUTO_RUN_INTERVAL_MS}`);
});
