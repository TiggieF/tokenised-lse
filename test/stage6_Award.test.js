const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const ONE_TTOKEN = 10n ** 18n;

async function deployStage6Fixture() {
  const [admin, dexCaller, traderA, traderB] = await ethers.getSigners();

  const TToken = await ethers.getContractFactory("TToken");
  const ttoken = await TToken.deploy();
  await ttoken.waitForDeployment();

  const Award = await ethers.getContractFactory("Award");
  const award = await Award.deploy(await ttoken.getAddress(), admin.address, dexCaller.address);
  await award.waitForDeployment();

  const minterRole = await ttoken.MINTER_ROLE();
  await ttoken.connect(admin).grantRole(minterRole, await award.getAddress());

  return { admin, dexCaller, traderA, traderB, ttoken, award };
}

describe("Stage 6 — Award", function () {
  it("tracks top trader by volume and rewards once per epoch", async function () {
    const { dexCaller, traderA, traderB, ttoken, award } = await loadFixture(deployStage6Fixture);

    const epoch = await award.currentEpoch();

    await award.connect(dexCaller).recordTrade(traderA.address, 5n * ONE_TTOKEN);
    await award.connect(dexCaller).recordTrade(traderB.address, 10n * ONE_TTOKEN);
    await award.connect(dexCaller).recordTrade(traderA.address, 6n * ONE_TTOKEN);

    expect(await award.topTraderByEpoch(epoch)).to.equal(traderA.address);

    await time.increase(11);

    await award.finalizeEpoch(epoch);
    expect(await ttoken.balanceOf(traderA.address)).to.equal(ONE_TTOKEN);

    await expect(award.finalizeEpoch(epoch)).to.be.revertedWith("award: already finalised");
  });

  it("does nothing when no volume", async function () {
    const { award } = await loadFixture(deployStage6Fixture);
    const epoch = await award.currentEpoch();

    await time.increase(11);
    await award.finalizeEpoch(epoch);
  });

  it("rejects non-dex reporters", async function () {
    const { traderA, award } = await loadFixture(deployStage6Fixture);
    await expect(award.connect(traderA).recordTrade(traderA.address, ONE_TTOKEN))
      .to.be.revertedWith("award: only dex");
  });
});
