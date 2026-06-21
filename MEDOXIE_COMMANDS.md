# MedoxieChain local operations guide

This fork keeps the real `matter-labs/anvil-zksync` execution engine and adds a
MedoxieChain-branded terminal experience based on the supplied RVP flowcharts.
The managed local node enables local account impersonation so the console can
submit test transactions without exposing or prompting for private keys.

## Quick start

```bash
./medoxie build
./medoxie chain start
./medoxie showcase
```

Stop the managed node with:

```bash
./medoxie chain stop
```

## Module commands

| Command | Function | Evidence level |
| --- | --- | --- |
| `./medoxie chain status` | L2 RPC, chain ID, block, batch, accounts | Live node data |
| `./medoxie chain logs` | Gateway availability chart, recent blocks, transactions, and performance | Live node data |
| `./medoxie send l1 <address> <amount>` | Send native MDX through the live L1 sidecar | Live L1 transaction |
| `./medoxie send l2 <address> <amount>` | Send native MDX through the live L2 node | Live L2 transaction |
| `./medoxie balance l1 <address>` | Query an address's native MDX balance on L1 | Live L1 RPC |
| `./medoxie balance l2 <address>` | Query an address's native MDX balance on L2 | Live L2 RPC |
| `./medoxie bridge l1-to-l2 <address> <amount>` | Debit L1 and credit L2 using privileged local RPC | Local development bridge |
| `./medoxie bridge l2-to-l1 <address> <amount>` | Debit L2 and credit L1 using privileged local RPC | Local development bridge |
| `./medoxie contract list` | List Solidity source files and compilation state | Local workspace |
| `./medoxie contract new <name>` | Create a simple Solidity source template | Local workspace |
| `./medoxie contract edit <name>` | Edit Solidity in the terminal editor | Local workspace |
| `./medoxie contract show <name>` | Print Solidity source | Local workspace |
| `./medoxie contract compile [name]` | Compile one or all contracts with Foundry | Real Solidity compiler |
| `./medoxie contract deploy <l1\|l2> <name>` | Deploy compiled bytecode | Live transaction |
| `./medoxie contract deployments` | List recorded deployments | Local registry |
| `./medoxie contract read <l1\|l2> <address> '<signature>' [args]` | Read contract state | Live RPC |
| `./medoxie contract write <l1\|l2> <address> '<signature>' [args]` | Submit a contract state change | Live transaction |
| `./medoxie supernode list` | Show the DPoS registry, voting power, stake, and PoS reward curve | Live registry and local stake ledger |
| `./medoxie supernode stake <node-id> <amount> [wallet]` | Delegate live L2 MDX and record the bonded position | Live L2 transaction |
| `./medoxie supernode invite <address> [name]` | Issue a pending supernode candidate invitation | Local DPoS governance registry |
| `./medoxie privacy transfer` | Submit a real L2 transfer and display Orchard-style metadata | Live transaction; modeled note/nullifier |
| `./medoxie zk watch` | Responsive proof pipeline for the latest live batch | Modeled proof pipeline |
| `./medoxie rvp watch` | Watcher/challenger view over live block and batch state | Live input; modeled policy |
| `./medoxie rvp challenge [batch]` | Trigger the challenged-batch response flow | Modeled challenge/proof policy |
| `./medoxie sequencer watch` | Tendermint/BLS quorum presentation | Modeled quorum backed by live block input |
| `./medoxie rollup status` | L2-to-L1 status and sidecar detection | Live status |
| `./medoxie rollup commit [batch]` | Submit a batch commitment through the upstream L1 sidecar | Live when L1 is enabled |
| `./medoxie rollup prove [batch]` | Submit the upstream batch proof transaction | Live when L1 is enabled |
| `./medoxie rollup execute [batch]` | Execute the upstream batch on L1 | Live when L1 is enabled |
| `./medoxie openclaw status` | Check project skill, CLI, Gateway, and policy state | Local connector |
| `./medoxie openclaw actions` | Show actions exposed to OpenClaw | Local policy |
| `./medoxie openclaw install` | Install the project skill into an OpenClaw workspace | Requires OpenClaw CLI |

## L1 mode

The real L1 sidecar requires Foundry `anvil >= 1.0.0`. The launcher also
searches the repository-local `.medoxie-tools/bin` directory before the system
`PATH`:

```bash
foundryup
./medoxie chain start --l1
./medoxie rollup status
```

`--l1` uses manual batch settlement so a failed L1 transaction does not enter an
automatic retry loop. The local launcher pins the sidecar to protocol v28 for
boot compatibility. The current upstream commitment generator can still panic on
empty pubdata information after a plain local transfer, so the console blocks the
privacy-transfer command while L1 mode is active. Use L2-only mode for the full
walkthrough and L1 mode for topology/status and settlement-RPC experiments.

## Truth boundary

Every terminal panel states its evidence level. `LIVE` values are queried from
JSON-RPC. `MODELED` stages are presentation visualizations and must not be
described as production Orchard privacy, a deployed ZK circuit, decentralized BLS
consensus, or economic slashing. The Solidity contract under the local contract
module is a
state-machine prototype only.

The `bridge` commands perform real balance changes on both local chains through
privileged development RPC methods. They are useful for local presentations but
are not a production trustless bridge or validity-proof settlement path.

The supernode registry has one active genesis operator by default. Candidate
invitations remain pending until a self-bond and governance vote are completed.
The staking APR uses the Ethereum-style inverse-square-root issuance shape and
is an estimate; realized yield depends on validator performance and policy.
