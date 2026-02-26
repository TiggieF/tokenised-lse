const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

function readDeploymentsForNetwork(name) {
  const file = path.join(__dirname, "..", "deployments", `${name}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`missing deployments file: ${file}`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

describe("Sepolia smoke checks", function () {
  this.timeout(120000);

  let dep;
  let ttoken;
  let registry;
  let priceFeed;
  let dex;
  let dividends;
  let dividendsMerkle;
  let leveragedFactory;
  let leveragedRouter;
  let award;
  let aggregator;

  before(async function () {
    if (network.name !== "sepolia") {
      this.skip();
    }

    dep = readDeploymentsForNetwork("sepolia");

    ttoken = await ethers.getContractAt("TToken", dep.ttoken);
    registry = await ethers.getContractAt("ListingsRegistry", dep.listingsRegistry);
    priceFeed = await ethers.getContractAt("PriceFeed", dep.priceFeed);
    dex = await ethers.getContractAt("OrderBookDEX", dep.orderBookDex);
    dividends = await ethers.getContractAt("Dividends", dep.dividends);
    dividendsMerkle = await ethers.getContractAt("DividendsMerkle", dep.dividendsMerkle);
    leveragedFactory = await ethers.getContractAt("LeveragedTokenFactory", dep.leveragedTokenFactory);
    leveragedRouter = await ethers.getContractAt("LeveragedProductRouter", dep.leveragedProductRouter);
    award = await ethers.getContractAt("Award", dep.award);
    aggregator = await ethers.getContractAt("PortfolioAggregator", dep.portfolioAggregator);
  });

  it("has bytecode at each deployed contract address", async function () {
    const contractAddresses = [
      dep.ttoken,
      dep.listingsRegistry,
      dep.priceFeed,
      dep.orderBookDex,
      dep.dividends,
      dep.dividendsMerkle,
      dep.leveragedTokenFactory,
      dep.leveragedProductRouter,
      dep.award,
      dep.portfolioAggregator,
    ];

    for (let i = 0; i < contractAddresses.length; i += 1) {
      const address = contractAddresses[i];
      const code = await ethers.provider.getCode(address);
      expect(code).to.not.equal("0x");
    }
  });

  it("loads registry symbols and listing contracts", async function () {
    const symbols = await registry.getAllSymbols();
    expect(symbols.length).to.be.greaterThan(0);

    for (let i = 0; i < symbols.length; i += 1) {
      const symbol = symbols[i];
      const tokenAddress = await registry.getListing(symbol);
      expect(tokenAddress).to.not.equal(ethers.ZeroAddress);
      const mappedSymbol = await registry.getSymbolByToken(tokenAddress);
      expect(mappedSymbol).to.equal(symbol);
    }
  });

  it("returns live/stored prices for listed symbols", async function () {
    const symbols = await registry.getAllSymbols();
    const sampleSize = Math.min(3, symbols.length);
    expect(sampleSize).to.be.greaterThan(0);

    for (let i = 0; i < sampleSize; i += 1) {
      const symbol = symbols[i];
      const [priceCents, timestamp] = await priceFeed.getPrice(symbol);
      expect(priceCents).to.be.greaterThan(0n);
      expect(timestamp).to.be.greaterThan(0n);
    }
  });

  it("exposes orderbook and token state", async function () {
    const symbols = await registry.getAllSymbols();
    const symbol = symbols[0];
    const tokenAddress = await registry.getListing(symbol);

    const nextOrderId = await dex.nextOrderId();
    expect(nextOrderId).to.be.greaterThan(0n);

    const sellOrders = await dex.getSellOrders(tokenAddress);
    const buyOrders = await dex.getBuyOrders(tokenAddress);
    expect(Array.isArray(sellOrders)).to.equal(true);
    expect(Array.isArray(buyOrders)).to.equal(true);

    const totalSupply = await ttoken.totalSupply();
    expect(totalSupply).to.be.greaterThan(0n);
  });

  it("exposes leveraged products and quote previews", async function () {
    const count = await leveragedFactory.productCount();
    expect(count).to.be.greaterThan(0n);

    const first = await leveragedFactory.getProductAt(0n);
    expect(first.token).to.not.equal(ethers.ZeroAddress);
    expect(Number(first.leverage)).to.be.greaterThan(0);

    const oneTToken = 10n ** 18n;
    const preview = await leveragedRouter.previewMint(first.token, oneTToken);
    const productOutWei = preview[0];
    const navCents = preview[1];
    expect(productOutWei).to.be.greaterThan(0n);
    expect(navCents).to.be.greaterThan(0n);
  });

  it("returns dividends and merkle epochs without reverting", async function () {
    const symbols = await registry.getAllSymbols();
    const symbol = symbols[0];
    const tokenAddress = await registry.getListing(symbol);

    const epochCount = await dividends.epochCount(tokenAddress);
    expect(epochCount).to.be.greaterThanOrEqual(0n);

    const merkleCount = await dividendsMerkle.merkleEpochCount();
    expect(merkleCount).to.be.greaterThanOrEqual(0n);

    if (merkleCount > 0n) {
      const epoch = await dividendsMerkle.getEpoch(merkleCount);
      expect(epoch.equityToken).to.not.equal(ethers.ZeroAddress);
      expect(epoch.merkleRoot).to.not.equal(ethers.ZeroHash);
    }
  });

  it("returns award and portfolio summary data", async function () {
    const epochDuration = await award.EPOCH_DURATION();
    const rewardAmount = await award.REWARD_AMOUNT();
    const currentEpoch = await award.currentEpoch();

    expect(epochDuration).to.equal(60n);
    expect(rewardAmount).to.equal(100n * 10n ** 18n);
    expect(currentEpoch).to.be.greaterThan(0n);

    const wallet = dep.admin;
    const summary = await aggregator.getPortfolioSummary(wallet);
    expect(summary[0]).to.be.greaterThanOrEqual(0n);
    expect(summary[1]).to.be.greaterThanOrEqual(0n);
    expect(summary[2]).to.equal(summary[0] + summary[1]);
  });
});
