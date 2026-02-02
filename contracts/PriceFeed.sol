// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title PriceFeed
 * @notice Stores the latest price (in pence) for listed equity symbols along
 *         with the timestamp of the update. Only trusted oracle accounts can
 *         update prices.
 */
contract PriceFeed is AccessControl {
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");
    uint256 public freshnessWindowSeconds;

    struct PriceEntry {
        uint256 priceCents;
        uint256 timestamp;
    }

    mapping(bytes32 => PriceEntry) private _prices;

    event PriceUpdated(string indexed symbol, uint256 priceCents, uint256 timestamp);

    constructor(address admin, address oracle) {
        require(admin != address(0), "PriceFeed: admin is zero");
        require(oracle != address(0), "PriceFeed: oracle is zero");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ORACLE_ROLE, oracle);
        freshnessWindowSeconds = 60;
    }

    function setPrice(string memory symbol, uint256 priceCents) external onlyRole(ORACLE_ROLE) {
        require(priceCents > 0, "PriceFeed: price must be > 0");
        bytes32 key = _symbolKey(symbol);
        _prices[key] = PriceEntry({ priceCents: priceCents, timestamp: block.timestamp });
        emit PriceUpdated(symbol, priceCents, block.timestamp);
    }

    function getPrice(string memory symbol) external view returns (uint256 priceCents, uint256 timestamp) {
        PriceEntry memory entry = _prices[_symbolKey(symbol)];
        return (entry.priceCents, entry.timestamp);
    }

    function setFreshnessWindow(uint256 secs) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(secs > 0, "PriceFeed: window must be > 0");
        freshnessWindowSeconds = secs;
    }

    function isFresh(string memory symbol) external view returns (bool) {
        PriceEntry memory entry = _prices[_symbolKey(symbol)];
        if (entry.timestamp == 0) {
            return false;
        }
        return block.timestamp - entry.timestamp <= freshnessWindowSeconds;
    }

    function _symbolKey(string memory symbol) internal pure returns (bytes32) {
        _validateSymbol(symbol);
        return keccak256(abi.encodePacked(symbol));
    }

    function _validateSymbol(string memory symbol) internal pure {
        bytes memory raw = bytes(symbol);
        require(raw.length > 0, "PriceFeed: symbol required");
        for (uint256 i = 0; i < raw.length; i++) {
            bytes1 char = raw[i];
            bool isUpper = char >= 0x41 && char <= 0x5A;
            bool isDigit = char >= 0x30 && char <= 0x39;
            require(isUpper || isDigit, "PriceFeed: symbol must be A-Z or 0-9");
        }
    }
}
