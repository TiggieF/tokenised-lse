
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
// access control

contract PriceFeed is AccessControl {
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");
    // defines the orcale role account1

    uint256 public freshnessWindowSeconds;
    // price freshness

    struct PriceEntry {
        uint256 priceCents;
        uint256 timestamp;
        // stores the price and time it was pulled
    }

    mapping(bytes32 => PriceEntry) private pricesByKey;
    // mapping for price entry

    event PriceUpdated(string indexed symbol, uint256 priceCents, uint256 timestamp);
    // price udpate event

    constructor(address admin, address oracle) {
        require(admin != address(0), "pricefeed: admin is zero");
        // requires admin addrerss
        require(oracle != address(0), "pricefeed: oracle is zero");
        // requires the orcale address

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ORACLE_ROLE, oracle);
        // grantrole for both admin and oracle role
        freshnessWindowSeconds = 60;
        // default freshness 60 seconds
    }

    function setPrice(string memory symbol, uint256 priceCents) external onlyRole(ORACLE_ROLE) {
        require(priceCents > 0, "pricefeed: price must be > 0");
        // checks valid price
        bytes32 key = symbolKey(symbol);
        // get key
        pricesByKey[key] = PriceEntry({ priceCents: priceCents, timestamp: block.timestamp });
        // update price and time
        emit PriceUpdated(symbol, priceCents, block.timestamp);
    }

    function getPrice(string memory symbol) external view returns (uint256 priceCents, uint256 timestamp) {
        PriceEntry memory entry = pricesByKey[symbolKey(symbol)];
        // get price
        return (entry.priceCents, entry.timestamp);

    }

    function setFreshnessWindow(uint256 secs) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(secs > 0, "pricefeed: window must be > 0");
        // checking freshness
        freshnessWindowSeconds = secs;
    }

    function isFresh(string memory symbol) external view returns (bool) {
        // check if the price is fresh
        PriceEntry memory entry = pricesByKey[symbolKey(symbol)];
        if (entry.timestamp == 0) {
            return false;
        }
        return block.timestamp - entry.timestamp <= freshnessWindowSeconds;
        // returns when fresh
    }

    function symbolKey(string memory symbol) internal pure returns (bytes32) {
        validateSymbol(symbol);
        return keccak256(abi.encodePacked(symbol));
        // map key for stock symbol
    }

    function validateSymbol(string memory symbol) internal pure {
        bytes memory raw = bytes(symbol);
        require(raw.length > 0, "pricefeed: symbol required");
        for (uint256 i = 0; i < raw.length; i++) {
            // validating
            bytes1 char = raw[i];
            bool isUpper = char >= 0x41 && char <= 0x5A;
            // uppercase and 0to9
            bool isDigit = char >= 0x30 && char <= 0x39;
            require(isUpper || isDigit, "symbol must be upper-case or 0-9");
        }
    }
}
