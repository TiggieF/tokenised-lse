pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface ITTokenMintableMerkle {
    function mint(address to, uint256 amount) external;
}

interface IListingsRegistryMerkle {
    function isTokenListed(address token) external view returns (bool);
}

contract DividendsMerkle is AccessControl, ReentrancyGuard {
    ITTokenMintableMerkle public immutable ttoken;
    IListingsRegistryMerkle public immutable registry;

    struct MerkleEpoch {
        address equityToken;
        bytes32 merkleRoot;
        uint256 declaredAt;
        uint256 totalEntitledWei;
        uint256 totalClaimedWei;
        bytes32 contentHash;
        string claimsUri;
    }

    uint256 public merkleEpochCount;
    mapping(uint256 => MerkleEpoch) private merkleEpochs;
    mapping(uint256 => mapping(uint256 => uint256)) private claimedBitMap;

    event MerkleDividendDeclared(
        uint256 indexed epochId,
        address indexed equityToken,
        bytes32 merkleRoot,
        uint256 totalEntitledWei,
        bytes32 contentHash,
        string claimsUri
    );
    event MerkleDividendClaimed(
        uint256 indexed epochId,
        address indexed account,
        uint256 amountWei,
        uint256 leafIndex
    );

    constructor(address ttokenAddress, address registryAddress, address admin) {
        require(ttokenAddress != address(0), "dividendsmerkle: ttoken is zero");
        require(registryAddress != address(0), "dividendsmerkle: registry is zero");
        require(admin != address(0), "dividendsmerkle: admin is zero");

        ttoken = ITTokenMintableMerkle(ttokenAddress);
        registry = IListingsRegistryMerkle(registryAddress);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function declareMerkleDividend(
        address equityToken,
        bytes32 merkleRoot,
        uint256 totalEntitledWei,
        bytes32 contentHash,
        string calldata claimsUri
    ) external onlyRole(DEFAULT_ADMIN_ROLE) returns (uint256 epochId) {
        require(equityToken != address(0), "dividendsmerkle: equity token is zero");
        require(merkleRoot != bytes32(0), "dividendsmerkle: merkle root is zero");
        require(totalEntitledWei > 0, "dividendsmerkle: total entitled is zero");
        require(registry.isTokenListed(equityToken), "dividendsmerkle: not an equity token");

        epochId = merkleEpochCount + 1;
        merkleEpochCount = epochId;

        MerkleEpoch memory nextEpoch = MerkleEpoch({
            equityToken: equityToken,
            merkleRoot: merkleRoot,
            declaredAt: block.timestamp,
            totalEntitledWei: totalEntitledWei,
            totalClaimedWei: 0,
            contentHash: contentHash,
            claimsUri: claimsUri
        });
        merkleEpochs[epochId] = nextEpoch;

        emit MerkleDividendDeclared(
            epochId,
            equityToken,
            merkleRoot,
            totalEntitledWei,
            contentHash,
            claimsUri
        );
    }

    function claim(
        uint256 epochId,
        address account,
        uint256 amountWei,
        uint256 leafIndex,
        bytes32[] calldata proof
    ) external nonReentrant returns (uint256 mintedWei) {
        require(account != address(0), "dividendsmerkle: account is zero");
        require(msg.sender == account, "dividendsmerkle: sender must be account");
        require(amountWei > 0, "dividendsmerkle: amount is zero");

        MerkleEpoch storage epoch = merkleEpochs[epochId];
        require(epoch.equityToken != address(0), "dividendsmerkle: epoch not found");

        bool alreadyClaimed = isClaimed(epochId, leafIndex);
        require(!alreadyClaimed, "dividendsmerkle: already claimed");

        bytes32 leaf = keccak256(
            abi.encode(epochId, epoch.equityToken, account, amountWei, leafIndex)
        );
        bytes32 rebuilt = processProofLeftRight(proof, leafIndex, leaf);
        bool valid = rebuilt == epoch.merkleRoot;
        require(valid, "dividendsmerkle: invalid proof");

        setClaimed(epochId, leafIndex);

        uint256 nextClaimedWei = epoch.totalClaimedWei + amountWei;
        require(
            nextClaimedWei <= epoch.totalEntitledWei,
            "dividendsmerkle: total claimed exceeds entitled"
        );
        epoch.totalClaimedWei = nextClaimedWei;

        mintedWei = amountWei;
        ttoken.mint(account, mintedWei);

        emit MerkleDividendClaimed(epochId, account, mintedWei, leafIndex);
    }

    function getEpoch(uint256 epochId) external view returns (MerkleEpoch memory epoch) {
        epoch = merkleEpochs[epochId];
    }

    function isClaimed(uint256 epochId, uint256 leafIndex) public view returns (bool) {
        uint256 bucket = leafIndex / 256;
        uint256 mask = 1 << (leafIndex % 256);
        uint256 claimedWord = claimedBitMap[epochId][bucket];
        return claimedWord & mask == mask;
    }

    function previewLeaf(
        uint256 epochId,
        address account,
        uint256 amountWei,
        uint256 leafIndex,
        bytes32[] calldata proof
    ) external view returns (bool valid, bool claimed) {
        MerkleEpoch storage epoch = merkleEpochs[epochId];
        if (epoch.equityToken == address(0)) {
            return (false, false);
        }
        bytes32 leaf = keccak256(
            abi.encode(epochId, epoch.equityToken, account, amountWei, leafIndex)
        );
        bytes32 rebuilt = processProofLeftRight(proof, leafIndex, leaf);
        valid = rebuilt == epoch.merkleRoot;
        claimed = isClaimed(epochId, leafIndex);
    }

    function setClaimed(uint256 epochId, uint256 leafIndex) internal {
        uint256 bucket = leafIndex / 256;
        uint256 bitMask = 1 << (leafIndex % 256);
        claimedBitMap[epochId][bucket] = claimedBitMap[epochId][bucket] | bitMask;
    }

    function processProofLeftRight(
        bytes32[] calldata proof,
        uint256 leafIndex,
        bytes32 leaf
    ) internal pure returns (bytes32 value) {
        value = leaf;
        uint256 index = leafIndex;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 sibling = proof[i];
            if (index % 2 == 0) {
                value = keccak256(abi.encodePacked(value, sibling));
            } else {
                value = keccak256(abi.encodePacked(sibling, value));
            }
            index = index / 2;
        }
    }
}
