
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";

import "./EquityToken.sol";
import "./ListingsRegistry.sol";
// import the equity token and listing registry

contract EquityTokenFactory is AccessControl {
    ListingsRegistry public immutable registry;
    address public immutable defaultMinter;

    constructor(address admin, address registryAddress, address minter) {
        require(admin != address(0), "EquityTokenFactory: admin is zero");
        require(registryAddress != address(0), "EquityTokenFactory: registry is zero");
        require(minter != address(0), "EquityTokenFactory: minter is zero");
        // checks for minter admin and reg address
        registry = ListingsRegistry(registryAddress);
        defaultMinter = minter;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    
    function createEquityToken(string memory symbol, string memory name)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        returns (address tokenAddr)
    {
        require(bytes(symbol).length > 0, "EquityTokenFactory: symbol required");
        require(bytes(name).length > 0, "EquityTokenFactory: name required");

        EquityToken token = new EquityToken(name, symbol, msg.sender, defaultMinter);
        tokenAddr = address(token);
        // declares new token

        registry.registerListing(symbol, name, tokenAddr);
        // register listings
    }
}
