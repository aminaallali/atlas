const { ethers } = require("ethers");

const RPC = process.env.RPC_URL || "https://ethereum-rpc.publicnode.com";
const provider = new ethers.providers.JsonRpcProvider(RPC);

const PROXY = "0xfe18ae03741a5b84e39c295ac9c856ed7991c38e".toLowerCase();
const IMPLEMENTATION = "0x7e772ed6e4bfeae80f2d58e4254f6b6e96669253";
const INIT_V21_SELECTOR = "0x2fc81e09";

const TOGGLE_BLOCK = 18969934; // 0x121754e
const FIRST_CODE_BLOCK = 18969842; // 0x12174f2
const LOG_FROM = 0x12174f0; // 18969840
const LOG_TO = 0x1217554;   // 18969940

const iface = new ethers.utils.Interface([
  "function initializeV2_1(address lostAndFound)",
  "event Blacklisted(address indexed account)",
  "event Transfer(address indexed from, address indexed to, uint256 value)"
]);

(async () => {
  console.log("RPC:", RPC);

  // 1) Block TOGGLE_BLOCK with transactions -> any tx to proxy?
  const blkToggle = await provider.getBlockWithTransactions(TOGGLE_BLOCK);
  const txsToProxyToggle = blkToggle.transactions.filter(
    (tx) => tx.to && tx.to.toLowerCase() === PROXY
  );
  console.log(`Block ${TOGGLE_BLOCK} txs to proxy:`, txsToProxyToggle.length);
  for (const tx of txsToProxyToggle) {
    console.log(
      "tx:", tx.hash,
      "from:", tx.from,
      "to:", tx.to,
      "input_prefix:", tx.data ? tx.data.slice(0, 10) : "0x",
      "block:", tx.blockNumber
    );
    // Decode lostAndFound if selector matches
    if (tx.data && tx.data.startsWith(INIT_V21_SELECTOR)) {
      try {
        const decoded = iface.decodeFunctionData("initializeV2_1", tx.data);
        console.log("decoded lostAndFound:", decoded.lostAndFound || decoded[0]);
      } catch (e) {
        console.log("decode error:", e.message || e);
      }
      // Fetch receipt and decode logs
      try {
        const rcpt = await provider.getTransactionReceipt(tx.hash);
        console.log("receipt status:", rcpt.status, "logs:", rcpt.logs.length);
        for (const l of rcpt.logs) {
          let parsed;
          try {
            parsed = iface.parseLog(l);
          } catch (_) {}
          console.log({
            logAddress: l.address,
            blockNumber: l.blockNumber,
            txHash: l.transactionHash,
            topics: l.topics,
            parsed: parsed ? { name: parsed.name, args: parsed.args } : null,
          });
        }
      } catch (e) {
        console.log("receipt fetch error:", e.message || e);
      }
    }
  }

  // 2) Block FIRST_CODE_BLOCK with transactions -> any tx to proxy?
  const blkFirst = await provider.getBlockWithTransactions(FIRST_CODE_BLOCK);
  const txsToProxyFirst = blkFirst.transactions.filter(
    (tx) => tx.to && tx.to.toLowerCase() === PROXY
  );
  console.log(`Block ${FIRST_CODE_BLOCK} txs to proxy:`, txsToProxyFirst.length);
  for (const tx of txsToProxyFirst) {
    console.log(
      "tx:", tx.hash,
      "from:", tx.from,
      "to:", tx.to,
      "input_prefix:", tx.data ? tx.data.slice(0, 10) : "0x",
      "block:", tx.blockNumber
    );
  }

  // 3) Logs for proxy in small window around toggle
  const logs = await provider.getLogs({
    address: PROXY,
    fromBlock: LOG_FROM,
    toBlock: LOG_TO,
  });
  console.log(`Logs for proxy in [${LOG_FROM}, ${LOG_TO}]: count=${logs.length}`);
  for (const l of logs.slice(0, 10)) {
    let parsed;
    try { parsed = iface.parseLog(l); } catch (_) {}
    console.log({
      blockNumber: l.blockNumber,
      txHash: l.transactionHash,
      topics: l.topics,
      parsed: parsed ? { name: parsed.name, args: parsed.args } : null,
    });
  }

  // 3b) Wider window scan around toggle in chunks
  const delta = 2000;
  const fromW = TOGGLE_BLOCK - delta;
  const toW = TOGGLE_BLOCK + delta;
  const chunk = 500;
  let total = 0;
  console.log(`Scanning wider logs window [${fromW}, ${toW}] in chunks of ${chunk}...`);
  for (let b = fromW; b <= toW; b += chunk) {
    const t = Math.min(toW, b + chunk - 1);
    try {
      const ls = await provider.getLogs({ address: PROXY, fromBlock: b, toBlock: t });
      total += ls.length;
      // print any logs parsed as Blacklisted/Transfer
      for (const l of ls) {
        let parsed;
        try { parsed = iface.parseLog(l); } catch (_) {}
        if (parsed && (parsed.name === "Blacklisted" || parsed.name === "Transfer")) {
          console.log("log:", { blk: l.blockNumber, tx: l.transactionHash, event: parsed.name, args: parsed.args });
        }
      }
    } catch (e) {
      console.log(`  getLogs error [${b}, ${t}]:`, e.message || e);
    }
  }
  console.log("wider window total logs:", total);

  // 4) Check implementation bytecode contains selector
  const code = await provider.getCode(IMPLEMENTATION, "latest");
  const hasSelector = code.toLowerCase().includes(INIT_V21_SELECTOR.slice(2));
  console.log("implementation selector 0x2fc81e09 present:", hasSelector);

  console.log("done");
})().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});