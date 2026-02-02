// scripts/stage5_5/demo.js
// -----------------------------------------------------------------------------
// Stage 5.5 demo: oracle-assisted buyExactQuoteAtOracle with detailed before/after balances + gas used.
// -----------------------------------------------------------------------------

const { ethers } = require("hardhat");

const ONE_SHARE = 10n ** 18n;

async function fetchFinnhubQuote(symbol, apiKey) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(
    symbol
  )}&token=${encodeURIComponent(apiKey)}`;

  const response = await fetch(url, {
    headers: {
      Accept: "application/json,text/plain,*/*",
    },
  });
  if (!response.ok) {
    throw new Error(`Finnhub request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  if (!data || typeof data.c !== "number") {
    throw new Error("Finnhub response missing price data");
  }

  return data;
}

function quoteAmount(qty, priceCents) {
  return (qty * priceCents) / 100n;
}

async function logBalances(label, equity, ttoken, dexAddr, maker, taker) {
  console.log(`\n${label}`);
  console.log("Maker equity:", (await equity.balanceOf(maker.address)).toString());
  console.log("Taker equity:", (await equity.balanceOf(taker.address)).toString());
  console.log("DEX equity:", (await equity.balanceOf(dexAddr)).toString());
  console.log("Maker TToken:", (await ttoken.balanceOf(maker.address)).toString());
  console.log("Taker TToken:", (await ttoken.balanceOf(taker.address)).toString());
  console.log("DEX TToken:", (await ttoken.balanceOf(dexAddr)).toString());
}

async function main() {
  const signers = await ethers.getSigners();
  const admin = signers[0];
  const maker = signers[5]; // account #5
  const taker = signers[6]; // account #6

  const TToken = await ethers.getContractFactory("TToken");
  const ttoken = await TToken.deploy();
  await ttoken.waitForDeployment();

  const EquityToken = await ethers.getContractFactory("EquityToken");
  const equity = await EquityToken.deploy("Acme Equity", "AAPL", admin.address, admin.address);
  await equity.waitForDeployment();

  const ListingsRegistry = await ethers.getContractFactory("ListingsRegistry");
  const registry = await ListingsRegistry.deploy(admin.address);
  await registry.waitForDeployment();

  await registry.connect(admin).registerListing("AAPL", "Acme Equity", await equity.getAddress());

  const PriceFeed = await ethers.getContractFactory("PriceFeed");
  const priceFeed = await PriceFeed.deploy(admin.address, admin.address);
  await priceFeed.waitForDeployment();

  const OrderBookDEX = await ethers.getContractFactory("OrderBookDEX");
  const dex = await OrderBookDEX.deploy(
    await ttoken.getAddress(),
    await registry.getAddress(),
    await priceFeed.getAddress()
  );
  await dex.waitForDeployment();

  const apiKey = process.env.FINNHUB_API_KEY || "d4699t1r01qj716fvnmgd4699t1r01qj716fvnn0";
  const finnhubSymbol = "AAPL";
  const quote = await fetchFinnhubQuote(finnhubSymbol, apiKey);
  const price = BigInt(Math.round(quote.c * 100));
  const maxSlippageBps = 100n; // 1%
  const makerQty = 2n * ONE_SHARE;
  const budget = quoteAmount(ONE_SHARE, price); // budget to buy 1 share

  await priceFeed.connect(admin).setPrice("AAPL", Number(price));

  await equity.connect(admin).mint(maker.address, makerQty);
  await ttoken.connect(admin).mint(taker.address, budget);

  await equity.connect(maker).approve(await dex.getAddress(), ethers.MaxUint256);
  await ttoken.connect(taker).approve(await dex.getAddress(), ethers.MaxUint256);

  console.log("TToken:", await ttoken.getAddress());
  console.log("EquityToken:", await equity.getAddress());
  console.log("OrderBookDEX:", await dex.getAddress());
  console.log("Oracle price (cents):", price.toString());
  console.log("Oracle source:", `${finnhubSymbol} @ ${quote.c} USD`);
  console.log("Max slippage (bps):", maxSlippageBps.toString());
  console.log("Quote budget (wei):", budget.toString());

  await logBalances("Balances before placing sell", equity, ttoken, await dex.getAddress(), maker, taker);

  const sellTx = await dex.connect(maker).placeLimitOrder(await equity.getAddress(), 1, price, makerQty);
  const sellReceipt = await sellTx.wait();
  console.log("\nSell order gas used:", sellReceipt.gasUsed.toString());

  await logBalances("Balances before buyExactQuoteAtOracle", equity, ttoken, await dex.getAddress(), maker, taker);

  const callResult = await dex
    .connect(taker)
    .buyExactQuoteAtOracle.staticCall(await equity.getAddress(), budget, maxSlippageBps);

  const buyTx = await dex
    .connect(taker)
    .buyExactQuoteAtOracle(await equity.getAddress(), budget, maxSlippageBps);
  const buyReceipt = await buyTx.wait();

  console.log("\nOracle buy return:");
  console.log("qtyBoughtWei:", callResult[0].toString());
  console.log("quoteSpentWei:", callResult[1].toString());
  console.log("oraclePriceCents:", callResult[2].toString());
  console.log("oracleMaxPriceCents:", callResult[3].toString());
  console.log("BuyExactQuoteAtOracle gas used:", buyReceipt.gasUsed.toString());

  await logBalances("Balances after buyExactQuoteAtOracle", equity, ttoken, await dex.getAddress(), maker, taker);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
