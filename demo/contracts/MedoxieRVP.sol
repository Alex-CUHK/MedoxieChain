// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Demonstration-only state machine for the PPT's responsive validity proof flow.
/// @dev This contract records proof commitments; it is not a production ZK verifier.
contract MedoxieRVP {
    enum BatchStatus {
        None,
        SoftConfirmed,
        Challenged,
        DemoProofAccepted,
        Rejected
    }

    struct Batch {
        bytes32 stateRoot;
        bytes32 dataCommitment;
        bytes32 proofCommitment;
        address challenger;
        BatchStatus status;
    }

    address public immutable sequencer;
    mapping(uint256 batchNumber => Batch) public batches;

    event BatchSoftConfirmed(uint256 indexed batchNumber, bytes32 stateRoot, bytes32 dataCommitment);
    event BatchChallenged(uint256 indexed batchNumber, address indexed challenger, bytes32 reasonHash);
    event DemoProofResolved(uint256 indexed batchNumber, bytes32 proofCommitment, bool accepted);

    error OnlySequencer();
    error InvalidTransition();

    constructor(address sequencer_) {
        sequencer = sequencer_;
    }

    function softConfirm(uint256 batchNumber, bytes32 stateRoot, bytes32 dataCommitment) external {
        if (msg.sender != sequencer) revert OnlySequencer();
        Batch storage batch = batches[batchNumber];
        if (batch.status != BatchStatus.None) revert InvalidTransition();
        batch.stateRoot = stateRoot;
        batch.dataCommitment = dataCommitment;
        batch.status = BatchStatus.SoftConfirmed;
        emit BatchSoftConfirmed(batchNumber, stateRoot, dataCommitment);
    }

    function challenge(uint256 batchNumber, bytes32 reasonHash) external payable {
        Batch storage batch = batches[batchNumber];
        if (batch.status != BatchStatus.SoftConfirmed) revert InvalidTransition();
        batch.challenger = msg.sender;
        batch.status = BatchStatus.Challenged;
        emit BatchChallenged(batchNumber, msg.sender, reasonHash);
    }

    function resolveDemoProof(uint256 batchNumber, bytes32 proofCommitment, bool accepted) external {
        if (msg.sender != sequencer) revert OnlySequencer();
        Batch storage batch = batches[batchNumber];
        if (batch.status != BatchStatus.Challenged) revert InvalidTransition();
        batch.proofCommitment = proofCommitment;
        batch.status = accepted ? BatchStatus.DemoProofAccepted : BatchStatus.Rejected;
        emit DemoProofResolved(batchNumber, proofCommitment, accepted);
    }
}
