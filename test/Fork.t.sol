// SPDX-License-Identifier: MIT
// Base mainnet fork test: full Flow fill flow against REAL chain state.
// Real USDC, real WETH, real Uniswap V3 quoter baseline.
//
// Run: forge test --fork-url https://mainnet.base.org --match-contract FlowForkTest -vv
// $0 cost. No faucet. Read-only fork + local execution.

pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../contracts/FlowIntentRouter.sol";

struct QuoteParams {
    address tokenIn;
    address tokenOut;
    uint256 amountIn;
    uint24 fee;
    uint160 sqrtPriceLimitX96;
}

interface IQuoterV2 {
    function quoteExactInputSingle(QuoteParams calldata params)
        external
        returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate);
}

contract FlowForkTest is Test {
    // Base mainnet (fork)
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant QUOTER_V2 = 0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a;

    FlowIntentRouter router;
    address auctioneer;
    uint256 auctioneerPk;
    address feeRecipient;
    address user;
    uint256 userPk;
    address filler;

    function setUp() public {
        (auctioneer, auctioneerPk) = makeAddrAndKey("auctioneer");
        feeRecipient = makeAddr("feeRecipient");
        (user, userPk) = makeAddrAndKey("user");
        filler = makeAddr("filler");

        router = new FlowIntentRouter(auctioneer, feeRecipient);

        // Fund with REAL mainnet tokens via deal
        deal(USDC, user, 1_000e6); // $1000 USDC
        deal(WETH, filler, 10 ether);
        vm.deal(filler, 10 ether); // gas + bond

        vm.prank(user);
        IERC20(USDC).approve(address(router), type(uint256).max);
        vm.prank(filler);
        IERC20(WETH).approve(address(router), type(uint256).max);
        vm.prank(filler);
        router.depositBond{value: 1 ether}();
    }

    /// @notice Get a real baseline quote from Uniswap V3 on the fork.
    function _realBaseline(address tokenIn, address tokenOut, uint256 amountIn)
        internal
        returns (uint256 best)
    {
        IQuoterV2 quoter = IQuoterV2(QUOTER_V2);
        uint24[3] memory fees = [uint24(500), uint24(3000), uint24(10000)];
        for (uint256 i = 0; i < 3; i++) {
            QuoteParams memory p = QuoteParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                amountIn: amountIn,
                fee: fees[i],
                sqrtPriceLimitX96: 0
            });
            try quoter.quoteExactInputSingle(p) returns (
                uint256 amountOut, uint160, uint32, uint256
            ) {
                if (amountOut > best) best = amountOut;
            } catch (bytes memory reason) {
                // QuoterV2 reverts with the quote abi-encoded
                if (reason.length >= 32) {
                    uint256 amountOut = abi.decode(reason, (uint256));
                    if (amountOut > best) best = amountOut;
                }
            }
        }
        require(best > 0, "no baseline quote");
    }

    function test_Fork_FullFillFlow_RealTokens() public {
        uint256 amountIn = 100e6; // $100 USDC
        uint256 baseline = _realBaseline(USDC, WETH, amountIn);
        emit log_named_uint("Real baseline WETH out", baseline);

        // Filler bids 10 bps better than baseline
        uint256 bidOut = (baseline * 10010) / 10000;

        FlowIntentRouter.Intent memory it = FlowIntentRouter.Intent({
            user: user,
            tokenIn: USDC,
            tokenOut: WETH,
            amountIn: amountIn,
            minAmountOut: (baseline * 99) / 100,
            expiry: block.timestamp + 120,
            nonce: 0
        });

        bytes32 intentHash = router.hashIntent(it);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, intentHash);
        bytes memory userSig = abi.encodePacked(r, s, v);

        bytes32 auctionHash = keccak256(
            abi.encodePacked(address(router), block.chainid, intentHash, filler, bidOut, baseline)
        );
        bytes32 ethHash =
            keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", auctionHash));
        (v, r, s) = vm.sign(auctioneerPk, ethHash);
        bytes memory auctionSig = abi.encodePacked(r, s, v);

        uint256 userWethBefore = IERC20(WETH).balanceOf(user);
        uint256 feeWethBefore = IERC20(WETH).balanceOf(feeRecipient);

        vm.prank(filler);
        router.fillIntent(it, userSig, bidOut, baseline, auctionSig);

        uint256 userGot = IERC20(WETH).balanceOf(user) - userWethBefore;
        uint256 feeGot = IERC20(WETH).balanceOf(feeRecipient) - feeWethBefore;

        // User got more than baseline would give (net of the 25% improvement fee)
        uint256 improvement = bidOut - baseline;
        uint256 expectedFee = improvement / 4; // 25%
        assertEq(feeGot, expectedFee, "protocol fee mismatch");
        assertEq(userGot, bidOut - expectedFee, "user amount mismatch");
        assertGt(userGot, (baseline * 999) / 1000, "user should beat baseline");

        emit log_named_uint("User received WETH", userGot);
        emit log_named_uint("Protocol fee WETH", feeGot);
        emit log_string("FORK TEST PASSED: real tokens, real quoter, full settlement");
    }
}
