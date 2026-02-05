// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IPriceFeed {
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
    function getAllSymbols()
        external
        view
        returns (string[] memory);

    function getSymbols(uint256 offset, uint256 limit)
        external
        view
        returns (string[] memory);

    function getListing(string memory symbol)
        external
        view
        returns (address);
}

/**
 * @title PortfolioAggregator
 * @notice Read-only helper to aggregate balances and valuations in TToken.
 */
contract PortfolioAggregator {
    struct Holding {
        address token;
        string symbol;
        uint256 balanceWei;
        uint256 priceCents;
        uint256 valueWei;
    }

    IERC20 public immutable ttoken;
    IListingsRegistry public immutable registry;
    IPriceFeed public immutable priceFeed;

    constructor(address ttokenAddress, address registryAddress, address priceFeedAddress) {
        require(ttokenAddress != address(0), "aggregator: ttoken is zero");
        require(registryAddress != address(0), "aggregator: registry is zero");
        require(priceFeedAddress != address(0), "aggregator: pricefeed is zero");
        ttoken = IERC20(ttokenAddress);
        registry = IListingsRegistry(registryAddress);
        priceFeed = IPriceFeed(priceFeedAddress);
    }

    function getTTokenBalance(address user) external view returns (uint256) {
        return ttoken.balanceOf(user);
    }

    function getHoldings(address user) external view returns (Holding[] memory) {
        string[] memory symbols = registry.getAllSymbols();
        return buildHoldings(user, symbols);
    }

    function getHoldingsSlice(address user, uint256 offset, uint256 limit)
        external
        view
        returns (Holding[] memory)
    {
        string[] memory symbols = registry.getSymbols(offset, limit);
        return buildHoldings(user, symbols);
    }

    function getTotalValue(address user) external view returns (uint256 totalWei) {
        totalWei = ttoken.balanceOf(user);
        string[] memory symbols = registry.getAllSymbols();
        for (uint256 i = 0; i < symbols.length; i++) {
            address token = registry.getListing(symbols[i]);
            if (token == address(0)) {
                continue;
            }
            uint256 balance = IERC20(token).balanceOf(user);
            if (balance == 0) {
                continue;
            }
            (uint256 priceCents, ) = priceFeed.getPrice(symbols[i]);
            if (priceCents == 0) {
                continue;
            }
            totalWei += (balance * priceCents) / 100;
        }
    }

    function getPortfolioSummary(address user)
        external
        view
        returns (uint256 cashValueWei, uint256 stockValueWei, uint256 totalValueWei)
    {
        cashValueWei = ttoken.balanceOf(user);
        stockValueWei = 0;
        string[] memory symbols = registry.getAllSymbols();
        for (uint256 i = 0; i < symbols.length; i++) {
            address token = registry.getListing(symbols[i]);
            if (token == address(0)) {
                continue;
            }
            uint256 balance = IERC20(token).balanceOf(user);
            if (balance == 0) {
                continue;
            }
            (uint256 priceCents, ) = priceFeed.getPrice(symbols[i]);
            if (priceCents == 0) {
                continue;
            }
            stockValueWei += (balance * priceCents) / 100;
        }
        totalValueWei = cashValueWei + stockValueWei;
    }

    function buildHoldings(address user, string[] memory symbols)
        internal
        view
        returns (Holding[] memory)
    {
        Holding[] memory holdings = new Holding[](symbols.length);
        for (uint256 i = 0; i < symbols.length; i++) {
            address token = registry.getListing(symbols[i]);
            uint256 balance = 0;
            if (token != address(0)) {
                balance = IERC20(token).balanceOf(user);
            }
            uint256 priceCents = 0;
            uint256 valueWei = 0;
            if (token != address(0) && balance > 0) {
                (priceCents, ) = priceFeed.getPrice(symbols[i]);
                if (priceCents > 0) {
                    valueWei = (balance * priceCents) / 100;
                }
            }
            holdings[i] = Holding({
                token: token,
                symbol: symbols[i],
                balanceWei: balance,
                priceCents: priceCents,
                valueWei: valueWei
            });
        }
        return holdings;
    }
}
