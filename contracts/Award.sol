pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";

interface ITTokenMintable {
    function mint(address to, uint256 amount)
        external;
}

contract Award is AccessControl {
    uint256 public constant EPOCH_DURATION = 60;
    uint256 public constant REWARD_AMOUNT = 100e18;

    ITTokenMintable public immutable ttoken;

    address public dex;

    mapping(uint256 => mapping(address => uint256)) public qtyByEpochByTrader;
    mapping(uint256 => uint256) public maxQtyByEpoch;
    mapping(uint256 => mapping(address => bool)) public claimedByEpoch;
    mapping(uint256 => address[]) private tradersByEpoch;
    mapping(uint256 => mapping(address => bool)) private traderSeenByEpoch;

    event DexUpdated(address indexed previousDex, address indexed newDex);
    event TradeQtyRecorded(uint256 indexed epochId, address indexed trader, uint256 qtyDeltaWei, uint256 qtyTotalWei, uint256 maxQtyWei);
    event AwardClaimed(uint256 indexed epochId, address indexed trader, uint256 rewardWei);

    constructor(address ttokenAddress, address admin, address dexAddress) {
        require(ttokenAddress != address(0), "award: ttoken is zero");
        require(admin != address(0), "award: admin is zero");

        ttoken = ITTokenMintable(ttokenAddress);
        dex = dexAddress;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function setDex(address newDex) external onlyRole(DEFAULT_ADMIN_ROLE) {
        address previousDex = dex;
        dex = newDex;

        emit DexUpdated(previousDex, newDex);
    }

    function currentEpoch() public view returns (uint256) {
        uint256 epochId = block.timestamp / EPOCH_DURATION;
        return epochId;
    }

    function recordTradeQty(address trader, uint256 qtyWei) external {
        require(msg.sender == dex, "award: only dex");
        require(trader != address(0), "award: trader is zero");
        require(qtyWei > 0, "award: qty is zero");

        uint256 epochId = currentEpoch();

        if (!traderSeenByEpoch[epochId][trader]) {
            traderSeenByEpoch[epochId][trader] = true;
            tradersByEpoch[epochId].push(trader);
        }

        uint256 currentQty = qtyByEpochByTrader[epochId][trader];
        uint256 newQty = currentQty + qtyWei;
        qtyByEpochByTrader[epochId][trader] = newQty;

        uint256 currentMaxQty = maxQtyByEpoch[epochId];
        if (newQty > currentMaxQty) {
            maxQtyByEpoch[epochId] = newQty;
        }

        emit TradeQtyRecorded(epochId, trader, qtyWei, newQty, maxQtyByEpoch[epochId]);
    }

    function getEpochTraderCount(uint256 epochId) external view returns (uint256) {
        return tradersByEpoch[epochId].length;
    }

    function getEpochTraderAt(uint256 epochId, uint256 index) external view returns (address) {
        return tradersByEpoch[epochId][index];
    }

    function isWinner(uint256 epochId, address trader) public view returns (bool) {
        if (trader == address(0)) {
            return false;
        }
        if (epochId >= currentEpoch()) {
            return false;
        }
        uint256 traderQty = qtyByEpochByTrader[epochId][trader];
        uint256 maxQty = maxQtyByEpoch[epochId];
        if (traderQty == 0 || maxQty == 0) {
            return false;
        }
        return traderQty == maxQty;
    }

    function hasClaimed(uint256 epochId, address trader) external view returns (bool) {
        return claimedByEpoch[epochId][trader];
    }

    function claimAward(uint256 epochId) external {
        require(epochId < currentEpoch(), "award: epoch not ended");
        require(isWinner(epochId, msg.sender), "award: not winner");
        require(!claimedByEpoch[epochId][msg.sender], "award: already claimed");

        claimedByEpoch[epochId][msg.sender] = true;
        ttoken.mint(msg.sender, REWARD_AMOUNT);

        emit AwardClaimed(epochId, msg.sender, REWARD_AMOUNT);
    }
}
