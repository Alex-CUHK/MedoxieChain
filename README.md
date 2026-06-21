# MedoxieChain

MedoxieChain is a local Layer 2 development network and operations console for
building, testing, and presenting MDX-based blockchain workflows on macOS.

The project provides a real local execution node together with presentation-ready
terminal dashboards for L1/L2 transfers, Rollup status, responsive ZK workflows,
DPoS supernode management, Solidity contracts, and OpenClaw-controlled operations.

## Core Features

- MedoxieChain-branded local L2 node with Chain ID `270`
- Native MDX balances, transfers, gas accounting, and transaction records
- Optional local Ethereum L1 Sidecar
- L1-to-L2 and L2-to-L1 local MDX bridge workflows
- DPoS supernode registry, delegation, invitations, and PoS reward curve
- Responsive ZK, RVP watcher/challenger, sequencer, and Rollup dashboards
- Dynamic block production, gateway availability, and utilization charts
- Solidity workspace with compile, deploy, read, and write commands
- HelloWorld smart contract example
- OpenClaw project skill with a controlled blockchain action policy

## Requirements

- macOS or Linux
- Rust and Cargo
- Node.js 20 or newer
- Foundry tools (`forge`, `cast`, and `anvil`)

Repository-local Foundry binaries are detected under `.medoxie-tools/bin`.

## Quick Start

```bash
git clone https://github.com/Alex-CUHK/MedoxieChain.git
cd MedoxieChain
chmod +x medoxie
./medoxie build
./medoxie chain start
```

Check the running network:

```bash
./medoxie chain status
./medoxie chain logs
```

Stop the managed node:

```bash
./medoxie chain stop
```

## L1 and L2 Mode

Start L2 only:

```bash
./medoxie chain start
```

Start the L1 Sidecar together with L2:

```bash
./medoxie chain start --l1
```

The default endpoints are:

| Network | Endpoint | Chain ID |
| --- | --- | --- |
| MedoxieChain L2 | `http://127.0.0.1:8011` | `270` |
| Local L1 Sidecar | `http://127.0.0.1:8012` | `31337` |

## MDX Operations

```bash
./medoxie balance l2 <address>
./medoxie balance l1 <address>
./medoxie send l2 <address> <amount>
./medoxie send l1 <address> <amount>
./medoxie bridge l1-to-l2 <address> <amount>
./medoxie bridge l2-to-l1 <address> <amount>
```

## DPoS Supernodes

```bash
./medoxie supernode list
./medoxie supernode stake medoxie-genesis <amount>
./medoxie supernode invite <address> [name]
```

The reward panel uses an Ethereum-style inverse-square-root issuance curve:
estimated APR decreases as total active stake increases. The current network
stake and APR are marked directly on the terminal chart.

## Smart Contracts

List and edit Solidity contracts:

```bash
./medoxie contract list
./medoxie contract new <name>
./medoxie contract edit <name>
./medoxie contract show <name>
```

Compile and deploy:

```bash
./medoxie contract compile HelloWorld
./medoxie contract deploy l2 HelloWorld
./medoxie contract deployments
```

Read and update the deployed HelloWorld contract:

```bash
./medoxie contract read l2 <contract-address> 'message()(string)'
./medoxie contract write l2 <contract-address> 'setMessage(string)' 'Hello from MDX'
```

The contract workspace is located under `smart-contracts/` and uses Foundry.

## OpenClaw Integration

The repository includes a project skill at
`.agents/skills/medoxiechain-operator/`. It exposes a controlled allowlist for
balance queries, MDX transfers, contract compilation, deployment, reads, and
writes.

```bash
./medoxie openclaw status
./medoxie openclaw actions
./medoxie openclaw install
```

State-changing OpenClaw actions require explicit user confirmation. The adapter
rejects commands outside the declared policy and does not expose arbitrary shell
execution.

## Network Modules

```bash
./medoxie privacy transfer
./medoxie zk watch
./medoxie rvp watch
./medoxie rvp challenge [batch]
./medoxie sequencer watch
./medoxie rollup status
./medoxie rollup commit [batch]
./medoxie rollup prove [batch]
./medoxie rollup execute [batch]
./medoxie showcase
```

The complete English command reference is available in
[`MedoxieChain_Commands_Simple_EN.txt`](MedoxieChain_Commands_Simple_EN.txt).

## Architecture

```text
OpenClaw / Terminal
        |
        v
MedoxieChain Command Console
        |
        +---- L2 RPC :8011 ---- Sequencer ---- State / Batches
        |
        +---- L1 RPC :8012 ---- Settlement Sidecar
        |
        +---- Solidity / Foundry ---- Contract Deployments
```

## Scope and Accuracy

Values marked `LIVE` are queried from local JSON-RPC or produced by real local
transactions and compiler runs. Values marked `MODELED` represent workflow and
presentation behavior; they must not be described as production proving,
decentralized multi-node consensus, or production trustless bridging.

MedoxieChain uses the open-source
[`anvil-zksync`](https://github.com/matter-labs/anvil-zksync) execution engine as
its local L2 foundation.

## License

Licensed under MIT or Apache-2.0. See `LICENSE-MIT` and `LICENSE-APACHE`.
