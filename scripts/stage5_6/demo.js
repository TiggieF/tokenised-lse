





const { ethers } = require("hardhat");

const ONE_SHARE = 10n ** 18n;

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
  const [admin, maker, taker] = await ethers.getSigners();

  const TToken = await ethers.getContractFactory("TToken");
  const ttoken = await TToken.deploy();
  await ttoken.waitForDeployment();

  const ListingsRegistry = await ethers.getContractFactory("ListingsRegistry");
  const registry = await ListingsRegistry.deploy(admin.address);
  await registry.waitForDeployment();

  const PriceFeed = await ethers.getContractFactory("PriceFeed");
  const priceFeed = await PriceFeed.deploy(admin.address, admin.address);
  await priceFeed.waitForDeployment();

  const EquityToken = await ethers.getContractFactory("EquityToken");
  const equity = await EquityToken.deploy("Acme Equity", "AAPL", admin.address, admin.address);
  await equity.waitForDeployment();

  await registry.connect(admin).registerListing("AAPL", "Acme Equity", await equity.getAddress());

  const OrderBookDEX = await ethers.getContractFactory("OrderBookDEX");
  const dex = await OrderBookDEX.deploy(
    await ttoken.getAddress(),
    await registry.getAddress(),
    await priceFeed.getAddress()
  );
  await dex.waitForDeployment();

  const price = 10_000n;
  const maxSlippageBps = 100n; 
  const makerQty = 2n * ONE_SHARE;
  const budget = quoteAmount(ONE_SHARE, price);

  await priceFeed.connect(admin).setPrice("AAPL", Number(price));

  await equity.connect(admin).mint(maker.address, makerQty);
  await ttoken.connect(admin).mint(taker.address, budget);

  await equity.connect(maker).approve(await dex.getAddress(), ethers.MaxUint256);
  await ttoken.connect(taker).approve(await dex.getAddress(), ethers.MaxUint256);

  console.log("TToken:", await ttoken.getAddress());
  console.log("EquityToken:", await equity.getAddress());
  console.log("ListingsRegistry:", await registry.getAddress());
  console.log("PriceFeed:", await priceFeed.getAddress());
  console.log("OrderBookDEX:", await dex.getAddress());
  console.log("Oracle price (cents):", price.toString());
  console.log("Max slippage (bps):", maxSlippageBps.toString());
  console.log("Quote budget (wei):", budget.toString());

  await logBalances("Balances before placing sell", equity, ttoken, await dex.getAddress(), maker, taker);

  const sellTx = await dex.connect(maker).placeLimitOrder(await equity.getAddress(), 1, price, makerQty);
  const sellReceipt = await sellTx.wait();
  console.log("\nSell gas used:", sellReceipt.gasUsed.toString());

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
  console.log("Buy gas used:", buyReceipt.gasUsed.toString());

  await logBalances("Balances after buyExactQuoteAtOracle", equity, ttoken, await dex.getAddress(), maker, taker);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
