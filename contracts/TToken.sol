
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
// balance tranfer mint and total supply

contract TToken is ERC20, AccessControl {
    
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    // defines the minter which account one in deployment 
    // account ending 79c8
    
    uint256 public constant MAX_SUPPLY = 3e50;
    // maxmium supply, just random larger number i selected
    
    
    uint256 public constant AIRDROP_AMOUNT = 1_000_000 * 1e18;
    // airdrop for 1million
    mapping(address => bool) private airdropClaimed;


    // airdrop status
    event AirdropClaimed(address indexed account, uint256 amount);

    
    constructor() ERC20("Tokenised dollar", "TToken") {
        // token name and symbol
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        // grants roll for both admin and minter which would be the default account 0 and 1
        _grantRole(MINTER_ROLE, msg.sender);
    }

    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        mintWithCap(to, amount);
        // capping
    }

    
    function airdropOnce() external returns (uint256 amount) {
        // airdrop once
        address caller = msg.sender;
        require(!airdropClaimed[caller], "ttoken: airdrop already claimed");

        airdropClaimed[caller] = true;
        amount = AIRDROP_AMOUNT;
        mintWithCap(caller, amount);
        emit AirdropClaimed(caller, amount);
    }

    
    function hasClaimedAirdrop(address account) external view returns (bool) {
        return airdropClaimed[account];
        // getter for airdrop status
    }

    
    function mintWithCap(address to, uint256 amount) internal {
        require(amount > 0, "ttoken: amount must be > 0");
        require(totalSupply() + amount <= MAX_SUPPLY, "ttoken: cap exceeded");
        _mint(to, amount);
        // capping
    }
}
