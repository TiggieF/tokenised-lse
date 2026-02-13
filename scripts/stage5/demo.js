







const { ethers } = require("hardhat");

const ONE_SHARE = 10n ** 18n;
const ONE_TTOKEN = 10n ** 18n;

async function main() {
  const [admin, alice, bob] = await ethers.getSigners();

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

  await equity.connect(admin).mint(alice.address, 2n * ONE_SHARE);
  await equity.connect(admin).mint(bob.address, ONE_SHARE);

  await dividends.connect(admin).declareDividendPerShare(await equity.getAddress(), ONE_TTOKEN);

  const aliceShares = await equity.balanceOf(alice.address);
  const bobShares = await equity.balanceOf(bob.address);

  const alicePreview = await dividends.previewClaim(await equity.getAddress(), 1, alice.address);
  const bobPreview = await dividends.previewClaim(await equity.getAddress(), 1, bob.address);

  const aliceBefore = await ttoken.balanceOf(alice.address);
  const bobBefore = await ttoken.balanceOf(bob.address);

  await dividends.connect(alice).claimDividend(await equity.getAddress(), 1);
  await dividends.connect(bob).claimDividend(await equity.getAddress(), 1);

  const aliceAfter = await ttoken.balanceOf(alice.address);
  const bobAfter = await ttoken.balanceOf(bob.address);

  console.log("TToken:", await ttoken.getAddress());
  console.log("EquityToken:", await equity.getAddress());
  console.log("Dividends:", await dividends.getAddress());
  console.log("Dividend per share (wei):", ONE_TTOKEN.toString());
  console.log("Alice equity (shares, 18dp):", aliceShares.toString());
  console.log("Bob equity (shares, 18dp):", bobShares.toString());
  console.log("Alice claim preview (wei):", alicePreview.toString());
  console.log("Bob claim preview (wei):", bobPreview.toString());
  console.log("Alice TToken before:", aliceBefore.toString());
  console.log("Bob TToken before:", bobBefore.toString());
  console.log("Alice TToken after:", aliceAfter.toString());
  console.log("Bob TToken after:", bobAfter.toString());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
