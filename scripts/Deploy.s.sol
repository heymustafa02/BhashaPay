// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {BhashaRegistry} from "../contracts/BhashaRegistry.sol";
import {BhashaSettlement} from "../contracts/BhashaSettlement.sol";

interface Vm {
    function envAddress(string calldata) external returns (address);
    function envUint(string calldata) external returns (uint256);
    function startBroadcast() external;
    function stopBroadcast() external;
}

contract Deploy {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external {
        address usdt = vm.envAddress("WHITECHAIN_USDT_ADDRESS");
        address relayer = vm.envAddress("WHITECHAIN_RELAYER_ADDRESS");
        address deployer = vm.envAddress("WHITECHAIN_DEPLOYER_ADDRESS");
        uint256 maxAmount = vm.envUint("WHITECHAIN_MAX_SETTLEMENT");

        vm.startBroadcast();
        BhashaRegistry registry = new BhashaRegistry(deployer);
        BhashaSettlement settlement =
            new BhashaSettlement(usdt, address(registry), deployer, maxAmount, relayer);
        vm.stopBroadcast();

        require(address(registry) != address(0) && address(settlement) != address(0), "deployment failed");
    }
}
