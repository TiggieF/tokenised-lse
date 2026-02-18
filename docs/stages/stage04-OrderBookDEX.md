# Stage 4 — OrderBookDEX (Detailed Plan)

This document locks Stage 4 design choices and expands the spec into a contract + test checklist.

## Chosen design knobs (confirmed)

- **A — Escrow/Reservation:** **Model 1 (full escrow on placement)**
  - BUY escrows **TToken** upfront.
  - SELL escrows **EquityToken** upfront.
  - Cancel refunds **remaining** escrow.
- **B — Decimals/Units:** **18 decimals everywhere**
  - Treat **TToken** and **EquityToken** as **18‑decimal ERC‑20s**.
- **C — Pair validation:** **Option A**
  - DEX accepts any `equityToken` address (no ListingsRegistry validation in Stage 4).
- **E — Order book storage:** **Unsorted arrays; scan best price each match**
  - Keep per-token `Order[]` arrays per side; matching uses linear scans to enforce price-time priority.
- **F — Safety:** **Reentrancy + CEI + safe transfers**
  - Use `ReentrancyGuard`, checks-effects-interactions discipline, `SafeERC20` transfers.

> **Fee note:** Stage 4 uses **no trading fee**.  
> Rewards are handled in Stage 6 via periodic payouts to the top trader.

---

## 0) Deliverables

- `contracts/OrderBookDEX.sol`
- `test/orderbook-dex.test.js`

---

## 1) Token assumptions and units (18 decimals)

### Decimals
- `TToken.decimals() = 18`
- `EquityToken.decimals() = 18`

### Units
- `qty` is in **equity base units** (18dp). Example: 1.00 share = `1e18`.
- `price` is in **cents per 1.00 share** (2dp). Example: $123.45/share = `12345`.
- All quote transfers are in **TToken base units** (18dp).

### Quote amount formula (core math)
For any fill:
- `ttokenAmount = (fillQty * priceCentsPerShare) / 100`

Example: `fillQty=1e18` (1.00 share), `price=12345` ($123.45)  
`ttokenAmount = 1e18 * 12345 / 100 = 123.45 * 1e18`

**Rounding:** integer division floors by default. Document and test this.

---

## 2) Storage layout

### Order struct
```solidity
enum Side { BUY, SELL }

struct Order {
  uint256 id;
  address trader;
  Side side;
  uint256 price;      // cents per 1.00 share (2dp)
  uint256 qty;        // equity qty (18dp)
  uint256 remaining;  // equity qty (18dp)
  bool active;
}
```

### Books (per equity token)
```solidity
mapping(address => Order[]) public buyOrders;   // equityToken => buy orders
mapping(address => Order[]) public sellOrders;  // equityToken => sell orders
uint256 public nextOrderId;
```

### Optional (recommended): ID → location index
To make cancellation O(1) instead of scanning:
```solidity
struct OrderRef { address equityToken; Side side; uint256 index; }
mapping(uint256 => OrderRef) public orderRefById;
```

---

## 3) Escrow model (Model 1)

### On placement (escrow in)
- **BUY order escrow:**  
  `quote = (qty * price) / 100`  
  Transfer `quote` from trader → DEX at order creation.
- **SELL order escrow:**  
  Transfer `qty` equity units from trader → DEX at order creation.

### On fill (settlement from escrow)
- DEX transfers assets from its escrow balances to maker/taker according to fill qty and match price.
- Reduce `remaining` for both maker and taker.
- If an order reaches `remaining == 0`, set `active = false`.

### On cancel (refund remaining escrow)
- Only refunds the **unfilled** portion:
  - **BUY refund:** `refund = (remaining * price) / 100`
  - **SELL refund:** `refund = remaining` equity units
- Then set `active = false`.

> **Important:** This is exactly why Model 1 is used: cancellation can deterministically “restore remaining volume” because funds are already escrowed in the DEX.

---

## 4) Matching engine (unsorted arrays, scan best each time)

### Eligibility rules
- **Taker BUY** can match **maker SELL** orders with `sell.price <= taker.price`
- **Taker SELL** can match **maker BUY** orders with `buy.price >= taker.price`

### Price-time priority (enforced via scan)
Even with unsorted arrays, you can enforce price-time priority by selecting:
- **Best price** first:
  - For BUY taker: lowest eligible sell price
  - For SELL taker: highest eligible buy price
- **Time priority** within same price:
  - earliest order = lowest array index

### Fill rule (partial fills)
Per match:
- `fillQty = min(taker.remaining, maker.remaining)`
- update both remaining values
- deactivate any order that reaches 0 remaining

### Internal helpers (suggested)
```solidity
function _findBestSell(address equityToken, uint256 maxPrice) internal view returns (bool found, uint256 index);
function _findBestBuy(address equityToken, uint256 minPrice) internal view returns (bool found, uint256 index);
function _quoteAmount(uint256 qty, uint256 price) internal pure returns (uint256) { return (qty * price) / 100; }
```

---

## 5) Fee model

### Definition
- **No trading fee** in Stage 4.
- Rewards are handled in Stage 6 (periodic payout to the top trader).

---

## 6) Public API (functions)

### Constructor / config
- `constructor(address ttoken, address registry, address priceFeed)`

### Core
1) **Place limit order**
- `placeLimitOrder(address equityToken, Side side, uint256 price, uint256 qty) returns (uint256 orderId)`
- Validations:
  - `equityToken != address(0)`
  - `price > 0`, `qty > 0`
  - approvals/allowance sufficient for escrow transfer
- Effects:
  - pull escrow into DEX (Model 1)
  - create order (remaining=qty, active=true)
  - attempt matching immediately
  - leave remainder on book if partially/unfilled

2) **Cancel order**
- `cancelOrder(uint256 orderId)`
- Validations:
  - order exists, `active == true`
  - `msg.sender == order.trader`
- Effects:
  - refund remaining escrow only
  - set `active = false`

### Views (minimum)
- `getBuyOrders(address equityToken) returns (Order[] memory)`
- `getSellOrders(address equityToken) returns (Order[] memory)`
- *(Optional)* `getOrder(uint256 orderId)` (if using `orderRefById` or separate mapping)

---

## 7) Events (recommended)

- `OrderPlaced(id, trader, equityToken, side, price, qty)`
- `OrderFilled(makerId, takerId, equityToken, price, qty)`
- `OrderCancelled(id, trader, remainingRefunded)`

Events will reduce friction in Stage 8 UI and make Stage 4 tests cleaner.

---

## 8) Safety (F)

Minimum hardening for Stage 4:
- `nonReentrant` on `placeLimitOrder` and `cancelOrder`
- `SafeERC20` for transfers
- checks-effects-interactions discipline (update order state before transferring out where possible)
- validate inputs
- avoid unexpected external calls inside loops (ERC-20 transfers are still external calls—keep logic tight)

---

# Stage 4 Test Plan (detailed)

## A) Partial fills
1. Maker SELL 200 @ 10000  
   Taker BUY 100 @ 10000  
   - maker.remaining = 100  
   - taker.remaining = 0; taker inactive/filled

2. Maker SELL 100 @ 10000 (earlier) + Maker SELL 100 @ 10000 (later)  
   Taker BUY 150 @ 10000  
   - consumes earlier order first (FIFO at same price) then the later one

## B) Price-time priority (independent of array order)
Create sells in this order:
- SELL id1: 100 @ 10100
- SELL id2: 100 @ 10000
- SELL id3: 100 @ 10000 (later than id2)

Then BUY 150 @ 10100:
- matches id2 first (better price)
- then id3 (same price, earlier time than id1)
- id1 only if needed afterward

## C) Cancellation restores remaining escrow (including partially filled)
- SELL order qty=200; fill 50; cancel  
  - refund 150 equity units
- BUY order qty=200 @ price; fill 50; cancel  
- refund `(150*price)/100` TToken base units

## D) Balance conservation (system-wide)
Track balances of:
- Maker, Taker, DEX for both tokens

After trades/cancel:
- Total equity conserved across all parties
- Total TToken conserved across all parties

---

## Clarification: what cancellation means (important)

### Can a user cancel an order?
**Yes**, the trader who placed it can cancel it **while it’s still active**.

### Can a user cancel a partially filled order?
**Yes**, but only the **unfilled remainder** is cancellable.

- The **filled portion is final** (already settled).
- Cancellation refunds only the **remaining** escrow and marks the order inactive.
- There is no concept of “cancelling the filled part” because it has already executed and transferred assets.

This matches “Cancel restores remaining volume” precisely.



const token = await ethers.getContractAt("TToken", "0x5FbDB2315678afecb367f032d93F642f64180aa3");
await token.totalSupply();
await token.MAX_SUPPLY();
await token.AIRDROP_AMOUNT();


npx hardhat console --network localhost
const token = await ethers.getContractAt("TToken", "0x5FbDB2315678afecb367f032d93F642f64180aa3");
await token.airdropOnce(); // mints to the console's default signer

//
const token = await ethers.getContractAt("EquityToken", 0x5FbDB2315678afecb367f032d93F642f64180aa3);
await token.mint("YOUR_WALLET", ethers.parseUnits("1000", 18));


const token = await ethers.getContractAt("EquityToken", tokenAddress);
await token.mint("0x90F79bf6EB2c4f870365E785982E1f101E93b906", ethers.parseUnits("1000", 18));



<!-- demo address 0x90F79bf6EB2c4f870365E785982E1f101E93b906 -->


Account #0: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 (10000 ETH)
Private Key: 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

Account #1: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 (10000 ETH)
Private Key: 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d

Account #2: 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC (10000 ETH)
Private Key: 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a

Account #3: 0x90F79bf6EB2c4f870365E785982E1f101E93b906 (10000 ETH)
Private Key: 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6

Account #4: 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65 (10000 ETH)
Private Key: 0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a

Account #5: 0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc (10000 ETH)
Private Key: 0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba

Account #6: 0x976EA74026E726554dB657fA54763abd0C3a0aa9 (10000 ETH)
Private Key: 0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e

Account #7: 0x14dC79964da2C08b23698B3D3cc7Ca32193d9955 (10000 ETH)
Private Key: 0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356

Account #8: 0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f (10000 ETH)
Private Key: 0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97

Account #9: 0xa0Ee7A142d267C1f36714E4a8F75612F20a79720 (10000 ETH)
Private Key: 0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6

Account #10: 0xBcd4042DE499D14e55001CcbB24a551F3b954096 (10000 ETH)
Private Key: 0xf214f2b2cd398c806f84e317254e0f0b801d0643303237d97a22a48e01628897

Account #11: 0x71bE63f3384f5fb98995898A86B02Fb2426c5788 (10000 ETH)
Private Key: 0x701b615bbdfb9de65240bc28bd21bbc0d996645a3dd57e7b12bc2bdf6f192c82

Account #12: 0xFABB0ac9d68B0B445fB7357272Ff202C5651694a (10000 ETH)
Private Key: 0xa267530f49f8280200edf313ee7af6b827f2a8bce2897751d06a843f644967b1

Account #13: 0x1CBd3b2770909D4e10f157cABC84C7264073C9Ec (10000 ETH)
Private Key: 0x47c99abed3324a2707c28affff1267e45918ec8c3f20b8aa892e8b065d2942dd

Account #14: 0xdF3e18d64BC6A983f673Ab319CCaE4f1a57C7097 (10000 ETH)
Private Key: 0xc526ee95bf44d8fc405a158bb884d9d1238d99f0612e9f33d006bb0789009aaa

Account #15: 0xcd3B766CCDd6AE721141F452C550Ca635964ce71 (10000 ETH)
Private Key: 0x8166f546bab6da521a8369cab06c5d2b9e46670292d85c875ee9ec20e84ffb61

Account #16: 0x2546BcD3c84621e976D8185a91A922aE77ECEc30 (10000 ETH)
Private Key: 0xea6c44ac03bff858b476bba40716402b03e41b8e97e276d1baec7c37d42484a0

Account #17: 0xbDA5747bFD65F08deb54cb465eB87D40e51B197E (10000 ETH)
Private Key: 0x689af8efa8c651a91ad287602527f3af2fe9f6501a7ac4b061667b5a93e037fd

Account #18: 0xdD2FD4581271e230360230F9337D5c0430Bf44C0 (10000 ETH)
Private Key: 0xde9be858da4a475276426320d5e9262ecfc3ba460bfac56360bfa6c4c28b4ee0

Account #19: 0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199 (10000 ETH)
Private Key: 0xdf57089febbacf7ba0bc227dafbffa9fc08a93fdc68e1e42411a14efcf23656e
