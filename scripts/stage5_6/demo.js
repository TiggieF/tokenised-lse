const { ethers } = require("hardhat");

const ONE_SHARE = 10n ** 18n;

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
  const maker = signers[1];
  const taker = signers[2];

  const ttokenFactory = await ethers.getContractFactory("TToken");
  const ttoken = await ttokenFactory.deploy();
  await ttoken.waitForDeployment();

  const registryFactory = await ethers.getContractFactory("ListingsRegistry");
  const registry = await registryFactory.deploy(admin.address);
  await registry.waitForDeployment();

  const priceFeedFactory = await ethers.getContractFactory("PriceFeed");
  const priceFeed = await priceFeedFactory.deploy(admin.address, admin.address);
  await priceFeed.waitForDeployment();

  const equityFactory = await ethers.getContractFactory("EquityToken");
  const equity = await equityFactory.deploy("Acme Equity", "AAPL", admin.address, admin.address);
  await equity.waitForDeployment();

  const equityAddress = await equity.getAddress();
  const registerTx = await registry.connect(admin).registerListing("AAPL", "Acme Equity", equityAddress);
  await registerTx.wait();

  const dexFactory = await ethers.getContractFactory("OrderBookDEX");
  const dex = await dexFactory.deploy(
    await ttoken.getAddress(),
    await registry.getAddress(),
    await priceFeed.getAddress()
  );
  await dex.waitForDeployment();

  const price = 10_000n;
  const maxSlippageBps = 100n;
  const makerQty = 2n * ONE_SHARE;
  const budget = quoteAmount(ONE_SHARE, price);

  const setPriceTx = await priceFeed.connect(admin).setPrice("AAPL", Number(price));
  await setPriceTx.wait();

  const mintMakerTx = await equity.connect(admin).mint(maker.address, makerQty);
  await mintMakerTx.wait();

  const mintTakerTx = await ttoken.connect(admin).mint(taker.address, budget);
  await mintTakerTx.wait();

  const dexAddress = await dex.getAddress();
  const approveMakerTx = await equity.connect(maker).approve(dexAddress, ethers.MaxUint256);
  await approveMakerTx.wait();

  const approveTakerTx = await ttoken.connect(taker).approve(dexAddress, ethers.MaxUint256);
  await approveTakerTx.wait();

  console.log("TToken:", await ttoken.getAddress());
  console.log("EquityToken:", equityAddress);
  console.log("ListingsRegistry:", await registry.getAddress());
  console.log("PriceFeed:", await priceFeed.getAddress());
  console.log("OrderBookDEX:", dexAddress);
  console.log("Oracle price (cents):", price.toString());
  console.log("Max slippage (bps):", maxSlippageBps.toString());
  console.log("Quote budget (wei):", budget.toString());

  await logBalances("Balances before placing sell", equity, ttoken, dexAddress, maker, taker);

  const sellTx = await dex.connect(maker).placeLimitOrder(equityAddress, 1, price, makerQty);
  const sellReceipt = await sellTx.wait();
  console.log("\nSell gas used:", sellReceipt.gasUsed.toString());

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
  console.log("Buy gas used:", buyReceipt.gasUsed.toString());

  await logBalances("Balances after buyExactQuoteAtOracle", equity, ttoken, dexAddress, maker, taker);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
