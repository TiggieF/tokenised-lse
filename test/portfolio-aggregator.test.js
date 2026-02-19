const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const ONE_SHARE = 10n ** 18n;

async function deployAggregatorFixture() {
  const signers = await ethers.getSigners();
  const admin = signers[0];
  const user = signers[1];

  const tokenFactory = await ethers.getContractFactory("TToken");
  const ttoken = await tokenFactory.deploy();
  await ttoken.waitForDeployment();

  const registryFactory = await ethers.getContractFactory("ListingsRegistry");
  const registry = await registryFactory.deploy(admin.address);
  await registry.waitForDeployment();

  const priceFeedFactory = await ethers.getContractFactory("PriceFeed");
  const priceFeed = await priceFeedFactory.deploy(admin.address, admin.address);
  await priceFeed.waitForDeployment();

  const equityFactory = await ethers.getContractFactory("EquityToken");
  const aapl = await equityFactory.deploy("Apple", "AAPL", admin.address, admin.address);
  await aapl.waitForDeployment();

  const tsla = await equityFactory.deploy("Tesla", "TSLA", admin.address, admin.address);
  await tsla.waitForDeployment();

  await registry.connect(admin).registerListing("AAPL", "Apple", await aapl.getAddress());
  await registry.connect(admin).registerListing("TSLA", "Tesla", await tsla.getAddress());

  const aggregatorFactory = await ethers.getContractFactory("PortfolioAggregator");
  const aggregator = await aggregatorFactory.deploy(
    await ttoken.getAddress(),
    await registry.getAddress(),
    await priceFeed.getAddress()
  );
  await aggregator.waitForDeployment();

  return { admin, user, ttoken, priceFeed, aapl, tsla, aggregator };
}

describe("PortfolioAggregator", function () {
  it("returns balances and valuations", async function () {
    const fixture = await loadFixture(deployAggregatorFixture);
    const admin = fixture.admin;
    const user = fixture.user;
    const ttoken = fixture.ttoken;
    const priceFeed = fixture.priceFeed;
    const aapl = fixture.aapl;
    const tsla = fixture.tsla;
    const aggregator = fixture.aggregator;

    await ttoken.connect(admin).mint(user.address, 5n * ONE_SHARE);
    await aapl.connect(admin).mint(user.address, 2n * ONE_SHARE);
    await tsla.connect(admin).mint(user.address, ONE_SHARE);

    await priceFeed.connect(admin).setPrice("AAPL", 10000);
    await priceFeed.connect(admin).setPrice("TSLA", 20000);

    const holdings = await aggregator.getHoldings(user.address);
    expect(holdings).to.have.length(2);

    const total = await aggregator.getTotalValue(user.address);
    expect(total).to.equal(405n * ONE_SHARE);
  });

  it("returns valuation using oracle price", async function () {
    const fixture = await loadFixture(deployAggregatorFixture);
    const admin = fixture.admin;
    const user = fixture.user;
    const priceFeed = fixture.priceFeed;
    const aapl = fixture.aapl;
    const aggregator = fixture.aggregator;

    await aapl.connect(admin).mint(user.address, ONE_SHARE);
    await priceFeed.connect(admin).setPrice("AAPL", 10000);

    await time.increase(61);

    const holdings = await aggregator.getHoldings(user.address);
    expect(holdings[0].priceCents).to.equal(10000);
    expect(holdings[0].valueWei).to.equal(100n * ONE_SHARE);
  });

  it("supports pagination", async function () {
    const fixture = await loadFixture(deployAggregatorFixture);
    const user = fixture.user;
    const aggregator = fixture.aggregator;

    const slice = await aggregator.getHoldingsSlice(user.address, 1, 1);
    expect(slice).to.have.length(1);
  });

  it("returns cash/stock/total summary", async function () {
    const fixture = await loadFixture(deployAggregatorFixture);
    const admin = fixture.admin;
    const user = fixture.user;
    const ttoken = fixture.ttoken;
    const priceFeed = fixture.priceFeed;
    const aapl = fixture.aapl;
    const aggregator = fixture.aggregator;

    await ttoken.connect(admin).mint(user.address, 3n * ONE_SHARE);
    await aapl.connect(admin).mint(user.address, ONE_SHARE);
    await priceFeed.connect(admin).setPrice("AAPL", 20000);

    const summary = await aggregator.getPortfolioSummary(user.address);
    const cash = summary[0];
    const stock = summary[1];
    const total = summary[2];

    expect(cash).to.equal(3n * ONE_SHARE);
    expect(stock).to.equal(200n * ONE_SHARE);
    expect(total).to.equal(203n * ONE_SHARE);
  });
});
