const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

async function deployPriceFeedFixture() {
  const signers = await ethers.getSigners();
  const admin = signers[0];
  const otherUser = signers[1];
  const oracle = signers[2];

  const feedFactory = await ethers.getContractFactory("PriceFeed");
  const feed = await feedFactory.deploy(admin.address, oracle.address);
  await feed.waitForDeployment();

  return { feed, admin, otherUser, oracle };
}

const describeLocal = network.name === "hardhat" ? describe : describe.skip;

describeLocal("PriceFeed oracle", function () {
  it("defaults freshness window to 60 seconds", async function () {
    const fixture = await loadFixture(deployPriceFeedFixture);
    const feed = fixture.feed;

    const freshnessWindow = await feed.freshnessWindowSeconds();
    expect(freshnessWindow).to.equal(60);
  });

  it("allows admin to update freshness window", async function () {
    const fixture = await loadFixture(deployPriceFeedFixture);
    const feed = fixture.feed;
    const admin = fixture.admin;

    await feed.connect(admin).setFreshnessWindow(120);

    const freshnessWindow = await feed.freshnessWindowSeconds();
    expect(freshnessWindow).to.equal(120);
  });

  it("prevents non-admin from updating freshness window", async function () {
    const fixture = await loadFixture(deployPriceFeedFixture);
    const feed = fixture.feed;
    const otherUser = fixture.otherUser;

    const adminRole = await feed.DEFAULT_ADMIN_ROLE();

    await expect(feed.connect(otherUser).setFreshnessWindow(120))
      .to.be.revertedWithCustomError(feed, "AccessControlUnauthorizedAccount")
      .withArgs(otherUser.address, adminRole);
  });

  it("allows only oracle role to set price", async function () {
    const fixture = await loadFixture(deployPriceFeedFixture);
    const feed = fixture.feed;
    const admin = fixture.admin;
    const otherUser = fixture.otherUser;

    const oracleRole = await feed.ORACLE_ROLE();

    await expect(feed.connect(otherUser).setPrice("ACME1", 12345))
      .to.be.revertedWithCustomError(feed, "AccessControlUnauthorizedAccount")
      .withArgs(otherUser.address, oracleRole);

    await expect(feed.connect(admin).setPrice("ACME1", 12345))
      .to.be.revertedWithCustomError(feed, "AccessControlUnauthorizedAccount")
      .withArgs(admin.address, oracleRole);
  });

  it("stores price and timestamp", async function () {
    const fixture = await loadFixture(deployPriceFeedFixture);
    const feed = fixture.feed;
    const oracle = fixture.oracle;

    const tx = await feed.connect(oracle).setPrice("ACME1", 2500);
    const receipt = await tx.wait();
    const block = await ethers.provider.getBlock(receipt.blockNumber);

    const priceData = await feed.getPrice("ACME1");
    const price = priceData[0];
    const timestamp = priceData[1];

    expect(price).to.equal(2500);
    expect(timestamp).to.equal(block.timestamp);
  });

  it("rejects zero prices", async function () {
    const fixture = await loadFixture(deployPriceFeedFixture);
    const feed = fixture.feed;
    const oracle = fixture.oracle;

    await expect(feed.connect(oracle).setPrice("ACME1", 0))
      .to.be.revertedWith("pricefeed: price must be > 0");
  });

  it("rejects symbols with lowercase letters", async function () {
    const fixture = await loadFixture(deployPriceFeedFixture);
    const feed = fixture.feed;
    const oracle = fixture.oracle;

    await expect(feed.connect(oracle).setPrice("Acme1", 1000))
      .to.be.revertedWith("symbol must be upper-case or 0-9");
  });

  it("reports freshness for recent updates", async function () {
    const fixture = await loadFixture(deployPriceFeedFixture);
    const feed = fixture.feed;
    const oracle = fixture.oracle;

    await feed.connect(oracle).setPrice("ACME1", 2500);

    const freshNow = await feed.isFresh("ACME1");
    expect(freshNow).to.equal(true);

    await time.increase(61);

    const freshLater = await feed.isFresh("ACME1");
    expect(freshLater).to.equal(false);
  });

  it("respects custom freshness window", async function () {
    const fixture = await loadFixture(deployPriceFeedFixture);
    const feed = fixture.feed;
    const admin = fixture.admin;
    const oracle = fixture.oracle;

    await feed.connect(admin).setFreshnessWindow(10);
    await feed.connect(oracle).setPrice("ACME1", 2500);

    const freshNow = await feed.isFresh("ACME1");
    expect(freshNow).to.equal(true);

    await time.increase(11);

    const freshLater = await feed.isFresh("ACME1");
    expect(freshLater).to.equal(false);
  });
});
