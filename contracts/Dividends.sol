// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface ITTokenMintable {
    function mint(address to, uint256 amount)
        external;
}

interface IEquityTokenSnapshot {
    function snapshot()
        external
        returns (uint256);

    function balanceOfAt(address account, uint256 snapshotId)
        external
        view
        returns (uint256);

    function totalSupplyAt(uint256 snapshotId)
        external
        view
        returns (uint256);
}

interface IListingsRegistry {
    function isTokenListed(address token)
        external
        view
        returns (bool);
}

/**
 * @title Dividends
 * @notice Snapshot-based, per-share dividends paid in TToken.
 */
contract Dividends is AccessControl, ReentrancyGuard {
    uint256 public constant MIN_DIV_PER_SHARE = 1e16; // 0.01 TToken per share
    uint256 public constant SHARE_UNIT = 1e18;

    ITTokenMintable public immutable ttoken;
    IListingsRegistry public immutable registry;

    struct DividendEpoch {
        uint256 snapshotId;
        uint256 divPerShareWei;
        uint256 declaredAt;
        uint256 totalClaimedWei;
        uint256 totalSupplyAtSnapshot;
    }

    mapping(address => uint256) public epochCount;
    mapping(address => mapping(uint256 => DividendEpoch)) public epochs;
    mapping(address => mapping(uint256 => mapping(address => bool))) public claimed;

    event DividendDeclared(
        address indexed equityToken,
        uint256 indexed epochId,
        uint256 snapshotId,
        uint256 divPerShareWei
    );
    event DividendClaimed(
        address indexed equityToken,
        uint256 indexed epochId,
        address indexed account,
        uint256 amountWei
    );

    constructor(address ttokenAddress, address registryAddress, address admin) {
        require(ttokenAddress != address(0), "dividends: ttoken is zero");
        require(registryAddress != address(0), "dividends: registry is zero");
        require(admin != address(0), "dividends: admin is zero");

        ttoken = ITTokenMintable(ttokenAddress);
        registry = IListingsRegistry(registryAddress);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function declareDividendPerShare(address equityToken, uint256 divPerShareWei)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        returns (uint256 epochId, uint256 snapshotId)
    {
        require(equityToken != address(0), "dividends: equity token is zero");
        require(registry.isTokenListed(equityToken), "dividends: not an equity token");
        require(divPerShareWei >= MIN_DIV_PER_SHARE, "dividends: div per share too small");

        snapshotId = IEquityTokenSnapshot(equityToken).snapshot();
        epochId = ++epochCount[equityToken];

        uint256 supplyAt = IEquityTokenSnapshot(equityToken).totalSupplyAt(snapshotId);
        epochs[equityToken][epochId] = DividendEpoch({
            snapshotId: snapshotId,
            divPerShareWei: divPerShareWei,
            declaredAt: block.timestamp,
            totalClaimedWei: 0,
            totalSupplyAtSnapshot: supplyAt
        });

        emit DividendDeclared(equityToken, epochId, snapshotId, divPerShareWei);
    }

    function claimDividend(address equityToken, uint256 epochId)
        external
        nonReentrant
        returns (uint256 mintedWei)
    {
        DividendEpoch storage epoch = epochs[equityToken][epochId];
        require(epoch.snapshotId != 0, "dividends: epoch not found");
        require(!claimed[equityToken][epochId][msg.sender], "dividends: already claimed");

        uint256 bal = IEquityTokenSnapshot(equityToken).balanceOfAt(msg.sender, epoch.snapshotId);
        require(bal > 0, "dividends: no balance");

        mintedWei = (bal * epoch.divPerShareWei) / SHARE_UNIT;
        require(mintedWei > 0, "dividends: nothing to claim");

        claimed[equityToken][epochId][msg.sender] = true;
        epoch.totalClaimedWei += mintedWei;

        ttoken.mint(msg.sender, mintedWei);
        emit DividendClaimed(equityToken, epochId, msg.sender, mintedWei);
    }

    function previewClaim(address equityToken, uint256 epochId, address account)
        external
        view
        returns (uint256 amountWei)
    {
        DividendEpoch storage epoch = epochs[equityToken][epochId];
        if (epoch.snapshotId == 0) {
            return 0;
        }
        if (claimed[equityToken][epochId][account]) {
            return 0;
        }
        uint256 bal = IEquityTokenSnapshot(equityToken).balanceOfAt(account, epoch.snapshotId);
        if (bal == 0) {
            return 0;
        }
        return (bal * epoch.divPerShareWei) / SHARE_UNIT;
    }

    function isClaimed(address equityToken, uint256 epochId, address account) external view returns (bool) {
        return claimed[equityToken][epochId][account];
    }
}
