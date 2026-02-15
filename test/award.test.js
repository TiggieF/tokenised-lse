const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const ONE_TTOKEN = 10n ** 18n;

async function deployStage6Fixture() {
  const signers = await ethers.getSigners();
  const admin = signers[0];
  const dexCaller = signers[1];
  const traderA = signers[2];
  const traderB = signers[3];

  const tokenFactory = await ethers.getContractFactory("TToken");
  const ttoken = await tokenFactory.deploy();
  await ttoken.waitForDeployment();

  const awardFactory = await ethers.getContractFactory("Award");
  const award = await awardFactory.deploy(await ttoken.getAddress(), admin.address, dexCaller.address);
  await award.waitForDeployment();

  const minterRole = await ttoken.MINTER_ROLE();
  await ttoken.connect(admin).grantRole(minterRole, await award.getAddress());

  return { admin, dexCaller, traderA, traderB, ttoken, award };
}

describe("Stage 6 — Award", function () {
  it("tracks top trader by volume and rewards once per epoch", async function () {
    const fixture = await loadFixture(deployStage6Fixture);
    const dexCaller = fixture.dexCaller;
    const traderA = fixture.traderA;
    const traderB = fixture.traderB;
    const ttoken = fixture.ttoken;
    const award = fixture.award;

    const epochDuration = Number(await award.EPOCH_DURATION());
    const now = await time.latest();
    const remainder = now % epochDuration;
    let shiftSeconds = 0;

    if (remainder === 0) {
      shiftSeconds = 1;
    } else if (remainder > 1) {
      shiftSeconds = (epochDuration - remainder) + 1;
    }

    if (shiftSeconds > 0) {
      await time.increase(shiftSeconds);
    }

    const epoch = await award.currentEpoch();

    await award.connect(dexCaller).recordTrade(traderA.address, 5n * ONE_TTOKEN);
    await award.connect(dexCaller).recordTrade(traderB.address, 10n * ONE_TTOKEN);
    await award.connect(dexCaller).recordTrade(traderA.address, 6n * ONE_TTOKEN);

    const topTrader = await award.topTraderByEpoch(epoch);
    expect(topTrader).to.equal(traderA.address);

    await time.increase(11);

    await award.finalizeEpoch(epoch);

    const rewardBalance = await ttoken.balanceOf(traderA.address);
    expect(rewardBalance).to.equal(ONE_TTOKEN);

    await expect(award.finalizeEpoch(epoch)).to.be.revertedWith("award: already finalised");
  });

  it("does nothing when no volume", async function () {
    const fixture = await loadFixture(deployStage6Fixture);
    const award = fixture.award;

    const epoch = await award.currentEpoch();
    await time.increase(11);
    await award.finalizeEpoch(epoch);
  });

  it("rejects non-dex reporters", async function () {
    const fixture = await loadFixture(deployStage6Fixture);
    const traderA = fixture.traderA;
    const award = fixture.award;

    await expect(award.connect(traderA).recordTrade(traderA.address, ONE_TTOKEN))
      .to.be.revertedWith("award: only dex");
  });
});
