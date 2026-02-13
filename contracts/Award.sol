
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
// permission role base

interface ITTokenMintable {
    // placeholder
    function mint(address to, uint256 amount)
        external;
}


contract Award is AccessControl {
    // inherit
    
    uint256 public constant EPOCH_DURATION = 10; 
    // for 10 secnds to test
    uint256 public constant REWARD_AMOUNT = 1e18; 
    // reward ampunt of 1 ttoken

    ITTokenMintable public immutable ttoken;
    // ttoken declare

    address public dex;
    // address of contract

    mapping(uint256 => mapping(address => uint256)) public volumeByEpoch;
    // total trading volumn

    mapping(uint256 => address) public topTraderByEpoch;
    // leader 
    mapping(uint256 => uint256) public topVolumeByEpoch;
    // leaders volume
    mapping(uint256 => bool) public rewarded;
    // winner

    event DexUpdated(address indexed previousDex, address indexed newDex);
    // event

    event TradeRecorded(uint256 indexed epochId, address indexed trader, uint256 volume);
    // event to monitor trades
    // opochrd: the time stamp
    event EpochFinalized(uint256 indexed epochId, address indexed winner, uint256 reward);
    // final set of events that defines the winner

    constructor(address ttokenAddress, address admin, address dexAddress) {
        require(ttokenAddress != address(0), "award: ttoken is zero");
        // preevntion of no token address
        require(admin != address(0), "award: admin is zero");
        // prevention of no admin address
        ttoken = ITTokenMintable(ttokenAddress);
        dex = dexAddress;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        // give a admin role to mint
    }

    function setDex(address newDex) external onlyRole(DEFAULT_ADMIN_ROLE) {
        // admin declare and update the dex address
        emit DexUpdated(dex, newDex);
        dex = newDex;
    }

    function currentEpoch() public view returns (uint256) {
        return block.timestamp / EPOCH_DURATION;
        // getter that returns the current epoch
    }

    function recordTrade(address trader, uint256 quoteVolume) external {
        // records trade
        require(msg.sender == dex, "award: only dex");
        // only truested account can call
        require(trader != address(0), "award: trader is zero");
        // checks the address is valid
        require(quoteVolume > 0, "award: volume is zero");

        uint256 epochId = currentEpoch();
        uint256 newVolume = volumeByEpoch[epochId][trader] + quoteVolume;
        volumeByEpoch[epochId][trader] = newVolume;

        if (newVolume > topVolumeByEpoch[epochId]) {
            topVolumeByEpoch[epochId] = newVolume;
            topTraderByEpoch[epochId] = trader;
            // defines the highest trader
        }

        emit TradeRecorded(epochId, trader, quoteVolume);
    }

    function finalizeEpoch(uint256 epochId) external {
        require(epochId < currentEpoch(), "award: epoch not ended");
        require(!rewarded[epochId], "award: already finalised");

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
