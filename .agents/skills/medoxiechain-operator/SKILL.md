---
name: medoxiechain-operator
description: Safely query MedoxieChain, send MDX, and compile, deploy, read, or write Solidity contracts through controlled commands.
user-invocable: true
---

# MedoxieChain Operator

Use the controlled adapter at `{baseDir}/scripts/medoxiechain.sh`. Never invoke
the repository CLI through an arbitrary shell expression, never use `eval`, and
never request, display, or store private keys.

## Read-only actions

These may run immediately when requested:

```bash
"{baseDir}/scripts/medoxiechain.sh" chain status
"{baseDir}/scripts/medoxiechain.sh" balance l2 <address>
"{baseDir}/scripts/medoxiechain.sh" balance l1 <address>
"{baseDir}/scripts/medoxiechain.sh" contract list
"{baseDir}/scripts/medoxiechain.sh" contract deployments
"{baseDir}/scripts/medoxiechain.sh" contract read l2 <address> '<signature>' [args]
"{baseDir}/scripts/medoxiechain.sh" contract read l1 <address> '<signature>' [args]
"{baseDir}/scripts/medoxiechain.sh" rollup status
"{baseDir}/scripts/medoxiechain.sh" supernode list
```

## State-changing actions

Before running any action below, state the network, address or contract, amount
or function arguments, and ask the user for explicit confirmation. Do not infer
confirmation from an earlier unrelated message.

```bash
"{baseDir}/scripts/medoxiechain.sh" send l2 <address> <amount>
"{baseDir}/scripts/medoxiechain.sh" send l1 <address> <amount>
"{baseDir}/scripts/medoxiechain.sh" contract compile <name>
"{baseDir}/scripts/medoxiechain.sh" contract deploy l2 <name>
"{baseDir}/scripts/medoxiechain.sh" contract deploy l1 <name>
"{baseDir}/scripts/medoxiechain.sh" contract write l2 <address> '<signature>' [args]
"{baseDir}/scripts/medoxiechain.sh" contract write l1 <address> '<signature>' [args]
```

After execution, report the transaction hash, block number, contract address,
or returned value exactly as printed by the adapter. If a command fails, report
the failure and do not retry a state-changing action without fresh confirmation.

For L2 sends, deployments, and contract writes, use L2-only mode. L1 operations
require the L1 Sidecar. Never switch node modes without asking the user first.
