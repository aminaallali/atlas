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
    console.log({
      blockNumber: l.blockNumber,
      txHash: l.transactionHash,
      topics: l.topics,
      data: l.data,
    });
  }

  // 4) Check implementation bytecode contains selector
  const code = await provider.getCode(IMPLEMENTATION, "latest");
  const hasSelector = code.toLowerCase().includes(INIT_V21_SELECTOR.slice(2));
  console.log("implementation selector 0x2fc81e09 present:", hasSelector);

  console.log("done");
})().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});