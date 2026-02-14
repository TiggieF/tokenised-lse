pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract TToken is ERC20, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    uint256 public constant MAX_SUPPLY = 3e50;
    uint256 public constant AIRDROP_AMOUNT = 1_000_000 * 1e18;

    mapping(address => bool) private airdropClaimed;

    event AirdropClaimed(address indexed account, uint256 amount);

    constructor() ERC20("Tokenised dollar", "TToken") {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(MINTER_ROLE, msg.sender);
    }

    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        mintWithCap(to, amount);
    }

    function airdropOnce() external returns (uint256 amount) {
        address caller = msg.sender;
        bool alreadyClaimed = airdropClaimed[caller];

        require(!alreadyClaimed, "ttoken: airdrop already claimed");

        airdropClaimed[caller] = true;

        amount = AIRDROP_AMOUNT;
        mintWithCap(caller, amount);

        emit AirdropClaimed(caller, amount);
    }

    function hasClaimedAirdrop(address account) external view returns (bool) {
        bool claimed = airdropClaimed[account];
        return claimed;
    }

    function mintWithCap(address to, uint256 amount) internal {
        require(amount > 0, "ttoken: amount must be > 0");

        uint256 currentSupply = totalSupply();
        uint256 nextSupply = currentSupply + amount;

        require(nextSupply <= MAX_SUPPLY, "ttoken: cap exceeded");

        _mint(to, amount);
    }
}
