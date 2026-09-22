// Posts the most recent $PAMP buy to the chat as a test, formatted like the live alert.
//   node test-last-buy.js
"use strict";
const { ethers } = require("ethers");
const cfg = { ...require("./config.json") };
const PAIR = "0xC774A953079B7411F313A2d23ECAcAFb19682b6E";
const CHART = "https://dexscreener.com/robinhood/0xc774a953079b7411f313a2d23ecacafb19682b6e";
const nf = (n, d = 0) => Number(n).toLocaleString("en-US", { maximumFractionDigits: d });
const esc = s => String(s).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, m => "\\" + m);
const fmtUsd = v => v >= 100 ? "$" + nf(v, 0) : v >= 1 ? "$" + nf(v, 2) : "$" + Number(v).toLocaleString("en-US", { maximumSignificantDigits: 3 });
const iface = new ethers.Interface(["event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"]);

(async () => {
  const p = new ethers.JsonRpcProvider("https://rpc.mainnet.chain.robinhood.com", { chainId: 4663, name: "robinhood" }, { staticNetwork: true });
  const head = await p.getBlockNumber();
  const logs = await p.getLogs({ address: PAIR, topics: [iface.getEvent("Swap").topicHash], fromBlock: head - 100000, toBlock: head });
  const buys = logs.map(l => ({ l, a: iface.parseLog({ topics: [...l.topics], data: l.data }).args })).filter(x => x.a.amount1 < 0n);
  if (!buys.length) { console.log("no $PAMP buy in the last 100,000 blocks"); return; }
  const { l: last, a } = buys[buys.length - 1], tx = last.transactionHash, pampOut = -a.amount1;
  let usd = null;
  try {
    const j = await (await fetch(`https://api.dexscreener.com/latest/dex/pairs/robinhood/${PAIR}`)).json();
    const pair = j.pair || (j.pairs && j.pairs[0]);
    usd = pair && pair.priceUsd ? Number(pair.priceUsd) : null;
  } catch {}
  const value = usd ? Number(ethers.formatEther(pampOut)) * usd : null;
  const blk = await p.getBlock(last.blockNumber);
  const ago = Math.round((Date.now() / 1000 - Number(blk.timestamp)) / 60);
  const text = `🧪 *Test — last $PAMP buy* \\(${esc(ago + " min ago")}\\):\n⛽ *${esc(nf(ethers.formatEther(pampOut)))} $PAMP* bought${value !== null ? ` ≈ ${esc(fmtUsd(value))}` : ""} · [chart](${CHART}) · [tx](https://robin.etherscan.io/tx/${tx})`;
  const r = await fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: cfg.telegramChatId, text, parse_mode: "MarkdownV2", disable_web_page_preview: true })
  });
  const j = await r.json();
  console.log("last buy tx", tx, "|", nf(ethers.formatEther(pampOut)), "$PAMP |", value !== null ? fmtUsd(value) : "no price", "| block", last.blockNumber, "|", ago, "min ago | posted:", j.ok ? "yes" : j.description);
})();
