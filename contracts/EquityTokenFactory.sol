pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";

import "./EquityToken.sol";
import "./ListingsRegistry.sol";

contract EquityTokenFactory is AccessControl {
    ListingsRegistry public immutable registry;
    address public immutable defaultMinter;

    constructor(address admin, address registryAddress, address minter) {
        require(admin != address(0), "EquityTokenFactory: admin is zero");
        require(registryAddress != address(0), "EquityTokenFactory: registry is zero");
        require(minter != address(0), "EquityTokenFactory: minter is zero");

        registry = ListingsRegistry(registryAddress);
        defaultMinter = minter;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function createEquityToken(string memory symbol, string memory name)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        returns (address tokenAddr)
    {
        bytes memory symbolBytes = bytes(symbol);
        bytes memory nameBytes = bytes(name);

        require(symbolBytes.length > 0, "EquityTokenFactory: symbol required");
        require(nameBytes.length > 0, "EquityTokenFactory: name required");

        EquityToken token = new EquityToken(name, symbol, msg.sender, defaultMinter);
        tokenAddr = address(token);

        registry.registerListing(symbol, name, tokenAddr);
    }
}
