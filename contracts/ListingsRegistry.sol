
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
    // for token adrress to check listed or not
    mapping(address => string) public tokenToSymbol;
    // maps token address to symbol
    string[] private listedSymbols;
    // stores all symbols

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
        // get key for symbol
        require(listingsByKey[key].token == address(0), "listingsregistry: symbol already listed");

        listingsByKey[key] = Listing({
            token: tokenAddr,
            symbol: symbol,
            name: name
        });
        // store the listing
        isTokenListed[tokenAddr] = true;
        // mark as listed
        tokenToSymbol[tokenAddr] = symbol;
        listedSymbols.push(symbol);

        emit StockListed(symbol, tokenAddr);
        // emit for offchain monitor
    }

    
    function getListing(string memory symbol) external view returns (address) {
        Listing storage listing = listingsByKey[symbolKey(symbol)];
        return listing.token;
    }

    function getSymbolByToken(address token) external view returns (string memory) {
        return tokenToSymbol[token];
    }

    function getAllSymbols() external view returns (string[] memory) {
        return listedSymbols;
    }

    function getSymbols(uint256 offset, uint256 limit) external view returns (string[] memory) {
        // return a slice of symbols
        uint256 total = listedSymbols.length;
        if (offset >= total) {
            return new string[](0);
        }
        uint256 end = offset + limit;
        if (end > total) {
            end = total;
        }
        string[] memory slice = new string[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            slice[i - offset] = listedSymbols[i];
        }
        return slice;
    }

    
    function getListingFull(string memory symbol)
        external
        view
        returns (address token, string memory sym, string memory name)
    {
        Listing storage listing = listingsByKey[symbolKey(symbol)];
        return (listing.token, listing.symbol, listing.name);
    }

    
    function isListed(string memory symbol) external view returns (bool) {
        return listingsByKey[symbolKey(symbol)].token != address(0);
    }

    function symbolKey(string memory symbol) internal pure returns (bytes32) {
        validateSymbol(symbol);
        return keccak256(abi.encodePacked(symbol));
    }

    function validateSymbol(string memory symbol) internal pure {
        // symbol validation, uupercase and numbered
        bytes memory raw = bytes(symbol);
        require(raw.length > 0, "listingsregistry: symbol required");
        for (uint256 i = 0; i < raw.length; i++) {
            bytes1 char = raw[i];
            bool isUpper = char >= 0x41 && char <= 0x5A;
            bool isDigit = char >= 0x30 && char <= 0x39;
            require(isUpper || isDigit, "listingsregistry: symbol must be upper-case or 0-9");
        }
    }
}
