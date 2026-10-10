// SPDX-License-Identifier: MIT
// FlowIntentRouter test suite: happy path + 6 failure cases.
// Run: forge test -vv

pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../contracts/FlowIntentRouter.sol";

/// @notice Minimal mock ERC20 for testing.
contract MockERC20 is ERC20 {
    uint8 private _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_)
        ERC20(name_, symbol_)
    {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract FlowIntentRouterTest is Test {
    FlowIntentRouter router;
    MockERC20 tokenIn; // mock USDC (6 decimals)
    MockERC20 tokenOut; // mock WETH (18 decimals)

    address owner;
    address auctioneer;
    uint256 auctioneerPk;
    address feeRecipient;
    address user;
    uint256 userPk;
    address filler;
    address stranger;
    uint256 strangerPk;

    uint256 constant AMOUNT_IN = 1_000e6; // $1000 USDC
    uint256 constant BASELINE_OUT = 0.4 ether; // 0.4 WETH baseline

    function setUp() public {
        owner = address(this);
        (auctioneer, auctioneerPk) = makeAddrAndKey("auctioneer");
        feeRecipient = makeAddr("feeRecipient");
        (user, userPk) = makeAddrAndKey("user");
        filler = makeAddr("filler");
        (stranger, strangerPk) = makeAddrAndKey("stranger");

        router = new FlowIntentRouter(auctioneer, feeRecipient);
        tokenIn = new MockERC20("USD Coin", "USDC", 6);
        tokenOut = new MockERC20("Wrapped Ether", "WETH", 18);

        // Fund user with tokenIn, filler with tokenOut
        tokenIn.mint(user, 100_000e6);
        tokenOut.mint(filler, 100 ether);

        // Approvals
        vm.prank(user);
        tokenIn.approve(address(router), type(uint256).max);
        vm.prank(filler);
        tokenOut.approve(address(router), type(uint256).max);

        // Filler posts bond
        vm.deal(filler, 10 ether);
        vm.prank(filler);
        router.depositBond{value: 1 ether}();
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    function _intent(uint256 nonce) internal view returns (FlowIntentRouter.Intent memory) {
        return FlowIntentRouter.Intent({
            user: user,
            tokenIn: address(tokenIn),
            tokenOut: address(tokenOut),
            amountIn: AMOUNT_IN,
            minAmountOut: (BASELINE_OUT * 95) / 100, // 5% slippage tolerance
            expiry: block.timestamp + 60,
            nonce: nonce
        });
    }

    function _userSig(FlowIntentRouter.Intent memory it) internal view returns (bytes memory) {
        bytes32 digest = router.hashIntent(it);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _auctionSig(
        bytes32 intentHash,
        address winner,
        uint256 amountOut,
        uint256 baselineOut
    ) internal view returns (bytes memory) {
        bytes32 auctionHash = keccak256(
            abi.encodePacked(address(router), block.chainid, intentHash, winner, amountOut, baselineOut)
        );
        bytes32 ethHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", auctionHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(auctioneerPk, ethHash);
        return abi.encodePacked(r, s, v);
    }

    function _fillArgs(FlowIntentRouter.Intent memory it, uint256 amountOut)
        internal
        view
        returns (bytes memory userSig, uint256 baselineOut, bytes memory auctionSig)
    {
        bytes32 intentHash = router.hashIntent(it);
        userSig = _userSig(it);
        baselineOut = BASELINE_OUT;
        auctionSig = _auctionSig(intentHash, filler, amountOut, baselineOut);
    }

    // -------------------------------------------------------------------------
    // Happy path
    // -------------------------------------------------------------------------

    function test_HappyPath_FillSucceeds() public {
        FlowIntentRouter.Intent memory it = _intent(0);
        uint256 amountOut = (BASELINE_OUT * 10015) / 10000; // 15 bps better
        (bytes memory userSig, uint256 baselineOut, bytes memory auctionSig) =
            _fillArgs(it, amountOut);

        uint256 userBalBefore = tokenOut.balanceOf(user);
        uint256 feeBalBefore = tokenOut.balanceOf(feeRecipient);

        vm.prank(filler);
        router.fillIntent(it, userSig, amountOut, baselineOut, auctionSig);

        // User got more than baseline net of fee
        uint256 improvement = amountOut - baselineOut;
        uint256 expectedFee = (improvement * 2500) / 10_000; // 25%
        assertEq(tokenOut.balanceOf(user), userBalBefore + amountOut - expectedFee);
        assertEq(tokenOut.balanceOf(feeRecipient), feeBalBefore + expectedFee);
        // Nonce consumed
        assertEq(router.nonces(user), 1);
        // Filler received tokenIn (no base fee at launch)
        assertEq(tokenIn.balanceOf(filler), AMOUNT_IN);
    }

    function test_HappyPath_ZeroImprovement_NoFee() public {
        FlowIntentRouter.Intent memory it = _intent(0);
        uint256 amountOut = BASELINE_OUT; // exactly baseline
        (bytes memory userSig, uint256 baselineOut, bytes memory auctionSig) =
            _fillArgs(it, amountOut);

        uint256 feeBalBefore = tokenOut.balanceOf(feeRecipient);
        vm.prank(filler);
        router.fillIntent(it, userSig, amountOut, baselineOut, auctionSig);
        assertEq(tokenOut.balanceOf(feeRecipient), feeBalBefore); // no fee taken
    }

    // -------------------------------------------------------------------------
    // Failure cases (6)
    // -------------------------------------------------------------------------

    /// @notice 1. Expired intent reverts.
    function test_Revert_ExpiredIntent() public {
        FlowIntentRouter.Intent memory it = _intent(0);
        it.expiry = block.timestamp - 1;
        uint256 amountOut = BASELINE_OUT;
        (bytes memory userSig, uint256 baselineOut, bytes memory auctionSig) =
            _fillArgs(it, amountOut);

        vm.prank(filler);
        vm.expectRevert(FlowIntentRouter.IntentExpired.selector);
        router.fillIntent(it, userSig, amountOut, baselineOut, auctionSig);
    }

    /// @notice 2. Replay of the same intent reverts (nonce consumed on first fill).
    function test_Revert_Replay() public {
        FlowIntentRouter.Intent memory it = _intent(0);
        uint256 amountOut = BASELINE_OUT;
        (bytes memory userSig, uint256 baselineOut, bytes memory auctionSig) =
            _fillArgs(it, amountOut);

        vm.prank(filler);
        router.fillIntent(it, userSig, amountOut, baselineOut, auctionSig);

        // Second attempt: nonce was consumed, so it reverts on BadNonce.
        // Either way the replay is blocked.
        vm.prank(filler);
        vm.expectRevert(FlowIntentRouter.BadNonce.selector);
        router.fillIntent(it, userSig, amountOut, baselineOut, auctionSig);
    }

    /// @notice 3. Tampered user signature reverts.
    function test_Revert_BadUserSig() public {
        FlowIntentRouter.Intent memory it = _intent(0);
        uint256 amountOut = BASELINE_OUT;
        (, uint256 baselineOut, bytes memory auctionSig) = _fillArgs(it, amountOut);

        // Sign with the WRONG key
        bytes32 digest = router.hashIntent(it);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(strangerPk, digest);
        bytes memory badSig = abi.encodePacked(r, s, v);

        vm.prank(filler);
        vm.expectRevert(FlowIntentRouter.BadUserSignature.selector);
        router.fillIntent(it, badSig, amountOut, baselineOut, auctionSig);
    }

    /// @notice 4. Fill by non-winning bidder reverts (auction sig binds msg.sender).
    function test_Revert_BadAuctionSig_WrongFiller() public {
        FlowIntentRouter.Intent memory it = _intent(0);
        uint256 amountOut = BASELINE_OUT;
        (bytes memory userSig, uint256 baselineOut,) = _fillArgs(it, amountOut);

        // Auction sig was made for `filler`, but stranger tries to fill
        bytes32 intentHash = router.hashIntent(it);
        bytes memory auctionSig = _auctionSig(intentHash, filler, amountOut, baselineOut);

        vm.prank(stranger);
        vm.expectRevert(FlowIntentRouter.BadAuctionSignature.selector);
        router.fillIntent(it, userSig, amountOut, baselineOut, auctionSig);
    }

    /// @notice 5. Bid below minAmountOut reverts.
    function test_Revert_BelowMinAmountOut() public {
        FlowIntentRouter.Intent memory it = _intent(0);
        uint256 amountOut = it.minAmountOut - 1;
        (bytes memory userSig, uint256 baselineOut, bytes memory auctionSig) =
            _fillArgs(it, amountOut);

        vm.prank(filler);
        vm.expectRevert(FlowIntentRouter.BelowMinAmountOut.selector);
        router.fillIntent(it, userSig, amountOut, baselineOut, auctionSig);
    }

    /// @notice 6. Unbonded filler reverts.
    function test_Revert_UnbondedFiller() public {
        FlowIntentRouter.Intent memory it = _intent(0);
        uint256 amountOut = BASELINE_OUT;
        bytes32 intentHash = router.hashIntent(it);
        bytes memory userSig = _userSig(it);
        // Auctioneer designates stranger (who never bonded)
        bytes memory auctionSig = _auctionSig(intentHash, stranger, amountOut, BASELINE_OUT);

        tokenOut.mint(stranger, 10 ether);
        vm.prank(stranger);
        tokenOut.approve(address(router), type(uint256).max);

        vm.prank(stranger);
        vm.expectRevert(FlowIntentRouter.FillerNotBonded.selector);
        router.fillIntent(it, userSig, amountOut, BASELINE_OUT, auctionSig);
    }

    /// @notice 7. REGRESSION (v0.2 fix): gross amountOut meets minAmountOut but the
    ///         user's NET receipt after the improvement fee would fall below it.
    ///         Must revert; the guarantee applies to what the user receives.
    function test_Revert_NetBelowMinAmountOut() public {
        FlowIntentRouter.Intent memory it = _intent(0);
        // amountOut exactly equals minAmountOut, but there IS improvement over
        // a lower baseline, so the fee pushes net below minAmountOut.
        uint256 amountOut = it.minAmountOut; // 0.38 ether
        uint256 baselineOut = (BASELINE_OUT * 925) / 1000; // 0.37 ether
        // improvement = 0.01 ether, fee = 25% = 0.0025 ether
        // userReceives = 0.3775 ether < 0.38 ether -> must revert
        bytes32 intentHash = router.hashIntent(it);
        bytes memory userSig = _userSig(it);
        bytes memory auctionSig = _auctionSig(intentHash, filler, amountOut, baselineOut);

        vm.prank(filler);
        vm.expectRevert(FlowIntentRouter.BelowMinAmountOut.selector);
        router.fillIntent(it, userSig, amountOut, baselineOut, auctionSig);
    }

    /// @notice 8. maxAmountIn cap: fills above the cap revert; at/below pass.
    function test_MaxAmountIn_CapEnforced() public {
        vm.prank(owner);
        router.setMaxAmountIn(AMOUNT_IN / 2);

        FlowIntentRouter.Intent memory it = _intent(0);
        uint256 amountOut = BASELINE_OUT;
        (bytes memory userSig, uint256 baselineOut, bytes memory auctionSig) =
            _fillArgs(it, amountOut);

        vm.prank(filler);
        vm.expectRevert(FlowIntentRouter.AmountInTooHigh.selector);
        router.fillIntent(it, userSig, amountOut, baselineOut, auctionSig);

        // Raise cap to exactly amountIn: fill succeeds
        vm.prank(owner);
        router.setMaxAmountIn(AMOUNT_IN);
        vm.prank(filler);
        router.fillIntent(it, userSig, amountOut, baselineOut, auctionSig);
        assertTrue(router.filled(router.hashIntent(it)));
    }

    // -------------------------------------------------------------------------
    // Admin / bond lifecycle
    // -------------------------------------------------------------------------

    function test_BondWithdraw() public {
        uint256 before = filler.balance;
        vm.prank(filler);
        router.withdrawBond(0.5 ether);
        assertEq(filler.balance, before + 0.5 ether);
        assertEq(router.bonds(filler), 0.5 ether);
    }

    function test_SlashBond() public {
        vm.prank(owner);
        router.slashBond(filler, 0.5 ether);
        assertEq(router.bonds(filler), 0.5 ether);
        assertEq(feeRecipient.balance, 0.5 ether);
    }

    function test_Revert_SetBaseFeeTooHigh() public {
        vm.prank(owner);
        vm.expectRevert(FlowIntentRouter.FeeTooHigh.selector);
        router.setBaseFeeBps(51);
    }

    function test_Revert_ZeroAddressAuctioneer() public {
        vm.prank(owner);
        vm.expectRevert(FlowIntentRouter.ZeroAddress.selector);
        router.setAuctioneer(address(0));
    }

    // -------------------------------------------------------------------------
    // Scaled edge cases
    // -------------------------------------------------------------------------

    /// @notice Improvement fee is capped at 10 bps of amountOut even when
    ///         raw 25% share would exceed it.
    function test_FeeCap_Enforced() public {
        FlowIntentRouter.Intent memory it = _intent(0);
        // Huge improvement: 200% over baseline
        uint256 amountOut = BASELINE_OUT * 3;
        (bytes memory userSig, uint256 baselineOut, bytes memory auctionSig) =
            _fillArgs(it, amountOut);

        uint256 feeBalBefore = tokenOut.balanceOf(feeRecipient);
        vm.prank(filler);
        router.fillIntent(it, userSig, amountOut, baselineOut, auctionSig);

        uint256 expectedCap = (amountOut * 10) / 10_000; // 10 bps cap
        assertEq(tokenOut.balanceOf(feeRecipient) - feeBalBefore, expectedCap);
    }

    /// @notice Dust-size intents settle correctly.
    function test_DustAmount_Settles() public {
        FlowIntentRouter.Intent memory it = _intent(0);
        it.amountIn = 100; // 0.0001 USDC
        it.minAmountOut = 1;
        uint256 amountOut = 2;
        bytes32 intentHash = router.hashIntent(it);
        bytes memory userSig = _userSig(it);
        bytes memory auctionSig = _auctionSig(intentHash, filler, amountOut, 1);

        tokenOut.mint(filler, 100);
        vm.prank(filler);
        router.fillIntent(it, userSig, amountOut, 1, auctionSig);
        assertTrue(router.filled(intentHash));
    }

    /// @notice After auctioneer rotation, old auctioneer sigs no longer work.
    function test_AuctioneerRotation_InvalidatesOldSigs() public {
        address newAuctioneer;
        uint256 newAuctioneerPk;
        (newAuctioneer, newAuctioneerPk) = makeAddrAndKey("auctioneer2");

        FlowIntentRouter.Intent memory it = _intent(0);
        uint256 amountOut = BASELINE_OUT;
        bytes32 intentHash = router.hashIntent(it);
        bytes memory userSig = _userSig(it);
        // Sig from the OLD auctioneer
        bytes memory oldAuctionSig = _auctionSig(intentHash, filler, amountOut, BASELINE_OUT);

        // Rotate
        vm.prank(owner);
        router.setAuctioneer(newAuctioneer);

        vm.prank(filler);
        vm.expectRevert(FlowIntentRouter.BadAuctionSignature.selector);
        router.fillIntent(it, userSig, amountOut, BASELINE_OUT, oldAuctionSig);

        // New auctioneer can authorize: sign with new key
        bytes32 auctionHash = keccak256(
            abi.encodePacked(address(router), block.chainid, intentHash, filler, amountOut, BASELINE_OUT)
        );
        bytes32 ethHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", auctionHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(newAuctioneerPk, ethHash);
        bytes memory newSig = abi.encodePacked(r, s, v);

        vm.prank(filler);
        router.fillIntent(it, userSig, amountOut, BASELINE_OUT, newSig);
        assertTrue(router.filled(intentHash));
    }

    /// @notice Base fee path: when enabled, base fee is taken in tokenIn.
    function test_BaseFee_TakenWhenEnabled() public {
        vm.prank(owner);
        router.setBaseFeeBps(3); // 3 bps

        FlowIntentRouter.Intent memory it = _intent(0);
        uint256 amountOut = BASELINE_OUT; // no improvement, only base fee
        (bytes memory userSig, uint256 baselineOut, bytes memory auctionSig) =
            _fillArgs(it, amountOut);

        uint256 feeInBefore = tokenIn.balanceOf(feeRecipient);
        uint256 fillerInBefore = tokenIn.balanceOf(filler);
        vm.prank(filler);
        router.fillIntent(it, userSig, amountOut, baselineOut, auctionSig);

        uint256 expectedBase = (AMOUNT_IN * 3) / 10_000;
        assertEq(tokenIn.balanceOf(feeRecipient) - feeInBefore, expectedBase);
        assertEq(tokenIn.balanceOf(filler) - fillerInBefore, AMOUNT_IN - expectedBase);

        // Reset to launch config
        vm.prank(owner);
        router.setBaseFeeBps(0);
    }

    /// @notice Events are emitted on admin actions.
    function test_Events_AdminActions() public {
        address newFee = makeAddr("newFee");
        vm.expectEmit(true, true, false, false);
        emit FlowIntentRouter.FeeRecipientUpdated(feeRecipient, newFee);
        vm.prank(owner);
        router.setFeeRecipient(newFee);
    }
}
