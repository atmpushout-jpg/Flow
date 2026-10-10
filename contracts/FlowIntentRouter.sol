// SPDX-License-Identifier: MIT
// AUDIT-CANDIDATE - NOT YET AUDITED - DO NOT USE WITH REAL FUNDS
//
// FlowIntentRouter v0.2
// Settles auctioned swap intents on Base. Users sign EIP-712 intents, an offchain
// auctioneer auctions each intent to bonded searchers, and the winning searcher
// fills it onchain. The protocol earns a share of the price improvement only.
// v0.2: minAmountOut now applies to the user's NET receipt (after protocol fee);
//       added maxAmountIn per-fill cap as a blast-radius limiter.
//
// Trust model: the auctioneer is trusted to run fair auctions and report honest
// baselines. Searchers are untrusted but bonded. Users trust the contract code.

pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title FlowIntentRouter
/// @notice Settles auctioned ERC-20 swap intents with protocol fee on price improvement.
/// @dev EIP-712 domain: name "FlowIntentRouter", version "0".
contract FlowIntentRouter is EIP712, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    /// @notice A user's signed swap intent.
    /// @dev Signed via EIP-712; see hashIntent for the exact encoding.
    struct Intent {
        address user;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut;
        uint256 expiry;
        uint256 nonce;
    }

    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    uint256 private constant BPS_DENOMINATOR = 10_000;
    uint256 private constant MAX_BASE_FEE_BPS = 50;
    uint256 private constant MAX_IMPROVEMENT_SHARE_BPS = 5_000;
    uint256 private constant MAX_IMPROVEMENT_FEE_BPS = 100;

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error ZeroAddress();
    error IntentExpired();
    error BadNonce();
    error AlreadyFilled();
    error BadUserSignature();
    error BadAuctionSignature();
    error BelowMinAmountOut();
    error FillerNotBonded();
    error InsufficientBond();
    error FeeTooHigh();
    error AmountInTooHigh();
    error SlashTransferFailed();
    error WithdrawTransferFailed();

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    /// @notice Offchain auctioneer authorized to designate fill winners.
    address public auctioneer;
    /// @notice Recipient of protocol fees.
    address public feeRecipient;
    /// @notice Base fee in bps on amountIn. 0 at launch.
    uint256 public baseFeeBps;
    /// @notice Protocol share of price improvement, in bps. 2500 = 25%.
    uint256 public improvementShareBps;
    /// @notice Cap on the improvement fee as bps of amountOut.
    uint256 public maxImprovementFeeBps;
    /// @notice Per-fill cap on tokenIn amount. 0 = no cap. Set before mainnet use.
    /// @dev Blast-radius limiter for unaudited deployments: bounds the value at
    ///      risk in any single fill.
    uint256 public maxAmountIn;

    /// @notice Per-user nonce for replay protection.
    mapping(address => uint256) public nonces;
    /// @notice Intent hash => filled.
    mapping(bytes32 => bool) public filled;
    /// @notice Searcher => bonded ETH.
    mapping(address => uint256) public bonds;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event IntentFilled(
        bytes32 indexed intentHash,
        address indexed user,
        address indexed filler,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutToUser,
        uint256 protocolFee
    );
    event BondDeposited(address indexed searcher, uint256 amount);
    event BondWithdrawn(address indexed searcher, uint256 amount);
    event BondSlashed(address indexed searcher, uint256 amount, address indexed recipient);
    event AuctioneerUpdated(address indexed oldAuctioneer, address indexed newAuctioneer);
    event FeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);
    event BaseFeeUpdated(uint256 oldBps, uint256 newBps);
    event ImprovementShareUpdated(uint256 oldBps, uint256 newBps);
    event MaxAmountInUpdated(uint256 oldMax, uint256 newMax);

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    /// @param _auctioneer Address authorized to sign auction wins.
    /// @param _feeRecipient Address receiving protocol fees.
    constructor(address _auctioneer, address _feeRecipient)
        EIP712("FlowIntentRouter", "0")
        Ownable(msg.sender)
    {
        if (_auctioneer == address(0) || _feeRecipient == address(0)) revert ZeroAddress();
        auctioneer = _auctioneer;
        feeRecipient = _feeRecipient;
        baseFeeBps = 0;
        improvementShareBps = 2500;
        maxImprovementFeeBps = 10;
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    /// @notice Rotate the auctioneer.
    function setAuctioneer(address _a) external onlyOwner {
        if (_a == address(0)) revert ZeroAddress();
        emit AuctioneerUpdated(auctioneer, _a);
        auctioneer = _a;
    }

    /// @notice Rotate the fee recipient.
    function setFeeRecipient(address _f) external onlyOwner {
        if (_f == address(0)) revert ZeroAddress();
        emit FeeRecipientUpdated(feeRecipient, _f);
        feeRecipient = _f;
    }

    /// @notice Set base fee in bps, capped at 50.
    function setBaseFeeBps(uint256 _b) external onlyOwner {
        if (_b > MAX_BASE_FEE_BPS) revert FeeTooHigh();
        emit BaseFeeUpdated(baseFeeBps, _b);
        baseFeeBps = _b;
    }

    /// @notice Set improvement share in bps, capped at 5000.
    function setImprovementShareBps(uint256 _s) external onlyOwner {
        if (_s > MAX_IMPROVEMENT_SHARE_BPS) revert FeeTooHigh();
        emit ImprovementShareUpdated(improvementShareBps, _s);
        improvementShareBps = _s;
    }

    /// @notice Set the per-fill cap on tokenIn amount. 0 disables the cap.
    /// @dev For unaudited mainnet use, set this to a small value to bound risk.
    function setMaxAmountIn(uint256 _m) external onlyOwner {
        emit MaxAmountInUpdated(maxAmountIn, _m);
        maxAmountIn = _m;
    }

    /// @notice Slash a searcher's bond, sending it to the fee recipient.
    /// @dev Only callable by owner; intended for proven misbehavior.
    function slashBond(address searcher, uint256 amount) external onlyOwner {
        if (bonds[searcher] < amount) revert InsufficientBond();
        bonds[searcher] -= amount;
        (bool ok, ) = feeRecipient.call{value: amount}("");
        if (!ok) revert SlashTransferFailed();
        emit BondSlashed(searcher, amount, feeRecipient);
    }

    // -------------------------------------------------------------------------
    // Searcher bonds
    // -------------------------------------------------------------------------

    /// @notice Deposit ETH as a searcher bond.
    function depositBond() external payable {
        bonds[msg.sender] += msg.value;
        emit BondDeposited(msg.sender, msg.value);
    }

    /// @notice Withdraw bonded ETH. Searchers are free to exit.
    function withdrawBond(uint256 amount) external nonReentrant {
        if (bonds[msg.sender] < amount) revert InsufficientBond();
        bonds[msg.sender] -= amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert WithdrawTransferFailed();
        emit BondWithdrawn(msg.sender, amount);
    }

    // -------------------------------------------------------------------------
    // Intent hashing
    // -------------------------------------------------------------------------

    /// @notice EIP-712 hash of an intent, as signed by the user.
    /// @dev Must match the offchain auctioneer's eip712IntentHash exactly.
    function hashIntent(Intent calldata it) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    keccak256(
                        "Intent(address user,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint256 expiry,uint256 nonce)"
                    ),
                    it.user,
                    it.tokenIn,
                    it.tokenOut,
                    it.amountIn,
                    it.minAmountOut,
                    it.expiry,
                    it.nonce
                )
            )
        );
    }

    // -------------------------------------------------------------------------
    // Settlement
    // -------------------------------------------------------------------------

    /// @notice Fill an auctioned intent. Caller must be the auctioneer-designated winner.
    /// @param it The user's intent.
    /// @param userSig EIP-712 signature by the user over the intent.
    /// @param amountOut Total tokenOut the filler delivers (before protocol fee).
    /// @param baselineOut Baseline quote, used to compute the improvement fee.
    /// @param auctionSig Auctioneer's signature over (this, chainid, intentHash, filler, amountOut, baselineOut).
    /// @dev Flow: validate -> mark filled -> pull tokenIn from user -> pull tokenOut
    ///      from filler -> pay user, fee recipient, filler. Checks-effects-interactions
    ///      with nonReentrant guard.
    function fillIntent(
        Intent calldata it,
        bytes calldata userSig,
        uint256 amountOut,
        uint256 baselineOut,
        bytes calldata auctionSig
    ) external nonReentrant {
        if (block.timestamp > it.expiry) revert IntentExpired();
        if (it.nonce != nonces[it.user]) revert BadNonce();
        if (it.user == address(0)) revert ZeroAddress();

        bytes32 intentHash = hashIntent(it);
        if (filled[intentHash]) revert AlreadyFilled();

        if (ECDSA.recover(intentHash, userSig) != it.user) revert BadUserSignature();

        bytes32 auctionHash = keccak256(
            abi.encodePacked(
                address(this),
                block.chainid,
                intentHash,
                msg.sender,
                amountOut,
                baselineOut
            )
        );
        if (ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(auctionHash), auctionSig) != auctioneer) {
            revert BadAuctionSignature();
        }

        if (bonds[msg.sender] == 0) revert FillerNotBonded();
        if (maxAmountIn > 0 && it.amountIn > maxAmountIn) revert AmountInTooHigh();

        // Compute all fees BEFORE any transfers, so the minAmountOut guarantee
        // applies to what the user actually receives (net of protocol fee).
        uint256 baseFee = (it.amountIn * baseFeeBps) / BPS_DENOMINATOR;
        uint256 amountInNet = it.amountIn - baseFee;

        uint256 improvementFee = 0;
        if (amountOut > baselineOut) {
            uint256 improvement = amountOut - baselineOut;
            improvementFee = (improvement * improvementShareBps) / BPS_DENOMINATOR;
            uint256 cap = (amountOut * maxImprovementFeeBps) / BPS_DENOMINATOR;
            if (improvementFee > cap) improvementFee = cap;
        }
        uint256 userReceives = amountOut - improvementFee;
        if (userReceives < it.minAmountOut) revert BelowMinAmountOut();

        // Effects: mark filled and consume nonce before external calls.
        filled[intentHash] = true;
        unchecked {
            nonces[it.user] = it.nonce + 1;
        }

        // Interactions.
        IERC20(it.tokenIn).safeTransferFrom(it.user, address(this), it.amountIn);
        if (baseFee > 0) {
            IERC20(it.tokenIn).safeTransfer(feeRecipient, baseFee);
        }

        IERC20(it.tokenOut).safeTransferFrom(msg.sender, address(this), amountOut);
        IERC20(it.tokenOut).safeTransfer(it.user, userReceives);
        if (improvementFee > 0) {
            IERC20(it.tokenOut).safeTransfer(feeRecipient, improvementFee);
        }
        IERC20(it.tokenIn).safeTransfer(msg.sender, amountInNet);

        emit IntentFilled(
            intentHash,
            it.user,
            msg.sender,
            it.tokenIn,
            it.tokenOut,
            it.amountIn,
            userReceives,
            baseFee + improvementFee
        );
    }
}
