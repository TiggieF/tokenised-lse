pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";

contract PriceFeed is AccessControl {
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");

    uint256 public freshnessWindowSeconds;

    struct PriceEntry {
        uint256 priceCents;
        uint256 timestamp;
    }

    mapping(bytes32 => PriceEntry) private pricesByKey;

    event PriceUpdated(string indexed symbol, uint256 priceCents, uint256 timestamp);

    constructor(address admin, address oracle) {
        require(admin != address(0), "pricefeed: admin is zero");
        require(oracle != address(0), "pricefeed: oracle is zero");

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ORACLE_ROLE, oracle);

        freshnessWindowSeconds = 60;
    }

    function setPrice(string memory symbol, uint256 priceCents) external onlyRole(ORACLE_ROLE) {
        require(priceCents > 0, "pricefeed: price must be > 0");

        bytes32 key = symbolKey(symbol);
        uint256 nowTimestamp = block.timestamp;

        pricesByKey[key] = PriceEntry({
            priceCents: priceCents,
            timestamp: nowTimestamp
        });

        emit PriceUpdated(symbol, priceCents, nowTimestamp);
    }

    function getPrice(string memory symbol) external view returns (uint256 priceCents, uint256 timestamp) {
        bytes32 key = symbolKey(symbol);
        PriceEntry memory entry = pricesByKey[key];

        priceCents = entry.priceCents;
        timestamp = entry.timestamp;
    }

    function setFreshnessWindow(uint256 secs) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(secs > 0, "pricefeed: window must be > 0");
        freshnessWindowSeconds = secs;
    }

    function isFresh(string memory symbol) external view returns (bool) {
        bytes32 key = symbolKey(symbol);
        PriceEntry memory entry = pricesByKey[key];

        if (entry.timestamp == 0) {
            return false;
        }

        uint256 ageSeconds = block.timestamp - entry.timestamp;
        bool withinWindow = ageSeconds <= freshnessWindowSeconds;
        return withinWindow;
    }

    function symbolKey(string memory symbol) internal pure returns (bytes32) {
        validateSymbol(symbol);
        bytes32 key = keccak256(abi.encodePacked(symbol));
        return key;
    }

    function validateSymbol(string memory symbol) internal pure {
        bytes memory raw = bytes(symbol);
        require(raw.length > 0, "pricefeed: symbol required");

        for (uint256 i = 0; i < raw.length; i++) {
            bytes1 char = raw[i];

            bool isUpper = char >= 0x41 && char <= 0x5A;
            bool isDigit = char >= 0x30 && char <= 0x39;
            bool valid = isUpper || isDigit;

            require(valid, "symbol must be upper-case or 0-9");
        }
    }
}
