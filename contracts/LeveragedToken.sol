pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract LeveragedToken is ERC20 {
    string public baseSymbol;
    address public baseToken;
    uint8 public leverage;
    address public factory;
    address public router;

    modifier onlyRouter() {
        require(msg.sender == router, "leveragedtoken: only router");
        _;
    }

    constructor(
        string memory name_,
        string memory symbol_,
        string memory baseSymbol_,
        address baseToken_,
        uint8 leverage_,
        address factory_,
        address router_
    ) ERC20(name_, symbol_) {
        require(bytes(baseSymbol_).length > 0, "leveragedtoken: base symbol required");
        require(baseToken_ != address(0), "leveragedtoken: base token is zero");
        require(factory_ != address(0), "leveragedtoken: factory is zero");
        require(router_ != address(0), "leveragedtoken: router is zero");

        baseSymbol = baseSymbol_;
        baseToken = baseToken_;
        leverage = leverage_;
        factory = factory_;
        router = router_;
    }

    function mintFromRouter(address to, uint256 amountWei) external onlyRouter {
        require(to != address(0), "leveragedtoken: to is zero");
        require(amountWei > 0, "leveragedtoken: amount is zero");

        _mint(to, amountWei);
    }

    function burnFromRouter(address from, uint256 amountWei) external onlyRouter {
        require(from != address(0), "leveragedtoken: from is zero");
        require(amountWei > 0, "leveragedtoken: amount is zero");

        _burn(from, amountWei);
    }
}
