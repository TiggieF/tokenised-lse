pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ILeveragePriceFeed {
    function getPrice(string memory symbol) external view returns (uint256 priceCents, uint256 timestamp);
}

interface ILeverageProductFactory {
    function isProductToken(address token) external view returns (bool);
}

interface ILeverageProductToken {
    function baseSymbol() external view returns (string memory);
    function leverage() external view returns (uint8);
    function mintFromRouter(address to, uint256 amountWei) external;
    function burnFromRouter(address from, uint256 amountWei) external;
}

contract LeveragedProductRouter is AccessControl, ReentrancyGuard {
    IERC20 public immutable ttoken;
    ILeveragePriceFeed public immutable priceFeed;
    ILeverageProductFactory public immutable factory;

    struct UserPosition {
        uint256 qtyWei;
        uint256 avgEntryPriceCents;
    }

    mapping(address => mapping(address => UserPosition)) public positions;

    event LeveragedMinted(
        address indexed user,
        address indexed productToken,
        string baseSymbol,
        uint8 leverage,
        uint256 ttokenInWei,
        uint256 productOutWei,
        uint256 navCents
    );

    event LeveragedUnwound(
        address indexed user,
        address indexed productToken,
        string baseSymbol,
        uint8 leverage,
        uint256 productInWei,
        uint256 ttokenOutWei,
        uint256 navCents
    );

    constructor(address admin, address ttokenAddress, address priceFeedAddress, address factoryAddress) {
        require(admin != address(0), "leveragedrouter: admin is zero");
        require(ttokenAddress != address(0), "leveragedrouter: ttoken is zero");
        require(priceFeedAddress != address(0), "leveragedrouter: pricefeed is zero");
        require(factoryAddress != address(0), "leveragedrouter: factory is zero");

        ttoken = IERC20(ttokenAddress);
        priceFeed = ILeveragePriceFeed(priceFeedAddress);
        factory = ILeverageProductFactory(factoryAddress);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function mintLong(address productToken, uint256 ttokenInWei, uint256 minProductOutWei)
        external
        nonReentrant
        returns (uint256 productOutWei, uint256 navCents)
    {
        require(factory.isProductToken(productToken), "leveragedrouter: unknown product");
        require(ttokenInWei > 0, "leveragedrouter: ttoken input is zero");

        ILeverageProductToken token = ILeverageProductToken(productToken);
        string memory baseSymbol = token.baseSymbol();
        uint8 leverage = token.leverage();

        (uint256 currentPriceCents, ) = priceFeed.getPrice(baseSymbol);
        require(currentPriceCents > 0, "leveragedrouter: price unavailable");

        navCents = currentPriceCents;
        productOutWei = ttokenInWei * uint256(leverage);
        require(productOutWei >= minProductOutWei, "leveragedrouter: slippage on mint");

        bool transferred = ttoken.transferFrom(msg.sender, address(this), ttokenInWei);
        require(transferred, "leveragedrouter: transfer in failed");

        token.mintFromRouter(msg.sender, productOutWei);

        UserPosition storage position = positions[msg.sender][productToken];
        if (position.qtyWei == 0) {
            position.qtyWei = productOutWei;
            position.avgEntryPriceCents = currentPriceCents;
        } else {
            uint256 existingQty = position.qtyWei;
            uint256 existingPrice = position.avgEntryPriceCents;
            uint256 nextQty = existingQty + productOutWei;
            uint256 weightedOld = existingQty * existingPrice;
            uint256 weightedNew = productOutWei * currentPriceCents;
            uint256 blended = (weightedOld + weightedNew) / nextQty;

            position.qtyWei = nextQty;
            position.avgEntryPriceCents = blended;
        }

        emit LeveragedMinted(
            msg.sender,
            productToken,
            baseSymbol,
            leverage,
            ttokenInWei,
            productOutWei,
            navCents
        );
    }

    function unwindLong(address productToken, uint256 productQtyWei, uint256 minTTokenOutWei)
        external
        nonReentrant
        returns (uint256 ttokenOutWei, uint256 navCents)
    {
        require(factory.isProductToken(productToken), "leveragedrouter: unknown product");
        require(productQtyWei > 0, "leveragedrouter: qty is zero");

        ILeverageProductToken token = ILeverageProductToken(productToken);
        UserPosition storage position = positions[msg.sender][productToken];
        require(position.qtyWei >= productQtyWei, "leveragedrouter: insufficient position");

        uint256 entryPrice = position.avgEntryPriceCents;
        string memory baseSymbol = token.baseSymbol();
        uint8 leverage = token.leverage();
        (uint256 currentPriceCents, ) = priceFeed.getPrice(baseSymbol);
        require(currentPriceCents > 0, "leveragedrouter: price unavailable");

        navCents = currentPriceCents;

        ttokenOutWei = calculateUnwindOut(productQtyWei, leverage, entryPrice, currentPriceCents);
        require(ttokenOutWei >= minTTokenOutWei, "leveragedrouter: slippage on unwind");

        token.burnFromRouter(msg.sender, productQtyWei);

        position.qtyWei = position.qtyWei - productQtyWei;
        if (position.qtyWei == 0) {
            position.avgEntryPriceCents = 0;
        }

        bool transferred = ttoken.transfer(msg.sender, ttokenOutWei);
        require(transferred, "leveragedrouter: transfer out failed");

        emit LeveragedUnwound(
            msg.sender,
            productToken,
            baseSymbol,
            leverage,
            productQtyWei,
            ttokenOutWei,
            navCents
        );
    }

    function previewMint(address productToken, uint256 ttokenInWei)
        external
        view
        returns (uint256 productOutWei, uint256 navCents)
    {
        require(factory.isProductToken(productToken), "leveragedrouter: unknown product");
        ILeverageProductToken token = ILeverageProductToken(productToken);
        string memory baseSymbol = token.baseSymbol();
        uint8 leverage = token.leverage();

        (uint256 currentPriceCents, ) = priceFeed.getPrice(baseSymbol);
        navCents = currentPriceCents;
        productOutWei = ttokenInWei * uint256(leverage);
    }

    function previewUnwind(address account, address productToken, uint256 productQtyWei)
        external
        view
        returns (uint256 ttokenOutWei, uint256 navCents)
    {
        require(factory.isProductToken(productToken), "leveragedrouter: unknown product");
        ILeverageProductToken token = ILeverageProductToken(productToken);
        string memory baseSymbol = token.baseSymbol();
        uint8 leverage = token.leverage();
        UserPosition storage position = positions[account][productToken];

        uint256 entryPrice = position.avgEntryPriceCents;
        require(entryPrice > 0, "leveragedrouter: no position");
        (uint256 currentPriceCents, ) = priceFeed.getPrice(baseSymbol);
        navCents = currentPriceCents;
        ttokenOutWei = calculateUnwindOut(productQtyWei, leverage, entryPrice, currentPriceCents);
    }

    function calculateUnwindOut(
        uint256 productQtyWei,
        uint8 leverage,
        uint256 entryPriceCents,
        uint256 currentPriceCents
    ) internal pure returns (uint256 ttokenOutWei) {
        uint256 collateralWei = productQtyWei / uint256(leverage);
        int256 signedPriceDiff = int256(currentPriceCents) - int256(entryPriceCents);
        int256 signedPnlWei = (int256(productQtyWei) * signedPriceDiff) / int256(entryPriceCents);
        int256 signedOutWei = int256(collateralWei) + signedPnlWei;

        if (signedOutWei < 0) {
            ttokenOutWei = 0;
        } else {
            ttokenOutWei = uint256(signedOutWei);
        }
    }
}
