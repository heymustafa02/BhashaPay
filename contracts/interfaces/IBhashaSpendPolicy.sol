// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IBhashaSpendPolicy {
    function owner() external view returns (address);
    function consume(address payer, address merchant, uint256 amount, bytes32 requestHash) external;
}
