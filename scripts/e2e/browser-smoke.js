const { chromium } = require('playwright');

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:3000';
const ADMIN_WALLET = '0x831B6E09dD00D2Cf2f37fe400Fe721DadD044945';
const USER_WALLET = '0x1111111111111111111111111111111111111111';
const CHAIN_ID = '0xaa36a7';

function walletInitScript(wallet) {
  return `
    (() => {
      const selectedWallet = ${JSON.stringify(wallet)};
      const listeners = new Map();
      const ethereum = {
        isMetaMask: true,
        chainId: ${JSON.stringify(CHAIN_ID)},
        selectedAddress: selectedWallet,
        on(event, cb) {
          const key = String(event || '');
          if (!listeners.has(key)) {
            listeners.set(key, []);
          }
          listeners.get(key).push(cb);
        },
        removeListener(event, cb) {
          const key = String(event || '');
          if (!listeners.has(key)) {
            return;
          }
          const rows = listeners.get(key);
          const next = [];
          for (let i = 0; i < rows.length; i += 1) {
            if (rows[i] !== cb) {
              next.push(rows[i]);
            }
          }
          listeners.set(key, next);
        },
        async request(args) {
          const method = args && args.method ? String(args.method) : '';
          if (method === 'eth_chainId') {
            return ${JSON.stringify(CHAIN_ID)};
          }
          if (method === 'eth_accounts' || method === 'eth_requestAccounts') {
            return [selectedWallet];
          }
          if (method === 'wallet_switchEthereumChain') {
            return null;
          }
          if (method === 'wallet_requestPermissions') {
            return [{ parentCapability: 'eth_accounts' }];
          }
          if (method === 'wallet_getPermissions') {
            return [{ parentCapability: 'eth_accounts' }];
          }
          if (method === 'wallet_sendTransaction' || method === 'eth_sendTransaction') {
            return '0x1111111111111111111111111111111111111111111111111111111111111111';
          }
          if (method === 'personal_sign' || method === 'eth_sign' || method === 'eth_signTypedData_v4') {
            return '0x' + '1'.repeat(130);
          }
          if (method === 'eth_estimateGas') {
            return '0x5208';
          }
          if (method === 'eth_gasPrice') {
            return '0x3b9aca00';
          }
          if (method === 'eth_getTransactionCount') {
            return '0x0';
          }
          return null;
        },
      };
      Object.defineProperty(window, 'ethereum', {
        value: ethereum,
        writable: false,
      });
    })();
  `;
}

async function runPageCheck(context, wallet, pageName, path, verifyFn) {
  const page = await context.newPage();
  const apiFailures = [];
  const apiCalls = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    if (!url.includes('/api/')) {
      return;
    }
    const status = resp.status();
    apiCalls.push({ url, status });
    if (status >= 500) {
      apiFailures.push({ url, status });
    }
  });
  const startedAt = Date.now();
  let pass = true;
  let detail = 'ok';
  try {
    await page.goto(`${BASE_URL}${path}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await verifyFn(page, wallet);
    if (apiFailures.length > 0) {
      pass = false;
      detail = `500+ api errors: ${apiFailures[0].status} ${apiFailures[0].url}`;
    }
  } catch (err) {
    pass = false;
    detail = err && err.message ? err.message : String(err);
  }
  const elapsedMs = Date.now() - startedAt;
  await page.close();
  return {
    wallet,
    page: pageName,
    pass,
    elapsedMs,
    apiCount: apiCalls.length,
    apiFailureCount: apiFailures.length,
    detail,
  };
}

async function expectAnySelector(page, selectors) {
  const rows = Array.isArray(selectors) ? selectors : [];
  for (let i = 0; i < rows.length; i += 1) {
    const selector = rows[i];
    const count = await page.locator(selector).count();
    if (count > 0) {
      return;
    }
  }
  throw new Error(`none of selectors found: ${rows.join(', ')}`);
}

async function runWalletSuite(wallet) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.addInitScript(walletInitScript(wallet));
  const checks = [
    {
      name: 'index',
      path: '/index.html',
      verify: async (page) => {
        await page.waitForSelector('#page-frame', { timeout: 15000 });
      },
    },
    {
      name: 'portfolio',
      path: '/portfolio.html',
      verify: async (page) => {
        await page.waitForSelector('#wallet', { timeout: 15000 });
        await page.waitForFunction(() => {
          const wallet = document.querySelector('#wallet');
          if (!wallet) {
            return false;
          }
          const text = String(wallet.textContent || '');
          return text.includes('0x');
        }, null, { timeout: 30000 });
        await page.waitForFunction(() => {
          const grid = document.querySelector('#summary-grid');
          return Boolean(grid && grid.children && grid.children.length > 0);
        }, null, { timeout: 30000 });
        const loadingText = await page.locator('#holdings-status').innerText().catch(() => '');
        if (String(loadingText || '').toLowerCase().includes('loading')) {
          throw new Error('holdings still loading');
        }
      },
    },
    {
      name: 'admin',
      path: '/admin.html',
      verify: async (page, activeWallet) => {
        await page.waitForTimeout(1500);
        if (activeWallet.toLowerCase() === ADMIN_WALLET.toLowerCase()) {
          await page.waitForSelector('#open-orders-body', { timeout: 15000 });
          await page.waitForSelector('#fills-body', { timeout: 15000 });
        } else {
          await page.waitForSelector('#admin-access-denied', { timeout: 15000 });
        }
      },
    },
    {
      name: 'trade',
      path: '/trade.html',
      verify: async (page) => {
        await page.waitForSelector('#trade-symbol', { timeout: 15000 });
        await page.waitForTimeout(1500);
      },
    },
    {
      name: 'sell',
      path: '/sell.html?symbol=AAPL',
      verify: async (page) => {
        await page.waitForSelector('#sell-btn', { timeout: 15000 });
        await page.waitForTimeout(1000);
      },
    },
    {
      name: 'transactions',
      path: '/transactions.html',
      verify: async (page) => {
        await expectAnySelector(page, ['#transactions-table tbody', '#tx-table-body', 'table tbody']);
      },
    },
    {
      name: 'markets',
      path: '/chart.html',
      verify: async (page) => {
        await page.waitForSelector('#symbol', { timeout: 15000 });
      },
    },
    {
      name: 'award',
      path: '/award.html',
      verify: async (page) => {
        await expectAnySelector(page, ['#award-status', '#status', '.status']);
      },
    },
    {
      name: 'ttoken',
      path: '/ttoken.html',
      verify: async (page) => {
        await page.waitForSelector('#airdrop-btn', { timeout: 15000 });
      },
    },
  ];
  const results = [];
  for (let i = 0; i < checks.length; i += 1) {
    const item = checks[i];
    const result = await runPageCheck(context, wallet, item.name, item.path, item.verify);
    results.push(result);
  }
  await context.close();
  await browser.close();
  return results;
}

async function main() {
  const rows = [];
  const adminRows = await runWalletSuite(ADMIN_WALLET);
  for (let i = 0; i < adminRows.length; i += 1) {
    rows.push(adminRows[i]);
  }
  const userRows = await runWalletSuite(USER_WALLET);
  for (let i = 0; i < userRows.length; i += 1) {
    rows.push(userRows[i]);
  }

  console.log('BROWSER_E2E_RESULTS');
  let passCount = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.pass) {
      passCount += 1;
    }
    console.log(`${row.pass ? 'PASS' : 'FAIL'} | ${row.wallet.slice(0, 8)} | ${row.page} | ${row.elapsedMs}ms | api=${row.apiCount} fail=${row.apiFailureCount} | ${row.detail}`);
  }
  console.log(`BROWSER_E2E_SUMMARY pass=${passCount} fail=${rows.length - passCount} total=${rows.length}`);
  if (passCount !== rows.length) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
