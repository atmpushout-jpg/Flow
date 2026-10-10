// SPDX-License-Identifier: MIT
// Deploy FlowIntentRouter to Base Sepolia (testnet, fake funds only).
//
// Usage:
//   cp .env.example .env   # fill in AUCTIONEER, FEE_RECIPIENT, PRIVATE_KEY
//   forge script script/Deploy.s.sol --rpc-url https://sepolia.base.org --broadcast
//
// Never use a mainnet key. Never deploy this to mainnet without an audit.

pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../contracts/FlowIntentRouter.sol";

contract Deploy is Script {
    function run() external {
        address auctioneer = vm.envAddress("AUCTIONEER");
        address feeRecipient = vm.envAddress("FEE_RECIPIENT");
        require(auctioneer != address(0), "AUCTIONEER not set");
        require(feeRecipient != address(0), "FEE_RECIPIENT not set");

        uint256 chainId = block.chainid;
        require(chainId == 84532, "not Base Sepolia (84532)");

        vm.startBroadcast();
        FlowIntentRouter router = new FlowIntentRouter(auctioneer, feeRecipient);
        // Blast-radius limiter: cap each fill at $25 of tokenIn (USDC 6 decimals).
        // Tighten or loosen with setMaxAmountIn as needed.
        router.setMaxAmountIn(25e6);
        vm.stopBroadcast();

        console.log("FlowIntentRouter deployed at:", address(router));
        console.log("  auctioneer:  ", router.auctioneer());
        console.log("  feeRecipient:", router.feeRecipient());
        console.log("  baseFeeBps:  ", router.baseFeeBps());
        console.log("  improvementShareBps:", router.improvementShareBps());
        console.log("  maxAmountIn: ", router.maxAmountIn());
        console.log("  chainId:     ", chainId);
    }
}
