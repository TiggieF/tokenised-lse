const { ethers } = require('hardhat');
const fs = require('fs');

async function main() {
  const dep = JSON.parse(fs.readFileSync('deployments/localhost.json','utf8'));
  const signers = await ethers.getSigners();
  const ttoken = await ethers.getContractAt('TToken', dep.ttoken);
  const router = await ethers.getContractAt('LeveragedProductRouter', dep.leveragedProductRouter);
  const lfactory = new ethers.Interface([
    'function getProductBySymbol(string productSymbol) view returns (address)'
  ]);

  const data = lfactory.encodeFunctionData('getProductBySymbol',['AAPL3L']);
  const raw = await ethers.provider.call({ to: dep.leveragedTokenFactory, data });
  const [productToken] = lfactory.decodeFunctionResult('getProductBySymbol', raw);

  console.log('productToken', productToken);
  for (let i=0;i<signers.length;i+=1){
    const s=signers[i];
    const pos = await router.positions(s.address, productToken);
    if (pos.qtyWei > 0n) {
      console.log('holder', i, s.address, 'qtyWei', pos.qtyWei.toString(), 'avgEntry', pos.avgEntryPriceCents.toString());
      const preview = await router.previewUnwind(s.address, productToken, pos.qtyWei);
      console.log(' previewOutWei', preview[0].toString());
    }
  }
  const routerBal = await ttoken.balanceOf(dep.leveragedProductRouter);
  console.log('routerTTokenWei', routerBal.toString());
}

main().catch((e) => { console.error(e); process.exit(1); });
