const { ethers } = require("hardhat");

const ONE_SHARE = 10n ** 18n;
const ONE_TTOKEN = 10n ** 18n;

async function main() {
  const signers = await ethers.getSigners();
  const admin = signers[0];
  const alice = signers[1];
  const bob = signers[2];

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
  const registerTx = await registry.connect(admin).registerListing("ACME1", "Acme Equity", equityAddress);
  await registerTx.wait();

  const dividendsFactory = await ethers.getContractFactory("Dividends");
  const ttokenAddress = await ttoken.getAddress();
  const registryAddress = await registry.getAddress();
  const dividends = await dividendsFactory.deploy(ttokenAddress, registryAddress, admin.address);
  await dividends.waitForDeployment();

  const dividendsAddress = await dividends.getAddress();

  const snapshotRole = await equity.SNAPSHOT_ROLE();
  const grantSnapshotTx = await equity.connect(admin).grantRole(snapshotRole, dividendsAddress);
  await grantSnapshotTx.wait();

  const minterRole = await ttoken.MINTER_ROLE();
  const grantMinterTx = await ttoken.connect(admin).grantRole(minterRole, dividendsAddress);
  await grantMinterTx.wait();

  const aliceMintQty = 2n * ONE_SHARE;
  const bobMintQty = ONE_SHARE;

  const mintAliceTx = await equity.connect(admin).mint(alice.address, aliceMintQty);
  await mintAliceTx.wait();

  const mintBobTx = await equity.connect(admin).mint(bob.address, bobMintQty);
  await mintBobTx.wait();

  const declareTx = await dividends.connect(admin).declareDividendPerShare(equityAddress, ONE_TTOKEN);
  await declareTx.wait();

  const aliceShares = await equity.balanceOf(alice.address);
  const bobShares = await equity.balanceOf(bob.address);

  const alicePreview = await dividends.previewClaim(equityAddress, 1, alice.address);
  const bobPreview = await dividends.previewClaim(equityAddress, 1, bob.address);

  const aliceBefore = await ttoken.balanceOf(alice.address);
  const bobBefore = await ttoken.balanceOf(bob.address);

  const aliceClaimTx = await dividends.connect(alice).claimDividend(equityAddress, 1);
  await aliceClaimTx.wait();

  const bobClaimTx = await dividends.connect(bob).claimDividend(equityAddress, 1);
  await bobClaimTx.wait();

  const aliceAfter = await ttoken.balanceOf(alice.address);
  const bobAfter = await ttoken.balanceOf(bob.address);

  console.log("TToken:", ttokenAddress);
  console.log("EquityToken:", equityAddress);
  console.log("Dividends:", dividendsAddress);
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
