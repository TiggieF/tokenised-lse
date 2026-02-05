const express = require("express");
const path = require("path");
const YahooFinance = require("yahoo-finance2").default;

const app = express();
const yahooFinance = new YahooFinance();

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/stock/:symbol", async (req, res) => {
  const symbol = req.params.symbol || "AAPL";

  try {
    const data = await yahooFinance.quoteSummary(symbol, {
      modules: [
        "price",
        "summaryDetail",
        "financialData",
        "majorHoldersBreakdown",
        "institutionOwnership",
        "fundOwnership",
        "insiderHolders",
        "insiderTransactions"
      ]
    });

    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch data" });
  }
});

const PORT = 3000;
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
