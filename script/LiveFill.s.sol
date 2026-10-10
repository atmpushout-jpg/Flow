// SPDX-License-Identifier: MIT
// Live smoke test on Base Sepolia against the DEPLOYED FlowIntentRouter.
// Deploys mock tokens, mints, approves, bonds, signs intent + auction,
// and executes a full fillIntent on the live contract.
//
// Usage:
//   forge script script/LiveFill.s.sol --rpc-url https://sepolia.base.org --broadcast
//
// Requires .env: PRIVATE_KEY, ROUTER_ADDRESS
// Testnet only. Deployer plays user + filler + auctioneer for the smoke test.

pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../contracts/FlowIntentRouter.sol";

contract MockToken is ERC20 {
    uint8 private _d;
    constructor(string memory n, string memory s, uint8 d) ERC20(n, s) {
        _d = d;
    }
    function decimals() public view override returns (uint8) {
        return _d;
    }
    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

contract LiveFill is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(pk);
        address routerAddr = vm.envAddress("ROUTER_ADDRESS");
        FlowIntentRouter router = FlowIntentRouter(payable(routerAddr));

        require(router.auctioneer() == me, "deployer is not auctioneer");

        vm.startBroadcast(pk);

        // 1. Deploy mock tokens
        MockToken usdc = new MockToken("Test USDC", "tUSDC", 6);
        MockToken weth = new MockToken("Test WETH", "tWETH", 18);

        // 2. Mint to self
        usdc.mint(me, 1_000e6);
        weth.mint(me, 10 ether);

        // 3. Approve router + post bond
        usdc.approve(address(router), type(uint256).max);
        weth.approve(address(router), type(uint256).max);
        router.depositBond{value: 0.001 ether}();

        // 4. Build intent: $10 tUSDC -> tWETH
        uint256 amountIn = 10e6;
        uint256 baseline = 0.004 ether; // mock baseline quote
        uint256 bidOut = (baseline * 10010) / 10000; // 10 bps better
        FlowIntentRouter.Intent memory it = FlowIntentRouter.Intent({
            user: me,
            tokenIn: address(usdc),
            tokenOut: address(weth),
            amountIn: amountIn,
            minAmountOut: (baseline * 99) / 100,
            expiry: block.timestamp + 600,
            nonce: router.nonces(me)
        });

        // 5. Sign intent as user (EIP-712)
        bytes32 intentHash = router.hashIntent(it);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, intentHash);
        bytes memory userSig = abi.encodePacked(r, s, v);

        // 6. Sign auction authorization as auctioneer
        bytes32 auctionHash = keccak256(
            abi.encodePacked(address(router), block.chainid, intentHash, me, bidOut, baseline)
        );
        bytes32 ethHash =
            keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", auctionHash));
        (v, r, s) = vm.sign(pk, ethHash);
        bytes memory auctionSig = abi.encodePacked(r, s, v);

        // 7. Execute the fill on the live contract
        router.fillIntent(it, userSig, bidOut, baseline, auctionSig);

        uint256 improvement = bidOut - baseline;
        uint256 expectedFee = improvement / 4; // 25%

        console.log("LIVE FILL OK on Base Sepolia");
        console.log("  router:      ", routerAddr);
        console.log("  tUSDC:       ", address(usdc));
        console.log("  tWETH:       ", address(weth));
        console.log("  bidOut:      ", bidOut);
        console.log("  user net:    ", bidOut - expectedFee);
        console.log("  protocol fee:", expectedFee);

        vm.stopBroadcast();
    }
}
