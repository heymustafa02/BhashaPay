// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IBhashaSpendPolicy} from "./interfaces/IBhashaSpendPolicy.sol";

contract AgentSpendPolicy is Ownable, IBhashaSpendPolicy {
    address public immutable settlement;
    uint256 public totalBudget;
    uint256 public totalSpent;
    uint256 public perMerchantLimit;
    uint256 public approvalThreshold;

    mapping(address => bool) public allowedMerchants;
    mapping(address => uint256) public merchantSpent;
    mapping(bytes32 => bool) public approvedRequests;

    error OnlySettlement();
    error InvalidSettlement();
    error MerchantNotAllowed();
    error TotalBudgetExceeded();
    error MerchantLimitExceeded();
    error ApprovalRequired();

    event PolicyConfigured(uint256 totalBudget, uint256 perMerchantLimit, uint256 approvalThreshold);
    event MerchantAllowlistUpdated(address indexed merchant, bool allowed);
    event RequestApproved(bytes32 indexed requestHash);
    event SpendRecorded(address indexed payer, address indexed merchant, uint256 amount, bytes32 indexed requestHash);

    constructor(address settlement_, address owner_) Ownable(owner_) {
        if (settlement_ == address(0)) revert InvalidSettlement();
        settlement = settlement_;
    }

    function owner() public view override(Ownable, IBhashaSpendPolicy) returns (address) {
        return super.owner();
    }

    function configure(uint256 budget, uint256 merchantLimit, uint256 threshold) external onlyOwner {
        totalBudget = budget;
        perMerchantLimit = merchantLimit;
        approvalThreshold = threshold;
        emit PolicyConfigured(budget, merchantLimit, threshold);
    }

    function setMerchantAllowed(address merchant, bool allowed) external onlyOwner {
        allowedMerchants[merchant] = allowed;
        emit MerchantAllowlistUpdated(merchant, allowed);
    }

    function approveRequest(bytes32 requestHash) external onlyOwner {
        approvedRequests[requestHash] = true;
        emit RequestApproved(requestHash);
    }

    function consume(address payer, address merchant, uint256 amount, bytes32 requestHash) external {
        if (msg.sender != settlement) revert OnlySettlement();
        if (!allowedMerchants[merchant]) revert MerchantNotAllowed();
        if (totalSpent + amount > totalBudget) revert TotalBudgetExceeded();
        if (merchantSpent[merchant] + amount > perMerchantLimit) revert MerchantLimitExceeded();
        if (amount > approvalThreshold) {
            if (!approvedRequests[requestHash]) revert ApprovalRequired();
            delete approvedRequests[requestHash];
        }

        totalSpent += amount;
        merchantSpent[merchant] += amount;
        emit SpendRecorded(payer, merchant, amount, requestHash);
    }
}
