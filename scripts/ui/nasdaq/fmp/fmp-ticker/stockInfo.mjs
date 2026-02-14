const API_KEY = "TNQATNqowKe9Owu1zL9QurgZCXx9Q1BS";
const SYMBOL = "TSLA";

const encodedSymbol = encodeURIComponent(SYMBOL);
const encodedApiKey = encodeURIComponent(API_KEY);

const endpoints = {
  quote: `https://financialmodelingprep.com/stable/quote?symbol=${encodedSymbol}&apikey=${encodedApiKey}`,
  aftermarket: `https://financialmodelingprep.com/stable/aftermarket-quote?symbol=${encodedSymbol}&apikey=${encodedApiKey}`,
};

async function getJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  try {
    const parsed = JSON.parse(text);
    return parsed;
  } catch (parseError) {
    const preview = text.slice(0, 200);
    throw new Error(`Non-JSON response: ${preview}...`);
  }
}

function firstOrNull(payload) {
  const isArray = Array.isArray(payload);

  if (isArray) {
    if (payload.length > 0) {
      return payload[0];
    }
    return null;
  }

  if (payload === undefined || payload === null) {
    return null;
  }

  return payload;
}

function fmtNum(x, digits = 2) {
  if (x === null || x === undefined || x === "") {
    return null;
  }

  const n = Number(x);
  if (Number.isFinite(n)) {
    return n.toFixed(digits);
  }

  return String(x);
}

function fmtInt(x) {
  if (x === null || x === undefined || x === "") {
    return null;
  }

  const n = Number(x);
  if (Number.isFinite(n)) {
    return Math.round(n).toLocaleString("en-GB");
  }

  return String(x);
}

function pick(obj, keys) {
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (obj && obj[key] !== undefined && obj[key] !== null) {
      return obj[key];
    }
  }

  return null;
}

(async () => {
  const quotePayload = await getJson(endpoints.quote);

  let afterPayload;
  try {
    afterPayload = await getJson(endpoints.aftermarket);
  } catch (error) {
    let message = String(error);
    if (error && error.message) {
      message = error.message;
    }
    afterPayload = { __error: message };
  }

  const quote = firstOrNull(quotePayload);
  const hasAfterError = Boolean(afterPayload.__error);

  let after = null;
  if (!hasAfterError) {
    after = firstOrNull(afterPayload);
  }

  console.log("=== RAW: /stable/quote ===");
  console.log(JSON.stringify(quotePayload, null, 2));

  console.log("\n=== RAW: /stable/aftermarket-quote ===");
  console.log(JSON.stringify(afterPayload, null, 2));

  const previousClose = pick(quote, ["previousClose", "prevClose"]);
  const open = pick(quote, ["open", "priceOpen"]);
  const dayLow = pick(quote, ["dayLow", "low"]);
  const dayHigh = pick(quote, ["dayHigh", "high"]);
  const yearLow = pick(quote, ["yearLow", "fiftyTwoWeekLow", "52WeekLow"]);
  const yearHigh = pick(quote, ["yearHigh", "fiftyTwoWeekHigh", "52WeekHigh"]);
  const volume = pick(quote, ["volume"]);
  const avgVolume = pick(quote, ["avgVolume", "averageVolume"]);
  const marketCap = pick(quote, ["marketCap", "mktCap"]);
  const beta = pick(quote, ["beta"]);
  const peTTM = pick(quote, ["pe", "peRatioTTM", "peTTM"]);
  const epsTTM = pick(quote, ["eps", "epsTTM"]);

  const bid = pick(after, ["bid", "bidPrice"]);
  const bidSize = pick(after, ["bidSize", "bidSizeShares"]);
  const ask = pick(after, ["ask", "askPrice"]);
  const askSize = pick(after, ["askSize", "askSizeShares"]);

  console.log("\n=== MAPPED PANEL (best-effort) ===");
  console.log(`Symbol: ${SYMBOL}`);

  let previousCloseText = "N/A";
  if (previousClose !== null) {
    previousCloseText = String(previousClose);
  }
  console.log(`Previous close: ${previousCloseText}`);

  let openText = "N/A";
  if (open !== null) {
    openText = String(open);
  }
  console.log(`Open: ${openText}`);

  let dayRange = "N/A";
  if (dayLow !== null && dayHigh !== null) {
    dayRange = `${fmtNum(dayLow)} - ${fmtNum(dayHigh)}`;
  }
  console.log(`Day's range: ${dayRange}`);

  let yearRange = "N/A";
  if (yearLow !== null && yearHigh !== null) {
    yearRange = `${fmtNum(yearLow)} - ${fmtNum(yearHigh)}`;
  }
  console.log(`52-week range: ${yearRange}`);

  let volumeText = "N/A";
  if (volume !== null) {
    volumeText = fmtInt(volume);
  }
  console.log(`Volume: ${volumeText}`);

  let avgVolumeText = "N/A";
  if (avgVolume !== null) {
    avgVolumeText = fmtInt(avgVolume);
  }
  console.log(`Avg. Volume: ${avgVolumeText}`);

  let marketCapText = "N/A";
  if (marketCap !== null) {
    marketCapText = fmtInt(marketCap);
  }
  console.log(`Market cap: ${marketCapText}`);

  let betaText = "N/A";
  if (beta !== null) {
    betaText = fmtNum(beta);
  }
  console.log(`Beta (5Y monthly): ${betaText}`);

  let peText = "N/A";
  if (peTTM !== null) {
    peText = fmtNum(peTTM);
  }
  console.log(`PE ratio (TTM): ${peText}`);

  let epsText = "N/A";
  if (epsTTM !== null) {
    epsText = fmtNum(epsTTM);
  }
  console.log(`EPS (TTM): ${epsText}`);

  if (hasAfterError) {
    console.log(`Bid: N/A (aftermarket endpoint error: ${afterPayload.__error})`);
    console.log(`Ask: N/A (aftermarket endpoint error: ${afterPayload.__error})`);
  } else {
    let bidText = "N/A";
    if (bid !== null) {
      bidText = String(fmtNum(bid));
      if (bidSize !== null) {
        bidText = `${bidText} x ${fmtInt(bidSize)}`;
      }
    }

    let askText = "N/A";
    if (ask !== null) {
      askText = String(fmtNum(ask));
      if (askSize !== null) {
        askText = `${askText} x ${fmtInt(askSize)}`;
      }
    }

    console.log(`Bid: ${bidText}`);
    console.log(`Ask: ${askText}`);
  }

  console.log("\nNotes:");
  console.log("- Earnings date (est.), forward dividend/yield, ex-div date, 1y target estimate are usually NOT in quote; they come from earnings/dividends/analyst endpoints.");
})();
