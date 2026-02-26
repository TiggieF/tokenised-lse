let apiKeyValue = "TNQATNqowKe9Owu1zL9QurgZCXx9Q1BS";
if (process.env.FMP_API_KEY) {
  apiKeyValue = process.env.FMP_API_KEY;
}
const API_KEY = apiKeyValue;

let symbolValue = "AAPL";
if (process.argv[2]) {
  symbolValue = process.argv[2];
}
const SYMBOL = String(symbolValue).toUpperCase();

let limitValue = "120";
if (process.argv[3]) {
  limitValue = process.argv[3];
}
const LIMIT = Number(limitValue);

function buildUrl(pathname, params) {
  const url = new URL(`https://financialmodelingprep.com/stable/${pathname}`);
  let paramEntries = [];
  if (params) {
    paramEntries = Object.entries(params);
  }
  const entries = paramEntries;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    url.searchParams.set(entry[0], String(entry[1]));
  }
  url.searchParams.set("apikey", API_KEY);
  return url.toString();
}

function toPreview(text, maxLen) {
  if (!text) {
    return "";
  }
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLen) {
    return compact;
  }
  return compact.slice(0, maxLen) + "...";
}

const endpoints = [
  { key: "search_exchange_variants", path: "search-exchange-variants", params: { symbol: SYMBOL } },
  { key: "company_screener", path: "company-screener", params: { limit: 50 } },
  { key: "profile", path: "profile", params: { symbol: SYMBOL } },
  { key: "employee_count", path: "employee-count", params: { symbol: SYMBOL } },
  { key: "key_executives", path: "key-executives", params: { symbol: SYMBOL } },
  { key: "quote", path: "quote", params: { symbol: SYMBOL } },
  { key: "quote_short", path: "quote-short", params: { symbol: SYMBOL } },
  { key: "stock_price_change", path: "stock-price-change", params: { symbol: SYMBOL } },
  { key: "balance_sheet_statement", path: "balance-sheet-statement", params: { symbol: SYMBOL, limit: 4 } },
  { key: "key_metrics", path: "key-metrics", params: { symbol: SYMBOL, limit: 4 } },
  { key: "ratios", path: "ratios", params: { symbol: SYMBOL, limit: 4 } },
  { key: "key_metrics_ttm", path: "key-metrics-ttm", params: { symbol: SYMBOL } },
  { key: "ratios_ttm", path: "ratios-ttm", params: { symbol: SYMBOL } },
  { key: "enterprise_values", path: "enterprise-values", params: { symbol: SYMBOL, limit: 4 } },
  { key: "news_stock_latest", path: "news/stock-latest", params: { page: 0, limit: 20 } },
  { key: "ratings_historical", path: "ratings-historical", params: { symbol: SYMBOL, limit: 20 } },
  { key: "analyst_estimates", path: "analyst-estimates", params: { symbol: SYMBOL, period: "annual", page: 0, limit: 10 } },
  { key: "price_target_summary", path: "price-target-summary", params: { symbol: SYMBOL } },
  { key: "grades", path: "grades", params: { symbol: SYMBOL, limit: 20 } },
  { key: "insider_trading_latest", path: "insider-trading/latest", params: { page: 0, limit: 100 } },

  { key: "stock_list", path: "stock-list", params: {} },
  { key: "actively_trading_list", path: "actively-trading-list", params: {} },
  { key: "etf_list", path: "etf-list", params: {} },
  { key: "symbol_change", path: "symbol-change", params: {} },
  { key: "available_exchanges", path: "available-exchanges", params: {} },
  { key: "available_sectors", path: "available-sectors", params: {} },
  { key: "available_industries", path: "available-industries", params: {} },
  { key: "available_countries", path: "available-countries", params: {} },
  { key: "stock_peers", path: "stock-peers", params: { symbol: SYMBOL } },
  { key: "historical_employee_count", path: "historical-employee-count", params: { symbol: SYMBOL } },
  { key: "market_capitalization", path: "market-capitalization", params: { symbol: SYMBOL } },
  { key: "historical_market_capitalization", path: "historical-market-capitalization", params: { symbol: SYMBOL } },
  { key: "shares_float", path: "shares-float", params: { symbol: SYMBOL } },
  { key: "mergers_acquisitions_latest", path: "mergers-acquisitions-latest", params: { page: 0, limit: 20 } },
  { key: "governance_executive_compensation", path: "governance-executive-compensation", params: { symbol: SYMBOL } },
];

async function probeOne(entry) {
  const url = buildUrl(entry.path, entry.params);
  const started = Date.now();
  try {
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }

    let itemCount = 0;
    if (Array.isArray(parsed)) {
      itemCount = parsed.length;
    } else if (parsed && typeof parsed === "object") {
      const keys = Object.keys(parsed);
      itemCount = keys.length;
    }

    const usable = response.ok;
    return {
      key: entry.key,
      path: entry.path,
      status: response.status,
      usable,
      ms: Date.now() - started,
      itemCount,
      preview: toPreview(text, LIMIT),
    };
  } catch (err) {
    return {
      key: entry.key,
      path: entry.path,
      status: 0,
      usable: false,
      ms: Date.now() - started,
      itemCount: 0,
      preview: err.message || "request failed",
    };
  }
}

async function main() {
  console.log(`FMP endpoint probe | symbol=${SYMBOL}`);
  console.log(`Using key ending: ...${API_KEY.slice(-6)}`);

  const rows = [];
  for (let i = 0; i < endpoints.length; i += 1) {
    const entry = endpoints[i];
    const row = await probeOne(entry);
    rows.push(row);
  }

  const usableRows = rows.filter((r) => r.usable);
  const blockedRows = rows.filter((r) => !r.usable);

  console.log(`\nUsable: ${usableRows.length} | Blocked/Failed: ${blockedRows.length} | Total: ${rows.length}\n`);

  console.table(rows.map((r) => ({
    endpoint: r.key,
    path: r.path,
    status: r.status,
    usable: r.usable ? "YES" : "NO",
    ms: r.ms,
    items: r.itemCount,
  })));

  console.log("\nBlocked/failed details:\n");
  if (blockedRows.length === 0) {
    console.log("None");
  } else {
    for (let i = 0; i < blockedRows.length; i += 1) {
      const r = blockedRows[i];
      console.log(`- ${r.key} (${r.path}) status=${r.status} preview=${r.preview}`);
    }
  }

  console.log("\nUsable endpoint keys:\n");
  for (let i = 0; i < usableRows.length; i += 1) {
    console.log(`- ${usableRows[i].key}`);
  }
}

main().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
