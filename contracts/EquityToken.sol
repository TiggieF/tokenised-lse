pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract EquityToken is ERC20, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant SNAPSHOT_ROLE = keccak256("SNAPSHOT_ROLE");

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
        _mint(to, amount);
    }

    function snapshot() external onlyRole(SNAPSHOT_ROLE) returns (uint256 snapshotId) {
        snapshotId = takeSnapshot();
    }

    function balanceOfAt(address account, uint256 snapshotId) external view returns (uint256) {
        Snapshots storage snapshots = accountBalanceSnapshots[account];
        (bool found, uint256 value) = valueAt(snapshotId, snapshots);

        if (found) {
            return value;
        }

        uint256 currentBalance = balanceOf(account);
        return currentBalance;
    }

    function totalSupplyAt(uint256 snapshotId) external view returns (uint256) {
        (bool found, uint256 value) = valueAt(snapshotId, totalSupplySnapshots);

        if (found) {
            return value;
        }

        uint256 currentSupply = totalSupply();
        return currentSupply;
    }

    function takeSnapshot() internal returns (uint256 snapshotId) {
        currentSnapshotId = currentSnapshotId + 1;
        snapshotId = currentSnapshotId;

        emit Snapshot(snapshotId);
    }

    function _update(address from, address to, uint256 value) internal override {
        bool hasSnapshotContext = currentSnapshotId > 0;

        if (hasSnapshotContext) {
            bool hasFrom = from != address(0);
            bool hasTo = to != address(0);

            if (hasFrom) {
                updateAccountSnapshot(from);
            }

            if (hasTo) {
                updateAccountSnapshot(to);
            }

            updateTotalSupplySnapshot();
        }

        super._update(from, to, value);
    }

    function updateAccountSnapshot(address account) private {
        uint256 currentBalance = balanceOf(account);
        updateSnapshot(accountBalanceSnapshots[account], currentBalance);
    }

    function updateTotalSupplySnapshot() private {
        uint256 currentSupply = totalSupply();
        updateSnapshot(totalSupplySnapshots, currentSupply);
    }

    function updateSnapshot(Snapshots storage snapshots, uint256 currentValue) private {
        uint256 currentId = currentSnapshotId;
        uint256 latestStoredId = lastSnapshotId(snapshots.ids);

        if (latestStoredId < currentId) {
            snapshots.ids.push(currentId);
            snapshots.values.push(currentValue);
        }
    }

    function valueAt(uint256 snapshotId, Snapshots storage snapshots)
        private
        view
        returns (bool found, uint256 value)
    {
        require(snapshotId > 0, "equitytoken: snapshot id is 0");

        uint256 index = findUpperBound(snapshots.ids, snapshotId);

        if (index == snapshots.ids.length) {
            found = false;
            value = 0;
        } else {
            found = true;
            value = snapshots.values[index];
        }
    }

    function lastSnapshotId(uint256[] storage ids) private view returns (uint256) {
        if (ids.length == 0) {
            return 0;
        }

        uint256 index = ids.length - 1;
        uint256 id = ids[index];
        return id;
    }

    function findUpperBound(uint256[] storage ids, uint256 snapshotId) private view returns (uint256) {
        uint256 low = 0;
        uint256 high = ids.length;

        while (low < high) {
            uint256 mid = (low + high) / 2;
            uint256 midValue = ids[mid];

            if (midValue >= snapshotId) {
                high = mid;
            } else {
                low = mid + 1;
            }
        }

        return low;
    }
}
