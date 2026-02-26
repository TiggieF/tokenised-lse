const TZ = "America/New_York";
const DEFAULT_INCLUDE_PREPOST = false;
const DEFAULT_HEADERS = {
  "User-Agent": "Mozilla/4.0 (compatible; MSIE 6.0; Windows NT 5.2; .NET CLR 1.0.3705;)",
  "Accept": "application/json,text/plain,*/*",
  "Accept-Language": "en-US,en;q=0.9",
};

function fmtET(unixSec) {
  const dateValue = new Date(unixSec * 1000);
  const text = dateValue.toLocaleString("en-US", { timeZone: TZ });
  return text;
}

function etParts(unixSec) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(new Date(unixSec * 1000));

  function getPartValue(type) {
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (part.type === type) {
        return part.value;
      }
    }

    return "";
  }

  const year = getPartValue("year");
  const month = getPartValue("month");
  const day = getPartValue("day");
  const hour = getPartValue("hour");
  const minute = getPartValue("minute");

  return {
    ymd: `${year}-${month}-${day}`,
    hm: `${hour}:${minute}`,
  };
}

function etToUnixSec(ymd, hh, mm) {
  const parts = ymd.split("-");
  const Y = Number(parts[0]);
  const M = Number(parts[1]);
  const D = Number(parts[2]);

  const targetUtc = Date.UTC(Y, M - 1, D, hh, mm) / 1000;
  let guess = targetUtc;

  for (let i = 0; i < 4; i += 1) {
    const p = etParts(guess);

    const currentYear = Number(p.ymd.slice(0, 4));
    const currentMonth = Number(p.ymd.slice(5, 7));
    const currentDay = Number(p.ymd.slice(8, 10));
    const currentHour = Number(p.hm.slice(0, 2));
    const currentMinute = Number(p.hm.slice(3, 5));

    const currentUtc = Date.UTC(
      currentYear,
      currentMonth - 1,
      currentDay,
      currentHour,
      currentMinute
    ) / 1000;

    guess = guess + (targetUtc - currentUtc);
  }

  return guess;
}

function round2(x) {
  const rounded = Number(x.toFixed(2));
  return rounded;
}

async function yahooFetchJson(url) {
  const response = await fetch(url, { headers: DEFAULT_HEADERS });

  if (!response.ok) {
    throw new Error(`Yahoo HTTP ${response.status}`);
  }

  const payload = await response.json();
  return payload;
}

async function fetchQuote(symbol) {
  const encodedSymbol = encodeURIComponent(symbol);
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodedSymbol}`;

  const json = await yahooFetchJson(url);
  const result = json.quoteResponse.result;
  const quote = result[0];

  const mapped = {
    symbol: quote.symbol,
    shortName: quote.shortName,
    currency: quote.currency,
    marketState: quote.marketState,
    regularMarketPrice: quote.regularMarketPrice,
    regularMarketChange: quote.regularMarketChange,
    regularMarketChangePercent: quote.regularMarketChangePercent,
    regularMarketOpen: quote.regularMarketOpen,
    regularMarketTime: quote.regularMarketTime,
    preMarketPrice: quote.preMarketPrice,
    preMarketChange: quote.preMarketChange,
    preMarketChangePercent: quote.preMarketChangePercent,
    preMarketTime: quote.preMarketTime,
  };

  return mapped;
}

async function fetchIntradayCandles(symbol, interval, dateET, includePrePost) {
  let includePrePostValue = includePrePost;
  if (!includePrePostValue) {
    includePrePostValue = DEFAULT_INCLUDE_PREPOST;
  }

  const open = etToUnixSec(dateET, 9, 30);
  const close = etToUnixSec(dateET, 16, 1);

  const nowSec = Math.floor(Date.now() / 1000);
  const todayEt = etParts(nowSec).ymd;

  let period2 = close;

  if (dateET === todayEt) {
    if (nowSec < open) {
      return [];
    }

    period2 = Math.min(close, nowSec);
  }

  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}` +
    `?interval=${interval}&period1=${open}&period2=${period2}` +
    `&includePrePost=${includePrePostValue}`;

  const json = await yahooFetchJson(url);

  if (json.chart && json.chart.error) {
    throw new Error(JSON.stringify(json.chart.error));
  }

  const result = json.chart.result[0];
  let ts = [];
  if (result.timestamp) {
    ts = result.timestamp;
  }
  const q = result.indicators.quote[0];

  const candles = [];

  for (let i = 0; i < ts.length; i += 1) {
    const t = ts[i];

    const candle = {
      timeSec: t,
      timeET: fmtET(t),
      open: round2(q.open[i]),
      high: round2(q.high[i]),
      low: round2(q.low[i]),
      close: round2(q.close[i]),
      volume: q.volume[i],
      _ymdET: etParts(t).ymd,
    };

    if (candle._ymdET === dateET) {
      candles.push(candle);
    }
  }

  return candles;
}

function bucketStartMinutes(ymd, unixSec, intervalMinutes) {
  const p = etParts(unixSec);
  const h = Number(p.hm.slice(0, 2));
  const m = Number(p.hm.slice(3, 5));

  const total = (h * 60) + m;
  const bucketMinutes = Math.floor(total / intervalMinutes) * intervalMinutes;
  const bucketText = String(bucketMinutes).padStart(4, "0");

  return `${ymd}-${bucketText}`;
}

function aggregateCandles(candles, intervalMinutes) {
  const copied = [];
  for (let i = 0; i < candles.length; i += 1) {
    copied.push(candles[i]);
  }

  copied.sort((a, b) => {
    return a.timeSec - b.timeSec;
  });

  if (intervalMinutes === 5) {
    return copied;
  }

  const result = [];
  let current = null;

  for (let i = 0; i < copied.length; i += 1) {
    const candle = copied[i];
    const bucketKey = bucketStartMinutes(candle._ymdET, candle.timeSec, intervalMinutes);

    let hasCurrent = false;
    if (current) {
      hasCurrent = true;
    }
    const sameBucket = hasCurrent && current.bucketKey === bucketKey;

    if (!sameBucket) {
      if (hasCurrent) {
        result.push(current);
      }

      current = {
        bucketKey,
        timeSec: candle.timeSec,
        timeET: candle.timeET,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        _ymdET: candle._ymdET,
      };
    } else {
      current.high = Math.max(current.high, candle.high);
      current.low = Math.min(current.low, candle.low);
      current.close = candle.close;
      current.volume = current.volume + candle.volume;
    }
  }

  if (current) {
    result.push(current);
  }

  return result;
}

module.exports = {
  fetchQuote,
  fetchIntradayCandles,
  aggregateCandles,
};
