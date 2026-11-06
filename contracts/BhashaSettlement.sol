// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IHederaAuthorizationToken} from "./interfaces/IHederaAuthorizationToken.sol";
import {IBhashaSpendPolicy} from "./interfaces/IBhashaSpendPolicy.sol";
import {BhashaRegistry} from "./BhashaRegistry.sol";

contract BhashaSettlement is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IHederaAuthorizationToken;

    struct Receipt {
        bytes32 serviceId;
        address payer;
        address merchant;
        uint256 amount;
        uint64 timestamp;
        bytes32 requestHash;
        bool refunded;
    }

    IHederaAuthorizationToken public immutable token;
    BhashaRegistry public immutable registry;
    uint256 public maxAmountPerSettlement;
    uint256 public nextReceiptId = 1;
    mapping(address => bool) public relayers;
    mapping(address => address) public spendPolicies;
    mapping(bytes32 => bool) public usedRequestHashes;
    mapping(bytes32 => uint256) public receiptForRequestHash;
    mapping(uint256 => Receipt) public receipts;

    error InvalidAddress();
    error RelayerNotAllowed();
    error ServiceInactive();
    error AmountMismatch();
    error AmountExceedsRelayerLimit();
    error InvalidRequestHash();
    error RequestAlreadySettled();
    error InvalidPolicyOwner();
    error ReceiptNotFound();
    error NotReceiptMerchant();
    error AlreadyRefunded();

    event RelayerUpdated(address indexed relayer, bool allowed);
    event MaxAmountUpdated(uint256 oldAmount, uint256 newAmount);
    event SpendPolicyUpdated(address indexed payer, address indexed policy);
    event PaymentSettled(
        uint256 indexed receiptId,
        bytes32 indexed serviceId,
        address indexed payer,
        address merchant,
        uint256 amount,
        bytes32 requestHash
    );
    event PaymentRefunded(uint256 indexed receiptId, address indexed merchant, address indexed payer, uint256 amount);

    constructor(
        address token_,
        address registry_,
        address owner_,
        uint256 maxAmount_,
        address initialRelayer
    ) Ownable(owner_) {
        if (token_ == address(0) || registry_ == address(0) || initialRelayer == address(0)) {
            revert InvalidAddress();
        }
        token = IHederaAuthorizationToken(token_);
        registry = BhashaRegistry(registry_);
        maxAmountPerSettlement = maxAmount_;
        relayers[initialRelayer] = true;
        emit RelayerUpdated(initialRelayer, true);
        emit MaxAmountUpdated(0, maxAmount_);
    }

    modifier onlyRelayer() {
        if (!relayers[msg.sender]) revert RelayerNotAllowed();
        _;
    }

    function setRelayer(address relayer, bool allowed) external onlyOwner {
        if (relayer == address(0)) revert InvalidAddress();
        relayers[relayer] = allowed;
        emit RelayerUpdated(relayer, allowed);
    }

    function setMaxAmountPerSettlement(uint256 amount) external onlyOwner {
        uint256 oldAmount = maxAmountPerSettlement;
        maxAmountPerSettlement = amount;
        emit MaxAmountUpdated(oldAmount, amount);
    }

    function setSpendPolicy(address policy) external {
        if (policy != address(0) && IBhashaSpendPolicy(policy).owner() != msg.sender) {
            revert InvalidPolicyOwner();
        }
        spendPolicies[msg.sender] = policy;
        emit SpendPolicyUpdated(msg.sender, policy);
    }

    function getReceipt(uint256 receiptId) external view returns (Receipt memory) {
        return receipts[receiptId];
    }

    function settle(
        bytes32 serviceId,
        address payer,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature,
        bytes32 requestHash
    ) external onlyRelayer whenNotPaused nonReentrant returns (uint256 receiptId) {
        if (payer == address(0)) revert InvalidAddress();
        if (requestHash == bytes32(0)) revert InvalidRequestHash();
        if (usedRequestHashes[requestHash]) revert RequestAlreadySettled();

        BhashaRegistry.Service memory service = registry.getService(serviceId);
        if (!service.active) revert ServiceInactive();
        if (amount != service.price) revert AmountMismatch();
        if (amount > maxAmountPerSettlement) revert AmountExceedsRelayerLimit();

        address policy = spendPolicies[payer];
        if (policy != address(0)) {
            IBhashaSpendPolicy(policy).consume(payer, service.merchant, amount, requestHash);
        }

        usedRequestHashes[requestHash] = true;
        token.transferWithAuthorization(
            payer,
            service.merchant,
            amount,
            validAfter,
            validBefore,
            nonce,
            signature
        );

        receiptId = nextReceiptId++;
        receipts[receiptId] = Receipt({
            serviceId: serviceId,
            payer: payer,
            merchant: service.merchant,
            amount: amount,
            timestamp: uint64(block.timestamp),
            requestHash: requestHash,
            refunded: false
        });
        receiptForRequestHash[requestHash] = receiptId;
        emit PaymentSettled(receiptId, serviceId, payer, service.merchant, amount, requestHash);
    }

    function refund(uint256 receiptId) external nonReentrant {
        Receipt storage receipt = receipts[receiptId];
        if (receipt.timestamp == 0) revert ReceiptNotFound();
        if (msg.sender != receipt.merchant) revert NotReceiptMerchant();
        if (receipt.refunded) revert AlreadyRefunded();

        receipt.refunded = true;
        token.safeTransferFrom(receipt.merchant, receipt.payer, receipt.amount);
        emit PaymentRefunded(receiptId, receipt.merchant, receipt.payer, receipt.amount);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
