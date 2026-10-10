// SPDX-License-Identifier: MIT
// FlowFlashArb v1 — $0-capital triangular arbitrage on Base.
// Borrows via Aave V3 flash loan, executes multi-hop swaps, repays in one tx.
// If profit doesn't cover premium + minProfit, the whole tx reverts.
// Operator only pays gas (~$0.05-0.10 per attempt, win or lose).

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

interface ISwapRouter {
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
        external
        returns (uint256 amountOut);
}

/// @title FlowFlashArb
/// @notice Executes triangular arbitrage with flash-loaned capital.
/// @dev Only the owner (operator) can trigger. Profits sweep to owner.
contract FlowFlashArb is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IPoolAddressesProvider public immutable addressesProvider;
    ISwapRouter public router;

    struct Hop {
        address tokenOut;
        uint24 fee;
    }

    event ArbExecuted(address indexed asset, uint256 borrowed, uint256 profit);
    event RouterUpdated(address indexed oldRouter, address indexed newRouter);

    error OnlyPool();
    error OnlySelfInitiated();
    error RouteMustReturnToAsset();
    error NotProfitable();

    constructor(address _addressesProvider, address _router) Ownable(msg.sender) {
        addressesProvider = IPoolAddressesProvider(_addressesProvider);
        router = ISwapRouter(_router);
    }

    function setRouter(address _r) external onlyOwner {
        emit RouterUpdated(address(router), _r);
        router = ISwapRouter(_r);
    }

    function pool() public view returns (IPool) {
        return IPool(addressesProvider.getPool());
    }

    /// @notice Trigger a flash arbitrage. Hops must start and end at `asset`.
    /// @param asset Token to borrow (e.g. USDC).
    /// @param amount Amount to borrow.
    /// @param hops Swap path, each hop's output token + pool fee tier.
    /// @param minProfit Minimum net profit (after premium) or revert.
    function executeArb(
        address asset,
        uint256 amount,
        Hop[] calldata hops,
        uint256 minProfit
    ) external onlyOwner nonReentrant {
        bytes memory params = abi.encode(hops, minProfit);
        pool().flashLoanSimple(address(this), asset, amount, params, 0);
    }

    /// @notice Aave V3 callback. Executes swaps, verifies profit, approves repay.
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        if (msg.sender != address(pool())) revert OnlyPool();
        if (initiator != address(this)) revert OnlySelfInitiated();

        (Hop[] memory hops, uint256 minProfit) = abi.decode(params, (Hop[], uint256));

        uint256 currentAmount = amount;
        address currentToken = asset;
        for (uint256 i = 0; i < hops.length; i++) {
            IERC20(currentToken).approve(address(router), currentAmount);
            currentAmount = router.exactInputSingle(
                ISwapRouter.ExactInputSingleParams({
                    tokenIn: currentToken,
                    tokenOut: hops[i].tokenOut,
                    fee: hops[i].fee,
                    recipient: address(this),
                    amountIn: currentAmount,
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: 0
                })
            );
            currentToken = hops[i].tokenOut;
        }
        if (currentToken != asset) revert RouteMustReturnToAsset();

        uint256 owed = amount + premium;
        if (currentAmount < owed + minProfit) revert NotProfitable();

        IERC20(asset).approve(address(pool()), owed);

        emit ArbExecuted(asset, amount, currentAmount - owed);
        return true;
    }

    /// @notice Sweep any token balance (profits) to the owner.
    function sweep(address token) external onlyOwner {
        uint256 bal = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransfer(owner(), bal);
    }
}
