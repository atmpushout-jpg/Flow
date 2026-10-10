// SPDX-License-Identifier: MIT
// Fork setup helper: deal USDC to the test user. Run against anvil fork only.
pragma solidity ^0.8.24;
import "forge-std/Script.sol";

contract DealUSDC is Script {
    function run() external {
        deal(
            0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913,
            0x70997970C51812dc3A010C7d01b50e0d17dc79C8,
            10_000e6
        );
    }
}
