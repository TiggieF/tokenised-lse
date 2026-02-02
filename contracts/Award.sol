// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";

interface ITTokenMintable {
    function mint(address to, uint256 amount) external;
}

/**
 * @title Award
 * @notice Tracks on-chain trading volume per epoch and awards the top trader.
 */
contract Award is AccessControl {
    // uint256 public constant EPOCH_DURATION = 90; // seconds
    uint256 public constant EPOCH_DURATION = 10; // seconds

    uint256 public constant REWARD_AMOUNT = 1e18; // 1 TToken

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
        require(ttokenAddress != address(0), "Award: ttoken is zero");
        require(admin != address(0), "Award: admin is zero");
        ttoken = ITTokenMintable(ttokenAddress);
        dex = dexAddress;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function setDex(address newDex) external onlyRole(DEFAULT_ADMIN_ROLE) {
        emit DexUpdated(dex, newDex);
        dex = newDex;
    }

    function currentEpoch() public view returns (uint256) {
        return block.timestamp / EPOCH_DURATION;
    }

    function recordTrade(address trader, uint256 quoteVolume) external {
        require(msg.sender == dex, "Award: only dex");
        require(trader != address(0), "Award: trader is zero");
        require(quoteVolume > 0, "Award: volume is zero");

        uint256 epochId = currentEpoch();
        uint256 newVolume = volumeByEpoch[epochId][trader] + quoteVolume;
        volumeByEpoch[epochId][trader] = newVolume;

        if (newVolume > topVolumeByEpoch[epochId]) {
            topVolumeByEpoch[epochId] = newVolume;
            topTraderByEpoch[epochId] = trader;
        }

        emit TradeRecorded(epochId, trader, quoteVolume);
    }

    function finalizeEpoch(uint256 epochId) external {
        require(epochId < currentEpoch(), "Award: epoch not ended");
        require(!rewarded[epochId], "Award: already finalized");

        rewarded[epochId] = true;
        address winner = topTraderByEpoch[epochId];
        uint256 reward = 0;
        if (topVolumeByEpoch[epochId] > 0 && winner != address(0)) {
            reward = REWARD_AMOUNT;
            ttoken.mint(winner, reward);
        }

        emit EpochFinalized(epochId, winner, reward);
    }
}
