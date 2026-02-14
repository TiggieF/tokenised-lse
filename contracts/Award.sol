pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";

interface ITTokenMintable {
    function mint(address to, uint256 amount)
        external;
}

contract Award is AccessControl {
    uint256 public constant EPOCH_DURATION = 10;
    uint256 public constant REWARD_AMOUNT = 1e18;

    ITTokenMintable public immutable ttoken;

    address public dex;

    mapping(uint256 => mapping(address => uint256)) public volumeByEpoch;
    mapping(uint256 => address) public topTraderByEpoch;
    mapping(uint256 => uint256) public topVolumeByEpoch;
    mapping(uint256 => bool) public rewarded;

    event DexUpdated(address indexed previousDex, address indexed newDex);
    event TradeRecorded(uint256 indexed epochId, address indexed trader, uint256 volume);
    event EpochFinalized(uint256 indexed epochId, address indexed winner, uint256 reward);

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

    function recordTrade(address trader, uint256 quoteVolume) external {
        require(msg.sender == dex, "award: only dex");
        require(trader != address(0), "award: trader is zero");
        require(quoteVolume > 0, "award: volume is zero");

        uint256 epochId = currentEpoch();

        uint256 currentTraderVolume = volumeByEpoch[epochId][trader];
        uint256 newTraderVolume = currentTraderVolume + quoteVolume;

        volumeByEpoch[epochId][trader] = newTraderVolume;

        uint256 currentTopVolume = topVolumeByEpoch[epochId];
        if (newTraderVolume > currentTopVolume) {
            topVolumeByEpoch[epochId] = newTraderVolume;
            topTraderByEpoch[epochId] = trader;
        }

        emit TradeRecorded(epochId, trader, quoteVolume);
    }

    function finalizeEpoch(uint256 epochId) external {
        uint256 activeEpoch = currentEpoch();

        require(epochId < activeEpoch, "award: epoch not ended");
        require(!rewarded[epochId], "award: already finalised");

        rewarded[epochId] = true;

        address winner = topTraderByEpoch[epochId];
        uint256 reward = 0;

        uint256 topVolume = topVolumeByEpoch[epochId];
        bool hasWinner = winner != address(0);

        if (topVolume > 0 && hasWinner) {
            reward = REWARD_AMOUNT;
            ttoken.mint(winner, reward);
        }

        emit EpochFinalized(epochId, winner, reward);
    }
}
