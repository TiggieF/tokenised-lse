
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

interface IPriceFeed {
    // declares pricefeed interface
    function getPrice(string memory symbol)
        external
        view
        returns (
            uint256 priceCents,
            uint256 timestamp
        );

    function isFresh(string memory symbol)
        external
        view
        returns (bool);
}

interface IListingsRegistry {
    function getSymbolByToken(address token)
        external
        view
        returns (string memory);
}

interface IAward {
    function recordTradeQty(address trader, uint256 qtyWei)
        external;
}


contract OrderBookDEX is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Side {
        BUY,
        SELL
        // custom type for buy and sell order
    }

    struct Order {
        uint256 id;
        address trader;
        Side side;
        uint256 price; 
        uint256 qty; 
        uint256 remaining; 
        bool active;
    }

    struct OrderRef {
        address equityToken;
        Side side;
        uint256 index;
        // order refernce
    }

    IERC20 public immutable ttoken;
    IListingsRegistry public immutable registry;
    IPriceFeed public immutable priceFeed;
    uint256 public nextOrderId;
    IAward public award;

    mapping(address => Order[]) public buyOrders;
    // order book for buy and sell
    mapping(address => Order[]) public sellOrders;
    mapping(uint256 => OrderRef) public orderRefById;
    // mapping order

    event OrderPlaced(
        uint256 indexed id,
        address indexed trader,
        address indexed equityToken,
        Side side,
        uint256 price,
        uint256 qty
    );
    event OrderFilled(
        uint256 indexed makerId,
        uint256 indexed takerId,
        address indexed equityToken,
        uint256 price,
        uint256 qty
    );
    event QuoteBuyExecuted(
        address indexed taker,
        address indexed equityToken,
        uint256 quoteBudgetWei,
        uint256 quoteSpentWei,
        uint256 qtyBoughtWei,
        uint256 maxPriceCents
    );
    event OracleQuoteBuyExecuted(
        // event for oracle buy which calls the oracle with and set as max price
        address indexed taker,
        address indexed equityToken,
        string symbol,
        uint256 quoteBudgetWei,
        uint256 quoteSpentWei,
        uint256 qtyBoughtWei,
        uint256 oraclePriceCents,
        uint256 oracleMaxPriceCents,
        uint256 maxSlippageBps
    );
    event AwardUpdated(address indexed previousAward, address indexed newAward);
    event OrderCancelled(uint256 indexed id, address indexed trader, uint256 remainingRefunded);

    constructor(address ttokenAddress, address registryAddress, address priceFeedAddress) {
        require(ttokenAddress != address(0), "orderbook: ttoken is zero");
        require(registryAddress != address(0), "orderbook: registry is zero");
        require(priceFeedAddress != address(0), "orderbook: pricefeed is zero");
        // checks all address
        ttoken = IERC20(ttokenAddress);
        registry = IListingsRegistry(registryAddress);
        priceFeed = IPriceFeed(priceFeedAddress);
        nextOrderId = 1;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    function setAward(address awardAddress) external onlyRole(DEFAULT_ADMIN_ROLE) {
        emit AwardUpdated(address(award), awardAddress);
        award = IAward(awardAddress);
    }

    function placeLimitOrder(
        address equityToken,
        Side side,
        uint256 price,
        uint256 qty
    ) external nonReentrant returns (uint256 orderId) {
        require(equityToken != address(0), "orderbook: equity token is zero");
        require(price > 0, "orderbook: price must be > 0");
        require(qty > 0, "orderbook: qty must be > 0");

        if (side == Side.BUY) {
            uint256 quote = quoteAmount(qty, price);
            ttoken.safeTransferFrom(msg.sender, address(this), quote);
        } else {
            IERC20(equityToken).safeTransferFrom(msg.sender, address(this), qty);
        }

        orderId = nextOrderId++;
        Order memory order =
            Order({ id: orderId, trader: msg.sender, side: side, price: price, qty: qty, remaining: qty, active: true });

        if (side == Side.BUY) {
            buyOrders[equityToken].push(order);
            orderRefById[orderId] = OrderRef({ equityToken: equityToken, side: side, index: buyOrders[equityToken].length - 1 });
        } else {
            sellOrders[equityToken].push(order);
            orderRefById[orderId] = OrderRef({ equityToken: equityToken, side: side, index: sellOrders[equityToken].length - 1 });
        }

        emit OrderPlaced(orderId, msg.sender, equityToken, side, price, qty);

        matchOrder(equityToken, side, orderId);
    }

    function buyExactQuote(address equityToken, uint256 quoteWei, uint256 maxPriceCents)
        external
        nonReentrant
        returns (uint256 qtyBoughtWei, uint256 quoteSpentWei)
    {
        (qtyBoughtWei, quoteSpentWei) = buyExactQuoteInternal(
            msg.sender,
            equityToken,
            quoteWei,
            maxPriceCents
        );
        emit QuoteBuyExecuted(msg.sender, equityToken, quoteWei, quoteSpentWei, qtyBoughtWei, maxPriceCents);
    }

    function buyExactQuoteAtOracle(
        address equityToken,
        uint256 quoteWei,
        uint256 maxSlippageBps
    )
        external
        nonReentrant
        returns (
            uint256 qtyBoughtWei,
            uint256 quoteSpentWei,
            uint256 oraclePriceCents,
            uint256 oracleMaxPriceCents
        )
    {
        require(maxSlippageBps <= 5000, "orderbook: slippage too high");

        string memory symbol = registry.getSymbolByToken(equityToken);
        require(bytes(symbol).length > 0, "orderbook: unknown token");
        require(priceFeed.isFresh(symbol), "orderbook: stale price");

        (oraclePriceCents, ) = priceFeed.getPrice(symbol);
        require(oraclePriceCents > 0, "orderbook: bad price");

        oracleMaxPriceCents = Math.mulDiv(oraclePriceCents, 10000 + maxSlippageBps, 10000);

        (qtyBoughtWei, quoteSpentWei) = buyExactQuoteInternal(
            msg.sender,
            equityToken,
            quoteWei,
            oracleMaxPriceCents
        );

        emit OracleQuoteBuyExecuted(
            msg.sender,
            equityToken,
            symbol,
            quoteWei,
            quoteSpentWei,
            qtyBoughtWei,
            oraclePriceCents,
            oracleMaxPriceCents,
            maxSlippageBps
        );
    }

    function buyExactQuoteInternal(
        address taker,
        address equityToken,
        uint256 quoteWei,
        uint256 maxPriceCents
    ) internal returns (uint256 qtyBoughtWei, uint256 quoteSpentWei) {
        require(equityToken != address(0), "orderbook: equity token is zero");
        require(quoteWei > 0, "orderbook: quote must be > 0");
        require(maxPriceCents > 0, "orderbook: max price must be > 0");

        ttoken.safeTransferFrom(taker, address(this), quoteWei);

        uint256 remainingQuote = quoteWei;

        while (remainingQuote > 0) {
            (bool found, uint256 index) = findBestSell(equityToken, maxPriceCents, taker);
            if (!found) {
                break;
            }

            Order storage maker = sellOrders[equityToken][index];
            uint256 maxQtyWei = (remainingQuote * 100) / maker.price;
            if (maxQtyWei == 0) {
                break;
            }

            uint256 fillQty = maxQtyWei;
            if (maker.remaining < fillQty) {
                fillQty = maker.remaining;
            }
            uint256 tradeQuote = quoteAmount(fillQty, maker.price);

            remainingQuote -= tradeQuote;
            qtyBoughtWei += fillQty;

            maker.remaining -= fillQty;
            if (maker.remaining == 0) {
                maker.active = false;
            }

            IERC20(equityToken).safeTransfer(taker, fillQty);
            ttoken.safeTransfer(maker.trader, tradeQuote);
            recordTradeQty(maker.trader, fillQty);
            recordTradeQty(taker, fillQty);

            emit OrderFilled(maker.id, 0, equityToken, maker.price, fillQty);
        }

        if (qtyBoughtWei == 0) {
            revert("orderbook: no fill");
        }

        quoteSpentWei = quoteWei - remainingQuote;
        if (remainingQuote > 0) {
            ttoken.safeTransfer(taker, remainingQuote);
        }
    }

    function cancelOrder(uint256 orderId) external nonReentrant {
        OrderRef memory ref = orderRefById[orderId];
        require(ref.equityToken != address(0), "orderbook: order not found");
        Order storage order = getOrderStorage(ref);

        require(order.active, "orderbook: order inactive");
        require(order.trader == msg.sender, "orderbook: not order owner");

        order.active = false;
        uint256 refundAmount;

        if (order.side == Side.BUY) {
            uint256 quote = quoteAmount(order.remaining, order.price);
            refundAmount = quote;
            ttoken.safeTransfer(order.trader, refundAmount);
        } else {
            refundAmount = order.remaining;
            IERC20(ref.equityToken).safeTransfer(order.trader, refundAmount);
        }

        order.remaining = 0;
        emit OrderCancelled(orderId, msg.sender, refundAmount);
    }

    function getBuyOrders(address equityToken) external view returns (Order[] memory) {
        return buyOrders[equityToken];
    }

    function getSellOrders(address equityToken) external view returns (Order[] memory) {
        return sellOrders[equityToken];
    }

    function matchOrder(address equityToken, Side takerSide, uint256 takerId) internal {
        Order storage taker = getOrderStorage(orderRefById[takerId]);
        if (!taker.active) {
            return;
        }

        if (takerSide == Side.BUY) {
            matchBuy(equityToken, taker);
        } else {
            matchSell(equityToken, taker);
        }
    }

    function matchBuy(address equityToken, Order storage taker) internal {
        // matching engine
        while (taker.remaining > 0) {
            // while not fulling filled
            (bool found, uint256 index) = findBestSell(equityToken, taker.price, taker.trader);
            // find the best sell
            if (!found) {
                break;
                // not found break
            }
            Order storage maker = sellOrders[equityToken][index];
            uint256 fillQty = taker.remaining;
            if (maker.remaining < fillQty) {
                fillQty = maker.remaining;
                // fill as much as possible
            }
            uint256 tradeValue = quoteAmount(fillQty, maker.price);
            // calculate trade value
            uint256 escrowQuote = quoteAmount(fillQty, taker.price);
            // max quote to be taken from the taker
            uint256 refund = escrowQuote - tradeValue;
            // refund difference

            IERC20(equityToken).safeTransfer(taker.trader, fillQty);
            ttoken.safeTransfer(maker.trader, tradeValue);
            recordTradeQty(maker.trader, fillQty);
            recordTradeQty(taker.trader, fillQty);
            if (refund > 0) {
                ttoken.safeTransfer(taker.trader, refund);
                // refund the difference if the price is better than the taker expected
            }

            taker.remaining -= fillQty;
            maker.remaining -= fillQty;
            if (maker.remaining == 0) {
                maker.active = false;
            }
            if (taker.remaining == 0) {
                taker.active = false;
            }

            emit OrderFilled(maker.id, taker.id, equityToken, maker.price, fillQty);
        }
    }

    function matchSell(address equityToken, Order storage taker) internal {
        // similar to match
        while (taker.remaining > 0) {
            (bool found, uint256 index) = findBestBuy(equityToken, taker.price, taker.trader);
            if (!found) {
                break;
            }
            Order storage maker = buyOrders[equityToken][index];
            uint256 fillQty = taker.remaining;
            if (maker.remaining < fillQty) {
                fillQty = maker.remaining;
            }
            uint256 tradeValue = quoteAmount(fillQty, maker.price);

            IERC20(equityToken).safeTransfer(maker.trader, fillQty);
            ttoken.safeTransfer(taker.trader, tradeValue);
            recordTradeQty(maker.trader, fillQty);
            recordTradeQty(taker.trader, fillQty);

            taker.remaining -= fillQty;
            maker.remaining -= fillQty;
            if (maker.remaining == 0) {
                maker.active = false;
            }
            if (taker.remaining == 0) {
                taker.active = false;
            }

            emit OrderFilled(maker.id, taker.id, equityToken, maker.price, fillQty);
        }
    }

    function findBestSell(address equityToken, uint256 maxPrice, address excludedTrader) internal view returns (bool found, uint256 index) {
        // loops through and find the best sell order within the price liimit
        Order[] storage orders = sellOrders[equityToken];
        
        uint256 bestPrice = 0;
        uint256 bestIndex = 0;

        for (uint256 i = 0; i < orders.length; i++) {
            Order storage order = orders[i];
            if (
                !order.active ||
                order.remaining == 0 ||
                order.price > maxPrice ||
                order.trader == excludedTrader
            ) {
                continue;
            }
            if (!found || order.price < bestPrice) {
                found = true;
                bestPrice = order.price;
                bestIndex = i;
            }
        }

        return (found, bestIndex);
    }

    function findBestBuy(address equityToken, uint256 minPrice, address excludedTrader) internal view returns (bool found, uint256 index) {
        Order[] storage orders = buyOrders[equityToken];
        uint256 bestPrice = 0;
        uint256 bestIndex = 0;

        for (uint256 i = 0; i < orders.length; i++) {
            Order storage order = orders[i];
            if (
                !order.active ||
                order.remaining == 0 ||
                order.price < minPrice ||
                order.trader == excludedTrader
            ) {
                continue;
            }
            if (!found || order.price > bestPrice) {
                found = true;
                bestPrice = order.price;
                bestIndex = i;
            }
        }

        return (found, bestIndex);
    }

    function getOrderStorage(OrderRef memory ref) internal view returns (Order storage order) {
        // get order storage base on referencee
        if (ref.side == Side.BUY) {
            order = buyOrders[ref.equityToken][ref.index];
        } else {
            order = sellOrders[ref.equityToken][ref.index];
        }
    }

    function quoteAmount(uint256 qty, uint256 price) internal pure returns (uint256) {
        return (qty * price) / 100;
        // returns quote amount based on qty and price
    }

    function recordTradeQty(address trader, uint256 qtyWei) internal {
        // record traded quantity for award
        if (address(award) != address(0)) {
            award.recordTradeQty(trader, qtyWei);
        }
    }

}
