const { ethers } = require('hardhat');
const fs = require('fs');

async function main() {
  const dep = JSON.parse(fs.readFileSync('deployments/localhost.json','utf8'));
  const [admin] = await ethers.getSigners();

  const ttoken = await ethers.getContractAt('TToken', dep.ttoken);
  const router = await ethers.getContractAt('LeveragedProductRouter', dep.leveragedProductRouter);
  const priceFeed = await ethers.getContractAt('PriceFeed', dep.priceFeed);

  const factoryIface = new ethers.Interface([
    'function getProductBySymbol(string productSymbol) view returns (address)'
  ]);
  const factoryCall = factoryIface.encodeFunctionData('getProductBySymbol', ['AAPL3L']);
  const factoryResult = await ethers.provider.call({ to: dep.leveragedTokenFactory, data: factoryCall });
  const [productToken] = factoryIface.decodeFunctionResult('getProductBySymbol', factoryResult);

  const pos = await router.positions(admin.address, productToken);
  const qtyWei = pos.qtyWei;
  const avgEntry = Number(pos.avgEntryPriceCents);

  const [beforePrice] = await priceFeed.getPrice('AAPL');
  const beforePriceCents = Number(beforePrice);
  const bumpPct = 10;
  const nextPriceCents = Math.max(1, Math.round(beforePriceCents * (1 + bumpPct / 100)));
  await (await priceFeed.connect(admin).setPrice('AAPL', nextPriceCents)).wait();

  const [previewOut] = await router.previewUnwind(admin.address, productToken, qtyWei);
  const routerBal = await ttoken.balanceOf(dep.leveragedProductRouter);
  const deficit = previewOut > routerBal ? (previewOut - routerBal) : 0n;

  let directUnwindFailed = false;
  try {
    await router.connect(admin).unwindLong(productToken, qtyWei, 0n);
  } catch (e) {
    directUnwindFailed = true;
  }

  if (deficit > 0n) {
    await (await ttoken.connect(admin).mint(dep.leveragedProductRouter, deficit)).wait();
  }

  const adminBalBefore = await ttoken.balanceOf(admin.address);
  await (await router.connect(admin).unwindLong(productToken, qtyWei, 0n)).wait();
  const adminBalAfter = await ttoken.balanceOf(admin.address);

  console.log('symbol AAPL3L');
  console.log('qtyWei', qtyWei.toString());
  console.log('avgEntryCents', String(avgEntry));
  console.log('priceBeforeCents', String(beforePriceCents));
  console.log('priceAfterCents', String(nextPriceCents));
  console.log('previewOutWei', previewOut.toString());
  console.log('routerBalBeforeWei', routerBal.toString());
  console.log('routerDeficitWei', deficit.toString());
  console.log('directUnwindFailed', String(directUnwindFailed));
  console.log('adminDeltaWei', (adminBalAfter - adminBalBefore).toString());
}

main().catch((e) => { console.error(e); process.exit(1); });
