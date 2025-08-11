const { ethers } = require("ethers");

// Configuration
const RPC = process.env.RPC_URL || "https://cloudflare-eth.com";
const provider = new ethers.providers.JsonRpcProvider(RPC);

const PROXY = (process.env.PROXY || "0xfe18ae03741a5b84e39c295ac9c856ed7991c38e").toLowerCase();
// EIP-1967 implementation slot per code noted
const IMPLEMENTATION_SLOT =
  process.env.IMPLEMENTATION_SLOT ||
  "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3";

// Topics
const TRANSFER_TOPIC = ethers.utils.id("Transfer(address,address,uint256)");
const BLACKLISTED_TOPIC = ethers.utils.id("Blacklisted(address)");

// Minimal ABI for required readonly calls
const ABI = [
  "function isBlacklisted(address) view returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function name() view returns (string)",
  "function owner() view returns (address)",
  "function version() view returns (string)"
];

const ALWAYS_SCAN_TRANSFERS = process.env.ALWAYS_SCAN_TRANSFERS === "1";

function stripHex32ToAddr(x) {
  const clean = x.replace(/^0x/, "");
  return ("0x" + clean.slice(24)).toLowerCase();
}

async function readImplementation() {
  const implRaw = await provider.send("eth_getStorageAt", [PROXY, IMPLEMENTATION_SLOT, "latest"]);
  return stripHex32ToAddr(implRaw);
}

async function callSafe(contract, fn, args = []) {
  try {
    return await contract[fn](...args);
  } catch (e) {
    return undefined;
  }
}

async function callAtBlock(contract, fn, args, blockTag) {
  try {
    const lastArg = args[args.length - 1];
    if (lastArg && typeof lastArg === "object" && lastArg.blockTag) {
      const newArgs = [...args.slice(0, -1), { ...lastArg, blockTag }];
      return await contract[fn](...newArgs);
    }
    return await contract[fn](...args, { blockTag });
  } catch (e) {
    return undefined;
  }
}

async function fetchBlacklistedEvents(fromBlock, toBlock) {
  const logs = await provider.getLogs({
    address: PROXY,
    fromBlock,
    toBlock,
    topics: [BLACKLISTED_TOPIC, ethers.utils.hexZeroPad(PROXY, 32)]
  });
  return logs;
}

async function fetchTransferFromProxy(fromBlock, toBlock) {
  const logs = await provider.getLogs({
    address: PROXY,
    fromBlock,
    toBlock,
    topics: [TRANSFER_TOPIC, ethers.utils.hexZeroPad(PROXY, 32)]
  });
  return logs;
}

async function codeExistsAtBlock(address, blockTag) {
  try {
    const code = await provider.getCode(address, blockTag);
    return code && code !== "0x";
  } catch (e) {
    return false;
  }
}

async function findFirstCodeBlock(address, latest) {
  // Binary search earliest block where code exists
  let lo = 1;
  let hi = latest;
  let ans = -1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const exists = await codeExistsAtBlock(address, mid);
    if (exists) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans;
}

async function findBlacklistToggleBlock(contract, startBlock, endBlock) {
  // Find first block where isBlacklisted(PROXY) returns true
  let lo = startBlock;
  let hi = endBlock;
  let ans = -1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const val = await callAtBlock(contract, "isBlacklisted", [PROXY], mid);
    if (val === undefined) {
      // provider limitation; shrink range conservatively
      hi = mid - 1;
      continue;
    }
    if (val) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans;
}

async function scanTransfersWindow(fromBlock, toBlock, chunk) {
  console.log(`Scanning Transfer-from-proxy events in [${fromBlock}, ${toBlock}] with chunk ${chunk}...`);
  let total = 0;
  for (let start = fromBlock; start <= toBlock; start += chunk) {
    const end = Math.min(toBlock, start + chunk - 1);
    try {
      const logs = await fetchTransferFromProxy(start, end);
      if (logs.length > 0) {
        total += logs.length;
        for (const t of logs) {
          const to = "0x" + t.topics[2].slice(26);
          console.log("  Transfer from proxy ->", to, "block:", t.blockNumber, "tx:", t.transactionHash, "value:", t.data);
        }
      }
    } catch (e) {
      console.log(`  Transfer scan error on [${start}, ${end}]:`, e.message || e);
    }
  }
  console.log(`Total Transfer-from-proxy events in window: ${total}`);
}

(async () => {
  console.log("Using RPC:", RPC);
  console.log("Proxy:", PROXY);

  // 1) Read current implementation from slot
  const implementationAddress = await readImplementation();
  console.log("Implementation address (from slot):", implementationAddress);

  // 2) Quick state probes
  const contract = new ethers.Contract(PROXY, ABI, provider);
  const [name, owner, version, isBlacklistedSelf, balanceSelf] = await Promise.all([
    callSafe(contract, "name"),
    callSafe(contract, "owner"),
    callSafe(contract, "version"),
    callSafe(contract, "isBlacklisted", [PROXY]),
    callSafe(contract, "balanceOf", [PROXY])
  ]);

  if (name !== undefined) console.log("Token name:", name);
  if (version !== undefined) console.log("Version():", version);
  if (owner !== undefined) console.log("Owner:", owner);
  if (isBlacklistedSelf !== undefined) console.log("isBlacklisted(address(this)):", isBlacklistedSelf);
  if (balanceSelf !== undefined) console.log("balanceOf(address(this)):", balanceSelf.toString());

  const latest = await provider.getBlockNumber();

  // 3) Try to locate the block when proxy became blacklisted (if currently true)
  let firstCodeBlock = await findFirstCodeBlock(PROXY, latest);
  console.log("First block with code at proxy:", firstCodeBlock);

  if (isBlacklistedSelf) {
    console.log("Attempting to locate the first block where proxy became blacklisted (binary search)...");
    if (firstCodeBlock === -1) {
      console.log("Could not determine firstCodeBlock; skipping toggle search.");
    } else {
      const atStart = await callAtBlock(contract, "isBlacklisted", [PROXY], firstCodeBlock);
      if (atStart === undefined) {
        console.log("Provider does not support historical state reads adequately; skipping toggle search.");
      } else if (atStart === true) {
        console.log("Proxy was already blacklisted at first code block; cannot locate toggle.");
      } else {
        const toggleBlock = await findBlacklistToggleBlock(contract, firstCodeBlock, latest);
        if (toggleBlock === -1) {
          console.log("Could not find blacklist toggle block (provider limits or not toggled in range).");
        } else {
          console.log("Proxy first became blacklisted at block:", toggleBlock);
          // Scan a tight window around toggleBlock
          const delta = parseInt(process.env.XFER_LOOKUP_DELTA || "2000", 10);
          const fromBlock = Math.max(0, toggleBlock - delta);
          const toBlock = toggleBlock + delta;
          console.log(`Scanning events in [${fromBlock}, ${toBlock}] around toggle block...`);
          try {
            const bl = await fetchBlacklistedEvents(fromBlock, toBlock);
            for (const ev of bl) {
              console.log("Blacklisted event -> block:", ev.blockNumber, "tx:", ev.transactionHash);
            }
          } catch (e) {
            console.log("Blacklisted window scan error:", e.message || e);
          }
          try {
            const txs = await fetchTransferFromProxy(fromBlock, toBlock);
            if (txs.length === 0) {
              console.log("No Transfer-from-proxy events in toggle window.");
            } else {
              for (const t of txs) {
                const to = "0x" + t.topics[2].slice(26);
                console.log("Transfer from proxy ->", to, "block:", t.blockNumber, "tx:", t.transactionHash);
              }
            }
          } catch (e) {
            console.log("Transfer window scan error:", e.message || e);
          }
        }
      }
    }
  }

  // 4) Full-window transfer scan from firstCodeBlock to latest in safe chunks (default 50000)
  const CHUNK = parseInt(process.env.CHUNK || "50000", 10);
  if (firstCodeBlock > 0) {
    await scanTransfersWindow(firstCodeBlock, latest, CHUNK);
  }

  console.log("Done.");
})().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});