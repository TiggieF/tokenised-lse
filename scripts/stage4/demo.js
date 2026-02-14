const { ethers } = require("hardhat");

const DEFAULT_PRICE = 10_000n;
const ONE_SHARE = 10n ** 18n;

async function main() {
  const signers = await ethers.getSigners();
  const admin = signers[0];
  const seller = signers[1];
  const buyer = signers[2];

  const rawEquityMinterIndex = process.env.EQUITY_MINTER_INDEX || "0";
  const equityMinterIndex = Number.parseInt(rawEquityMinterIndex, 10);

  let equityMinter = admin;
  if (equityMinterIndex >= 0 && equityMinterIndex < signers.length) {
    equityMinter = signers[equityMinterIndex];
  }

  const dexAddress = process.env.DEX_ADDRESS;
  const ttokenAddress = process.env.TTOKEN_ADDRESS;
  const equityAddress = process.env.EQUITY_TOKEN_ADDRESS;

  let price = DEFAULT_PRICE;
  if (process.env.PRICE) {
    price = BigInt(process.env.PRICE);
  }

  let qty = ONE_SHARE;
  if (process.env.QTY) {
    qty = BigInt(process.env.QTY);
  }

  if (!dexAddress) {
    throw new Error("Set DEX_ADDRESS env var");
  }
  if (!ttokenAddress) {
    throw new Error("Set TTOKEN_ADDRESS env var");
  }

  const ttoken = await ethers.getContractAt("TToken", ttokenAddress);
  const dex = await ethers.getContractAt("OrderBookDEX", dexAddress);

  let equity;
  if (equityAddress) {
    equity = await ethers.getContractAt("EquityToken", equityAddress);
  } else {
    const equityFactory = await ethers.getContractFactory("EquityToken");
    equity = await equityFactory.deploy("Acme Equity", "ACME", admin.address, admin.address);
    await equity.waitForDeployment();
    console.log("EquityToken deployed to:", await equity.getAddress());
  }

  const tradeValue = (qty * price) / 100n;

  await equity.connect(equityMinter).mint(seller.address, qty);
  await ttoken.connect(admin).mint(buyer.address, tradeValue);

  await equity.connect(seller).approve(dexAddress, ethers.MaxUint256);
  await ttoken.connect(buyer).approve(dexAddress, ethers.MaxUint256);

  const equityTokenAddress = await equity.getAddress();
  await dex.connect(seller).placeLimitOrder(equityTokenAddress, 1, price, qty);
  await dex.connect(buyer).placeLimitOrder(equityTokenAddress, 0, price, qty);

  const sellerEquity = await equity.balanceOf(seller.address);
  const buyerEquity = await equity.balanceOf(buyer.address);
  const buyerCash = await ttoken.balanceOf(buyer.address);

  console.log("Trade executed.");
  console.log("Seller equity balance:", sellerEquity.toString());
  console.log("Buyer equity balance:", buyerEquity.toString());
  console.log("Buyer TToken balance:", buyerCash.toString());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
