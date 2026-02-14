const { ethers } = require("hardhat");

const ONE_SHARE = 10n ** 18n;

async function fetchFinnhubQuote(symbol, apiKey) {
  const encodedSymbol = encodeURIComponent(symbol);
  const encodedApiKey = encodeURIComponent(apiKey);
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodedSymbol}&token=${encodedApiKey}`;

  const response = await fetch(url, {
    headers: {
      Accept: "application/json,text/plain,*/*",
    },
  });

  if (!response.ok) {
    throw new Error(`Finnhub request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const hasPrice = data && typeof data.c === "number";
  if (!hasPrice) {
    throw new Error("Finnhub response missing price data");
  }

  return data;
}

function quoteAmount(qty, priceCents) {
  return (qty * priceCents) / 100n;
}

async function logBalances(label, equity, ttoken, dexAddr, maker, taker) {
  const makerEquity = await equity.balanceOf(maker.address);
  const takerEquity = await equity.balanceOf(taker.address);
  const dexEquity = await equity.balanceOf(dexAddr);

  const makerCash = await ttoken.balanceOf(maker.address);
  const takerCash = await ttoken.balanceOf(taker.address);
  const dexCash = await ttoken.balanceOf(dexAddr);

  console.log(`\n${label}`);
  console.log("Maker equity:", makerEquity.toString());
  console.log("Taker equity:", takerEquity.toString());
  console.log("DEX equity:", dexEquity.toString());
  console.log("Maker TToken:", makerCash.toString());
  console.log("Taker TToken:", takerCash.toString());
  console.log("DEX TToken:", dexCash.toString());
}

async function main() {
  const signers = await ethers.getSigners();
  const admin = signers[0];
  const maker = signers[5];
  const taker = signers[6];

  const ttokenFactory = await ethers.getContractFactory("TToken");
  const ttoken = await ttokenFactory.deploy();
  await ttoken.waitForDeployment();

  const equityFactory = await ethers.getContractFactory("EquityToken");
  const equity = await equityFactory.deploy("Acme Equity", "AAPL", admin.address, admin.address);
  await equity.waitForDeployment();

  const registryFactory = await ethers.getContractFactory("ListingsRegistry");
  const registry = await registryFactory.deploy(admin.address);
  await registry.waitForDeployment();

  const equityAddress = await equity.getAddress();
  const registerTx = await registry.connect(admin).registerListing("AAPL", "Acme Equity", equityAddress);
  await registerTx.wait();

  const priceFeedFactory = await ethers.getContractFactory("PriceFeed");
  const priceFeed = await priceFeedFactory.deploy(admin.address, admin.address);
  await priceFeed.waitForDeployment();

  const dexFactory = await ethers.getContractFactory("OrderBookDEX");
  const dex = await dexFactory.deploy(
    await ttoken.getAddress(),
    await registry.getAddress(),
    await priceFeed.getAddress()
  );
  await dex.waitForDeployment();

  const apiKey = process.env.FINNHUB_API_KEY || "d4699t1r01qj716fvnmgd4699t1r01qj716fvnn0";
  const finnhubSymbol = "AAPL";
  const quote = await fetchFinnhubQuote(finnhubSymbol, apiKey);

  const price = BigInt(Math.round(quote.c * 100));
  const maxSlippageBps = 100n;
  const makerQty = 2n * ONE_SHARE;
  const budget = quoteAmount(ONE_SHARE, price);

  const setPriceTx = await priceFeed.connect(admin).setPrice("AAPL", Number(price));
  await setPriceTx.wait();

  const mintMakerEquityTx = await equity.connect(admin).mint(maker.address, makerQty);
  await mintMakerEquityTx.wait();

  const mintTakerCashTx = await ttoken.connect(admin).mint(taker.address, budget);
  await mintTakerCashTx.wait();

  const dexAddress = await dex.getAddress();
  const approveMakerTx = await equity.connect(maker).approve(dexAddress, ethers.MaxUint256);
  await approveMakerTx.wait();

  const approveTakerTx = await ttoken.connect(taker).approve(dexAddress, ethers.MaxUint256);
  await approveTakerTx.wait();

  console.log("TToken:", await ttoken.getAddress());
  console.log("EquityToken:", equityAddress);
  console.log("OrderBookDEX:", dexAddress);
  console.log("Oracle price (cents):", price.toString());
  console.log("Oracle source:", `${finnhubSymbol} @ ${quote.c} USD`);
  console.log("Max slippage (bps):", maxSlippageBps.toString());
  console.log("Quote budget (wei):", budget.toString());

  await logBalances("Balances before placing sell", equity, ttoken, dexAddress, maker, taker);

  const sellTx = await dex.connect(maker).placeLimitOrder(equityAddress, 1, price, makerQty);
  const sellReceipt = await sellTx.wait();
  console.log("\nSell order gas used:", sellReceipt.gasUsed.toString());

  await logBalances("Balances before buyExactQuoteAtOracle", equity, ttoken, dexAddress, maker, taker);

  const callResult = await dex
    .connect(taker)
    .buyExactQuoteAtOracle.staticCall(equityAddress, budget, maxSlippageBps);

  const buyTx = await dex
    .connect(taker)
    .buyExactQuoteAtOracle(equityAddress, budget, maxSlippageBps);
  const buyReceipt = await buyTx.wait();

  const qtyBoughtWei = callResult[0];
  const quoteSpentWei = callResult[1];
  const oraclePriceCents = callResult[2];
  const oracleMaxPriceCents = callResult[3];

  console.log("\nOracle buy return:");
  console.log("qtyBoughtWei:", qtyBoughtWei.toString());
  console.log("quoteSpentWei:", quoteSpentWei.toString());
  console.log("oraclePriceCents:", oraclePriceCents.toString());
  console.log("oracleMaxPriceCents:", oracleMaxPriceCents.toString());
  console.log("BuyExactQuoteAtOracle gas used:", buyReceipt.gasUsed.toString());

  await logBalances("Balances after buyExactQuoteAtOracle", equity, ttoken, dexAddress, maker, taker);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
