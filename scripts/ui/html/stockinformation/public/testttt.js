const Alpaca = require("@alpacahq/alpaca-trade-api");
const fs = require("fs");

// Alpaca API keys
const API_KEY = "PKDQTXIA3IPUMEHZDAQ3EPORGE";
const API_SECRET = "BjPuojJSTo548cPH85RpppnpeTZGWor7C9hjKbDCuYHg";

// Create client
const alpaca = new Alpaca({
  keyId: API_KEY,
  secretKey: API_SECRET,
  paper: true,
  feed: "iex",
});

// Get last 30 minutes (UTC)
const endTime = new Date();
const startTime = new Date(endTime.getTime() - 30 * 60 * 1000);

async function fetchAndPlot() {
  const bars = await alpaca.getBarsV2("AAPL", {
    start: startTime.toISOString(),
    end: endTime.toISOString(),
    timeframe: "1Min",
    feed: "iex",
  });

  const data = [];
  for await (const bar of bars) {
    data.push(bar);
  }

  if (data.length === 0) {
    throw new Error("No bar data returned for the last 30 minutes.");
  }

  const time = data.map(b => b.Timestamp);
  const open = data.map(b => b.OpenPrice);
  const high = data.map(b => b.HighPrice);
  const low = data.map(b => b.LowPrice);
  const close = data.map(b => b.ClosePrice);

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>AAPL Intraday Candlestick</title>
  <script src="https://cdn.plot.ly/plotly-latest.min.js"></script>
</head>
<body>
  <div id="chart" style="width:100%;height:100vh;"></div>

  <script>
    const trace = {
      x: ${JSON.stringify(time)},
      open: ${JSON.stringify(open)},
      high: ${JSON.stringify(high)},
      low: ${JSON.stringify(low)},
      close: ${JSON.stringify(close)},
      type: "candlestick"
    };

    const layout = {
      title: "AAPL — Today's Intraday Candlestick Chart",
      xaxis: { rangeslider: { visible: false } }
    };

    Plotly.newPlot("chart", [trace], layout);
  </script>
</body>
</html>
`;

  fs.writeFileSync("today_candles.html", html);
  console.log("✅ Saved today_candles.html");
}

fetchAndPlot().catch(console.error);
