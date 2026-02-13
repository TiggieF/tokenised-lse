
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";


contract EquityToken is ERC20, AccessControl {
    
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    
    bytes32 public constant SNAPSHOT_ROLE = keccak256("SNAPSHOT_ROLE");
    // snapshot to record balance and total supply (dividends)
    struct Snapshots {
        uint256[] ids;
        uint256[] values;
        
    }

    mapping(address => Snapshots) private accountBalanceSnapshots;
    Snapshots private totalSupplySnapshots;
    uint256 private currentSnapshotId;

    event Snapshot(uint256 id);

    
    constructor(
        string memory name_,
        string memory symbol_,
        address admin,
        address minter
    ) ERC20(name_, symbol_) {
        require(admin != address(0), "equitytoken: admin is zero");
        require(minter != address(0), "equitytoken: minter is zero");

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, minter);
        _grantRole(SNAPSHOT_ROLE, admin);
    }

    
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        require(amount > 0, "equitytoken: amount must be > 0");
        // mint tokens
        _mint(to, amount);
    }

    function snapshot() external onlyRole(SNAPSHOT_ROLE) returns (uint256 snapshotId) {
        snapshotId = takeSnapshot();
        // return the snapshot for offchain
    }

    function balanceOfAt(address account, uint256 snapshotId) external view returns (uint256) {
        (bool found, uint256 value) = valueAt(snapshotId, accountBalanceSnapshots[account]);
        if (found) {
            return value;
        }
        return balanceOf(account);
        // getter
    }

    function totalSupplyAt(uint256 snapshotId) external view returns (uint256) {
        (bool found, uint256 value) = valueAt(snapshotId, totalSupplySnapshots);
        if (found) {
            return value;
        }
        return totalSupply();
        // getter for total supply(of this equity token) at snapshot
    }

    function takeSnapshot() internal returns (uint256 snapshotId) {
        currentSnapshotId = currentSnapshotId + 1;
        snapshotId = currentSnapshotId;
        emit Snapshot(snapshotId);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (currentSnapshotId > 0) {
            if (from != address(0)) {
                updateAccountSnapshot(from);
            }
            if (to != address(0)) {
                updateAccountSnapshot(to);
            }
            updateTotalSupplySnapshot();
        }
        super._update(from, to, value);
        // update snapshot on transfer mint burn
    }

    function updateAccountSnapshot(address account) private {
        updateSnapshot(accountBalanceSnapshots[account], balanceOf(account));
        // setter for account balance snapshot when transfer mint burn
    }

    function updateTotalSupplySnapshot() private {
        updateSnapshot(totalSupplySnapshots, totalSupply());
    }

    function updateSnapshot(Snapshots storage snapshots, uint256 currentValue) private {
        uint256 currentId = currentSnapshotId;
        if (lastSnapshotId(snapshots.ids) < currentId) {
            snapshots.ids.push(currentId);
            snapshots.values.push(currentValue);
        }
    }

    function valueAt(uint256 snapshotId, Snapshots storage snapshots)
        private
        view
        returns (bool found, uint256 value)
    {
        // getter for snapshot value, binary search for the snapshot id
        require(snapshotId > 0, "equitytoken: snapshot id is 0");
        uint256 index = findUpperBound(snapshots.ids, snapshotId);
        if (index == 0) {
            return (false, 0);
        }
        return (true, snapshots.values[index - 1]);
    }

    function lastSnapshotId(uint256[] storage ids) private view returns (uint256) {
        // getter for last snapshot id
        if (ids.length == 0) {
            return 0;
        }
        return ids[ids.length - 1];
    }

    function findUpperBound(uint256[] storage ids, uint256 snapshotId) private view returns (uint256) {
        // find upper bound
        uint256 low = 0;
        uint256 high = ids.length;
        while (low < high) {
            uint256 mid = (low + high) / 2;
            if (ids[mid] > snapshotId) {
                high = mid;
            } else {
                low = mid + 1;
            }
        }
        return low;
    }
}
