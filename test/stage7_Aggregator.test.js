const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const ONE_SHARE = 10n ** 18n;

async function deployStage7Fixture() {
  const [admin, user] = await ethers.getSigners();

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
  const aapl = await EquityToken.deploy("Apple", "AAPL", admin.address, admin.address);
  await aapl.waitForDeployment();
  const tsla = await EquityToken.deploy("Tesla", "TSLA", admin.address, admin.address);
  await tsla.waitForDeployment();

  await registry.connect(admin).registerListing("AAPL", "Apple", await aapl.getAddress());
  await registry.connect(admin).registerListing("TSLA", "Tesla", await tsla.getAddress());

  const Aggregator = await ethers.getContractFactory("PortfolioAggregator");
  const aggregator = await Aggregator.deploy(
    await ttoken.getAddress(),
    await registry.getAddress(),
    await priceFeed.getAddress()
  );
  await aggregator.waitForDeployment();

  return { admin, user, ttoken, priceFeed, aapl, tsla, aggregator };
}

describe("Stage 7 — PortfolioAggregator", function () {
  it("returns balances and valuations", async function () {
    const { admin, user, ttoken, priceFeed, aapl, tsla, aggregator } = await loadFixture(
      deployStage7Fixture
    );

    await ttoken.connect(admin).mint(user.address, 5n * ONE_SHARE);
    await aapl.connect(admin).mint(user.address, 2n * ONE_SHARE);
    await tsla.connect(admin).mint(user.address, 1n * ONE_SHARE);

    await priceFeed.connect(admin).setPrice("AAPL", 10000);
    await priceFeed.connect(admin).setPrice("TSLA", 20000);

    const holdings = await aggregator.getHoldings(user.address);
    expect(holdings).to.have.length(2);

    const total = await aggregator.getTotalValue(user.address);
    // 5 TToken + (2 * 100) + (1 * 200) = 5 + 200 + 200 = 405 TToken
    expect(total).to.equal(405n * ONE_SHARE);
  });

  it("returns valuation using oracle price", async function () {
    const { admin, user, priceFeed, aapl, aggregator } = await loadFixture(deployStage7Fixture);

    await aapl.connect(admin).mint(user.address, ONE_SHARE);
    await priceFeed.connect(admin).setPrice("AAPL", 10000);
    await time.increase(61);

    const holdings = await aggregator.getHoldings(user.address);
    expect(holdings[0].priceCents).to.equal(10000);
    expect(holdings[0].valueWei).to.equal(100n * ONE_SHARE);
  });

  it("supports pagination", async function () {
    const { user, aggregator } = await loadFixture(deployStage7Fixture);
    const slice = await aggregator.getHoldingsSlice(user.address, 1, 1);
    expect(slice).to.have.length(1);
  });

  it("returns cash/stock/total summary", async function () {
    const { admin, user, ttoken, priceFeed, aapl, aggregator } = await loadFixture(
      deployStage7Fixture
    );

    await ttoken.connect(admin).mint(user.address, 3n * ONE_SHARE);
    await aapl.connect(admin).mint(user.address, ONE_SHARE);
    await priceFeed.connect(admin).setPrice("AAPL", 20000);

    const [cash, stock, total] = await aggregator.getPortfolioSummary(user.address);
    expect(cash).to.equal(3n * ONE_SHARE);
    expect(stock).to.equal(200n * ONE_SHARE);
    expect(total).to.equal(203n * ONE_SHARE);
  });
});
