
const API_KEY = "TNQATNqowKe9Owu1zL9QurgZCXx9Q1BS";


const SYMBOL = "TSLA";

const endpoints = {
  quote: `https://financialmodelingprep.com/stable/quote?symbol=${encodeURIComponent(SYMBOL)}&apikey=${encodeURIComponent(API_KEY)}`,
  aftermarket: `https://financialmodelingprep.com/stable/aftermarket-quote?symbol=${encodeURIComponent(SYMBOL)}&apikey=${encodeURIComponent(API_KEY)}`,
};

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response: ${text.slice(0, 200)}...`);
  }
}

function firstOrNull(payload) {
  return Array.isArray(payload) ? (payload[0] ?? null) : payload ?? null;
}

function fmtNum(x, digits = 2) {
  if (x === null || x === undefined || x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n.toFixed(digits) : String(x);
}

function fmtInt(x) {
  if (x === null || x === undefined || x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? Math.round(n).toLocaleString("en-GB") : String(x);
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return null;
}

(async () => {
  const [quotePayload, afterPayload] = await Promise.all([
    getJson(endpoints.quote),
    getJson(endpoints.aftermarket).catch((e) => ({ __error: e.message })),
  ]);

  const quote = firstOrNull(quotePayload);
  const after = afterPayload.__error ? null : firstOrNull(afterPayload);

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
  console.log(`Previous close: ${previousClose ?? "N/A"}`);
  console.log(`Open: ${open ?? "N/A"}`);
  console.log(
    `Day's range: ${dayLow !== null && dayHigh !== null ? `${fmtNum(dayLow)} - ${fmtNum(dayHigh)}` : "N/A"}`
  );
  console.log(
    `52-week range: ${yearLow !== null && yearHigh !== null ? `${fmtNum(yearLow)} - ${fmtNum(yearHigh)}` : "N/A"}`
  );
  console.log(`Volume: ${volume !== null ? fmtInt(volume) : "N/A"}`);
  console.log(`Avg. Volume: ${avgVolume !== null ? fmtInt(avgVolume) : "N/A"}`);
  console.log(`Market cap: ${marketCap !== null ? fmtInt(marketCap) : "N/A"}`);
  console.log(`Beta (5Y monthly): ${beta !== null ? fmtNum(beta) : "N/A"}`);
  console.log(`PE ratio (TTM): ${peTTM !== null ? fmtNum(peTTM) : "N/A"}`);
  console.log(`EPS (TTM): ${epsTTM !== null ? fmtNum(epsTTM) : "N/A"}`);

  if (afterPayload.__error) {
    console.log(`Bid: N/A (aftermarket endpoint error: ${afterPayload.__error})`);
    console.log(`Ask: N/A (aftermarket endpoint error: ${afterPayload.__error})`);
  } else {
    const bidStr =
      bid !== null ? `${fmtNum(bid)}${bidSize !== null ? ` x ${fmtInt(bidSize)}` : ""}` : "N/A";
    const askStr =
      ask !== null ? `${fmtNum(ask)}${askSize !== null ? ` x ${fmtInt(askSize)}` : ""}` : "N/A";
    console.log(`Bid: ${bidStr}`);
    console.log(`Ask: ${askStr}`);
  }

  console.log("\nNotes:");
  console.log("- Earnings date (est.), forward dividend/yield, ex-div date, 1y target estimate are usually NOT in quote; they come from earnings/dividends/analyst endpoints.");
})();
