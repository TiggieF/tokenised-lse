// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title TToken
 * @notice Tokenised Great British Pound (TToken) stable token used as the base
 *         settlement asset for the Tokenised LSE exchange.  The contract is a
 *         standard ERC-20 token with a hard supply cap and role-based minting
 *         controls.  In addition to regular ERC-20 functionality, it provides
 *         a gas-efficient one-time airdrop mechanism that any wallet can call
 *         to receive an initial balance of tokens.
 *
 *         Key design points (cross-referenced with the Stage 1 specification):
 *           - Max supply of 3 × 10^50 units enforced on every mint (manual or
 *             via the public airdrop function).
 *           - AccessControl governs privileged actions.  The deployer receives
 *             both the DEFAULT_ADMIN_ROLE (full permissions) and a dedicated
 *             MINTER_ROLE for operational minting.
 *           - `airdropOnce()` ensures each wallet can only claim the 1,000,000
 *             TToken signup reward a single time.
 *
 *         The contract is intentionally verbose in its inline documentation to
 *         help readers who are new to Solidity follow the control flow.
 */
contract TToken is ERC20, AccessControl {
    /// @notice Role identifier used to control privileged minting actions.
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @notice Absolute maximum number of tokens that can ever exist.
    ///         3e50 = 3 × 10^50 units, expressed with the standard 18 decimals
    ///         used by ERC-20 tokens.  The value comfortably exceeds any
    ///         plausible circulating supply while acting as an explicit guard
    ///         against runaway inflation bugs.
    uint256 public constant MAX_SUPPLY = 3e50;

    /// @notice Amount dispensed when a wallet calls {airdropOnce} for the first
    ///         time.  1,000,000 whole tokens with 18 decimal places.
    uint256 public constant AIRDROP_AMOUNT = 1_000_000 * 1e18;

    /// @dev Tracks whether an address has already received the signup airdrop.
    mapping(address => bool) private _airdropClaimed;

    /// @notice Emitted whenever a wallet successfully claims the airdrop.
    event AirdropClaimed(address indexed account, uint256 amount);

    /**
     * @dev Upon deployment the sender becomes both the contract administrator
     *      and the initial minter.  We purposefully do not mint any supply in
     *      the constructor so that governance can decide when to issue tokens.
     */
    constructor() ERC20("Tokenised dollar", "TToken") {
        // Grant the deployer the admin role so they can manage other roles.
        _grantRole(DEFAULT_ADMIN_ROLE, _msgSender());
        // The deployer also receives the minter role for operational minting.
        _grantRole(MINTER_ROLE, _msgSender());
    }

    /**
     * @notice Mints new TToken tokens to the supplied address.  Access is limited
     *         to accounts that hold the {MINTER_ROLE}.
     * @param to Recipient of the newly minted tokens.
     * @param amount Number of tokens (including decimals) to create.
     *
     * Requirements:
     *  - Caller must hold the `MINTER_ROLE`.
     *  - Post-mint total supply must not exceed {MAX_SUPPLY}.
     */
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mintWithCap(to, amount);
    }

    /**
     * @notice Allows any wallet to claim the onboarding airdrop exactly once.
     *         The tokens are minted directly to the caller to avoid approving
     *         third parties and to keep the function trustless.
     * @return amount The number of tokens minted to the caller.
     */
    function airdropOnce() external returns (uint256 amount) {
        address caller = _msgSender();
        require(!_airdropClaimed[caller], "TToken:Airdrop already claimed");

        _airdropClaimed[caller] = true;
        amount = AIRDROP_AMOUNT;
        _mintWithCap(caller, amount);

        emit AirdropClaimed(caller, amount);
    }

    /**
     * @notice Helper view that external systems (e.g. the frontend) can use to
     *         check whether an account has already claimed its airdrop.
     * @param account Address to inspect.
     * @return True if the account has already claimed, false otherwise.
     */
    function hasClaimedAirdrop(address account) external view returns (bool) {
        return _airdropClaimed[account];
    }

    /**
     * @dev Internal mint helper that enforces the global supply cap before
     *      delegating to the standard ERC-20 `_mint` implementation.
     */
    function _mintWithCap(address to, uint256 amount) internal {
        require(amount > 0, "TToken: amount must be > 0");
        require(totalSupply() + amount <= MAX_SUPPLY, "TToken: cap exceeded");
        _mint(to, amount);
    }
}
