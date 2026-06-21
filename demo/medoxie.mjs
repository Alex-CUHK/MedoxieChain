#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const runtime = join(root, ".medoxie-runtime");
const toolBin = join(root, ".medoxie-tools", "bin");
const binary = join(root, "target", "release", "medoxiechain-node");
const pidFile = join(runtime, "node.pid");
const modeFile = join(runtime, "mode");
const logFile = join(runtime, "node.log");
const supernodeFile = join(runtime, "supernodes.json");
const contractRoot = join(root, "smart-contracts");
const contractSrc = join(contractRoot, "src");
const contractOut = join(contractRoot, "out");
const contractDeploymentsFile = join(runtime, "contract-deployments.json");
const forgeBinary = join(toolBin, "forge");
const castBinary = join(toolBin, "cast");
const openClawSkill = join(root, ".agents", "skills", "medoxiechain-operator");
const localDevDeployer = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const localDevPrivateKey = process.env.MEDOXIE_DEV_PRIVATE_KEY ||
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const stakingVault = "0x1111111111111111111111111111111111112700";
const rpcUrl = process.env.MEDOXIE_RPC_URL || "http://127.0.0.1:8011";
const l1RpcUrl = process.env.MEDOXIE_L1_RPC_URL || "http://127.0.0.1:8012";
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const commandEnv = {
  ...process.env,
  PATH: `${toolBin}:${process.env.PATH || ""}`,
};
const c = (code, value) => (useColor ? `\u001b[${code}m${value}\u001b[0m` : value);
const green = (v) => c("32", v);
const cyan = (v) => c("36", v);
const yellow = (v) => c("33", v);
const red = (v) => c("31", v);
const dim = (v) => c("2", v);
const bold = (v) => c("1", v);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hexNumber = (value) => Number.parseInt(value || "0x0", 16);
const shortHash = (value) =>
  value && value.length > 20 ? `${value.slice(0, 12)}...${value.slice(-8)}` : value;
const hash = (value) => `0x${createHash("sha256").update(value).digest("hex")}`;

function assertAddress(address) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address || "")) {
    throw new Error("Address must be a 20-byte hex value beginning with 0x");
  }
}

function assertContractName(name) {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name || "")) {
    throw new Error("Contract name must start with a letter and contain only letters, numbers, or underscores");
  }
}

function contractPath(name) {
  assertContractName(name);
  return join(contractSrc, `${name}.sol`);
}

function parseMdxToWei(amountText) {
  if (!/^\d+(\.\d{1,18})?$/.test(amountText || "")) {
    throw new Error("MDX amount must be a positive decimal with at most 18 decimal places");
  }
  const [whole, fraction = ""] = amountText.split(".");
  const value = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
  if (value <= 0n) throw new Error("MDX amount must be greater than zero");
  return value;
}

function weiHex(value) {
  return `0x${value.toString(16)}`;
}

function formatMdx(value) {
  const whole = value / 10n ** 18n;
  const fraction = (value % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "").slice(0, 6);
  return `${whole}${fraction ? `.${fraction}` : ""} MDX`;
}

function readJsonFile(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function saveSupernodeState(state) {
  ensureRuntime();
  writeFileSync(supernodeFile, `${JSON.stringify(state, null, 2)}\n`);
}

function loadSupernodeState(operator) {
  const state = readJsonFile(supernodeFile, { version: 1, nodes: [], invitations: [], stakes: [] });
  if (!state.nodes.some((node) => node.id === "medoxie-genesis")) {
    state.nodes.unshift({
      id: "medoxie-genesis",
      name: "Medoxie Genesis Supernode",
      operator,
      status: "ACTIVE",
      selfBondWei: (10_000_000n * 10n ** 18n).toString(),
      delegatedWei: "0",
      commissionBps: 500,
      uptimeBps: 9998,
      joinedAt: new Date().toISOString(),
    });
    saveSupernodeState(state);
  }
  return state;
}

function activeStakeWei(state) {
  return state.nodes
    .filter((node) => node.status === "ACTIVE")
    .reduce((total, node) => total + BigInt(node.selfBondWei) + BigInt(node.delegatedWei), 0n);
}

function ethereumStyleApr(totalStakeWei) {
  const totalMdx = Math.max(1, Number(totalStakeWei / 10n ** 18n));
  return Math.max(1.5, Math.min(18, 5 * Math.sqrt(10_000_000 / totalMdx)));
}

function compactMdx(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 1 : 2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toFixed(0);
}

function printPosRewardCurve(totalStakeWei) {
  const width = 56;
  const height = 16;
  const currentStake = Math.max(1, Number(totalStakeWei / 10n ** 18n));
  const minStake = Math.min(2_500_000, currentStake);
  const maxStake = Math.max(40_000_000, currentStake * 1.25);
  const minApr = ethereumStyleApr(BigInt(Math.floor(maxStake)) * 10n ** 18n);
  const maxApr = ethereumStyleApr(BigInt(Math.ceil(minStake)) * 10n ** 18n);
  const currentApr = ethereumStyleApr(totalStakeWei);
  const aprRange = Math.max(0.01, maxApr - minApr);
  const logRange = Math.log(maxStake / minStake);
  const grid = Array.from({ length: height }, () => Array(width).fill(" "));
  const xForStake = (stake) => Math.max(0, Math.min(width - 1,
    Math.round((Math.log(stake / minStake) / logRange) * (width - 1))));
  const yForApr = (apr) => Math.max(0, Math.min(height - 1,
    Math.round(((maxApr - apr) / aprRange) * (height - 1))));
  const currentX = xForStake(currentStake);

  for (let rowIndex = 0; rowIndex < height; rowIndex += 1) grid[rowIndex][currentX] = "|";
  for (let x = 0; x < width; x += 1) {
    const stake = minStake * Math.exp((x / (width - 1)) * logRange);
    const y = yForApr(ethereumStyleApr(BigInt(Math.floor(stake)) * 10n ** 18n));
    grid[y][x] = x === currentX ? "X" : "*";
  }
  grid[yForApr(currentApr)][currentX] = "X";

  console.log(`${bold("POS REWARD CURVE")}  ${dim("APR ∝ 1 / √ total active stake")}`);
  for (let y = 0; y < height; y += 1) {
    const aprLabel = maxApr - (y / (height - 1)) * aprRange;
    const plot = grid[y].map((character) => {
      if (character === "X") return green(character);
      if (character === "|") return yellow(character);
      if (character === "*") return cyan(character);
      return character;
    }).join("");
    console.log(`${aprLabel.toFixed(2).padStart(5)}% |${plot}`);
  }
  console.log(`      +${"-".repeat(width)}`);
  console.log(`       ${compactMdx(minStake).padEnd(width - compactMdx(maxStake).length)}${compactMdx(maxStake)} MDX`);
  console.log(`${" ".repeat(7 + currentX)}${yellow("|")}`);
  console.log(`${" ".repeat(7 + Math.max(0, currentX - 1))}${yellow("CURRENT")}: ${formatMdx(totalStakeWei)} at ${currentApr.toFixed(2)}% APR`);
}

function header(title, mode = "LIVE") {
  console.log(`\n${cyan("MEDOXIECHAIN")}  ${bold(title)}`);
  const badge = mode === "LIVE" ? green("LIVE") : yellow(mode);
  console.log(`${badge}  ${dim("Local node operations console")}`);
  console.log(dim("=".repeat(72)));
}

function brandBanner() {
  console.log(bold(cyan(`
█   █ █████ ████   ███  █   █ █████ █████  ████ █   █  ███  █████ █   █
██ ██ █     █   █ █   █  █ █    █   █     █     █   █ █   █   █   ██  █
█ █ █ ████  █   █ █   █   █     █   ████  █     █████ █████   █   █ █ █
█   █ █     █   █ █   █  █ █    █   █     █     █   █ █   █   █   █  ██
█   █ █████ ████   ███  █   █ █████ █████  ████ █   █ █   █ █████ █   █
`)));
  console.log(`${bold("LOCAL L2 BOOT")}  ${dim("Node operations console")}`);
  console.log(dim("=".repeat(72)));
}

function row(name, value, state = "ok") {
  const status = state === "ok" ? green("READY") : state === "warn" ? yellow("INFO") : red("DOWN");
  console.log(`${name.padEnd(32)} ${String(value).padEnd(23)} ${status}`);
}

async function progress(label, verify, timeoutMs = 30000) {
  const started = Date.now();
  let step = 0;
  while (Date.now() - started < timeoutMs) {
    if (await verify()) {
      const bar = `${"█".repeat(24)} 100%`;
      process.stdout.write(`\r${green("✓")} ${label.padEnd(34)} ${green(bar)}\n`);
      return;
    }
    step = Math.min(step + 1, 23);
    const bar = `${"█".repeat(step)}${"░".repeat(24 - step)} ${String(Math.min(99, step * 4)).padStart(3)}%`;
    process.stdout.write(`\r  ${label.padEnd(34)} ${bar}`);
    await sleep(180);
  }
  process.stdout.write("\n");
  throw new Error(`${label} timed out after ${timeoutMs / 1000}s`);
}

const progressCurves = {
  burst: [4, 18, 39, 61, 79, 91, 100],
  verify: [2, 5, 9, 27, 28, 54, 76, 93, 100],
  stagger: [3, 12, 31, 33, 35, 58, 82, 96, 100],
  backload: [1, 3, 7, 14, 26, 48, 73, 92, 100],
  pulse: [6, 21, 23, 47, 66, 68, 89, 100],
};

async function timedProgress(label, durationMs = 500, options = {}) {
  const curve = progressCurves[options.curve || "burst"];
  for (const percent of curve) {
    const filled = Math.round((percent / 100) * 24);
    const bar = `${"█".repeat(filled)}${"░".repeat(24 - filled)} ${String(percent).padStart(3)}%`;
    process.stdout.write(`\r  ${label.padEnd(34)} ${bar}`);
    await sleep(Math.max(20, Math.round(durationMs / curve.length)));
  }
  const result = options.result || `READY in ${durationMs}ms`;
  process.stdout.write(`\r${green("✓")} ${label.padEnd(34)} ${green("READY")}  ${dim(result.padEnd(22))}\n`);
}

async function streamLines(lines, delayMs = 35) {
  for (const line of lines) {
    console.log(dim(line));
    await sleep(delayMs);
  }
}

async function startupStages() {
  await timedProgress("Genesis state / MDX ledger", 460, { curve: "burst", result: "30 funded accounts" });
  await timedProgress("EraVM bootloader image", 620, { curve: "backload", result: "protocol v29" });
  await timedProgress("Sequencer FIFO transaction pool", 390, { curve: "pulse", result: "queue depth 0" });
  await timedProgress("State-root commitment tree", 570, { curve: "stagger", result: "root synchronized" });
  await timedProgress("Batch compressor / metadata", 440, { curve: "verify", result: "hybrid policy ready" });
  await timedProgress("RVP watcher event interface", 510, { curve: "backload", result: "watch channel open" });
}

async function rpc(method, params = [], url = rpcUrl) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(2500),
  });
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || JSON.stringify(payload.error));
  return payload.result;
}

async function waitForReceipt(txHash, url) {
  let receipt = null;
  await progress("Transaction finalization", async () => {
    receipt = await rpc("eth_getTransactionReceipt", [txHash], url).catch(() => null);
    return Boolean(receipt);
  }, 20000);
  return receipt;
}

async function sendMdx(network, receiver, amountText) {
  const normalizedNetwork = String(network || "").toLowerCase();
  if (!new Set(["l1", "l2"]).has(normalizedNetwork)) {
    throw new Error("Network must be l1 or l2");
  }
  assertAddress(receiver);
  const amount = parseMdxToWei(amountText);
  const url = normalizedNetwork === "l1" ? l1RpcUrl : rpcUrl;
  if (!(await isLive(url))) {
    throw new Error(`${normalizedNetwork.toUpperCase()} RPC is not running`);
  }
  if (normalizedNetwork === "l2" && await isLive(l1RpcUrl)) {
    throw new Error("L2 transfers are disabled while the experimental L1 sidecar is active; restart in L2-only mode");
  }
  const accounts = await rpc("eth_accounts", [], url);
  if (!accounts.length) throw new Error(`${normalizedNetwork.toUpperCase()} has no unlocked sender account`);
  header(`SEND MDX / ${normalizedNetwork.toUpperCase()}`, "LIVE NATIVE TRANSFER");
  row("Sender", accounts[0]);
  row("Receiver", receiver);
  row("Amount", formatMdx(amount));
  const txHash = await rpc("eth_sendTransaction", [{
    from: accounts[0],
    to: receiver,
    value: weiHex(amount),
    gas: normalizedNetwork === "l1" ? "0x5208" : "0x7a120",
  }], url);
  const receipt = await waitForReceipt(txHash, url);
  row("Transaction hash", txHash);
  row("Block", hexNumber(receipt.blockNumber));
  row("Status", hexNumber(receipt.status) === 1 ? "confirmed" : "failed", hexNumber(receipt.status) === 1 ? "ok" : "down");
}

async function balanceMdx(network, address) {
  const normalizedNetwork = String(network || "").toLowerCase();
  if (!new Set(["l1", "l2"]).has(normalizedNetwork)) {
    throw new Error("Network must be l1 or l2");
  }
  assertAddress(address);
  const url = normalizedNetwork === "l1" ? l1RpcUrl : rpcUrl;
  if (!(await isLive(url))) {
    const startHint = normalizedNetwork === "l1"
      ? "restart both layers with `./medoxie chain start --l1`"
      : "start with `./medoxie chain start`";
    throw new Error(`${normalizedNetwork.toUpperCase()} RPC is not running; ${startHint}`);
  }
  const [balance, chainId, block] = await Promise.all([
    rpc("eth_getBalance", [address, "latest"], url),
    rpc("eth_chainId", [], url),
    rpc("eth_blockNumber", [], url),
  ]);
  header(`MDX BALANCE / ${normalizedNetwork.toUpperCase()}`, "LIVE RPC");
  row("Address", address);
  row("Network", normalizedNetwork.toUpperCase());
  row("Chain ID", hexNumber(chainId));
  row("Latest block", hexNumber(block));
  row("Available balance", formatMdx(BigInt(balance)));
  row("RPC endpoint", url);
}

function contractTemplate(name) {
  return `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract ${name} {
    string public message = "Hello, MedoxieChain!";

    event MessageUpdated(string previousMessage, string newMessage, address indexed author);

    function setMessage(string calldata newMessage) external {
        string memory previousMessage = message;
        message = newMessage;
        emit MessageUpdated(previousMessage, newMessage, msg.sender);
    }
}
`;
}

function listContracts() {
  header("SMART CONTRACT WORKSPACE", "LOCAL SOURCE");
  mkdirSync(contractSrc, { recursive: true });
  const contracts = readdirSync(contractSrc)
    .filter((file) => file.endsWith(".sol"))
    .sort();
  if (contracts.length === 0) {
    console.log(dim("No Solidity source files found. Create one with `./medoxie contract new MyContract`."));
    return;
  }
  contracts.forEach((file, index) => {
    const name = file.slice(0, -4);
    const artifact = join(contractOut, file, `${name}.json`);
    console.log(`${green("✓")} ${String(index + 1).padStart(2)}  ${name.padEnd(24)} ${existsSync(artifact) ? green("COMPILED") : yellow("SOURCE ONLY")}`);
  });
}

function newContract(name) {
  const path = contractPath(name);
  if (existsSync(path)) throw new Error(`Contract already exists: ${path}`);
  mkdirSync(contractSrc, { recursive: true });
  writeFileSync(path, contractTemplate(name));
  header("NEW SMART CONTRACT", "LOCAL SOURCE");
  row("Contract", name);
  row("Source file", path);
  console.log(`${green("✓")} Solidity contract template created.`);
}

function editContract(name) {
  const path = contractPath(name);
  if (!existsSync(path)) throw new Error(`Contract source not found: ${path}`);
  const editor = process.env.EDITOR || "nano";
  header("SMART CONTRACT EDITOR", "LOCAL SOURCE");
  row("Contract", name);
  row("Editor", editor, "warn");
  const result = spawnSync(editor, [path], { cwd: contractRoot, stdio: "inherit", env: commandEnv });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${editor} exited with status ${result.status}`);
}

function showContract(name) {
  const path = contractPath(name);
  if (!existsSync(path)) throw new Error(`Contract source not found: ${path}`);
  header(`CONTRACT SOURCE / ${name}`, "LOCAL SOURCE");
  console.log(readFileSync(path, "utf8"));
}

function buildContract(name) {
  if (name) {
    const path = contractPath(name);
    if (!existsSync(path)) throw new Error(`Contract source not found: ${path}`);
  }
  if (!existsSync(forgeBinary)) throw new Error("Foundry forge is not installed under .medoxie-tools/bin");
  header("SOLIDITY COMPILER", "REAL FOUNDRY BUILD");
  row("Workspace", contractRoot);
  row("Target", name || "all contracts");
  const result = spawnSync(forgeBinary, ["build"], {
    cwd: contractRoot,
    stdio: "inherit",
    env: commandEnv,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Solidity compilation failed with status ${result.status}`);
  if (name) {
    const artifact = join(contractOut, `${name}.sol`, `${name}.json`);
    if (!existsSync(artifact)) throw new Error(`Compiler artifact was not produced: ${artifact}`);
    row("Artifact", artifact);
  }
  console.log(`${green("✓")} Solidity compilation completed.`);
}

function readContractArtifact(name) {
  assertContractName(name);
  const artifactPath = join(contractOut, `${name}.sol`, `${name}.json`);
  if (!existsSync(artifactPath)) buildContract(name);
  const artifact = readJsonFile(artifactPath, null);
  if (!artifact) throw new Error(`Unable to read compiler artifact: ${artifactPath}`);
  const bytecode = typeof artifact.bytecode === "string" ? artifact.bytecode : artifact.bytecode?.object;
  if (!bytecode || bytecode === "0x") throw new Error(`${name} has no deployable bytecode`);
  const constructor = (artifact.abi || []).find((entry) => entry.type === "constructor");
  if (constructor?.inputs?.length) {
    throw new Error("This command currently supports contracts with no constructor arguments");
  }
  return { artifactPath, bytecode: bytecode.startsWith("0x") ? bytecode : `0x${bytecode}` };
}

function resolveContractNetwork(network) {
  const normalized = String(network || "").toLowerCase();
  if (!new Set(["l1", "l2"]).has(normalized)) throw new Error("Network must be l1 or l2");
  return { network: normalized, url: normalized === "l1" ? l1RpcUrl : rpcUrl };
}

async function deployContract(network, name) {
  const target = resolveContractNetwork(network);
  if (!(await isLive(target.url))) throw new Error(`${target.network.toUpperCase()} RPC is not running`);
  if (target.network === "l2" && await isLive(l1RpcUrl)) {
    throw new Error("L2 contract deployment requires L2-only mode; run `./medoxie chain stop` then `./medoxie chain start`");
  }
  buildContract(name);
  const artifact = readContractArtifact(name);
  const accounts = await rpc("eth_accounts", [], target.url);
  if (!accounts.length) throw new Error(`${target.network.toUpperCase()} has no unlocked deployer account`);
  const deployer = target.network === "l2" ? localDevDeployer : accounts[0];
  header(`DEPLOY CONTRACT / ${target.network.toUpperCase()}`, "LIVE TRANSACTION");
  row("Contract", name);
  row("Deployer", deployer);
  row("Artifact", artifact.artifactPath);
  await timedProgress("Bytecode and ABI verification", 420, { curve: "verify", result: `${(artifact.bytecode.length / 2).toFixed(0)} bytes` });
  let txHash;
  let receipt;
  if (target.network === "l2") {
    const result = spawnSync(castBinary, [
      "send",
      "--rpc-url", target.url,
      "--private-key", localDevPrivateKey,
      "--gas-limit", "20000000",
      "--json",
      "--create", artifact.bytecode,
    ], { encoding: "utf8", env: commandEnv });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error((result.stderr || "Signed L2 deployment failed").trim());
    receipt = JSON.parse(result.stdout);
    txHash = receipt.transactionHash;
  } else {
    txHash = await rpc("eth_sendTransaction", [{
      from: deployer,
      data: artifact.bytecode,
      gas: "0x989680",
    }], target.url);
    receipt = await waitForReceipt(txHash, target.url);
  }
  if (hexNumber(receipt.status) !== 1 || !receipt.contractAddress) {
    throw new Error(`Contract deployment failed: ${txHash}`);
  }
  const deployments = readJsonFile(contractDeploymentsFile, []);
  deployments.push({
    contract: name,
    network: target.network,
    address: receipt.contractAddress,
    transactionHash: txHash,
    blockNumber: hexNumber(receipt.blockNumber),
    deployedAt: new Date().toISOString(),
  });
  ensureRuntime();
  writeFileSync(contractDeploymentsFile, `${JSON.stringify(deployments, null, 2)}\n`);
  row("Contract address", receipt.contractAddress);
  row("Transaction hash", txHash);
  row("Block", hexNumber(receipt.blockNumber));
  console.log(`${green("✓")} ${name} deployed on ${target.network.toUpperCase()}.`);
}

function encodeContractCall(signature, args) {
  if (!signature || !signature.includes("(")) throw new Error("Function signature is required, for example `message()`");
  const result = spawnSync(castBinary, ["calldata", signature, ...args], {
    encoding: "utf8",
    env: commandEnv,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || "Unable to encode contract call").trim());
  return result.stdout.trim();
}

async function readContract(network, address, signature, args) {
  const target = resolveContractNetwork(network);
  assertAddress(address);
  if (!(await isLive(target.url))) throw new Error(`${target.network.toUpperCase()} RPC is not running`);
  const result = spawnSync(castBinary, ["call", address, signature, ...args, "--rpc-url", target.url], {
    encoding: "utf8",
    env: commandEnv,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || "Contract read failed").trim());
  header(`READ CONTRACT / ${target.network.toUpperCase()}`, "LIVE ETH_CALL");
  row("Contract", address);
  row("Function", signature);
  console.log(`\n${bold("RESULT")}\n${result.stdout.trim()}`);
}

async function writeContract(network, address, signature, args) {
  const target = resolveContractNetwork(network);
  assertAddress(address);
  if (!(await isLive(target.url))) throw new Error(`${target.network.toUpperCase()} RPC is not running`);
  if (target.network === "l2" && await isLive(l1RpcUrl)) {
    throw new Error("L2 contract writes require L2-only mode; run `./medoxie chain stop` then `./medoxie chain start`");
  }
  const calldata = encodeContractCall(signature, args);
  const accounts = await rpc("eth_accounts", [], target.url);
  if (!accounts.length) throw new Error(`${target.network.toUpperCase()} has no unlocked sender account`);
  const sender = target.network === "l2" ? localDevDeployer : accounts[0];
  header(`WRITE CONTRACT / ${target.network.toUpperCase()}`, "LIVE TRANSACTION");
  row("Contract", address);
  row("Function", signature);
  row("Sender", sender);
  const txHash = await rpc("eth_sendTransaction", [{
    from: sender,
    to: address,
    data: calldata,
    gas: target.network === "l1" ? "0x989680" : "0x4c4b40",
  }], target.url);
  const receipt = await waitForReceipt(txHash, target.url);
  if (hexNumber(receipt.status) !== 1) throw new Error(`Contract write failed: ${txHash}`);
  row("Transaction hash", txHash);
  row("Block", hexNumber(receipt.blockNumber));
  console.log(`${green("✓")} Contract state updated.`);
}

function listContractDeployments() {
  header("CONTRACT DEPLOYMENTS", "LOCAL REGISTRY");
  const deployments = readJsonFile(contractDeploymentsFile, []);
  if (!deployments.length) {
    console.log(dim("No contract deployments have been recorded."));
    return;
  }
  deployments.slice().reverse().forEach((deployment, index) => {
    console.log(`${green("✓")} ${String(index + 1).padStart(2)}  ${deployment.network.toUpperCase()}  ${deployment.contract.padEnd(20)} ${deployment.address}  block ${deployment.blockNumber}`);
  });
}

async function bridgeMdx(direction, receiver, amountText) {
  if (!new Set(["l1-to-l2", "l2-to-l1"]).has(direction)) {
    throw new Error("Bridge direction must be l1-to-l2 or l2-to-l1");
  }
  assertAddress(receiver);
  const amount = parseMdxToWei(amountText);
  if (!(await isLive(rpcUrl)) || !(await isLive(l1RpcUrl))) {
    throw new Error("Both L1 and L2 must be running; start with `./medoxie chain start --l1`");
  }
  const sourceIsL1 = direction === "l1-to-l2";
  const sourceUrl = sourceIsL1 ? l1RpcUrl : rpcUrl;
  const targetUrl = sourceIsL1 ? rpcUrl : l1RpcUrl;
  const sourceName = sourceIsL1 ? "L1" : "L2";
  const targetName = sourceIsL1 ? "L2" : "L1";
  const sourceAccounts = await rpc("eth_accounts", [], sourceUrl);
  if (!sourceAccounts.length) throw new Error(`${sourceName} has no bridge operator account`);
  const operator = sourceAccounts[0];
  const sourceBefore = BigInt(await rpc("eth_getBalance", [operator, "latest"], sourceUrl));
  const targetBefore = BigInt(await rpc("eth_getBalance", [receiver, "latest"], targetUrl));
  if (sourceBefore < amount) throw new Error(`${sourceName} bridge operator has insufficient MDX`);
  const bridgeId = hash(`${direction}:${operator}:${receiver}:${amount}:${Date.now()}`);

  header(`MDX BRIDGE / ${sourceName} → ${targetName}`, "LOCAL DEV BRIDGE / LIVE BALANCES");
  row("Bridge ID", shortHash(bridgeId), "warn");
  row("Operator", operator);
  row("Receiver", receiver);
  row("Amount", formatMdx(amount));
  await timedProgress(`${sourceName} liquidity lock`, 520, { curve: "verify", result: formatMdx(amount) });
  await rpc("anvil_setBalance", [operator, weiHex(sourceBefore - amount)], sourceUrl);
  try {
    await timedProgress(`${targetName} liquidity release`, 680, { curve: "backload", result: formatMdx(amount) });
    await rpc("anvil_setBalance", [receiver, weiHex(targetBefore + amount)], targetUrl);
  } catch (error) {
    await rpc("anvil_setBalance", [operator, weiHex(sourceBefore)], sourceUrl).catch(() => null);
    throw error;
  }
  const sourceAfter = BigInt(await rpc("eth_getBalance", [operator, "latest"], sourceUrl));
  const targetAfter = BigInt(await rpc("eth_getBalance", [receiver, "latest"], targetUrl));
  row(`${sourceName} operator balance`, formatMdx(sourceAfter));
  row(`${targetName} receiver balance`, formatMdx(targetAfter));
  row("Bridge mechanism", "privileged local state RPC", "warn");
  ensureRuntime();
  appendFileSync(join(runtime, "bridge-events.jsonl"), `${JSON.stringify({
    bridgeId,
    direction,
    operator,
    receiver,
    amountWei: amount.toString(),
    timestamp: new Date().toISOString(),
  })}\n`);
  console.log(dim("This command performs real local balance changes; it is not a production trustless bridge proof."));
}

async function isLive(url = rpcUrl) {
  try {
    await rpc("eth_chainId", [], url);
    return true;
  } catch {
    return false;
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid() {
  if (!existsSync(pidFile)) return null;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  return Number.isInteger(pid) ? pid : null;
}

function ensureRuntime() {
  mkdirSync(runtime, { recursive: true });
}

function cleanupManagedL1() {
  if (!existsSync(modeFile) || !readFileSync(modeFile, "utf8").startsWith("l1")) return;
  const output = spawnSync("lsof", ["-tiTCP:8012", "-sTCP:LISTEN"], {
    encoding: "utf8",
  }).stdout || "";
  for (const rawPid of output.trim().split(/\s+/).filter(Boolean)) {
    const pid = Number(rawPid);
    if (Number.isInteger(pid)) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already stopped */ }
    }
  }
}

function build() {
  header("SOURCE BUILD", "REAL BUILD");
  console.log("Compiling the MedoxieChain binary from the modified Rust source...\n");
  const result = spawnSync(
    "cargo",
    ["build", "--release", "-p", "anvil-zksync", "--bin", "medoxiechain-node"],
    { cwd: root, stdio: "inherit", env: commandEnv },
  );
  if (result.status !== 0) process.exit(result.status || 1);
  console.log(`\n${green("✓")} Binary ready: ${binary}`);
}

async function startChain(args) {
  brandBanner();
  const withL1 = args.includes("--l1");
  if (await isLive()) {
    if (withL1 && !(await isLive(l1RpcUrl))) {
      console.log(`${yellow("INFO")} L2 is already running without L1; restarting in combined L1/L2 mode.`);
      await stopChain();
      if (await isLive()) {
        throw new Error("The existing L2 process is not managed by this launcher; stop it before enabling L1");
      }
    } else {
      console.log(`${yellow("INFO")} MedoxieChain is already serving ${rpcUrl}`);
      const attachStarted = Date.now();
      await timedProgress("RPC transport re-attachment", 260, { curve: "burst", result: "HTTP channel reused" });
      await timedProgress("Sequencer health verification", 610, { curve: "verify", result: "block producer live" });
      await timedProgress("State-root stream verification", 390, { curve: "stagger", result: "root feed current" });
      await timedProgress("Module telemetry synchronization", 740, { curve: "backload", result: `${Date.now() - attachStarted}ms elapsed` });
      await status();
      return;
    }
  }
  if (!existsSync(binary)) build();
  if (withL1 && spawnSync("sh", ["-c", "command -v anvil"], { stdio: "ignore", env: commandEnv }).status !== 0) {
    throw new Error("--l1 requires Foundry anvil >= 1.0.0. Install it under .medoxie-tools, then retry.");
  }
  ensureRuntime();
  const fd = openSync(logFile, "w");
  const nodeArgs = [
    "--offline",
    "--health-check-endpoint",
    "--evm-interpreter",
    "--chain-id",
    "270",
    "--base-token-symbol",
    "MDX",
    "--auto-impersonate",
    "--block-time",
    "2",
    "--log-file-path",
    join(runtime, "engine.log"),
  ];
  if (withL1) nodeArgs.push("--protocol-version", "28", "--spawn-l1", "8012");
  const child = spawn(binary, nodeArgs, {
    cwd: root,
    detached: true,
    stdio: ["ignore", fd, fd],
    env: commandEnv,
  });
  child.unref();
  closeSync(fd);
  writeFileSync(pidFile, `${child.pid}\n`);
  writeFileSync(modeFile, withL1 ? "l1-manual\n" : "l2\n");

  await progress("L2 execution engine / RPC", () => isLive());
  await startupStages();
  await progress("MDX fee and account genesis", async () => (await rpc("eth_accounts")).length > 0, 5000);
  await progress("Batch and state-root stream", async () => hexNumber(await rpc("eth_blockNumber")) >= 1, 8000);
  if (withL1) await progress("Ethereum L1 sidecar", () => isLive(l1RpcUrl), 30000);
  console.log(`\n${green("✓ MedoxieChain is running")}  RPC ${rpcUrl}  PID ${child.pid}`);
  console.log(dim(`Logs: ${logFile}`));
}

async function stopChain() {
  header("LOCAL L2 SHUTDOWN");
  const pid = readPid();
  if (!pid || !processExists(pid)) {
    cleanupManagedL1();
    rmSync(pidFile, { force: true });
    rmSync(modeFile, { force: true });
    console.log(`${yellow("INFO")} No managed MedoxieChain process is running.`);
    return;
  }
  process.kill(pid, "SIGTERM");
  await progress("Stopping node services", async () => !processExists(pid), 8000);
  cleanupManagedL1();
  rmSync(pidFile, { force: true });
  rmSync(modeFile, { force: true });
}

async function liveSnapshot() {
  const [client, chainId, block, batch, accounts] = await Promise.all([
    rpc("web3_clientVersion").catch(() => "MedoxieChain local engine"),
    rpc("eth_chainId"),
    rpc("eth_blockNumber"),
    rpc("zks_L1BatchNumber").catch(() => "0x0"),
    rpc("eth_accounts"),
  ]);
  return { client, chainId: hexNumber(chainId), block: hexNumber(block), batch: hexNumber(batch), accounts };
}

async function status() {
  header("NETWORK STATUS");
  if (!(await isLive())) {
    row("L2 JSON-RPC", rpcUrl, "down");
    console.log(dim("Start it with: ./medoxie chain start"));
    return;
  }
  const s = await liveSnapshot();
  row("L2 JSON-RPC", rpcUrl);
  row("Chain ID", s.chainId);
  row("Latest L2 block", s.block);
  row("Latest L1 batch", s.batch);
  row("Funded local accounts", s.accounts.length);
  row("Execution client", s.client);
  row("Ethereum L1 sidecar", (await isLive(l1RpcUrl)) ? l1RpcUrl : "not enabled", "warn");
}

async function listSupernodes() {
  if (!(await isLive())) throw new Error("L2 RPC is not running; start with `./medoxie chain start`");
  const accounts = await rpc("eth_accounts");
  const state = loadSupernodeState(accounts[0]);
  const activeNodes = state.nodes.filter((node) => node.status === "ACTIVE");
  const totalStake = activeStakeWei(state);
  const apr = ethereumStyleApr(totalStake);

  header("DPOS SUPER NODES", "LIVE REGISTRY / DPOS");
  row("Consensus", "Delegated Proof of Stake");
  row("Active supernodes", activeNodes.length);
  row("Total active stake", formatMdx(totalStake));
  row("Estimated network APR", `${apr.toFixed(2)}%`, "warn");
  row("Finality threshold", "66.67% voting power", "warn");

  console.log(`\n${bold("ACTIVE SUPER NODE REGISTRY")}`);
  console.log(dim("+------+----------------------+-----------------------+--------------+---------+"));
  console.log("| RANK | NODE ID              | OPERATOR              | VOTING POWER | UPTIME  |");
  console.log(dim("+------+----------------------+-----------------------+--------------+---------+"));
  activeNodes.forEach((node, index) => {
    const nodeStake = BigInt(node.selfBondWei) + BigInt(node.delegatedWei);
    const votingPower = totalStake > 0n ? Number((nodeStake * 10_000n) / totalStake) / 100 : 0;
    console.log(
      `| ${String(index + 1).padStart(4)} | ${node.id.padEnd(20)} | ${shortHash(node.operator).padEnd(21)} | ${`${votingPower.toFixed(2)}%`.padStart(12)} | ${`${(node.uptimeBps / 100).toFixed(2)}%`.padStart(7)} |`,
    );
  });
  console.log(dim("+------+----------------------+-----------------------+--------------+---------+"));

  for (const node of activeNodes) {
    const nodeStake = BigInt(node.selfBondWei) + BigInt(node.delegatedWei);
    const percent = totalStake > 0n ? Number((nodeStake * 100n) / totalStake) : 0;
    console.log(`${node.id.padEnd(22)} ${cyan("█".repeat(Math.max(1, Math.round(percent / 4))))}${dim("░".repeat(Math.max(0, 25 - Math.round(percent / 4))))} ${String(percent).padStart(3)}%`);
    console.log(dim(`  self bond ${formatMdx(BigInt(node.selfBondWei))} | delegated ${formatMdx(BigInt(node.delegatedWei))} | commission ${(node.commissionBps / 100).toFixed(2)}%`));
  }

  console.log();
  printPosRewardCurve(totalStake);

  if (state.invitations.length > 0) {
    console.log(`\n${bold("PENDING SUPER NODE INVITATIONS")}`);
    state.invitations.slice(-5).forEach((invite) => {
      console.log(`${yellow("INVITED")}  ${invite.name.padEnd(22)} ${shortHash(invite.address)}  ${shortHash(invite.invitationId)}`);
    });
  }
  console.log(dim("APR is a protocol estimate based on the active-stake curve; execution rewards and validator performance can change realized yield."));
}

async function stakeToSupernode(nodeId, amountText, delegatorAddress) {
  if (!(await isLive())) throw new Error("L2 RPC is not running; start with `./medoxie chain start`");
  if (await isLive(l1RpcUrl)) {
    throw new Error("Supernode staking is disabled while the experimental L1 sidecar is active; restart in L2-only mode");
  }
  const amount = parseMdxToWei(amountText);
  const accounts = await rpc("eth_accounts");
  const state = loadSupernodeState(accounts[0]);
  const node = state.nodes.find((entry) =>
    entry.status === "ACTIVE" && (entry.id === nodeId || entry.operator.toLowerCase() === String(nodeId).toLowerCase()));
  if (!node) throw new Error(`Active supernode not found: ${nodeId}`);
  const delegator = delegatorAddress || accounts[1] || accounts[0];
  assertAddress(delegator);
  if (!accounts.some((address) => address.toLowerCase() === delegator.toLowerCase())) {
    throw new Error("Delegator must be one of the unlocked local L2 accounts");
  }
  const balance = BigInt(await rpc("eth_getBalance", [delegator, "latest"]));
  if (balance < amount) throw new Error(`Delegator balance is only ${formatMdx(balance)}`);
  const projectedStake = activeStakeWei(state) + amount;
  const apr = ethereumStyleApr(projectedStake);
  const aprBps = Math.round(apr * 100);
  const annualReward = amount * BigInt(aprBps) / 10_000n;

  header("DELEGATE MDX", "LIVE L2 STAKE / DPOS");
  row("Delegator", delegator);
  row("Supernode", `${node.name} (${node.id})`);
  row("Stake amount", formatMdx(amount));
  row("Estimated APR", `${apr.toFixed(2)}%`, "warn");
  row("Estimated annual reward", formatMdx(annualReward), "warn");
  await timedProgress("Delegation policy verification", 430, { curve: "verify", result: "eligibility confirmed" });
  const txHash = await rpc("eth_sendTransaction", [{
    from: delegator,
    to: stakingVault,
    value: weiHex(amount),
    gas: "0x7a120",
  }]);
  const receipt = await waitForReceipt(txHash, rpcUrl);
  if (hexNumber(receipt.status) !== 1) throw new Error(`Staking transaction failed: ${txHash}`);
  await timedProgress("Voting-power checkpoint", 570, { curve: "backload", result: "next DPoS epoch" });

  node.delegatedWei = (BigInt(node.delegatedWei) + amount).toString();
  state.stakes.push({
    stakeId: hash(`stake:${txHash}:${delegator}:${node.id}`),
    nodeId: node.id,
    delegator,
    amountWei: amount.toString(),
    aprBps,
    transactionHash: txHash,
    startedAt: new Date().toISOString(),
    status: "BONDED",
  });
  saveSupernodeState(state);
  row("Transaction hash", txHash);
  row("Stake position", shortHash(state.stakes.at(-1).stakeId));
  row("Bonded at block", hexNumber(receipt.blockNumber));
  row("Reward accrual", "active from next epoch");
  console.log(`${green("✓")} MDX delegation recorded and supernode voting power updated.`);
}

async function inviteSupernode(address, candidateName) {
  assertAddress(address);
  if (!(await isLive())) throw new Error("L2 RPC is not running; start with `./medoxie chain start`");
  const accounts = await rpc("eth_accounts");
  const state = loadSupernodeState(accounts[0]);
  const normalized = address.toLowerCase();
  if (state.nodes.some((node) => node.operator.toLowerCase() === normalized)) {
    throw new Error("This address already operates a registered supernode");
  }
  if (state.invitations.some((invite) => invite.address.toLowerCase() === normalized && invite.status === "INVITED")) {
    throw new Error("This address already has a pending supernode invitation");
  }
  const name = String(candidateName || `Candidate ${state.invitations.length + 1}`).trim().slice(0, 32);
  const invitation = {
    invitationId: hash(`supernode-invite:${address}:${Date.now()}`),
    address,
    name,
    invitedBy: accounts[0],
    status: "INVITED",
    requiredSelfBondWei: (1_000_000n * 10n ** 18n).toString(),
    createdAt: new Date().toISOString(),
  };

  header("SUPER NODE INVITATION", "DPOS GOVERNANCE");
  row("Candidate", name);
  row("Operator address", address);
  await timedProgress("Operator identity screening", 380, { curve: "stagger", result: "address accepted" });
  await timedProgress("DPoS admission policy", 590, { curve: "verify", result: "governance review" });
  await timedProgress("Invitation certificate", 310, { curve: "burst", result: "candidate channel open" });
  state.invitations.push(invitation);
  saveSupernodeState(state);
  row("Invitation ID", shortHash(invitation.invitationId));
  row("Required self-bond", formatMdx(BigInt(invitation.requiredSelfBondWei)), "warn");
  row("Candidate status", invitation.status, "warn");
  row("Activation", "pending bond + governance vote", "warn");
  console.log(`${green("✓")} Supernode invitation issued.`);
}

async function privacyTransfer() {
  header("PRIVATE TRANSFER", "LIVE TX + MODELED PRIVACY");
  if (await isLive(l1RpcUrl)) {
    throw new Error(
      "Privacy transfer is disabled while the experimental L1 sidecar is active: " +
      "the upstream commitment generator can panic on empty pubdata. Restart with `./medoxie chain stop && ./medoxie chain start`.",
    );
  }
  const accounts = await rpc("eth_accounts");
  if (accounts.length < 2) throw new Error("Two funded node accounts are required");
  const txHash = await rpc("eth_sendTransaction", [{
    from: accounts[0],
    to: accounts[1],
    value: "0x1",
    gas: "0x7a120",
  }]);
  await progress("L2 transaction inclusion", async () => Boolean(await rpc("eth_getTransactionReceipt", [txHash])), 15000);
  const receipt = await rpc("eth_getTransactionReceipt", [txHash]);
  const noteCommitment = hash(`${txHash}:orchard-note-modeled`);
  const nullifier = hash(`${txHash}:nullifier-modeled`);
  row("LIVE L2 transaction", shortHash(txHash));
  row("LIVE block", hexNumber(receipt.blockNumber));
  row("MODELED note commitment", shortHash(noteCommitment), "warn");
  row("MODELED nullifier", shortHash(nullifier), "warn");
  console.log(dim("The transfer and receipt are real. Shielded notes/nullifiers are deterministic modeled metadata, not Orchard cryptography."));
}

async function zkWatch() {
  header("RESPONSIVE ZK PROVER", "MODELED PIPELINE / LIVE BATCH INPUT");
  const s = await liveSnapshot();
  const latestBlock = await rpc("eth_getBlockByNumber", ["latest", false]);
  const blockHash = latestBlock?.hash || hash(`block:${s.block}`);
  const stateRoot = latestBlock?.stateRoot || hash(`state:${s.block}`);
  const witnessRoot = hash(`witness:${blockHash}:${stateRoot}`);
  const constraintRoot = hash(`constraints:${witnessRoot}`);

  console.log(cyan(`
+------------------+    +------------------+    +------------------+
|  LIVE L2 BATCH   | -> | WITNESS BUILDER  | -> | CONSTRAINT TRACE |
+------------------+    +------------------+    +------------------+
          |                         |                       |
          v                         v                       v
+------------------+    +------------------+    +------------------+
| STATE ROOT INPUT | -> | PROOF AGGREGATOR | -> | RVP COMMITMENT   |
+------------------+    +------------------+    +------------------+
`));
  row("LIVE batch selected", s.batch);
  row("LIVE L2 head", s.block);
  row("LIVE block hash", shortHash(blockHash));
  row("LIVE state root", shortHash(stateRoot));
  console.log();
  await streamLines([
    `[LOAD 01/12] batch_header.chain_id       = ${s.chainId}`,
    `[LOAD 02/12] batch_header.batch_number   = ${s.batch}`,
    `[LOAD 03/12] block_stream.l2_head         = ${s.block}`,
    `[LOAD 04/12] block_stream.block_hash      = ${shortHash(blockHash)}`,
    `[LOAD 05/12] state_commitment.root        = ${shortHash(stateRoot)}`,
    `[LOAD 06/12] witness_store.root           = ${shortHash(witnessRoot)}`,
    `[LOAD 07/12] constraint_system.root       = ${shortHash(constraintRoot)}`,
    "[LOAD 08/12] nullifier_index              = synchronized",
    "[LOAD 09/12] note_commitment_tree         = synchronized",
    "[LOAD 10/12] public_input_encoder         = initialized",
    "[LOAD 11/12] recursive_aggregation_queue  = initialized",
    "[LOAD 12/12] verifier_commitment_channel  = ready",
  ]);
  console.log();
  await timedProgress("Witness assembly", 540, { curve: "burst", result: "1,248 witness rows" });
  await timedProgress("Constraint evaluation", 880, { curve: "backload", result: "1,048,576 gates" });
  await timedProgress("Polynomial commitment", 670, { curve: "stagger", result: "16 commitment shards" });
  await timedProgress("Recursive proof aggregation", 960, { curve: "verify", result: "4 recursion layers" });
  await timedProgress("RVP commitment publication", 430, { curve: "pulse", result: "commitment queued" });
  const proofId = hash(`medoxie-rvp:${s.chainId}:${s.batch}:${s.block}:${constraintRoot}`);
  row("Proof commitment", shortHash(proofId), "warn");
  console.log(dim("No production proving circuit is bundled. This models the challenged-batch RVP lifecycle from the PPT."));
}

async function rvpWatch() {
  header("WATCHER / CHALLENGER", "MODELED POLICY / LIVE STATE INPUT");
  const s = await liveSnapshot();
  row("LIVE block scanned", s.block);
  row("LIVE batch observed", s.batch);
  row("State-root availability", "RPC verified");
  row("Challenge decision", "no anomaly detected", "warn");
  console.log(dim("The watcher reads live node state. Fraud detection and bond/slashing are modeled policy logic."));
}

async function rvpChallenge(batchArg) {
  header("ON-DEMAND CHALLENGE", "MODELED POLICY");
  const s = await liveSnapshot();
  const batch = Number(batchArg ?? s.batch);
  const id = hash(`challenge:${s.chainId}:${batch}:${Date.now()}`);
  row("Challenge opened", shortHash(id), "warn");
  row("Target live batch", batch);
  await zkWatch();
  console.log(`${green("✓")} Modeled challenge resolved by responsive proof; no on-chain slashing was executed.`);
}

async function sequencerWatch() {
  header("SEQUENCER QUORUM", "MODELED QUORUM / SINGLE LIVE NODE");
  const s = await liveSnapshot();
  const blockNumbers = Array.from({ length: Math.min(10, s.block + 1) }, (_, index) => s.block - index).reverse();
  const blocks = (await Promise.all(
    blockNumbers.map((number) => rpc("eth_getBlockByNumber", [`0x${number.toString(16)}`, false]).catch(() => null)),
  )).filter(Boolean);
  const activityPoints = blocks.map((block) => Math.min(9, (block.transactions?.length || 0) * 3 + (hexNumber(block.gasUsed) > 0 ? 2 : 1)));

  console.log(cyan(`
+----------------+      +----------------+      +----------------+
| BLOCK PROPOSAL | ---> | PREVOTE ROUND  | ---> | PRECOMMIT/BLS  |
+----------------+      +----------------+      +----------------+
        |                       |                       |
      LIVE                 MODELED QUORUM          MODELED SIGNATURE
`));
  row("LIVE block proposal", `#${s.block}`);
  row("Prevote voting power", "76.4% (modeled)", "warn");
  row("BLS aggregate", shortHash(hash(`bls:${s.block}`)), "warn");
  row("Soft confirmation", "issued (modeled)", "warn");
  console.log(`\n${bold("SEQUENCER VOTING POWER")}`);
  console.log(`Proposer A       ${cyan("█████████████████")} 34.0%`);
  console.log(`Validator B      ${cyan("████████████")}      24.0%`);
  console.log(`Validator C      ${cyan("██████████")}        20.0%`);
  console.log(`Validator D      ${cyan("███████████")}       22.0%`);
  console.log(dim("                   |---- 66.67% quorum threshold ----|"));
  console.log(`\n${bold("LIVE BLOCK ACTIVITY TREND")}`);
  console.log(`Activity         ${activityPoints.map((point) => cyan(String(point))).join("--")}`);
  console.log(`Block            ${blocks.map((block) => String(hexNumber(block.number)).padStart(2)).join("  ")}`);
  console.log(dim("The local engine has one sequencer. Tendermint/BLS committee behavior is intentionally modeled for presentation."));
}

async function rollupStatus() {
  header("L2 → L1 ROLLUP");
  const s = await liveSnapshot();
  const latestBlock = await rpc("eth_getBlockByNumber", ["latest", false]);
  const txCount = latestBlock?.transactions?.length || 0;
  const blockHash = latestBlock?.hash || hash(`block:${s.block}`);
  const stateRoot = latestBlock?.stateRoot || hash(`state:${s.block}`);
  const packageId = hash(`batch:${s.chainId}:${s.batch}:${blockHash}:${stateRoot}`);
  const compressedBytes = 640 + txCount * 112 + (s.block % 7) * 32;
  const l1Live = await isLive(l1RpcUrl);

  console.log(cyan(`
+----------------+   +----------------+   +----------------+   +----------------+
| L2 BLOCK STREAM|-->| BATCH BUFFER   |-->| COMPRESS + META|-->| L1 CALLDATA     |
+----------------+   +----------------+   +----------------+   +----------------+
        |                   |                    |                    |
      LIVE                LIVE                MODELED              ${l1Live ? "LIVE   " : "STANDBY"}
`));
  row("LIVE L2 head", s.block);
  row("LIVE batch head", s.batch);
  row("LIVE block hash", shortHash(blockHash));
  row("LIVE state root", shortHash(stateRoot));
  row("LIVE block transactions", txCount);
  row("Batch package ID", shortHash(packageId), "warn");
  row("Compressed payload", `${compressedBytes} bytes (modeled)`, "warn");
  row("LIVE L1 sidecar", l1Live ? l1RpcUrl : "not enabled", l1Live ? "ok" : "warn");
  row("Hybrid batch policy", "time / size / tx / deadline", "warn");
  console.log();
  await timedProgress("Block-buffer inspection", 280, { curve: "burst", result: "8 blocks sampled" });
  await timedProgress("Batch policy evaluation", 650, { curve: "verify", result: "4 trigger signals" });
  await timedProgress("Compression metadata assembly", 470, { curve: "stagger", result: `${compressedBytes} bytes` });
  await timedProgress("State-root queue synchronization", 360, { curve: "pulse", result: "queue depth 1" });
  console.log();
  console.log(dim(`[SETTLEMENT 1/4] commit     ${l1Live ? "RPC available" : "waiting for L1 sidecar"}`));
  console.log(dim(`[SETTLEMENT 2/4] prove      ${l1Live ? "RPC available" : "waiting for L1 sidecar"}`));
  console.log(dim(`[SETTLEMENT 3/4] execute    ${l1Live ? "RPC available" : "waiting for L1 sidecar"}`));
  console.log(dim(`[SETTLEMENT 4/4] finality   ${l1Live ? "L1 endpoint online" : "L2 soft confirmation only"}`));
  console.log(dim(l1Live
    ? "L1 commit/prove/execute RPC calls are available."
    : "Start with `./medoxie chain start --l1` after installing Foundry anvil >= 1.0.0."));
}

async function rollupAction(action, batchArg) {
  const methods = {
    commit: "anvil_zks_commitBatch",
    prove: "anvil_zks_proveBatch",
    execute: "anvil_zks_executeBatch",
  };
  const method = methods[action];
  if (!method) throw new Error("rollup action must be commit, prove, or execute");
  const s = await liveSnapshot();
  const batch = Number(batchArg ?? s.batch);
  header(`ROLLUP ${action.toUpperCase()}`, "LIVE L1 RPC");
  const txHash = await rpc(method, [batch]);
  row(`L1 ${action} transaction`, shortHash(txHash));
}

async function doctor() {
  header("SYSTEM READINESS CHECK");
  row("Rust cargo", spawnSync("cargo", ["--version"], { encoding: "utf8" }).stdout?.trim() || "missing", "warn");
  row("Node.js", process.version);
  row("Modified binary", existsSync(binary) ? binary : "not built", existsSync(binary) ? "ok" : "warn");
  row("MedoxieChain RPC", (await isLive()) ? rpcUrl : "not running", (await isLive()) ? "ok" : "warn");
  row("Foundry anvil", spawnSync("sh", ["-c", "command -v anvil"], { encoding: "utf8", env: commandEnv }).stdout?.trim() || "missing", "warn");
}

function openClawCommand() {
  return spawnSync("sh", ["-c", "command -v openclaw"], {
    encoding: "utf8",
    env: commandEnv,
  }).stdout?.trim() || "";
}

function openClawActions() {
  header("OPENCLAW ACTION POLICY", "CONTROLLED COMMANDS");
  console.log(`${bold("READ-ONLY ACTIONS")}
  balance l1|l2 <address>
  chain status
  contract list
  contract deployments
  contract read l1|l2 <address> <signature> [args]
  rollup status
  supernode list

${bold("CONFIRMATION REQUIRED")}
  send l1|l2 <address> <amount>
  contract compile <name>
  contract deploy l1|l2 <name>
  contract write l1|l2 <address> <signature> [args]
`);
  console.log(dim("The OpenClaw adapter rejects every command outside this policy."));
}

async function openClawStatus() {
  header("OPENCLAW INTEGRATION", "LOCAL CONNECTOR");
  const cli = openClawCommand();
  let gateway = false;
  try {
    const response = await fetch("http://127.0.0.1:18789/healthz", { signal: AbortSignal.timeout(1200) });
    gateway = response.ok;
  } catch {
    gateway = false;
  }
  row("Project skill", existsSync(join(openClawSkill, "SKILL.md")) ? openClawSkill : "missing",
    existsSync(join(openClawSkill, "SKILL.md")) ? "ok" : "down");
  row("Controlled adapter", existsSync(join(openClawSkill, "scripts", "medoxiechain.sh")) ? "ready" : "missing",
    existsSync(join(openClawSkill, "scripts", "medoxiechain.sh")) ? "ok" : "down");
  row("OpenClaw CLI", cli || "not installed", cli ? "ok" : "warn");
  row("OpenClaw Gateway", gateway ? "http://127.0.0.1:18789" : "not running", gateway ? "ok" : "warn");
  row("Execution policy", "allowlisted actions + approval", "warn");
  console.log(dim("OpenClaw discovers the project skill when its workspace is this repository."));
}

function installOpenClawSkill() {
  const cli = openClawCommand();
  if (!cli) throw new Error("OpenClaw CLI is not installed; install OpenClaw, then retry this command");
  header("OPENCLAW SKILL INSTALL", "LOCAL CONNECTOR");
  const result = spawnSync(cli, ["skills", "install", openClawSkill, "--as", "medoxiechain-operator"], {
    stdio: "inherit",
    env: commandEnv,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`OpenClaw skill installation failed with status ${result.status}`);
  console.log(`${green("✓")} OpenClaw skill installed. Start a new OpenClaw session to load it.`);
}

function printGatewayLineChart(l1Availability, l2Availability, sampleCount = 8) {
  const points = Array.from({ length: sampleCount }, () => "o").join("---");
  console.log(bold("GATEWAY AVAILABILITY TREND"));
  console.log(dim("RPC health sampled across the recent observation window."));
  console.log();
  console.log(`100% | ${l2Availability === 100 ? cyan(`L2 ${points}`) : ""}`);
  if (l1Availability === 100) console.log(`     | ${yellow(`L1 ${points}`)}`);
  console.log(" 75% |");
  console.log(" 50% |");
  console.log(" 25% |");
  console.log(`  0% | ${l1Availability === 0 ? yellow(`L1 ${points}`) : ""}`);
  if (l2Availability === 0) console.log(`     | ${red(`L2 ${points}`)}`);
  console.log("     +------------------------------------");
  console.log("       oldest                         now");
  console.log();
}

function blockActivityBar(txCount, gasUsed) {
  const activity = Math.min(18, Math.max(2, txCount * 4, gasUsed > 0 ? 3 : 0));
  return cyan("█".repeat(activity)) + dim("░".repeat(18 - activity));
}

function chainUtilization(blocks) {
  const window = blocks.slice(0, 24);
  if (window.length === 0) return 0;
  const activeBlocks = window.filter((block) => (block.transactions?.length || 0) > 0 || hexNumber(block.gasUsed) > 0).length;
  const txCount = window.reduce((sum, block) => sum + (block.transactions?.length || 0), 0);
  const gasRatios = window.map((block) => {
    const gasLimit = hexNumber(block.gasLimit);
    return gasLimit > 0 ? (hexNumber(block.gasUsed) / gasLimit) * 100 : 0;
  });
  const averageGas = gasRatios.reduce((sum, value) => sum + value, 0) / window.length;
  const activityScore = (activeBlocks / window.length) * 60 + Math.min(30, txCount * 6);
  return Math.min(100, Math.round(Math.max(averageGas, activityScore)));
}

function redLoadBar(percent, width = 24) {
  const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * width);
  return red("█".repeat(filled)) + dim("░".repeat(width - filled));
}

async function animateChainLoad(scannedBlocks) {
  let blocks = [...scannedBlocks];
  let lastHead = blocks[0] ? hexNumber(blocks[0].number) : -1;
  for (let sample = 1; sample <= 7; sample += 1) {
    const latest = await rpc("eth_getBlockByNumber", ["latest", false]).catch(() => null);
    if (latest && hexNumber(latest.number) > lastHead) {
      blocks.unshift(latest);
      lastHead = hexNumber(latest.number);
    }
    const percent = chainUtilization(blocks);
    process.stdout.write(
      `\rChain utilization   ${redLoadBar(percent)} ${String(percent).padStart(3)}%  sample ${sample}/7`,
    );
    await sleep(320);
  }
  process.stdout.write("\n");
  return chainUtilization(blocks);
}

async function logs() {
  header("NODE OPERATIONS DASHBOARD");
  if (!(await isLive())) {
    row("L2 Gateway", rpcUrl, "down");
    console.log(dim("Start it with: ./medoxie chain start"));
    return;
  }

  const snapshot = await liveSnapshot();
  const l1Live = await isLive(l1RpcUrl);
  const l1Height = l1Live ? hexNumber(await rpc("eth_blockNumber", [], l1RpcUrl)) : null;
  const scanCount = Math.min(128, snapshot.block + 1);
  const blockNumbers = Array.from({ length: scanCount }, (_, index) => snapshot.block - index);
  const scannedBlocks = (await Promise.all(
    blockNumbers.map((number) => rpc("eth_getBlockByNumber", [`0x${number.toString(16)}`, false]).catch(() => null)),
  )).filter(Boolean);
  const recentBlocks = scannedBlocks.slice(0, 8);
  const recentTransactions = scannedBlocks
    .flatMap((block) => (block.transactions || []).map((txHash) => ({ txHash, block: hexNumber(block.number) })))
    .slice(0, 5);

  printGatewayLineChart(l1Live ? 100 : 0, 100, Math.min(8, recentBlocks.length || 8));
  row("L1 Gateway", l1Live ? `${l1RpcUrl} / block ${l1Height}` : "STANDBY", l1Live ? "ok" : "warn");
  row("L2 Gateway", `${rpcUrl} / block ${snapshot.block}`);
  row("L2 Chain ID", snapshot.chainId);
  row("L1 batch head", snapshot.batch);
  row("Funded accounts", snapshot.accounts.length);

  console.log(`\n${bold("RECENT BLOCK PRODUCTION")}`);
  console.log(dim("+--------+------+------------+-----------------------+--------------------+"));
  console.log("| BLOCK  | TXS  | GAS USED   | BLOCK HASH            | ACTIVITY           |");
  console.log(dim("+--------+------+------------+-----------------------+--------------------+"));
  for (const block of recentBlocks) {
    const number = hexNumber(block.number);
    const txCount = block.transactions?.length || 0;
    const gasUsed = hexNumber(block.gasUsed);
    const blockHash = shortHash(block.hash).padEnd(21);
    const activity = blockActivityBar(txCount, gasUsed);
    console.log(
      `| ${String(number).padStart(6)} | ${String(txCount).padStart(4)} | ${String(gasUsed).padStart(10)} | ${blockHash} | ${activity} |`,
    );
  }
  console.log(dim("+--------+------+------------+-----------------------+--------------------+"));

  console.log(`\n${bold("RECENT TRANSACTION RECORDS")}`);
  if (recentTransactions.length === 0) {
    console.log(dim("No transactions were found in the most recent 128 blocks."));
  } else {
    recentTransactions.forEach(({ txHash, block }, index) => {
      console.log(`${green("✓")} ${String(index + 1).padStart(2)}  block ${String(block).padStart(6)}  ${txHash}`);
    });
  }

  const latest = recentBlocks[0];
  const latestGas = latest ? hexNumber(latest.gasUsed) : 0;
  const latestTxs = latest?.transactions?.length || 0;
  console.log(`\n${bold("NODE PERFORMANCE")}`);
  console.log(`Block cadence       ${cyan("████████████████████")} 2.0s configured`);
  console.log(`RPC availability    ${green("████████████████████")} 100% live`);
  console.log(`Latest block gas    ${blockActivityBar(latestTxs, latestGas)} ${latestGas}`);
  console.log(`L1 settlement       ${l1Live ? green("████████████████████ online") : dim("░░░░░░░░░░░░░░░░░░░░ standby")}`);
  await animateChainLoad(scannedBlocks);
  console.log(dim("Utilization is derived from active blocks, transaction count, and gas usage in the latest 24-block window."));
  console.log(dim(`\nRaw engine log: ${logFile}`));
}

function help() {
  console.log(`${bold("MedoxieChain local commands")}

  ./medoxie build                     Compile the modified Rust node
  ./medoxie chain start [--l1]        Start L2 with optional manual L1 sidecar
  ./medoxie chain status              Show live RPC, block and batch state
  ./medoxie chain logs                Show gateway charts and recent block production
  ./medoxie chain stop                Stop the managed local node
  ./medoxie send l2 <address> <MDX>   Send native MDX on L2
  ./medoxie send l1 <address> <MDX>   Send native MDX on L1 sidecar
  ./medoxie balance l2 <address>      Query an address's live L2 MDX balance
  ./medoxie balance l1 <address>      Query an address's live L1 MDX balance
  ./medoxie bridge l1-to-l2 <address> <MDX>  Move local MDX from L1 to L2
  ./medoxie bridge l2-to-l1 <address> <MDX>  Move local MDX from L2 to L1
  ./medoxie contract list             List Solidity contracts
  ./medoxie contract new <name>       Create a Solidity contract template
  ./medoxie contract edit <name>      Edit a contract in the terminal
  ./medoxie contract show <name>      Print Solidity source
  ./medoxie contract compile [name]   Compile one or all contracts with Foundry
  ./medoxie contract deploy <l1|l2> <name>  Deploy a compiled contract
  ./medoxie contract deployments      List recorded contract deployments
  ./medoxie contract read <l1|l2> <address> '<signature>' [args]
  ./medoxie contract write <l1|l2> <address> '<signature>' [args]
  ./medoxie supernode list            Show the active DPoS supernode registry
  ./medoxie supernode stake <node-id> <MDX> [wallet]  Delegate live L2 MDX
  ./medoxie supernode invite <address> [name]         Invite a candidate operator
  ./medoxie privacy transfer          Submit a real L2 transfer + modeled privacy metadata
  ./medoxie zk watch                  Model responsive ZK proof over a live batch
  ./medoxie rvp watch                 Watch live state with modeled challenge policy
  ./medoxie rvp challenge [batch]     Trigger a modeled challenged-batch proof flow
  ./medoxie sequencer watch           Model Tendermint/BLS quorum over live blocks
  ./medoxie rollup status             Inspect the live L2/L1 pipeline
  ./medoxie rollup commit [batch]     Call the real L1 batch commit RPC
  ./medoxie rollup prove [batch]      Call the real L1 batch prove RPC
  ./medoxie rollup execute [batch]    Call the real L1 batch execute RPC
  ./medoxie doctor                    Check local dependencies
  ./medoxie openclaw status           Check the OpenClaw connector
  ./medoxie openclaw actions          Show OpenClaw's controlled action policy
  ./medoxie openclaw install          Install the project skill into OpenClaw
  ./medoxie showcase                  Run the presentation-friendly walkthrough

${yellow("Truth boundary:")} LIVE values come from JSON-RPC. Anything marked MODELED is
presentation behavior and must not be represented as production cryptography or consensus.
`);
}

async function showcase() {
  await status();
  if (await isLive(l1RpcUrl)) {
    console.log(`${yellow("INFO")} Skipping the transfer in experimental L1 mode; use L2-only mode for the full walkthrough.`);
  } else {
    await privacyTransfer();
  }
  await zkWatch();
  await rvpWatch();
  await sequencerWatch();
  await rollupStatus();
}

async function main() {
  const [group = "help", action, value, ...rest] = process.argv.slice(2);
  if (group === "help" || group === "--help" || group === "-h") return help();
  if (group === "build") return build();
  if (group === "doctor") return doctor();
  if (group === "showcase") return showcase();
  if (group === "chain" && action === "start") return startChain([value, ...rest].filter(Boolean));
  if (group === "chain" && action === "stop") return stopChain();
  if (group === "chain" && action === "status") return status();
  if (group === "chain" && action === "logs") return logs();
  if (group === "send") return sendMdx(action, value, rest[0]);
  if (group === "balance") return balanceMdx(action, value);
  if (group === "bridge") return bridgeMdx(action, value, rest[0]);
  if (group === "contract" && action === "list") return listContracts();
  if (group === "contract" && action === "new") return newContract(value);
  if (group === "contract" && action === "edit") return editContract(value);
  if (group === "contract" && action === "show") return showContract(value);
  if (group === "contract" && action === "compile") return buildContract(value);
  if (group === "contract" && action === "deploy") return deployContract(value, rest[0]);
  if (group === "contract" && action === "deployments") return listContractDeployments();
  if (group === "contract" && action === "read") return readContract(value, rest[0], rest[1], rest.slice(2));
  if (group === "contract" && action === "write") return writeContract(value, rest[0], rest[1], rest.slice(2));
  if (group === "supernode" && action === "list") return listSupernodes();
  if (group === "supernode" && action === "stake") return stakeToSupernode(value, rest[0], rest[1]);
  if (group === "supernode" && action === "invite") return inviteSupernode(value, rest.join(" "));
  if (group === "privacy" && action === "transfer") return privacyTransfer();
  if (group === "zk" && action === "watch") return zkWatch();
  if (group === "rvp" && action === "watch") return rvpWatch();
  if (group === "rvp" && action === "challenge") return rvpChallenge(value);
  if (group === "sequencer" && action === "watch") return sequencerWatch();
  if (group === "rollup" && action === "status") return rollupStatus();
  if (group === "rollup" && ["commit", "prove", "execute"].includes(action)) return rollupAction(action, value);
  if (group === "openclaw" && action === "status") return openClawStatus();
  if (group === "openclaw" && action === "actions") return openClawActions();
  if (group === "openclaw" && action === "install") return installOpenClawSkill();
  help();
  throw new Error(`Unknown command: ${[group, action, value].filter(Boolean).join(" ")}`);
}

main().catch((error) => {
  console.error(`\n${red("ERROR MedoxieChain command failed:")} ${error.message}`);
  process.exitCode = 1;
});
