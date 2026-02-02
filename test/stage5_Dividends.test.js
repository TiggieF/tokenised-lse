const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const ONE_SHARE = 10n ** 18n;
const ONE_TTOKEN = 10n ** 18n;

async function deployStage5Fixture() {
  const [admin, alice, bob, carol] = await ethers.getSigners();

  const TToken = await ethers.getContractFactory("TToken");
  const ttoken = await TToken.deploy();
  await ttoken.waitForDeployment();

  const ListingsRegistry = await ethers.getContractFactory("ListingsRegistry");
  const registry = await ListingsRegistry.deploy(admin.address);
  await registry.waitForDeployment();

  const EquityToken = await ethers.getContractFactory("EquityToken");
  const equity = await EquityToken.deploy("Acme Equity", "ACME1", admin.address, admin.address);
  await equity.waitForDeployment();

  await registry.connect(admin).registerListing("ACME1", "Acme Equity", await equity.getAddress());

  const Dividends = await ethers.getContractFactory("Dividends");
  const dividends = await Dividends.deploy(await ttoken.getAddress(), await registry.getAddress(), admin.address);
  await dividends.waitForDeployment();

  const snapshotRole = await equity.SNAPSHOT_ROLE();
  await equity.connect(admin).grantRole(snapshotRole, await dividends.getAddress());

  const minterRole = await ttoken.MINTER_ROLE();
  await ttoken.connect(admin).grantRole(minterRole, await dividends.getAddress());

  return { admin, alice, bob, carol, ttoken, registry, equity, dividends };
}

describe("Stage 5 — Dividends", function () {
  it("uses snapshot balances for claims", async function () {
    const { admin, alice, bob, ttoken, equity, dividends } = await loadFixture(deployStage5Fixture);

    await equity.connect(admin).mint(alice.address, 2n * ONE_SHARE);
    await equity.connect(admin).mint(bob.address, ONE_SHARE);

    await dividends.connect(admin).declareDividendPerShare(await equity.getAddress(), ONE_TTOKEN);

    await equity.connect(alice).transfer(bob.address, ONE_SHARE);

    await dividends.connect(alice).claimDividend(await equity.getAddress(), 1);
    await dividends.connect(bob).claimDividend(await equity.getAddress(), 1);

    expect(await ttoken.balanceOf(alice.address)).to.equal(2n * ONE_TTOKEN);
    expect(await ttoken.balanceOf(bob.address)).to.equal(ONE_TTOKEN);
  });

  it("prevents double claims", async function () {
    const { admin, alice, equity, dividends } = await loadFixture(deployStage5Fixture);

    await equity.connect(admin).mint(alice.address, ONE_SHARE);
    await dividends.connect(admin).declareDividendPerShare(await equity.getAddress(), ONE_TTOKEN);

    await dividends.connect(alice).claimDividend(await equity.getAddress(), 1);

    await expect(dividends.connect(alice).claimDividend(await equity.getAddress(), 1))
      .to.be.revertedWith("Dividends: already claimed");
  });

  it("handles zero balance gracefully", async function () {
    const { admin, carol, equity, dividends } = await loadFixture(deployStage5Fixture);

    await dividends.connect(admin).declareDividendPerShare(await equity.getAddress(), ONE_TTOKEN);

    await expect(dividends.connect(carol).claimDividend(await equity.getAddress(), 1))
      .to.be.revertedWith("Dividends: no balance");
  });

  it("enforces minimum dividend per share", async function () {
    const { admin, equity, dividends } = await loadFixture(deployStage5Fixture);

    await expect(
      dividends.connect(admin).declareDividendPerShare(await equity.getAddress(), 10n ** 15n)
    ).to.be.revertedWith("Dividends: div per share too small");
  });
});
