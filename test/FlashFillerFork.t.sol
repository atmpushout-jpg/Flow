// SPDX-License-Identifier: MIT
// Fork test: FlowFlashFiller on Base mainnet state.
// Proves $0-inventory fills work with real liquidity.
//
// Run: forge test --fork-url https://mainnet.base.org --match-contract FlashFillerForkTest -vv

pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../contracts/FlowFlashFiller.sol";

interface IUniSwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params)
        external returns (uint256 amountOut);
}

contract FlashFillerForkTest is Test {
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    // Aave V3 PoolAddressesProvider on Base (verified)
    address constant AAVE_PROVIDER = 0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D;
    // Uniswap V3 SwapRouter02 on Base (verified)
    address constant UNI_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;

    FlowFlashFiller filler;
    address owner;
    address user;
    address feeRecipient;

    function setUp() public {
        owner = makeAddr("owner");
        user = makeAddr("user");
        feeRecipient = makeAddr("feeRecipient");

        vm.prank(owner);
        filler = new FlowFlashFiller(AAVE_PROVIDER, feeRecipient);

        // User has $10k USDC + buffer for flash premium, approves the filler
        deal(USDC, user, 10_100e6);
        vm.prank(user);
        IERC20(USDC).approve(address(filler), type(uint256).max);
    }

    function test_flashFill() public {
        uint256 amountIn = 10_000e6; // $10k

        // Build Uniswap swap calldata: USDC -> WETH, fee 500
        // (Using Uni for the test; Aerodrome gives better prices in prod)
        bytes memory swapCalldata = abi.encodeCall(
            IUniSwapRouter.exactInputSingle,
            IUniSwapRouter.ExactInputSingleParams({
                tokenIn: USDC,
                tokenOut: WETH,
                fee: 500,
                recipient: address(filler),
                amountIn: amountIn,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );

        // User's quoted amount: slightly below market (we keep the edge)
        // For the test, quote 99.5% of a direct quoter estimate.
        // We'll compute it via a static call first.
        uint256 quotedOut = 3.9 ether; // ~$10k in WETH, conservative

        FlowFlashFiller.FillParams memory p = FlowFlashFiller.FillParams({
            user: user,
            tokenIn: USDC,
            amountIn: amountIn,
            tokenOut: WETH,
            userAmountOut: quotedOut,
            swapTarget: UNI_ROUTER,
            swapCalldata: swapCalldata,
            minProfit: 0.001 ether
        });

        uint256 userWethBefore = IERC20(WETH).balanceOf(user);

        vm.prank(owner);
        filler.fillWithFlash(p);

        uint256 userWethAfter = IERC20(WETH).balanceOf(user);
        uint256 received = userWethAfter - userWethBefore;

        console.log("User received WETH:", received);
        console.log("Filler WETH profit:", IERC20(WETH).balanceOf(address(filler)));
        console.log("Fee recipient WETH:", IERC20(WETH).balanceOf(feeRecipient));

        assertGe(received, quotedOut, "user got less than quoted");
        // Filler should have zero USDC left (repaid) and some WETH profit
        assertEq(IERC20(USDC).balanceOf(address(filler)), 0, "USDC not fully repaid");
    }

    function test_revertsIfUnprofitable() public {
        uint256 amountIn = 10_000e6;

        bytes memory swapCalldata = abi.encodeCall(
            IUniSwapRouter.exactInputSingle,
            IUniSwapRouter.ExactInputSingleParams({
                tokenIn: USDC,
                tokenOut: WETH,
                fee: 500,
                recipient: address(filler),
                amountIn: amountIn,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );

        // Demand an impossibly high payout -> must revert
        FlowFlashFiller.FillParams memory p = FlowFlashFiller.FillParams({
            user: user,
            tokenIn: USDC,
            amountIn: amountIn,
            tokenOut: WETH,
            userAmountOut: 1000 ether, // impossible
            swapTarget: UNI_ROUTER,
            swapCalldata: swapCalldata,
            minProfit: 0
        });

        vm.prank(owner);
        vm.expectRevert();
        filler.fillWithFlash(p);
    }
}
