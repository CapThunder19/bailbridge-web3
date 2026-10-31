/**
 * Deploy BailRegistry, grant roles, and export deployment info + ABI.
 *
 * Writes (never containing private keys):
 *   deployments/<network>.json
 *   server/src/generated/deployment.json
 *   web/src/generated/deployment.json
 *
 * Role addresses come from env. On localhost they default to Hardhat accounts:
 *   #0 admin + registrar, #1 lawyer, #2 issuer, #3 prison.
 */
import { ethers, network, artifacts } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..", "..");

function addressList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((a) => ethers.getAddress(a));
}

async function main() {
  const [deployer, ...rest] = await ethers.getSigners();
  const isLocal = network.name === "localhost" || network.name === "hardhat";
  const { chainId } = await ethers.provider.getNetwork();

  // A local Hardhat chain always uses the well-known Hardhat accounts, so the same .env
  // (with Sepolia values filled in) also works for local development.
  const env = (name: string) => (isLocal ? undefined : process.env[name]);
  const admin = env("ADMIN_ADDRESS") ? ethers.getAddress(env("ADMIN_ADDRESS")!) : deployer.address;
  const registrars = addressList(env("REGISTRAR_ADDRESS"));
  const lawyers = addressList(env("LAWYER_ADDRESSES"));
  const issuers = addressList(env("ISSUER_ADDRESSES"));
  const prisons = addressList(env("PRISON_ADDRESSES"));

  if (isLocal) {
    registrars.push(deployer.address);
    lawyers.push(rest[0].address);
    issuers.push(rest[1].address);
    prisons.push(rest[2].address);
  } else {
    if (!registrars.length) registrars.push(deployer.address);
    for (const [name, list] of [
      ["LAWYER_ADDRESSES", lawyers],
      ["ISSUER_ADDRESSES", issuers],
      ["PRISON_ADDRESSES", prisons],
    ] as const) {
      if (!list.length) throw new Error(`${name} must be set for network ${network.name}`);
    }
  }

  console.log(`Network: ${network.name} (chainId ${chainId})`);
  console.log(`Deployer: ${deployer.address}`);

  const Registry = await ethers.getContractFactory("BailRegistry");
  // Deploy with the deployer as temporary admin so it can grant roles,
  // then hand admin to ADMIN_ADDRESS if different.
  const registry = await Registry.deploy(deployer.address);
  const deployTx = registry.deploymentTransaction();
  await registry.waitForDeployment();
  const receipt = await deployTx!.wait();
  const address = await registry.getAddress();
  const deploymentBlock = receipt!.blockNumber;
  console.log(`BailRegistry: ${address} (block ${deploymentBlock})`);

  const grant = async (roleName: string, role: string, who: string[]) => {
    for (const a of who) {
      if (await registry.hasRole(role, a)) continue;
      const tx = await registry.grantRole(role, a);
      await tx.wait();
      console.log(`  granted ${roleName} -> ${a}`);
    }
  };
  await grant("REGISTRAR_ROLE", await registry.REGISTRAR_ROLE(), registrars);
  await grant("LAWYER_ROLE", await registry.LAWYER_ROLE(), lawyers);
  await grant("ISSUER_ROLE", await registry.ISSUER_ROLE(), issuers);
  await grant("PRISON_ROLE", await registry.PRISON_ROLE(), prisons);

  if (admin !== deployer.address) {
    const adminRole = await registry.DEFAULT_ADMIN_ROLE();
    await (await registry.grantRole(adminRole, admin)).wait();
    await (await registry.renounceRole(adminRole, deployer.address)).wait();
    console.log(`  admin handed to ${admin}`);
  }

  const artifact = await artifacts.readArtifact("BailRegistry");
  const explorerUrl = isLocal
    ? null
    : process.env.EXPLORER_URL || (Number(chainId) === 11155111 ? "https://sepolia.etherscan.io" : null);
  const publicRpcUrl = isLocal ? "http://127.0.0.1:8545" : process.env.PUBLIC_RPC_URL || null;
  if (!isLocal && !publicRpcUrl) console.warn("  PUBLIC_RPC_URL is not set: /verify and /release-clock will have no RPC to read from.");

  const deployment = {
    contract: "BailRegistry",
    network: network.name,
    chainId: Number(chainId),
    address,
    deploymentBlock,
    deployedAt: new Date().toISOString(),
    explorerUrl,
    publicRpcUrl,
    roles: { admin, registrars, lawyers, issuers, prisons },
    abi: artifact.abi,
  };

  const json = JSON.stringify(deployment, null, 2) + "\n";
  const targets = [
    path.join(ROOT, "deployments", `${network.name}.json`),
    path.join(ROOT, "server", "src", "generated", "deployment.json"),
    path.join(ROOT, "web", "src", "generated", "deployment.json"),
  ];
  for (const file of targets) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, json);
    console.log(`  wrote ${path.relative(ROOT, file)}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
