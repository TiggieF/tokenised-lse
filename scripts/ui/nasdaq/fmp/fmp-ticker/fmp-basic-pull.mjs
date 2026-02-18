const API_KEY = process.env.FMP_API_KEY || "TNQATNqowKe9Owu1zL9QurgZCXx9Q1BS";
const SYMBOL = (process.argv[2] || "AAPL").toUpperCase();

function buildUrl(pathname, params) {
  const url = new URL(`https://financialmodelingprep.com/stable/${pathname}`);
  const entries = Object.entries(params || {});
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    url.searchParams.set(entry[0], String(entry[1]));
  }
  url.searchParams.set("apikey", API_KEY);
  return url.toString();
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Non JSON response: ${text.slice(0, 200)}`);
  }
}

function toArray(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (payload === null || payload === undefined) {
    return [];
  }
  return [payload];
}

function first(payload) {
  const rows = toArray(payload);
  if (rows.length > 0) {
    return rows[0];
  }
  return {};
}

function numberOrNull(value) {
  const n = Number(value);
  if (Number.isFinite(n)) {
    return n;
  }
  return null;
}

const endpointMap = {
  searchExchangeVariants: buildUrl("search-exchange-variants", { symbol: SYMBOL }),
  companyScreener: buildUrl("company-screener", { limit: 200 }),
  profile: buildUrl("profile", { symbol: SYMBOL }),
  employeeCount: buildUrl("employee-count", { symbol: SYMBOL }),
  keyExecutives: buildUrl("key-executives", { symbol: SYMBOL }),
  quote: buildUrl("quote", { symbol: SYMBOL }),
  stockPriceChange: buildUrl("stock-price-change", { symbol: SYMBOL }),
  balanceSheetStatement: buildUrl("balance-sheet-statement", { symbol: SYMBOL, limit: 4 }),
  keyMetrics: buildUrl("key-metrics", { symbol: SYMBOL, limit: 4 }),
  ratios: buildUrl("ratios", { symbol: SYMBOL, limit: 4 }),
  keyMetricsTtm: buildUrl("key-metrics-ttm", { symbol: SYMBOL }),
  ratiosTtm: buildUrl("ratios-ttm", { symbol: SYMBOL }),
  enterpriseValues: buildUrl("enterprise-values", { symbol: SYMBOL, limit: 4 }),
  newsStockLatest: buildUrl("news/stock-latest", { page: 0, limit: 30 }),
  ratingsHistorical: buildUrl("ratings-historical", { symbol: SYMBOL, limit: 20 }),
  analystEstimates: buildUrl("analyst-estimates", { symbol: SYMBOL, period: "annual", page: 0, limit: 10 }),
  priceTargetSummary: buildUrl("price-target-summary", { symbol: SYMBOL }),
  grades: buildUrl("grades", { symbol: SYMBOL, limit: 20 }),
  insiderTradingLatest: buildUrl("insider-trading/latest", { page: 0, limit: 100 }),
};

async function main() {
  const keys = Object.keys(endpointMap);
  const raw = {};
  const errors = {};

  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    const url = endpointMap[key];
    try {
      raw[key] = await fetchJson(url);
    } catch (err) {
      raw[key] = [];
      errors[key] = err.message || "request failed";
    }
  }

  const quoteRow = first(raw.quote);
  const profileRow = first(raw.profile);
  const changeRow = first(raw.stockPriceChange);
  const employeeRow = first(raw.employeeCount);

  const news = toArray(raw.newsStockLatest)
    .filter((row) => {
      const rowSymbol = String(row.symbol || row.ticker || "").toUpperCase();
      return !rowSymbol || rowSymbol === SYMBOL;
    })
    .slice(0, 20);

  const insider = toArray(raw.insiderTradingLatest)
    .filter((row) => String(row.symbol || row.ticker || "").toUpperCase() === SYMBOL)
    .slice(0, 20);

  const merged = {
    symbol: SYMBOL,
    fetchedAt: new Date().toISOString(),
    endpointCount: keys.length,
    endpoints: endpointMap,
    errors,
    sections: {
      overview: {
        name: String(profileRow.companyName || profileRow.name || ""),
        exchange: String(profileRow.exchange || profileRow.exchangeShortName || ""),
        sector: String(profileRow.sector || ""),
        industry: String(profileRow.industry || ""),
        ceo: String(profileRow.ceo || ""),
        country: String(profileRow.country || ""),
        website: String(profileRow.website || ""),
        price: numberOrNull(quoteRow.price),
        previousClose: numberOrNull(quoteRow.previousClose),
        open: numberOrNull(quoteRow.open),
        dayLow: numberOrNull(quoteRow.dayLow || quoteRow.low),
        dayHigh: numberOrNull(quoteRow.dayHigh || quoteRow.high),
        marketCap: numberOrNull(quoteRow.marketCap),
        volume: numberOrNull(quoteRow.volume),
        oneDayChangePct: numberOrNull(changeRow["1D"] ?? changeRow.changesPercentage ?? changeRow.changePercent),
      },
      company: {
        searchExchangeVariants: toArray(raw.searchExchangeVariants).slice(0, 10),
        employeeCount: numberOrNull(employeeRow.employeeCount || employeeRow.employees),
      },
      people: {
        keyExecutives: toArray(raw.keyExecutives).slice(0, 10),
      },
      financial: {
        balanceSheet: toArray(raw.balanceSheetStatement).slice(0, 4),
        keyMetrics: toArray(raw.keyMetrics).slice(0, 4),
        ratios: toArray(raw.ratios).slice(0, 4),
        keyMetricsTtm: first(raw.keyMetricsTtm),
        ratiosTtm: first(raw.ratiosTtm),
        enterpriseValues: toArray(raw.enterpriseValues).slice(0, 4),
      },
      analysis: {
        ratingsHistorical: toArray(raw.ratingsHistorical).slice(0, 10),
        analystEstimates: toArray(raw.analystEstimates).slice(0, 10),
        priceTargetSummary: first(raw.priceTargetSummary),
        grades: toArray(raw.grades).slice(0, 10),
      },
      news,
      insider,
    },
    raw,
  };

  console.log(JSON.stringify(merged, null, 2));
}

main().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
