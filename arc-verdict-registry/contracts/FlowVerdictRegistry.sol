// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Flow Verdict Registry (Arc)
/// @notice Permissionless, no-owner, no-funds registry that anchors Flow's
///         contract-safety verdicts on Arc mainnet (chain 5042).
///
///         Flow's /api/verify endpoint grades token/contract addresses on
///         Base (and other EVM chains): a 0-100 safety score and a
///         safe / caution / danger verdict. This registry stores a compact,
///         immutable attestation of each check — subject address, source
///         chain, score, verdict, and a keccak256 hash of the full verdict
///         payload — so any agent or app can confirm, on Arc, that Flow
///         graded a contract and exactly what it said.
///
///         The contract holds no funds, has no owner, no admin keys and no
///         upgrade path. Entries can never be edited or deleted. Recording
///         is permissionless: the recorder address is stored with every
///         entry so readers can weigh whose attestations they trust
///         (Flow's own recorder is the Flow operational wallet).
contract FlowVerdictRegistry {
    struct Verdict {
        address subject;     // contract/token address that was checked
        uint256 sourceChain; // chain the check ran on (8453 = Base)
        uint8 score;         // 0-100 safety score
        uint8 verdict;       // 0 = safe, 1 = caution, 2 = danger
        bytes32 verdictHash; // keccak256 of the canonical verdict payload
        address recorder;    // who anchored this entry
        uint64 timestamp;    // block timestamp of anchoring
    }

    Verdict[] private _verdicts;

    /// @notice How many verdicts exist for a subject address.
    mapping(address => uint256) public verdictCountFor;
    /// @notice Latest verdict id for a subject, stored as id + 1 (0 = none).
    mapping(address => uint256) public latestVerdictId;

    event VerdictRecorded(
        uint256 indexed id,
        address indexed subject,
        uint256 sourceChain,
        uint8 score,
        uint8 verdict,
        bytes32 verdictHash,
        address recorder
    );

    /// @notice Anchor a verdict attestation. Permissionless; costs gas only.
    /// @return id The sequential id assigned to the new entry.
    function recordVerdict(
        address subject,
        uint256 sourceChain,
        uint8 score,
        uint8 verdict,
        bytes32 verdictHash
    ) external returns (uint256 id) {
        require(subject != address(0), "zero subject");
        require(score <= 100, "score > 100");
        require(verdict <= 2, "verdict > 2");
        require(verdictHash != bytes32(0), "zero hash");

        id = _verdicts.length;
        _verdicts.push(
            Verdict({
                subject: subject,
                sourceChain: sourceChain,
                score: score,
                verdict: verdict,
                verdictHash: verdictHash,
                recorder: msg.sender,
                timestamp: uint64(block.timestamp)
            })
        );
        verdictCountFor[subject] += 1;
        latestVerdictId[subject] = id + 1;

        emit VerdictRecorded(id, subject, sourceChain, score, verdict, verdictHash, msg.sender);
    }

    /// @notice Total number of verdicts ever recorded.
    function totalVerdicts() external view returns (uint256) {
        return _verdicts.length;
    }

    /// @notice Read one entry by id.
    function getVerdict(uint256 id)
        external
        view
        returns (
            address subject,
            uint256 sourceChain,
            uint8 score,
            uint8 verdict,
            bytes32 verdictHash,
            address recorder,
            uint64 timestamp
        )
    {
        Verdict storage v = _verdicts[id];
        return (v.subject, v.sourceChain, v.score, v.verdict, v.verdictHash, v.recorder, v.timestamp);
    }

    /// @notice Read the most recent entry for a subject address.
    function latestFor(address subject)
        external
        view
        returns (
            bool found,
            uint256 id,
            uint8 score,
            uint8 verdict,
            bytes32 verdictHash,
            uint64 timestamp
        )
    {
        uint256 lid = latestVerdictId[subject];
        if (lid == 0) return (false, 0, 0, 0, bytes32(0), 0);
        Verdict storage v = _verdicts[lid - 1];
        return (true, lid - 1, v.score, v.verdict, v.verdictHash, v.timestamp);
    }
}
