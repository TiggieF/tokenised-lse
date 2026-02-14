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
const awardInterface = new ethers.Interface([
  'function currentEpoch() view returns (uint256)',
  'function topTraderByEpoch(uint256 epochId) view returns (address)',
  'function topVolumeByEpoch(uint256 epochId) view returns (uint256)',
  'function rewarded(uint256 epochId) view returns (bool)',
  'function finalizeEpoch(uint256 epochId)',
]);
const aggregatorInterface = new ethers.Interface([
  'function getPortfolioSummary(address user) view returns (uint256 cashValueWei,uint256 stockValueWei,uint256 totalValueWei)',
  'function getHoldings(address user) view returns (tuple(address token,string symbol,uint256 balanceWei,uint256 priceCents,uint256 valueWei)[])',
]);
const priceFeedInterface = new ethers.Interface([
  'function getPrice(string symbol) view returns (uint256 priceCents, uint256 timestamp)',
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

    const url = getFmpUrl('quote-short', { symbol });
    const payload = await fetchFmpJson(url);
    let quote = payload;
    if (Array.isArray(payload)) {
      quote = payload[0];
    }
    const price = quote.price;
    const volume = quote.volume;
    let responseSymbol = symbol;
    if (quote.symbol) {
      responseSymbol = quote.symbol;
    }
    const data = {
      symbol: responseSymbol,
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
    const sideText = String(body.side).toUpperCase();
    const priceCents = Number(body.priceCents);
    const qty = Number(body.qty);
    const from = String(body.from);
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
    const { orders, fills, cancellations, cashflows, transfers } = snapshot;
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
      let valuation = { priceCents: 0, priceSource: 'NONE' };
      if (liveCents > 0) {
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
      let valuation = { priceCents: 0, priceSource: 'NONE' };
      if (liveCents > 0) {
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
    const totalValueWei = cashWei + stockValueWei;

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
          symbol: listing.symbol,
          tokenAddress: listing.tokenAddress,
          epochId,
          claimableWei,
          claimed,
          canClaim: BigInt(claimableWei) > 0n && !claimed,
        });
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

app.get('/api/award/current', async (_req, res) => {
  try {
    const deployments = loadDeployments();
    if (!deployments.award) {
      return res.json({ available: false });
    }
    const epochData = awardInterface.encodeFunctionData('currentEpoch', []);
    const epochResult = await hardhatRpc('eth_call', [{ to: deployments.award, data: epochData }, 'latest']);
    const [currentEpochRaw] = awardInterface.decodeFunctionResult('currentEpoch', epochResult);
    const currentEpoch = Number(currentEpochRaw);
    let targetEpoch = 0;
    if (currentEpoch > 0) {
      targetEpoch = currentEpoch - 1;
    }
    const topTraderData = awardInterface.encodeFunctionData('topTraderByEpoch', [targetEpoch]);
    const topTraderResult = await hardhatRpc('eth_call', [{ to: deployments.award, data: topTraderData }, 'latest']);
    const [topTrader] = awardInterface.decodeFunctionResult('topTraderByEpoch', topTraderResult);
    const topVolData = awardInterface.encodeFunctionData('topVolumeByEpoch', [targetEpoch]);
    const topVolResult = await hardhatRpc('eth_call', [{ to: deployments.award, data: topVolData }, 'latest']);
    const [topVolume] = awardInterface.decodeFunctionResult('topVolumeByEpoch', topVolResult);
    const rewardedData = awardInterface.encodeFunctionData('rewarded', [targetEpoch]);
    const rewardedResult = await hardhatRpc('eth_call', [{ to: deployments.award, data: rewardedData }, 'latest']);
    const [rewarded] = awardInterface.decodeFunctionResult('rewarded', rewardedResult);
    res.json({
      available: true,
      currentEpoch,
      previousEpoch: targetEpoch,
      topTrader: normalizeAddress(topTrader),
      topVolumeWei: topVolume.toString(),
      rewarded,
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
    const limit = Math.min(100, Math.max(1, Number(req.query.limit)));
    const epochData = awardInterface.encodeFunctionData('currentEpoch', []);
    const epochResult = await hardhatRpc('eth_call', [{ to: deployments.award, data: epochData }, 'latest']);
    const [currentEpochRaw] = awardInterface.decodeFunctionResult('currentEpoch', epochResult);
    const currentEpoch = Number(currentEpochRaw);
    const items = [];
    for (let epochId = Math.max(0, currentEpoch - limit); epochId < currentEpoch; epochId++) {
      const topTraderData = awardInterface.encodeFunctionData('topTraderByEpoch', [epochId]);
      const topTraderResult = await hardhatRpc('eth_call', [{ to: deployments.award, data: topTraderData }, 'latest']);
      const [topTrader] = awardInterface.decodeFunctionResult('topTraderByEpoch', topTraderResult);
      const topVolData = awardInterface.encodeFunctionData('topVolumeByEpoch', [epochId]);
      const topVolResult = await hardhatRpc('eth_call', [{ to: deployments.award, data: topVolData }, 'latest']);
      const [topVolume] = awardInterface.decodeFunctionResult('topVolumeByEpoch', topVolResult);
      const rewardedData = awardInterface.encodeFunctionData('rewarded', [epochId]);
      const rewardedResult = await hardhatRpc('eth_call', [{ to: deployments.award, data: rewardedData }, 'latest']);
      const [rewarded] = awardInterface.decodeFunctionResult('rewarded', rewardedResult);
      items.push({
        epochId,
        topTrader: normalizeAddress(topTrader),
        topVolumeWei: topVolume.toString(),
        rewarded,
      });
    }
    items.sort((a, b) => b.epochId - a.epochId);
    res.json({ available: true, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/award/finalize', async (req, res) => {
  try {
    const deployments = loadDeployments();
    if (!deployments.award) {
      return res.status(400).json({ error: 'award contract not deployed' });
    }
    let epochIdRaw = 0;
    if (req.body && req.body.epochId) {
      epochIdRaw = req.body.epochId;
    }
    const epochId = Number(epochIdRaw);
    if (!Number.isFinite(epochId) || epochId < 0) {
      return res.status(400).json({ error: 'invalid epochId' });
    }
    const data = awardInterface.encodeFunctionData('finalizeEpoch', [BigInt(epochId)]);
    const txHash = await hardhatRpc('eth_sendTransaction', [{
      from: deployments.admin,
      to: deployments.award,
      data,
    }]);
    await waitForReceipt(txHash);
    res.json({ txHash, epochId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
    res.status(502).json({ error: err.message });
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
