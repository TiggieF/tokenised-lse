const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

async function deployPriceFeedFixture() {
  const [admin, otherUser, oracle] = await ethers.getSigners();
  const PriceFeed = await ethers.getContractFactory("PriceFeed");
  const feed = await PriceFeed.deploy(admin.address, oracle.address);
  await feed.waitForDeployment();

  return { feed, admin, otherUser, oracle };
}

describe("Stage 3 — PriceFeed oracle", function () {
  it("defaults freshness window to 60 seconds", async function () {
    const { feed } = await loadFixture(deployPriceFeedFixture);
    expect(await feed.freshnessWindowSeconds()).to.equal(60);
  });

  it("allows admin to update freshness window", async function () {
    const { feed, admin } = await loadFixture(deployPriceFeedFixture);
    await feed.connect(admin).setFreshnessWindow(120);
    expect(await feed.freshnessWindowSeconds()).to.equal(120);
  });

  it("prevents non-admin from updating freshness window", async function () {
    const { feed, otherUser } = await loadFixture(deployPriceFeedFixture);
    await expect(feed.connect(otherUser).setFreshnessWindow(120))
      .to.be.revertedWithCustomError(feed, "AccessControlUnauthorizedAccount")
      .withArgs(otherUser.address, await feed.DEFAULT_ADMIN_ROLE());
  });

  it("allows only oracle role to set price", async function () {
    const { feed, admin, otherUser } = await loadFixture(deployPriceFeedFixture);

    await expect(feed.connect(otherUser).setPrice("ACME1", 12345))
      .to.be.revertedWithCustomError(feed, "AccessControlUnauthorizedAccount")
      .withArgs(otherUser.address, await feed.ORACLE_ROLE());

    await expect(feed.connect(admin).setPrice("ACME1", 12345))
      .to.be.revertedWithCustomError(feed, "AccessControlUnauthorizedAccount")
      .withArgs(admin.address, await feed.ORACLE_ROLE());
  });

  it("stores price and timestamp", async function () {
    const { feed, oracle } = await loadFixture(deployPriceFeedFixture);

    const tx = await feed.connect(oracle).setPrice("ACME1", 2500);
    const receipt = await tx.wait();
    const block = await ethers.provider.getBlock(receipt.blockNumber);

    const [price, timestamp] = await feed.getPrice("ACME1");
    expect(price).to.equal(2500);
    expect(timestamp).to.equal(block.timestamp);
  });

  it("rejects zero prices", async function () {
    const { feed, oracle } = await loadFixture(deployPriceFeedFixture);

    await expect(feed.connect(oracle).setPrice("ACME1", 0))
      .to.be.revertedWith("PriceFeed: price must be > 0");
  });

  it("rejects symbols with lowercase letters", async function () {
    const { feed, oracle } = await loadFixture(deployPriceFeedFixture);

    await expect(feed.connect(oracle).setPrice("Acme1", 1000))
      .to.be.revertedWith("PriceFeed: symbol must be A-Z or 0-9");
  });

  it("reports freshness for recent updates", async function () {
    const { feed, oracle } = await loadFixture(deployPriceFeedFixture);

    await feed.connect(oracle).setPrice("ACME1", 2500);
    expect(await feed.isFresh("ACME1")).to.equal(true);

    await time.increase(61);
    expect(await feed.isFresh("ACME1")).to.equal(false);
  });

  it("respects custom freshness window", async function () {
    const { feed, admin, oracle } = await loadFixture(deployPriceFeedFixture);

    await feed.connect(admin).setFreshnessWindow(10);
    await feed.connect(oracle).setPrice("ACME1", 2500);
    expect(await feed.isFresh("ACME1")).to.equal(true);

    await time.increase(11);
    expect(await feed.isFresh("ACME1")).to.equal(false);
  });
});
