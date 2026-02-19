const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const ONE_SHARE = 10n ** 18n;
const ONE_TTOKEN = 10n ** 18n;

async function deployDividendsFixture() {
  const signers = await ethers.getSigners();
  const admin = signers[0];
  const alice = signers[1];
  const bob = signers[2];
  const carol = signers[3];

  const ttokenFactory = await ethers.getContractFactory("TToken");
  const ttoken = await ttokenFactory.deploy();
  await ttoken.waitForDeployment();

  const registryFactory = await ethers.getContractFactory("ListingsRegistry");
  const registry = await registryFactory.deploy(admin.address);
  await registry.waitForDeployment();

  const equityFactory = await ethers.getContractFactory("EquityToken");
  const equity = await equityFactory.deploy("Acme Equity", "ACME1", admin.address, admin.address);
  await equity.waitForDeployment();

  const equityAddress = await equity.getAddress();
  await registry.connect(admin).registerListing("ACME1", "Acme Equity", equityAddress);

  const dividendsFactory = await ethers.getContractFactory("Dividends");
  const dividends = await dividendsFactory.deploy(
    await ttoken.getAddress(),
    await registry.getAddress(),
    admin.address
  );
  await dividends.waitForDeployment();

  const dividendsAddress = await dividends.getAddress();
  const snapshotRole = await equity.SNAPSHOT_ROLE();
  await equity.connect(admin).grantRole(snapshotRole, dividendsAddress);

  const minterRole = await ttoken.MINTER_ROLE();
  await ttoken.connect(admin).grantRole(minterRole, dividendsAddress);

  return { admin, alice, bob, carol, ttoken, registry, equity, dividends };
}

describe("Dividends", function () {
  it("uses snapshot balances for claims", async function () {
    const fixture = await loadFixture(deployDividendsFixture);
    const admin = fixture.admin;
    const alice = fixture.alice;
    const bob = fixture.bob;
    const ttoken = fixture.ttoken;
    const equity = fixture.equity;
    const dividends = fixture.dividends;

    const equityAddress = await equity.getAddress();

    await equity.connect(admin).mint(alice.address, 2n * ONE_SHARE);
    await equity.connect(admin).mint(bob.address, ONE_SHARE);

    await dividends.connect(admin).declareDividendPerShare(equityAddress, ONE_TTOKEN);
    await equity.connect(alice).transfer(bob.address, ONE_SHARE);

    await dividends.connect(alice).claimDividend(equityAddress, 1);
    await dividends.connect(bob).claimDividend(equityAddress, 1);

    const aliceBalance = await ttoken.balanceOf(alice.address);
    const bobBalance = await ttoken.balanceOf(bob.address);

    expect(aliceBalance).to.equal(2n * ONE_TTOKEN);
    expect(bobBalance).to.equal(ONE_TTOKEN);
  });

  it("prevents double claims", async function () {
    const fixture = await loadFixture(deployDividendsFixture);
    const admin = fixture.admin;
    const alice = fixture.alice;
    const equity = fixture.equity;
    const dividends = fixture.dividends;

    const equityAddress = await equity.getAddress();

    await equity.connect(admin).mint(alice.address, ONE_SHARE);
    await dividends.connect(admin).declareDividendPerShare(equityAddress, ONE_TTOKEN);

    await dividends.connect(alice).claimDividend(equityAddress, 1);

    await expect(dividends.connect(alice).claimDividend(equityAddress, 1))
      .to.be.revertedWith("dividends: already claimed");
  });

  it("handles zero balance gracefully", async function () {
    const fixture = await loadFixture(deployDividendsFixture);
    const admin = fixture.admin;
    const carol = fixture.carol;
    const equity = fixture.equity;
    const dividends = fixture.dividends;

    const equityAddress = await equity.getAddress();

    await dividends.connect(admin).declareDividendPerShare(equityAddress, ONE_TTOKEN);

    await expect(dividends.connect(carol).claimDividend(equityAddress, 1))
      .to.be.revertedWith("dividends: no balance");
  });

  it("enforces minimum dividend per share", async function () {
    const fixture = await loadFixture(deployDividendsFixture);
    const admin = fixture.admin;
    const equity = fixture.equity;
    const dividends = fixture.dividends;

    const equityAddress = await equity.getAddress();

    await expect(dividends.connect(admin).declareDividendPerShare(equityAddress, 10n ** 15n))
      .to.be.revertedWith("dividends: div per share too small");
  });

  it("uses current balance when a later snapshot has no direct account entry", async function () {
    const fixture = await loadFixture(deployDividendsFixture);
    const admin = fixture.admin;
    const alice = fixture.alice;
    const bob = fixture.bob;
    const ttoken = fixture.ttoken;
    const equity = fixture.equity;
    const dividends = fixture.dividends;

    const equityAddress = await equity.getAddress();

    await equity.connect(admin).mint(alice.address, 3n * ONE_SHARE);

    await dividends.connect(admin).declareDividendPerShare(equityAddress, ONE_TTOKEN);
    await equity.connect(alice).transfer(bob.address, ONE_SHARE);

    await dividends.connect(admin).declareDividendPerShare(equityAddress, ONE_TTOKEN);
    await dividends.connect(alice).claimDividend(equityAddress, 2);

    const aliceBalance = await ttoken.balanceOf(alice.address);
    expect(aliceBalance).to.equal(2n * ONE_TTOKEN);
  });
});
