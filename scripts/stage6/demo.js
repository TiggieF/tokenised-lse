const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

const ONE_SHARE = 10n ** 18n;
const PRICE = 10_000n;

function quoteAmount(qty, priceCents) {
  return (qty * priceCents) / 100n;
}

function loadDeployment() {
  const filePath = path.join(__dirname, "..", "..", "deployments", "localhost.json");
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

async function main() {
  const signers = await ethers.getSigners();
  const admin = signers[0];
  const minter = signers[1];
  const trader5 = signers[5];
  const trader6 = signers[6];
  const trader7 = signers[7];

  const deployment = loadDeployment();
  const dexAddr = deployment.orderBookDex;
  const registryAddr = deployment.listingsRegistry;

  const dex = await ethers.getContractAt("OrderBookDEX", dexAddr);

  const ttokenAddress = await dex.ttoken();
  const ttoken = await ethers.getContractAt("TToken", ttokenAddress);

  const registry = await ethers.getContractAt("ListingsRegistry", registryAddr);
  const equityAddr = await registry.getListing("AAPL");
  const equity = await ethers.getContractAt("EquityToken", equityAddr);

  const awardFactory = await ethers.getContractFactory("Award");
  const award = await awardFactory.deploy(ttokenAddress, admin.address, dexAddr);
  await award.waitForDeployment();

  const awardAddress = await award.getAddress();
  const minterRole = await ttoken.MINTER_ROLE();

  const grantMinterTx = await ttoken.connect(admin).grantRole(minterRole, awardAddress);
  await grantMinterTx.wait();

  const setAwardTx = await dex.connect(admin).setAward(awardAddress);
  await setAwardTx.wait();

  const qty = ONE_SHARE;
  const quote = quoteAmount(qty, PRICE);

  const mint5EquityTx = await equity.connect(minter).mint(trader5.address, 3n * qty);
  await mint5EquityTx.wait();

  const mint6EquityTx = await equity.connect(minter).mint(trader6.address, qty);
  await mint6EquityTx.wait();

  const mint7EquityTx = await equity.connect(minter).mint(trader7.address, qty);
  await mint7EquityTx.wait();

  const mint5CashTx = await ttoken.connect(admin).mint(trader5.address, 3n * quote);
  await mint5CashTx.wait();

  const mint6CashTx = await ttoken.connect(admin).mint(trader6.address, 2n * quote);
  await mint6CashTx.wait();

  const mint7CashTx = await ttoken.connect(admin).mint(trader7.address, 2n * quote);
  await mint7CashTx.wait();

  await (await equity.connect(trader5).approve(dexAddr, ethers.MaxUint256)).wait();
  await (await equity.connect(trader6).approve(dexAddr, ethers.MaxUint256)).wait();
  await (await equity.connect(trader7).approve(dexAddr, ethers.MaxUint256)).wait();
  await (await ttoken.connect(trader5).approve(dexAddr, ethers.MaxUint256)).wait();
  await (await ttoken.connect(trader6).approve(dexAddr, ethers.MaxUint256)).wait();
  await (await ttoken.connect(trader7).approve(dexAddr, ethers.MaxUint256)).wait();

  const epochDuration = await award.EPOCH_DURATION();
  const rewardAmount = await award.REWARD_AMOUNT();

  console.log("DEX:", dexAddr);
  console.log("Award:", awardAddress);
  console.log("Epoch duration (sec):", epochDuration.toString());
  console.log("Reward (wei):", rewardAmount.toString());

  const epoch = await award.currentEpoch();

  await (await dex.connect(trader5).placeLimitOrder(equityAddr, 1, PRICE, qty)).wait();
  await (await dex.connect(trader6).placeLimitOrder(equityAddr, 0, PRICE, qty)).wait();

  await (await dex.connect(trader5).placeLimitOrder(equityAddr, 1, PRICE, qty)).wait();
  await (await dex.connect(trader7).placeLimitOrder(equityAddr, 0, PRICE, qty)).wait();

  await (await dex.connect(trader5).placeLimitOrder(equityAddr, 1, PRICE, qty)).wait();
  await (await dex.connect(trader6).placeLimitOrder(equityAddr, 0, PRICE, qty)).wait();

  await ethers.provider.send("evm_increaseTime", [11]);
  await ethers.provider.send("evm_mine", []);

  const finaliseTx = await award.finalizeEpoch(epoch);
  await finaliseTx.wait();

  const topTrader = await award.topTraderByEpoch(epoch);
  const trader5RewardBalance = await ttoken.balanceOf(trader5.address);

  console.log("Top trader:", topTrader);
  console.log("Trader5 reward balance:", trader5RewardBalance.toString());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
