// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title ListingsRegistry
 * @notice Registry mapping ticker symbols to deployed equity token addresses.
 *         A dedicated LISTING_ROLE is used so trusted factory contracts can
 *         register and unlist stock tokens.
 */
contract ListingsRegistry is AccessControl {
    /// @notice Role identifier used to manage listings.
    bytes32 public constant LISTING_ROLE = keccak256("LISTING_ROLE");

    struct Listing {
        address token;
        string symbol;
        string name;
    }

    mapping(bytes32 => Listing) private _listings;
    mapping(address => bool) public isTokenListed;
    mapping(address => string) public tokenToSymbol;

    event StockListed(string indexed symbol, address tokenAddr);

    constructor(address admin) {
        require(admin != address(0), "ListingsRegistry: admin is zero");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(LISTING_ROLE, admin);
    }

    /**
     * @notice Register a new equity token in the registry.
     */
    function registerListing(
        string memory symbol,
        string memory name,
        address tokenAddr
    ) external onlyRole(LISTING_ROLE) {
        require(tokenAddr != address(0), "ListingsRegistry: token is zero");
        bytes32 key = _symbolKey(symbol);
        require(_listings[key].token == address(0), "ListingsRegistry: symbol already listed");

        _listings[key] = Listing({
            token: tokenAddr,
            symbol: symbol,
            name: name
        });
        isTokenListed[tokenAddr] = true;
        tokenToSymbol[tokenAddr] = symbol;

        emit StockListed(symbol, tokenAddr);
    }

    /**
     * @notice Returns the token address for a ticker symbol or address(0).
     */
    function getListing(string memory symbol) external view returns (address) {
        Listing storage listing = _listings[_symbolKey(symbol)];
        return listing.token;
    }

    function getSymbolByToken(address token) external view returns (string memory) {
        return tokenToSymbol[token];
    }

    /**
     * @notice Returns full listing info or empty values if missing.
     */
    function getListingFull(string memory symbol)
        external
        view
        returns (address token, string memory sym, string memory name)
    {
        Listing storage listing = _listings[_symbolKey(symbol)];
        return (listing.token, listing.symbol, listing.name);
    }

    /**
     * @notice Returns true when a symbol has been listed.
     */
    function isListed(string memory symbol) external view returns (bool) {
        return _listings[_symbolKey(symbol)].token != address(0);
    }

    function _symbolKey(string memory symbol) internal pure returns (bytes32) {
        _validateSymbol(symbol);
        return keccak256(abi.encodePacked(symbol));
    }

    function _validateSymbol(string memory symbol) internal pure {
        bytes memory raw = bytes(symbol);
        require(raw.length > 0, "ListingsRegistry: symbol required");
        for (uint256 i = 0; i < raw.length; i++) {
            bytes1 char = raw[i];
            bool isUpper = char >= 0x41 && char <= 0x5A;
            bool isDigit = char >= 0x30 && char <= 0x39;
            require(isUpper || isDigit, "ListingsRegistry: symbol must be A-Z or 0-9");
        }
    }
}
