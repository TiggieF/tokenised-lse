const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

const ONE_SHARE = 10n ** 18n;
const PRICE = 10_000n;

function quoteAmount(qty, priceCents) {
  return (qty * priceCents) / 100n;
}

async function loadDeployment() {
  const filePath = path.join(__dirname, "..", "..", "deployments", "localhost.json");
  const exists = fs.existsSync(filePath);

  if (!exists) {
    throw new Error("Missing deployments/localhost.json. Run stage2 + stage4 deploys first.");
  }

  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

async function logBalances(label, ttoken, equity, dexAddr, seller, buyer) {
  const sellerEquity = await equity.balanceOf(seller.address);
  const buyerEquity = await equity.balanceOf(buyer.address);
  const dexEquity = await equity.balanceOf(dexAddr);
  const sellerCash = await ttoken.balanceOf(seller.address);
  const buyerCash = await ttoken.balanceOf(buyer.address);
  const dexCash = await ttoken.balanceOf(dexAddr);

  console.log(`\n${label}`);
  console.log("Seller equity:", sellerEquity.toString());
  console.log("Buyer equity:", buyerEquity.toString());
  console.log("DEX equity:", dexEquity.toString());
  console.log("Seller TToken:", sellerCash.toString());
  console.log("Buyer TToken:", buyerCash.toString());
  console.log("DEX TToken:", dexCash.toString());
}

async function main() {
  const signers = await ethers.getSigners();
  const admin = signers[0];
  const minter = signers[1];
  const seller = signers[5];
  const buyer = signers[6];

  const deployment = await loadDeployment();
  const dexAddr = deployment.orderBookDex;
  const registryAddr = deployment.listingsRegistry;

  const dex = await ethers.getContractAt("OrderBookDEX", dexAddr);
  const ttokenAddr = await dex.ttoken();
  const ttoken = await ethers.getContractAt("TToken", ttokenAddr);

  const registry = await ethers.getContractAt("ListingsRegistry", registryAddr);
  const equityAddr = await registry.getListing("AAPL");

  if (equityAddr === ethers.ZeroAddress) {
    throw new Error("AAPL not listed. Run scripts/deployStage2.js first.");
  }

  const equity = await ethers.getContractAt("EquityToken", equityAddr);

  const qty = ONE_SHARE;
  const quote = quoteAmount(qty, PRICE);

  await equity.connect(minter).mint(seller.address, qty);
  await ttoken.connect(admin).mint(buyer.address, quote);

  await equity.connect(seller).approve(dexAddr, ethers.MaxUint256);
  await ttoken.connect(buyer).approve(dexAddr, ethers.MaxUint256);

  console.log("OrderBookDEX:", dexAddr);
  console.log("TToken:", ttokenAddr);
  console.log("EquityToken (AAPL):", equityAddr);
  console.log("Seller (acct #5):", seller.address);
  console.log("Buyer (acct #6):", buyer.address);
  console.log("Price (cents):", PRICE.toString());
  console.log("Qty (shares, 18dp):", qty.toString());
  console.log("Quote (TToken wei):", quote.toString());

  await logBalances("Balances before trade", ttoken, equity, dexAddr, seller, buyer);

  const sellTx = await dex.connect(seller).placeLimitOrder(equityAddr, 1, PRICE, qty);
  const sellReceipt = await sellTx.wait();

  const buyTx = await dex.connect(buyer).placeLimitOrder(equityAddr, 0, PRICE, qty);
  const buyReceipt = await buyTx.wait();

  console.log("\nSell gas used:", sellReceipt.gasUsed.toString());
  console.log("Buy gas used:", buyReceipt.gasUsed.toString());

  await logBalances("Balances after trade", ttoken, equity, dexAddr, seller, buyer);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
