#!/usr/bin/env node
"use strict";
/* PAMP entry alerts for Telegram.
   Watches the DailyAuctionV2 contract on Robinhood Chain and posts one message per entry
   transaction, plus a note when a day closes. Plain Node: no framework, no database. State
   (the last block handled) lives in a small JSON file next to this script so a restart never
   posts the same entry twice.

   Run:   node entry-alerts.js            (needs config.json, see README.md)
   Test:  node entry-alerts.js --dry-run  (prints instead of posting; no bot token needed)
   Once:  node entry-alerts.js --once     (one poll, then exit; for cron / Task Scheduler) */

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const DRY = process.argv.includes("--dry-run");
const ONCE = process.argv.includes("--once");
const HERE = __dirname;
const CONFIG_PATH = path.join(HERE, "config.json");
const STATE_PATH = path.join(HERE, "state.json");

const DEFAULTS = {
  rpc: ["https://rpc.mainnet.chain.robinhood.com", "https://robinhood.drpc.org"],
  auction: "0x140CD99bC94Ab43c735f7839457890C957710483",
  burner: "0xae399b78eA729A4730c65b8D368cd6F280f95728",     // the $MORE burner the auction pays into
  auctionDeployBlock: 68090257,
  explorer: "https://robin.etherscan.io",
  dashboard: "https://willis5555.github.io/PAMP/",
  pollSeconds: 15,
  lookbackBlocks: 6000,   // with no saved state, scan this far back (~10 min at ~10 blocks/s)
  // the page shows the contract's day 2 as day 1; the bot says the same numbers
  dayOffset: 1,
  minEntries: 1,          // ignore transactions with fewer entries than this
  fuelToken: "0xe60C1F5d9bA7f62a392a78472a3Ab83DD62467A3",
  fuelMints: true,        // also post a one-liner whenever $FUEL is minted
  fuelMintMin: 0,         // ...but only when a transaction mints at least this many $FUEL
  // $PAMP buys: every swap on the PAMP/WETH Uniswap V3 pool where $PAMP leaves the pool.
  pampPair: "0xC774A953079B7411F313A2d23ECAcAFb19682b6E",
  pampBuys: true,
  pampBuyMinUsd: 0,       // only announce buys worth at least this many dollars (0 = all)
  dexscreener: "https://dexscreener.com/robinhood/0xc774a953079b7411f313a2d23ecacafb19682b6e",
  telegramBotToken: "",
  telegramChatId: ""
};

const ABI = [
  "event Entered(address indexed buyer, uint256 indexed day, uint256 count, uint256 ethPaid, uint256 fuelBurned)",
  "function currentDay() view returns (uint256)",
  "function dayEntries(uint256) view returns (uint256)",
  "function userEntries(uint256,address) view returns (uint256)",
  "function today() view returns (uint256 day, uint256 emission, uint256 entries, uint256 secondsLeft)",
  "function schedule() view returns (address)"
];
const SCHEDULE_ABI = ["function emissionFor(uint256) view returns (uint256)"];
const BURNER_ABI = ["event LegBurned(uint256 indexed leg, uint256 ethIn, uint256 moreBurned)"];
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
const ZERO_TOPIC = ethers.zeroPadValue("0x00", 32);
const SWAP_IFACE = new ethers.Interface(["event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"]);
const SWAP_TOPIC = SWAP_IFACE.getEvent("Swap").topicHash;

// $PAMP's dollar price from DexScreener, cached for a minute so a burst of buys costs one call.
let priceCache = { at: 0, usd: null };
async function pampUsd(cfg) {
  if (Date.now() - priceCache.at < 60000) return priceCache.usd;
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/pairs/robinhood/${cfg.pampPair}`);
    const j = await r.json();
    const pair = j.pair || (j.pairs && j.pairs[0]);
    priceCache = { at: Date.now(), usd: pair && pair.priceUsd ? Number(pair.priceUsd) : null };
  } catch { priceCache = { at: Date.now(), usd: null }; }
  return priceCache.usd;
}
const fmtUsd = v => v >= 100 ? "$" + nf(v, 0) : v >= 1 ? "$" + nf(v, 2) : "$" + Number(v).toLocaleString("en-US", { maximumSignificantDigits: 3 });

// ---------------------------------------------------------------- config + state
function loadConfig() {
  let file = {};
  if (fs.existsSync(CONFIG_PATH)) file = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const cfg = { ...DEFAULTS, ...file };
  cfg.telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || cfg.telegramBotToken;
  cfg.telegramChatId = process.env.TELEGRAM_CHAT_ID || cfg.telegramChatId;
  if (!DRY && (!cfg.telegramBotToken || !cfg.telegramChatId)) {
    console.error("Missing telegramBotToken / telegramChatId. Put them in config.json (see README.md) or run with --dry-run.");
    process.exit(1);
  }
  return cfg;
}
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); } catch { return {}; }
}
function saveState(st) { fs.writeFileSync(STATE_PATH, JSON.stringify(st, null, 2)); }

// ---------------------------------------------------------------- chain
function providers(cfg) {
  return cfg.rpc.map(url => {
    const req = new ethers.FetchRequest(url); req.timeout = 15000;
    return new ethers.JsonRpcProvider(req, { chainId: 4663, name: "robinhood" }, { staticNetwork: true, batchMaxCount: 1 });
  });
}
async function withRpc(ps, fn) {
  let last;
  for (const p of ps) { try { return await fn(p); } catch (e) { last = e; } }
  throw last;
}

// ---------------------------------------------------------------- formatting
const nf = (n, d = 0) => Number(n).toLocaleString("en-US", { maximumFractionDigits: d });
const short = a => a.slice(0, 6) + "…" + a.slice(-4);
const fmtEth = wei => nf(Number(ethers.formatEther(wei)), 5) + " ETH";
const fmtTok = (wei, d = 0) => nf(Number(ethers.formatEther(wei)), d);
const esc = s => String(s).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, m => "\\" + m); // MarkdownV2
const hms = secs => { secs = Math.max(0, secs); const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60); return `${h}h ${String(m).padStart(2, "0")}m`; };

function entryMessage(cfg, ev, ctx) {
  const shown = Number(ev.day) - cfg.dayOffset;
  const dayLabel = shown >= 1 ? `day ${shown}` : "pre\\-launch day";
  const share = ctx.dayEntries > 0n ? Number((ev.count * 10000n) / ctx.dayEntries) / 100 : 100;
  const est = ctx.dayEntries > 0n && ctx.emission ? (ctx.emission * ev.count) / ctx.dayEntries : null;
  const lines = [
    `🟢 *New entry* — ${esc(dayLabel)}`,
    `[${esc(short(ev.buyer))}](${cfg.explorer}/address/${ev.buyer}) entered *${esc(nf(ev.count))}* ${ev.count === 1n ? "entry" : "entries"}`,
    `${esc(fmtEth(ev.ethPaid))} paid · burned *${esc(fmtTok(ev.fuelBurned))} $FUEL* and *${esc(fmtTok(ev.moreBurned ?? 0n))} $MORE* in this tx`,
    `Day so far: *${esc(nf(ctx.dayEntries))}* entries · this wallet holds ${esc(share.toFixed(1))}% of them`,
  ];
  if (est) lines.push(`Their share if the day closed now: ≈ ${esc(fmtTok(est, 0))} $PAMP`);
  if (ctx.secondsLeft != null) lines.push(`Day closes in ${esc(hms(ctx.secondsLeft))}`);
  lines.push(`[tx](${cfg.explorer}/tx/${ev.tx}) · [dashboard](${cfg.dashboard})`);
  return lines.join("\n");
}
function rolloverMessage(cfg, closedDay, closedEntries, emission, newDay) {
  const c = Number(closedDay) - cfg.dayOffset, n = Number(newDay) - cfg.dayOffset;
  const per = closedEntries > 0n ? emission / closedEntries : 0n;
  return [
    `🔔 *Day ${esc(c)} has closed*`,
    `${esc(nf(closedEntries))} entries · ${esc(fmtTok(emission))} $PAMP to claim · ${closedEntries > 0n ? esc(fmtTok(per, 2)) + " $PAMP per entry" : "nobody entered, nothing minted"}`,
    `*Day ${esc(n)} is open\\.* [Enter](${cfg.dashboard})`
  ].join("\n");
}

// ---------------------------------------------------------------- telegram
async function send(cfg, text) {
  if (DRY) { console.log("\n--- would post ---\n" + text + "\n"); return; }
  const r = await fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: cfg.telegramChatId, text, parse_mode: "MarkdownV2", disable_web_page_preview: true })
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error("telegram: " + (j.description || r.status));
}

// ---------------------------------------------------------------- the loop
async function poll(cfg, ps, state) {
  const iface = new ethers.Interface(ABI);
  const head = await withRpc(ps, p => p.getBlockNumber());
  // No saved state (first run, or a scheduled runner whose cache did not come back): look a
  // little way back rather than starting at the head, so a run never silently skips what
  // happened just before it. lookbackBlocks ~ 10 minutes on this chain.
  const from = state.lastBlock ? state.lastBlock + 1 : Math.max(cfg.auctionDeployBlock, head - (cfg.lookbackBlocks || 0));
  if (!state.lastBlock) console.log("no saved state: scanning from block", from, "to", head);
  if (from <= head) {
    const logs = await withRpc(ps, p => p.getLogs({ address: cfg.auction, topics: [iface.getEvent("Entered").topicHash], fromBlock: from, toBlock: head }));
    // one message per transaction, in order
    for (const lg of logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index)) {
      const ev = iface.parseLog({ topics: [...lg.topics], data: lg.data });
      const e = { buyer: ev.args.buyer, day: ev.args.day, count: ev.args.count, ethPaid: ev.args.ethPaid, fuelBurned: ev.args.fuelBurned, tx: lg.transactionHash };
      if (e.count < BigInt(cfg.minEntries)) continue;
      // the $MORE burned by this same transaction: the burner's LegBurned events in its receipt
      try {
        const rc = await withRpc(ps, p => p.getTransactionReceipt(lg.transactionHash));
        const bi = new ethers.Interface(BURNER_ABI), topic = bi.getEvent("LegBurned").topicHash;
        e.moreBurned = rc.logs.filter(x => x.address.toLowerCase() === cfg.burner.toLowerCase() && x.topics[0] === topic)
          .reduce((sum, x) => sum + bi.parseLog({ topics: [...x.topics], data: x.data }).args.moreBurned, 0n);
      } catch { e.moreBurned = null; }
      const a = new ethers.Contract(cfg.auction, ABI, ps[0]);
      const [t, dayEntries] = await withRpc(ps, async p => Promise.all([a.connect(p).today(), a.connect(p).dayEntries(e.day)]));
      const ctx = { dayEntries, emission: t.day === e.day ? t.emission : null, secondsLeft: t.day === e.day ? Number(t.secondsLeft) : null };
      await send(cfg, entryMessage(cfg, e, ctx));
      console.log(new Date().toISOString(), "posted entry", short(e.buyer), String(e.count), "day", String(e.day));
    }
    // $FUEL minted: every Transfer from the zero address on the FUEL token, one line per
    // transaction (a batch claim mints to several addresses at once), amount only.
    if (cfg.fuelMints) {
      const mints = await withRpc(ps, p => p.getLogs({ address: cfg.fuelToken, topics: [TRANSFER_TOPIC, ZERO_TOPIC], fromBlock: from, toBlock: head }));
      const byTx = new Map();
      for (const lg of mints) byTx.set(lg.transactionHash, (byTx.get(lg.transactionHash) || 0n) + BigInt(lg.data));
      for (const [tx, amount] of byTx) {
        if (Number(ethers.formatEther(amount)) < cfg.fuelMintMin) continue;
        await send(cfg, `⛽ ${esc(fmtTok(amount))} $FUEL claimed · [tx](${cfg.explorer}/tx/${tx})`);
        console.log(new Date().toISOString(), "posted fuel claim", fmtTok(amount), tx.slice(0, 12));
      }
    }
    // $PAMP buys: one line per swap that takes $PAMP out of the pool. Sells stay quiet.
    if (cfg.pampBuys && cfg.pampPair) {
      const swaps = await withRpc(ps, p => p.getLogs({ address: cfg.pampPair, topics: [SWAP_TOPIC], fromBlock: from, toBlock: head }));
      for (const lg of swaps) {
        const sw = SWAP_IFACE.parseLog({ topics: [...lg.topics], data: lg.data });
        const pampOut = -sw.args.amount1;             // token1 is $PAMP; negative = left the pool
        if (pampOut <= 0n) continue;
        const usd = await pampUsd(cfg);
        const value = usd ? Number(ethers.formatEther(pampOut)) * usd : null;
        if (value !== null && value < cfg.pampBuyMinUsd) continue;
        await send(cfg, `🟢 *${esc(fmtTok(pampOut))} $PAMP* bought${value !== null ? ` ≈ ${esc(fmtUsd(value))}` : ""} · [chart](${cfg.dexscreener}) · [tx](${cfg.explorer}/tx/${lg.transactionHash})`);
        console.log(new Date().toISOString(), "posted pamp buy", fmtTok(pampOut), value !== null ? fmtUsd(value) : "", lg.transactionHash.slice(0, 12));
      }
    }
    state.lastBlock = head;
  }
  // rollover: the contract's day moved on since the last poll
  const a = new ethers.Contract(cfg.auction, ABI, ps[0]);
  const day = Number(await withRpc(ps, p => a.connect(p).currentDay()));
  if (state.lastDay && day > state.lastDay && day - cfg.dayOffset >= 1) {
    const closed = state.lastDay;
    const sched = new ethers.Contract(await withRpc(ps, p => a.connect(p).schedule()), SCHEDULE_ABI, ps[0]);
    const [entries, emission] = await withRpc(ps, async p => Promise.all([a.connect(p).dayEntries(closed), sched.connect(p).emissionFor(closed)]));
    await send(cfg, rolloverMessage(cfg, closed, entries, emission, day));
    console.log(new Date().toISOString(), "posted rollover", closed, "->", day);
  }
  state.lastDay = day;
  saveState(state);
}

process.on("SIGTERM", () => { console.log("stopping (SIGTERM)"); process.exit(0); });
(async () => {
  const cfg = loadConfig();
  const ps = providers(cfg);
  const state = loadState();
  if (DRY && process.argv.includes("--replay")) state.lastBlock = cfg.auctionDeployBlock - 1;  // dry-run over the whole history
  if (process.argv.includes("--test")) {
    // one sample alert through the real formatter, so the chat and the markup are proven
    const sample = { buyer: "0xB4b28BF331b721a6B99D3DbD58DF5A9907d4DCAa", day: 2n, count: 35n, ethPaid: 21n * 10n ** 14n, fuelBurned: 561870n * 10n ** 18n, moreBurned: 53201n * 10n ** 18n, tx: "0x5b7f31bdfafe17ae60c7370d89ef78913e6bfe008a728f908862d22ad71dc496" };
    await send(cfg, "🧪 *Test alert* — this is what an entry looks like:\n\n" + entryMessage(cfg, sample, { dayEntries: 42n, emission: 255739n * 10n ** 18n, secondsLeft: 79620 }));
    console.log("test alert sent"); return;
  }
  console.log(`PAMP entry alerts ${DRY ? "(dry run) " : ""}watching ${cfg.auction} every ${cfg.pollSeconds}s`);
  for (;;) {
    try { await poll(cfg, ps, state); }
    catch (e) { console.error(new Date().toISOString(), "poll failed:", e.message || e); }
    if (ONCE || (DRY && process.argv.includes("--replay"))) break;
    await new Promise(r => setTimeout(r, cfg.pollSeconds * 1000));
  }
})();
