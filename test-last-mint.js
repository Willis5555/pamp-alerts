// Posts the most recent $FUEL mint to the chat as a test, formatted like the live alert.
//   node test-last-mint.js
"use strict";
const { ethers } = require("ethers");
const cfg = { ...require("./config.json") };
const nf = (n, d = 0) => Number(n).toLocaleString("en-US", { maximumFractionDigits: d });
const esc = s => String(s).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, m => "\\" + m);

(async () => {
  const p = new ethers.JsonRpcProvider("https://rpc.mainnet.chain.robinhood.com", { chainId: 4663, name: "robinhood" }, { staticNetwork: true });
  const head = await p.getBlockNumber();
  const logs = await p.getLogs({
    address: "0xe60C1F5d9bA7f62a392a78472a3Ab83DD62467A3",
    topics: [ethers.id("Transfer(address,address,uint256)"), ethers.zeroPadValue("0x00", 32)],
    fromBlock: head - 100000, toBlock: head
  });
  if (!logs.length) { console.log("no mint in the last 100,000 blocks"); return; }
  const last = logs[logs.length - 1], tx = last.transactionHash;
  const amount = logs.filter(l => l.transactionHash === tx).reduce((a, l) => a + BigInt(l.data), 0n);
  const blk = await p.getBlock(last.blockNumber);
  const ago = Math.round((Date.now() / 1000 - Number(blk.timestamp)) / 60);
  const text = `🧪 *Test — last $FUEL mint* \\(${esc(ago + " min ago")}\\):\n⛽ ${esc(nf(ethers.formatEther(amount)))} $FUEL minted · [tx](https://robin.etherscan.io/tx/${tx})`;
  const r = await fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: cfg.telegramChatId, text, parse_mode: "MarkdownV2", disable_web_page_preview: true })
  });
  const j = await r.json();
  console.log("last mint tx", tx, "| amount", nf(ethers.formatEther(amount)), "$FUEL | block", last.blockNumber, "|", ago, "min ago | posted:", j.ok ? "yes" : j.description);
})();
