let apiKey = process.env.FMP_API_KEY;
if (!apiKey) {
  apiKey = "TNQATNqowKe9Owu1zL9QurgZCXx9Q1BS";
}

let symbolFromArgs = process.argv[2];
if (!symbolFromArgs) {
  symbolFromArgs = "AAPL";
}
const symbol = String(symbolFromArgs).toUpperCase();

function buildUrl(pathname, paramsInput) {
  const url = new URL(`https://financialmodelingprep.com/stable/${pathname}`);
  let params = paramsInput;
  if (!params) {
    params = {};
  }

  const entries = Object.entries(params);
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const key = entry[0];
    const value = entry[1];
    url.searchParams.set(key, String(value));
  }

  url.searchParams.set("apikey", apiKey);
  return url.toString();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  let parsed = {};
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Non JSON response: ${text.slice(0, 200)}`);
  }

  return parsed;
}

function asArray(payload) {
  const rows = [];
  if (Array.isArray(payload)) {
    for (let i = 0; i < payload.length; i += 1) {
      rows.push(payload[i]);
    }
  } else {
    rows.push(payload);
  }
  return rows;
}

function firstRow(payload) {
  const rows = asArray(payload);
  let row = {};
  if (rows.length > 0) {
    row = rows[0];
  }
  return row;
}

function toNumberOrNull(value) {
  const parsed = Number(value);
  let result = null;
  if (Number.isFinite(parsed)) {
    result = parsed;
  }
  return result;
}

const endpointMap = {
  searchExchangeVariants: buildUrl("search-exchange-variants", { symbol }),
  companyScreener: buildUrl("company-screener", { limit: 200 }),
  profile: buildUrl("profile", { symbol }),
  employeeCount: buildUrl("employee-count", { symbol }),
  keyExecutives: buildUrl("key-executives", { symbol }),
  quote: buildUrl("quote", { symbol }),
  stockPriceChange: buildUrl("stock-price-change", { symbol }),
  balanceSheetStatement: buildUrl("balance-sheet-statement", { symbol, limit: 4 }),
  keyMetrics: buildUrl("key-metrics", { symbol, limit: 4 }),
  ratios: buildUrl("ratios", { symbol, limit: 4 }),
  keyMetricsTtm: buildUrl("key-metrics-ttm", { symbol }),
  ratiosTtm: buildUrl("ratios-ttm", { symbol }),
  enterpriseValues: buildUrl("enterprise-values", { symbol, limit: 4 }),
  newsStockLatest: buildUrl("news/stock-latest", { page: 0, limit: 30 }),
  ratingsHistorical: buildUrl("ratings-historical", { symbol, limit: 20 }),
  analystEstimates: buildUrl("analyst-estimates", { symbol, period: "annual", page: 0, limit: 10 }),
  priceTargetSummary: buildUrl("price-target-summary", { symbol }),
  grades: buildUrl("grades", { symbol, limit: 20 }),
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
      const payload = await fetchJson(url);
      raw[key] = payload;
    } catch (err) {
      raw[key] = [];
      let message = String(err);
      if (err && err.message) {
        message = err.message;
      }
      errors[key] = message;
    }
  }

  const quoteRow = firstRow(raw.quote);
  const profileRow = firstRow(raw.profile);
  const changeRow = firstRow(raw.stockPriceChange);
  const employeeRow = firstRow(raw.employeeCount);

  const allNews = asArray(raw.newsStockLatest);
  const news = [];
  for (let i = 0; i < allNews.length; i += 1) {
    const row = allNews[i];
    const candidate = String(row.symbol).toUpperCase();
    const candidateTicker = String(row.ticker).toUpperCase();

    let include = false;
    if (candidate === symbol) {
      include = true;
    }
    if (candidateTicker === symbol) {
      include = true;
    }
    if (candidate === "UNDEFINED" && candidateTicker === "UNDEFINED") {
      include = true;
    }

    if (include) {
      news.push(row);
    }
    if (news.length >= 20) {
      break;
    }
  }

  const allInsider = asArray(raw.insiderTradingLatest);
  const insider = [];
  for (let i = 0; i < allInsider.length; i += 1) {
    const row = allInsider[i];
    const candidate = String(row.symbol).toUpperCase();
    const candidateTicker = String(row.ticker).toUpperCase();

    let include = false;
    if (candidate === symbol) {
      include = true;
    }
    if (candidateTicker === symbol) {
      include = true;
    }

    if (include) {
      insider.push(row);
    }
    if (insider.length >= 20) {
      break;
    }
  }

  let oneDayChangeSource = changeRow["1D"];
  if (!Number.isFinite(Number(oneDayChangeSource))) {
    oneDayChangeSource = changeRow.changesPercentage;
  }
  if (!Number.isFinite(Number(oneDayChangeSource))) {
    oneDayChangeSource = changeRow.changePercent;
  }

  const merged = {
    symbol,
    fetchedAt: new Date().toISOString(),
    endpointCount: keys.length,
    endpoints: endpointMap,
    errors,
    sections: {
      overview: {
        name: String(profileRow.companyName),
        exchange: String(profileRow.exchange),
        sector: String(profileRow.sector),
        industry: String(profileRow.industry),
        ceo: String(profileRow.ceo),
        country: String(profileRow.country),
        website: String(profileRow.website),
        price: toNumberOrNull(quoteRow.price),
        previousClose: toNumberOrNull(quoteRow.previousClose),
        open: toNumberOrNull(quoteRow.open),
        dayLow: toNumberOrNull(quoteRow.dayLow),
        dayHigh: toNumberOrNull(quoteRow.dayHigh),
        marketCap: toNumberOrNull(quoteRow.marketCap),
        volume: toNumberOrNull(quoteRow.volume),
        oneDayChangePct: toNumberOrNull(oneDayChangeSource),
      },
      company: {
        searchExchangeVariants: asArray(raw.searchExchangeVariants).slice(0, 10),
        employeeCount: toNumberOrNull(employeeRow.employeeCount),
      },
      people: {
        keyExecutives: asArray(raw.keyExecutives).slice(0, 10),
      },
      financial: {
        balanceSheet: asArray(raw.balanceSheetStatement).slice(0, 4),
        keyMetrics: asArray(raw.keyMetrics).slice(0, 4),
        ratios: asArray(raw.ratios).slice(0, 4),
        keyMetricsTtm: firstRow(raw.keyMetricsTtm),
        ratiosTtm: firstRow(raw.ratiosTtm),
        enterpriseValues: asArray(raw.enterpriseValues).slice(0, 4),
      },
      analysis: {
        ratingsHistorical: asArray(raw.ratingsHistorical).slice(0, 10),
        analystEstimates: asArray(raw.analystEstimates).slice(0, 10),
        priceTargetSummary: firstRow(raw.priceTargetSummary),
        grades: asArray(raw.grades).slice(0, 10),
      },
      news,
      insider,
    },
    raw,
  };

  console.log(JSON.stringify(merged, null, 2));
}

main().catch((err) => {
  let message = String(err);
  if (err && err.message) {
    message = err.message;
  }
  console.error(message);
  process.exit(1);
});
