pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";

import "./LeveragedToken.sol";

interface IStage12ListingsRegistry {
    function isListed(string memory symbol) external view returns (bool);
    function getListing(string memory symbol) external view returns (address);
}

contract LeveragedTokenFactory is AccessControl {
    bytes32 public constant PRODUCT_ADMIN_ROLE = keccak256("PRODUCT_ADMIN_ROLE");

    IStage12ListingsRegistry public immutable registry;
    address public router;

    struct Product {
        string productSymbol;
        string baseSymbol;
        address baseToken;
        uint8 leverage;
        bool isLong;
        address token;
    }

    mapping(bytes32 => address) private productByKey;
    mapping(string => address) private productBySymbol;
    mapping(address => bool) public isProductToken;
    Product[] private products;

    event LongProductCreated(
        string indexed productSymbol,
        string indexed baseSymbol,
        uint8 leverage,
        address productToken
    );

    event RouterUpdated(address indexed router);

    constructor(address admin, address registryAddress) {
        require(admin != address(0), "leveragedfactory: admin is zero");
        require(registryAddress != address(0), "leveragedfactory: registry is zero");

        registry = IStage12ListingsRegistry(registryAddress);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PRODUCT_ADMIN_ROLE, admin);
    }

    function setRouter(address routerAddress) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(routerAddress != address(0), "leveragedfactory: router is zero");
        router = routerAddress;

        emit RouterUpdated(routerAddress);
    }

    function createLongProduct(string memory baseSymbol, uint8 leverage)
        external
        onlyRole(PRODUCT_ADMIN_ROLE)
        returns (address productToken)
    {
        require(bytes(baseSymbol).length > 0, "leveragedfactory: base symbol required");
        require(isAllowedLeverage(leverage), "leveragedfactory: leverage not allowed");
        require(router != address(0), "leveragedfactory: router not set");

        bool listed = registry.isListed(baseSymbol);
        require(listed, "leveragedfactory: base not listed");

        bytes32 key = productKey(baseSymbol, leverage, true);
        address existing = productByKey[key];
        require(existing == address(0), "leveragedfactory: product exists");

        address baseToken = registry.getListing(baseSymbol);
        require(baseToken != address(0), "leveragedfactory: base token missing");

        string memory productSymbol = buildLongSymbol(baseSymbol, leverage);
        string memory productName = buildLongName(baseSymbol, leverage);

        LeveragedToken token = new LeveragedToken(
            productName,
            productSymbol,
            baseSymbol,
            baseToken,
            leverage,
            address(this),
            router
        );
        productToken = address(token);

        productByKey[key] = productToken;
        productBySymbol[productSymbol] = productToken;
        isProductToken[productToken] = true;

        Product memory item = Product({
            productSymbol: productSymbol,
            baseSymbol: baseSymbol,
            baseToken: baseToken,
            leverage: leverage,
            isLong: true,
            token: productToken
        });
        products.push(item);

        emit LongProductCreated(productSymbol, baseSymbol, leverage, productToken);
    }

    function getProduct(string memory baseSymbol, uint8 leverage) external view returns (address) {
        bytes32 key = productKey(baseSymbol, leverage, true);
        return productByKey[key];
    }

    function getProductBySymbol(string memory productSymbol) external view returns (address) {
        return productBySymbol[productSymbol];
    }

    function isProductListed(string memory productSymbol) external view returns (bool) {
        address token = productBySymbol[productSymbol];
        return token != address(0);
    }

    function productCount() external view returns (uint256) {
        return products.length;
    }

    function getProductAt(uint256 index) external view returns (Product memory) {
        require(index < products.length, "leveragedfactory: index out of range");
        return products[index];
    }

    function isAllowedLeverage(uint8 leverage) public pure returns (bool) {
        bool allowed = false;
        if (leverage == 3) {
            allowed = true;
        }
        if (leverage == 5) {
            allowed = true;
        }
        return allowed;
    }

    function productKey(string memory baseSymbol, uint8 leverage, bool isLong) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(baseSymbol, leverage, isLong));
    }

    function buildLongSymbol(string memory baseSymbol, uint8 leverage) internal pure returns (string memory) {
        return string(abi.encodePacked(baseSymbol, toString(leverage), "L"));
    }

    function buildLongName(string memory baseSymbol, uint8 leverage) internal pure returns (string memory) {
        return string(abi.encodePacked(baseSymbol, " ", toString(leverage), "x Long"));
    }

    function toString(uint8 value) internal pure returns (string memory) {
        if (value == 0) {
            return "0";
        }
        uint8 copy = value;
        uint256 digits = 0;
        while (copy != 0) {
            digits = digits + 1;
            copy = copy / 10;
        }
        bytes memory buffer = new bytes(digits);
        uint256 index = digits;
        copy = value;
        while (copy != 0) {
            index = index - 1;
            buffer[index] = bytes1(uint8(48 + copy % 10));
            copy = copy / 10;
        }
        return string(buffer);
    }
}
