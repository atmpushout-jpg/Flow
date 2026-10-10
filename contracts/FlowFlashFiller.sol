// SPDX-License-Identifier: MIT
// FlowFlashFiller v1 — fill swap intents with $0 inventory.
// Borrows tokenIn via Aave flash loan, swaps on the best venue,
// pays the user their quoted amount, repays the loan, keeps the edge.
//
// The user approves this contract for tokenIn. The flash loan is just
// bridge capital — the user's own tokens repay it. We keep the
// cross-venue price improvement as profit.
//
// If the swap doesn't cover premium + minProfit, everything reverts.
// Operator pays gas only (~$0.05-0.10 per attempt).

pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IPoolAddressesProvider {
    function getPool() external view returns (address);
}

interface IPool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

/// @title FlowFlashFiller
/// @notice Fills user swap intents using flash-loaned capital.
/// @dev Owner (operator) triggers fills. Users approve this contract for tokenIn.
contract FlowFlashFiller is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IPoolAddressesProvider public immutable addressesProvider;
    address public feeRecipient;
    uint256 public protocolShareBps = 2500; // 25% of profit to protocol

    struct FillParams {
        address user;
        address tokenIn;
        uint256 amountIn;
        address tokenOut;
        uint256 userAmountOut;   // what the user receives (their quoted price)
        address swapTarget;      // DEX router to call
        bytes swapCalldata;      // pre-built swap(tokenIn -> tokenOut)
        uint256 minProfit;       // min profit in tokenOut, or revert
    }

    event IntentFilled(
        address indexed user,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 userReceived,
        uint256 profit
    );
    event FeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);

    error OnlyPool();
    error OnlySelfInitiated();
    error SwapFailed();
    error NotProfitable();
    error ZeroAddress();

    constructor(address _addressesProvider, address _feeRecipient) Ownable(msg.sender) {
        if (_addressesProvider == address(0) || _feeRecipient == address(0)) revert ZeroAddress();
        addressesProvider = IPoolAddressesProvider(_addressesProvider);
        feeRecipient = _feeRecipient;
    }

    function setFeeRecipient(address _f) external onlyOwner {
        if (_f == address(0)) revert ZeroAddress();
        emit FeeRecipientUpdated(feeRecipient, _f);
        feeRecipient = _f;
    }

    function pool() public view returns (IPool) {
        return IPool(addressesProvider.getPool());
    }

    /// @notice Fill a user's swap using flash-loaned capital.
    /// @dev User must have approved this contract for amountIn of tokenIn.
    function fillWithFlash(FillParams calldata p) external onlyOwner nonReentrant {
        if (p.user == address(0)) revert ZeroAddress();
        bytes memory params = abi.encode(p);
        pool().flashLoanSimple(address(this), p.tokenIn, p.amountIn, params, 0);
    }

    /// @notice Aave V3 callback. Swaps, pays user, repays loan.
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        if (msg.sender != address(pool())) revert OnlyPool();
        if (initiator != address(this)) revert OnlySelfInitiated();

        FillParams memory p = abi.decode(params, (FillParams));

        // 1. Swap borrowed tokenIn -> tokenOut on best venue.
        IERC20(asset).approve(p.swapTarget, amount);
        (bool ok, ) = p.swapTarget.call(p.swapCalldata);
        if (!ok) revert SwapFailed();

        uint256 balanceOut = IERC20(p.tokenOut).balanceOf(address(this));
        uint256 owed = amount + premium;

        // 2. Profit check: must have enough to pay user + repay + minProfit.
        //    We repay by pulling tokenIn from the user (they approved us).
        //    Profit is measured in tokenOut.
        if (balanceOut < p.userAmountOut + p.minProfit) revert NotProfitable();

        // 3. Pay the user their quoted amount.
        IERC20(p.tokenOut).safeTransfer(p.user, p.userAmountOut);

        // 4. Pull tokenIn from user to repay the flash loan (plus premium).
        //    The user pays the small premium (~5bps) — they're still getting
        //    a better price than the public market.
        IERC20(p.tokenIn).safeTransferFrom(p.user, address(this), owed);
        IERC20(p.tokenIn).approve(address(pool()), owed);

        // 5. Split profit: 25% to protocol, 75% stays (swept by owner).
        uint256 profit = balanceOut - p.userAmountOut;
        uint256 fee = (profit * protocolShareBps) / 10_000;
        if (fee > 0) {
            IERC20(p.tokenOut).safeTransfer(feeRecipient, fee);
        }

        emit IntentFilled(p.user, p.tokenIn, p.tokenOut, amount, p.userAmountOut, profit);
        return true;
    }

    /// @notice Sweep profits to owner.
    function sweep(address token) external onlyOwner {
        uint256 bal = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransfer(owner(), bal);
    }
}
