# MedoxieChain RVP demonstration contract

`MedoxieRVP.sol` mirrors the PPT state transitions: soft confirmation, challenge,
responsive proof commitment, and resolution. It is intentionally not a production
ZK verifier, fraud-proof system, staking contract, or slashing implementation.

The local node already exposes real L1 batch methods when started with a Foundry
Anvil sidecar:

- `anvil_zks_commitBatch`
- `anvil_zks_proveBatch`
- `anvil_zks_executeBatch`

The demo console invokes those methods through `./medoxie rollup ...`.
