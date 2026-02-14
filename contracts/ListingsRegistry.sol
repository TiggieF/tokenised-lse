pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";

contract ListingsRegistry is AccessControl {
    bytes32 public constant LISTING_ROLE = keccak256("LISTING_ROLE");

    struct Listing {
        address token;
        string symbol;
        string name;
    }

    mapping(bytes32 => Listing) private listingsByKey;
    mapping(address => bool) public isTokenListed;
    mapping(address => string) public tokenToSymbol;
    string[] private listedSymbols;

    event StockListed(string indexed symbol, address tokenAddr);

    constructor(address admin) {
        require(admin != address(0), "listingsregistry: admin is zero");

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(LISTING_ROLE, admin);
    }

    function registerListing(
        string memory symbol,
        string memory name,
        address tokenAddr
    ) external onlyRole(LISTING_ROLE) {
        require(tokenAddr != address(0), "listingsregistry: token is zero");

        bytes32 key = symbolKey(symbol);
        address existingToken = listingsByKey[key].token;

        require(existingToken == address(0), "listingsregistry: symbol already listed");

        Listing memory listing = Listing({
            token: tokenAddr,
            symbol: symbol,
            name: name
        });

        listingsByKey[key] = listing;

        isTokenListed[tokenAddr] = true;
        tokenToSymbol[tokenAddr] = symbol;
        listedSymbols.push(symbol);

        emit StockListed(symbol, tokenAddr);
    }

    function getListing(string memory symbol) external view returns (address) {
        bytes32 key = symbolKey(symbol);
        Listing storage listing = listingsByKey[key];
        return listing.token;
    }

    function getSymbolByToken(address token) external view returns (string memory) {
        string memory symbol = tokenToSymbol[token];
        return symbol;
    }

    function getAllSymbols() external view returns (string[] memory) {
        return listedSymbols;
    }

    function getSymbols(uint256 offset, uint256 limit) external view returns (string[] memory) {
        uint256 total = listedSymbols.length;

        if (offset >= total) {
            return new string[](0);
        }

        uint256 end = offset + limit;
        if (end > total) {
            end = total;
        }

        uint256 size = end - offset;
        string[] memory slice = new string[](size);

        for (uint256 i = offset; i < end; i++) {
            uint256 localIndex = i - offset;
            slice[localIndex] = listedSymbols[i];
        }

        return slice;
    }

    function getListingFull(string memory symbol)
        external
        view
        returns (address token, string memory sym, string memory name)
    {
        bytes32 key = symbolKey(symbol);
        Listing storage listing = listingsByKey[key];

        token = listing.token;
        sym = listing.symbol;
        name = listing.name;
    }

    function isListed(string memory symbol) external view returns (bool) {
        bytes32 key = symbolKey(symbol);
        address token = listingsByKey[key].token;
        bool listed = token != address(0);
        return listed;
    }

    function symbolKey(string memory symbol) internal pure returns (bytes32) {
        validateSymbol(symbol);
        bytes32 key = keccak256(abi.encodePacked(symbol));
        return key;
    }

    function validateSymbol(string memory symbol) internal pure {
        bytes memory raw = bytes(symbol);
        require(raw.length > 0, "listingsregistry: symbol required");

        for (uint256 i = 0; i < raw.length; i++) {
            bytes1 char = raw[i];

            bool isUpper = char >= 0x41 && char <= 0x5A;
            bool isDigit = char >= 0x30 && char <= 0x39;
            bool valid = isUpper || isDigit;

            require(valid, "listingsregistry: symbol must be upper-case or 0-9");
        }
    }
}
