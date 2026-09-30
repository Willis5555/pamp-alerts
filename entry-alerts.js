#!/usr/bin/env node
"use strict";
/* PAMP entry alerts for Telegram.
   Watches the DailyAuctionV2 contract on Robinhood Chain and posts one message per entry
   transaction, plus a note when a day closes. It watches the PulseChain auction the same way
   (`pulse*` settings; `"pulse": false` turns that off). Plain Node: no framework, no database. State
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
  fuelMints: false,       // set true to also post a one-liner whenever $FUEL is claimed
  fuelMintMin: 5000000,   // ...but only when a transaction claims at least this many $FUEL
  // $PAMP buys: every swap on the PAMP/WETH Uniswap V3 pool where $PAMP leaves the pool.
  pampPair: "0xC774A953079B7411F313A2d23ECAcAFb19682b6E",
  pampBuys: true,
  pampBuyMinUsd: 4,       // only announce buys worth at least this many dollars (0 = all)
  dexscreener: "https://dexscreener.com/robinhood/0xc774a953079b7411f313a2d23ecacafb19682b6e",
  // $FUEL buys: every swap on the FUEL/WETH Uniswap V3 pool where $FUEL leaves the pool.
  fuelPair: "0xFF40c99525ffA6b6cf79ecbE370eF7C887D68F69",
  fuelBuys: true,
  fuelBuyMinUsd: 25,
  fuelDexscreener: "https://dexscreener.com/robinhood/0xff40c99525ffa6b6cf79ecbe370ef7c887d68f69",
  // $PAMP stakes: every Staked event on the staking contract.
  staking: "0x6ebf3eAfc1fD08a1E51Ec3a7f7D254BAE1a9370E",
  stakeAlerts: true,
  stakeMinUsd: 0,         // only announce stakes worth at least this many dollars (0 = all)
  // $PAMP claims: every Claimed event on the auction (a wallet collecting a closed day).
  claimAlerts: true,
  claimMinUsd: 0,         // only announce claims worth at least this many dollars (0 = all)
  // ---- PulseChain PAMP (chain 369): entries and day closes, posted to the same chat
  pulse: true,
  pulseRpc: ["https://rpc.pulsechain.com", "https://pulsechain-rpc.publicnode.com"],
  pulseAuction: "0x0cb79f2123DA9fba7Ee8Fcad12206c959525Eb72",
  pulseAuctionDeployBlock: 27670648,
  pulseToken: "0xd5E952eA1B17034Ad3368805ed9CFB08009deA79",
  pulseFuel: "0x6633aeDbB64115391238D7ce56D2DFAa2e0c7b45",
  pulseExplorer: "https://scan.pulsechain.com",
  pulseDashboard: "https://pulsepamp.github.io/369/",
  pulseLookbackBlocks: 2000,   // with no saved state, scan this far back (~5.5 h at ~10 s blocks)
  pulseMinEntries: 1,
  // $PAMP buys on PulseChain: any PAMP/WPLS pair on the PulseX factories below, found as soon as it exists
  pulsePampBuys: true,
  pulsePampBuyMinUsd: 10,     // only announce buys worth at least this many dollars (0 = all)
  pulseWpls: "0xA1077a294dDE1B09bB078844df40758a5D0f9a27",
  pulseFactories: ["0x29eA7545DEf87022BAdc76323F373EA1e707C523", "0x1715a3E4A142d8b698131108995174F37aEBA10D"],   // PulseX V2, V1
  // PulseChain claims (PAMP won in the auction, with its PLS yield) and stakes (opened, and PLS yield claimed from one)
  pulseStaking: "0x008d3398E3b477d5D026B9013D0aC419b14176d3",
  pulseClaimAlerts: true,
  pulseClaimMinUsd: 0,
  pulseStakeAlerts: true,
  pulseStakeMinUsd: 0,
  telegramBotToken: "",
  telegramChatId: ""
};

const ABI = [
  "event Entered(address indexed buyer, uint256 indexed day, uint256 count, uint256 ethPaid, uint256 fuelBurned)",
  "function currentDay() view returns (uint256)",
  "function totalFuelBurned() view returns (uint256)",
  "function totalEntries() view returns (uint256)",
  "function totalEthToMore() view returns (uint256)",
  "function dayEntries(uint256) view returns (uint256)",
  "function userEntries(uint256,address) view returns (uint256)",
  "function today() view returns (uint256 day, uint256 emission, uint256 entries, uint256 secondsLeft)",
  "function schedule() view returns (address)"
];
const SCHEDULE_ABI = ["function emissionFor(uint256) view returns (uint256)"];
const BURNER_ABI = ["event LegBurned(uint256 indexed leg, uint256 ethIn, uint256 moreBurned)"];
const MORE_TOKEN = "0xc0F1A40512114b25cc1F30b5DF0bb48691405555";
const PAMP_TOKEN = "0x64D1472d061a6B4a0ebE4B31Ad30f3774df219a6";
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
const ZERO_TOPIC = ethers.zeroPadValue("0x00", 32);
const SWAP_IFACE = new ethers.Interface(["event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"]);
const SWAP_TOPIC = SWAP_IFACE.getEvent("Swap").topicHash;
const STAKE_IFACE = new ethers.Interface(["event Staked(uint256 indexed stakeId, address indexed staker, uint256 amount, uint256 duration)"]);
const STAKE_TOPIC = STAKE_IFACE.getEvent("Staked").topicHash;
const CLAIM_IFACE = new ethers.Interface(["event Claimed(address indexed claimer, uint256 indexed day, uint256 entries, uint256 amount)"]);
const CLAIM_TOPIC = CLAIM_IFACE.getEvent("Claimed").topicHash;

/* One transaction can claim several days at once (claimMany): the lines are folded into
   one message with the total, and the days listed. */
function claimMessage(cfg, c, usd) {
  const value = usd ? Number(ethers.formatEther(c.amount)) * usd : null;
  const shown = c.days.map(d => Number(d) - cfg.dayOffset).filter(d => d >= 1);
  const dayText = shown.length === 0 ? "the pre\\-launch day"
    : shown.length === 1 ? `day ${shown[0]}`
    : `${shown.length} days \\(${shown.slice(0, 6).join(", ")}${shown.length > 6 ? "…" : ""}\\)`;
  return `🎁 *${esc(fmtTok(c.amount))} $PAMP* claimed${value !== null ? ` ≈ ${esc(fmtUsd(value))}` : ""} · ${esc(nf(c.entries))} ${c.entries === 1n ? "entry" : "entries"} on ${dayText} · [wallet](${cfg.explorer}/address/${c.claimer}) · [tx](${cfg.explorer}/tx/${c.tx})`;
}
function foldClaims(logs) {
  const byTx = new Map();
  for (const lg of logs) {
    const a = CLAIM_IFACE.parseLog({ topics: [...lg.topics], data: lg.data }).args;
    const c = byTx.get(lg.transactionHash) || { claimer: a.claimer, days: [], entries: 0n, amount: 0n, tx: lg.transactionHash, block: lg.blockNumber };
    c.days.push(a.day); c.entries += a.getValue("entries"); c.amount += a.amount;   // getValue: a Result has its own .entries() method
    byTx.set(lg.transactionHash, c);
  }
  return [...byTx.values()];
}
const fmtDate = ts => new Date(ts * 1000).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });

// ---------------------------------------------------------------- PulseChain
/* The PulseChain auction (DailyAuctionPulse): each entry is worth 25,000 PLS, paid as PLS
   plus $FUEL burned by value. The PLS goes to the PAMP buy and burn and the PLS yield (the
   PlsSplit event in the same transaction). Its days need no offset: day 1 is the first day. */
const PULSE_ABI = [
  "event Entered(address indexed buyer, uint256 indexed day, uint256 count, uint256 plsPaid, uint256 fuelBurned)",
  "event PlsSplit(uint256 indexed day, uint256 toYield, uint256 toBurn, uint256 toDev)",
  "function currentDay() view returns (uint256)",
  "function dayEntries(uint256) view returns (uint256)",
  "function userEntries(uint256,address) view returns (uint256)",
  "function totalEntries() view returns (uint256)",
  "function today() view returns (uint256 day, uint256 emission, uint256 entries, uint256 secondsLeft)",
  "function schedule() view returns (address)"
];
const PULSE_IFACE = new ethers.Interface(PULSE_ABI);
const PULSE_ENTERED = PULSE_IFACE.getEvent("Entered").topicHash;
const PULSE_SPLIT = PULSE_IFACE.getEvent("PlsSplit").topicHash;
const PULSE_ENTRY_PLS = 25000n * 10n ** 18n;
const fmtPls = wei => nf(Number(ethers.formatEther(wei)), 0) + " PLS";

function pulseProviders(cfg) {
  return cfg.pulseRpc.map(url => {
    const req = new ethers.FetchRequest(url); req.timeout = 15000;
    return new ethers.JsonRpcProvider(req, { chainId: 369, name: "pulsechain" }, { staticNetwork: true, batchMaxCount: 1 });
  });
}
// PLS, $FUEL and $PAMP in dollars from DexScreener's PulseChain pairs, cached a minute.
let pulsePriceCache = { at: 0, usd: {} };
async function pulseUsd(cfg) {
  if (Date.now() - pulsePriceCache.at < 60000) return pulsePriceCache.usd;
  const usd = {};
  try {
    const j = await (await fetch(`https://api.dexscreener.com/tokens/v1/pulsechain/${cfg.pulseFuel},${cfg.pulseToken}`)).json();
    const best = {};
    for (const pr of Array.isArray(j) ? j : []) {
      const k = pr.baseToken.address.toLowerCase(), liq = pr.liquidity && pr.liquidity.usd || 0;
      if (!best[k] || liq > best[k].liq) best[k] = { liq, usd: Number(pr.priceUsd), native: Number(pr.priceNative), quote: pr.quoteToken && pr.quoteToken.symbol };
    }
    usd.fuel = best[cfg.pulseFuel.toLowerCase()]?.usd;
    usd.pamp = best[cfg.pulseToken.toLowerCase()]?.usd;
    // PLS itself: a pair quoted in WPLS gives it as priceUsd / priceNative
    const q = Object.values(best).find(b => b.native > 0 && /PLS/i.test(b.quote || ""));
    if (q) usd.pls = q.usd / q.native;
  } catch {}
  pulsePriceCache = { at: Date.now(), usd };
  return usd;
}

async function describePulseEntry(cfg, ps, lg) {
  const a = PULSE_IFACE.parseLog({ topics: [...lg.topics], data: lg.data }).args;
  const e = { buyer: a.buyer, day: a.day, count: a.count, plsPaid: a.plsPaid, fuelBurned: a.fuelBurned, tx: lg.transactionHash };
  if (e.count < BigInt(cfg.pulseMinEntries)) return null;
  // where the PLS went: the PlsSplit event in the same transaction
  try {
    const rc = await withRpc(ps, p => p.getTransactionReceipt(lg.transactionHash));
    const s = rc.logs.find(x => x.address.toLowerCase() === cfg.pulseAuction.toLowerCase() && x.topics[0] === PULSE_SPLIT);
    if (s) { const sa = PULSE_IFACE.parseLog({ topics: [...s.topics], data: s.data }).args; e.toYield = sa.toYield; e.toBurn = sa.toBurn; }
  } catch {}
  const c = new ethers.Contract(cfg.pulseAuction, PULSE_ABI, ps[0]);
  // only the countdown is shown now; the wallet's share, the day's count and the estimate were dropped
  const t = await withRpc(ps, p => c.connect(p).today());
  const ctx = { secondsLeft: t.day === e.day ? Number(t.secondsLeft) : null };
  ctx.usd = await pulseUsd(cfg).catch(() => ({}));
  return { e, ctx };
}
function pulseEntryMessage(cfg, ev, ctx) {
  const usd = ctx.usd || {};
  const val = (wei, px) => px ? ` ≈ ${esc(fmtUsd(Number(ethers.formatEther(wei)) * px))}` : "";
  const lines = [
    `🟣⛽ *${esc(nf(ev.count))} ${ev.count === 1n ? "entry" : "entries"} on PulseChain* · ${esc(`Day ${ev.day}`)}⛽🟣`,
    `⛽ *${esc(fmtTok(ev.fuelBurned))} $FUEL* burned${val(ev.fuelBurned, usd.fuel)}`
  ];
  // compact: the two PLS legs share a line, the countdown and the link share the last
  const pls = [ev.toBurn && `🔥 *${esc(fmtPls(ev.toBurn))}* to buy & burn`, ev.toYield && `💰 *${esc(fmtPls(ev.toYield))}* to yield`].filter(Boolean);
  if (pls.length) lines.push(pls.join(" · "));
  lines.push((ctx.secondsLeft != null ? `⏳ Day closes in *${esc(hms(ctx.secondsLeft))}* · ` : "") + `[dashboard](${cfg.pulseDashboard})`);
  return lines.join("\n");
}
function pulseRolloverMessage(cfg, closedDay, closedEntries, emission, newDay) {
  const per = closedEntries > 0n ? emission / closedEntries : 0n;
  return [
    `🔔 *PulseChain day ${esc(closedDay)} has closed*`,
    `${esc(nf(closedEntries))} entries · ${esc(fmtTok(emission))} $PAMP to claim · ${closedEntries > 0n ? esc(fmtTok(per, 2)) + " $PAMP per entry" : "nobody entered, nothing minted"}`,
    `*Day ${esc(newDay)} is open\\.* [Enter](${cfg.pulseDashboard})`
  ].join("\n");
}
/* $PAMP buys on PulseChain. There is no PAMP/WPLS pool yet, so every poll asks the PulseX
   factories whether one exists (after reading the head, so a pool that appears is scanned from the
   poll's first block and no buy in it is missed); once found it is remembered. A buy is a swap that
   takes PAMP out of the pool, valued at the PLS paid in times the PLS price. */
const PAIR_SWAP = new ethers.Interface(["event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)"]);
const PAIR_SWAP_TOPIC = PAIR_SWAP.getEvent("Swap").topicHash;
const pulsePampPairs = new Map();   // pair address -> { pampIs0 }
async function findPulsePampPairs(cfg, ps) {
  for (const f of cfg.pulseFactories) {
    const fc = new ethers.Contract(f, ["function getPair(address, address) view returns (address)"], ps[0]);
    const pair = await withRpc(ps, p => fc.connect(p).getPair(cfg.pulseToken, cfg.pulseWpls));
    if (!pair || pair === ethers.ZeroAddress || pulsePampPairs.has(pair.toLowerCase())) continue;
    const pc = new ethers.Contract(pair, ["function token0() view returns (address)"], ps[0]);
    const t0 = await withRpc(ps, p => pc.connect(p).token0());
    pulsePampPairs.set(pair.toLowerCase(), { pair, pampIs0: t0.toLowerCase() === cfg.pulseToken.toLowerCase() });
    console.log(new Date().toISOString(), "pulse: watching PAMP/WPLS pair", pair);
  }
}
function pulseBuyMessage(cfg, amount, usdValue, pair, tx) {
  return `🟣 *${esc(fmtTok(amount))} $PAMP* bought on PulseChain${usdValue !== null ? ` ≈ ${esc(fmtUsd(usdValue))}` : ""} · [chart](https://dexscreener.com/pulsechain/${pair.toLowerCase()}) · [tx](${cfg.pulseExplorer}/tx/${tx})`;
}
async function pollPulseBuys(cfg, ps, from, head) {
  await findPulsePampPairs(cfg, ps);
  if (!pulsePampPairs.size) return;
  const logs = await withRpc(ps, p => p.getLogs({ address: [...pulsePampPairs.values()].map(x => x.pair), topics: [PAIR_SWAP_TOPIC], fromBlock: from, toBlock: head }));
  for (const lg of logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index)) {
    const info = pulsePampPairs.get(lg.address.toLowerCase()); if (!info) continue;
    const a = PAIR_SWAP.parseLog({ topics: [...lg.topics], data: lg.data }).args;
    const pampOut = info.pampIs0 ? a.amount0Out : a.amount1Out, plsIn = info.pampIs0 ? a.amount1In : a.amount0In;
    if (pampOut <= 0n) continue;   // a sell or an add: only buys are announced
    const px = (await pulseUsd(cfg).catch(() => ({}))).pls;
    const value = px ? Number(ethers.formatEther(plsIn)) * px : null;
    // with a minimum set, a buy that cannot be priced is not announced
    if (cfg.pulsePampBuyMinUsd > 0 && (value === null || value < cfg.pulsePampBuyMinUsd)) continue;
    await send(cfg, pulseBuyMessage(cfg, pampOut, value, info.pair, lg.transactionHash));
    console.log(new Date().toISOString(), "posted pulse PAMP buy", fmtTok(pampOut), value !== null ? fmtUsd(value) : "", lg.transactionHash.slice(0, 12));
  }
}

/* PulseChain claims and stakes. The auction's Claimed also carries the PLS yield paid with the PAMP;
   a claimMany is one message. Stakes opened come from the staking contract's Staked. (PLS yield
   claimed from a stake is left out on purpose.) */
const PULSE_CLAIM = new ethers.Interface(["event Claimed(address indexed claimer, uint256 indexed day, uint256 entries, uint256 amount, uint256 plsYield)"]);
const PULSE_CLAIM_TOPIC = PULSE_CLAIM.getEvent("Claimed").topicHash;
const PULSE_STAKING = new ethers.Interface(["event Staked(uint256 indexed stakeId, address indexed staker, uint256 amount, uint256 duration)"]);
const PULSE_STAKED_TOPIC = PULSE_STAKING.getEvent("Staked").topicHash;
/* $PAMP in dollars: DexScreener's price once it lists the pool, otherwise the pool's own reserves × the PLS price */
async function pulsePampUsd(cfg, ps) {
  const u = await pulseUsd(cfg).catch(() => ({}));
  if (u.pamp) return { pamp: u.pamp, pls: u.pls };
  await findPulsePampPairs(cfg, ps).catch(() => {});
  const first = [...pulsePampPairs.values()][0];
  if (!first || !u.pls) return { pamp: null, pls: u.pls ?? null };
  try {
    const pc = new ethers.Contract(first.pair, ["function getReserves() view returns (uint112, uint112, uint32)"], ps[0]);
    const r = await withRpc(ps, p => pc.connect(p).getReserves());
    const pamp = first.pampIs0 ? r[0] : r[1], pls = first.pampIs0 ? r[1] : r[0];
    return { pamp: pamp > 0n ? (Number(ethers.formatEther(pls)) / Number(ethers.formatEther(pamp))) * u.pls : null, pls: u.pls };
  } catch { return { pamp: null, pls: u.pls }; }
}
const usdText = v => v !== null && isFinite(v) ? ` ≈ ${esc(fmtUsd(v))}` : "";
function pulseClaimMessage(cfg, c, px) {
  // the PAMP claimed, valued on its own (the PLS yield paid with it is not shown)
  const value = px.pamp ? Number(ethers.formatEther(c.amount)) * px.pamp : null;
  const days = c.days.map(Number);
  const dayText = days.length === 1 ? `day ${days[0]}` : `${days.length} days \\(${days.slice(0, 6).join(", ")}${days.length > 6 ? "…" : ""}\\)`;
  return `🎁 *${esc(fmtTok(c.amount))} $PAMP* claimed on PulseChain${usdText(value)} · ${esc(nf(c.entries))} ${c.entries === 1n ? "entry" : "entries"} on ${dayText} · [wallet](${cfg.pulseExplorer}/address/${c.claimer}) · [tx](${cfg.pulseExplorer}/tx/${c.tx})`;
}
function pulseStakeMessage(cfg, st, px) {
  const days = Math.round(st.duration / 86400);
  return `🔒 *${esc(fmtTok(st.amount))} $PAMP* staked on PulseChain${usdText(px.pamp ? Number(ethers.formatEther(st.amount)) * px.pamp : null)} · *${esc(nf(days))} days* · unlocks ${esc(fmtDate(st.unlockAt))} · [wallet](${cfg.pulseExplorer}/address/${st.staker}) · [tx](${cfg.pulseExplorer}/tx/${st.tx})`;
}
async function pollPulseClaimsAndStakes(cfg, ps, from, head) {
  const [claims, staking] = await Promise.all([
    cfg.pulseClaimAlerts ? withRpc(ps, p => p.getLogs({ address: cfg.pulseAuction, topics: [PULSE_CLAIM_TOPIC], fromBlock: from, toBlock: head })) : [],
    cfg.pulseStakeAlerts ? withRpc(ps, p => p.getLogs({ address: cfg.pulseStaking, topics: [PULSE_STAKED_TOPIC], fromBlock: from, toBlock: head })) : []
  ]);
  if (!claims.length && !staking.length) return;
  const px = await pulsePampUsd(cfg, ps);
  // claims, folded per transaction (a claimMany collects several days at once)
  const byTx = new Map();
  for (const lg of claims.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index)) {
    const a = PULSE_CLAIM.parseLog({ topics: [...lg.topics], data: lg.data }).args;
    const c = byTx.get(lg.transactionHash) || { claimer: a.claimer, days: [], entries: 0n, amount: 0n, pls: 0n, tx: lg.transactionHash };
    c.days.push(a.day); c.entries += a.getValue("entries"); c.amount += a.amount; c.pls += a.plsYield;
    byTx.set(lg.transactionHash, c);
  }
  for (const c of byTx.values()) {
    const value = px.pamp ? Number(ethers.formatEther(c.amount)) * px.pamp : null;
    if (cfg.pulseClaimMinUsd > 0 && (value === null || value < cfg.pulseClaimMinUsd)) continue;
    await send(cfg, pulseClaimMessage(cfg, c, px));
    console.log(new Date().toISOString(), "posted pulse claim", fmtTok(c.amount), "PAMP +", fmtPls(c.pls), c.tx.slice(0, 12));
  }
  for (const lg of staking.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index)) {
    const ev = PULSE_STAKING.parseLog({ topics: [...lg.topics], data: lg.data });
    const blk = await withRpc(ps, p => p.getBlock(lg.blockNumber));
    const st = { staker: ev.args.staker, amount: ev.args.amount, duration: Number(ev.args.duration), unlockAt: Number(blk.timestamp) + Number(ev.args.duration), tx: lg.transactionHash };
    if (cfg.pulseStakeMinUsd > 0 && (!px.pamp || Number(ethers.formatEther(st.amount)) * px.pamp < cfg.pulseStakeMinUsd)) continue;
    await send(cfg, pulseStakeMessage(cfg, st, px));
    console.log(new Date().toISOString(), "posted pulse stake", fmtTok(st.amount), lg.transactionHash.slice(0, 12));
  }
}

async function pollPulse(cfg, ps, state) {
  const head = await withRpc(ps, p => p.getBlockNumber());
  const from = state.pulseLastBlock ? state.pulseLastBlock + 1 : Math.max(cfg.pulseAuctionDeployBlock, head - (cfg.pulseLookbackBlocks || 0));
  if (!state.pulseLastBlock) console.log("pulse: no saved state, scanning from block", from, "to", head);
  if (from <= head) {
    const logs = await withRpc(ps, p => p.getLogs({ address: cfg.pulseAuction, topics: [PULSE_ENTERED], fromBlock: from, toBlock: head }));
    for (const lg of logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index)) {
      const built = await describePulseEntry(cfg, ps, lg);
      if (!built) continue;
      await send(cfg, pulseEntryMessage(cfg, built.e, built.ctx));
      console.log(new Date().toISOString(), "posted pulse entry", short(built.e.buyer), String(built.e.count), "day", String(built.e.day));
    }
    if (cfg.pulsePampBuys) await pollPulseBuys(cfg, ps, from, head);
    if (cfg.pulseClaimAlerts || cfg.pulseStakeAlerts) await pollPulseClaimsAndStakes(cfg, ps, from, head);
    state.pulseLastBlock = head;
  }
  const c = new ethers.Contract(cfg.pulseAuction, PULSE_ABI, ps[0]);
  const day = Number(await withRpc(ps, p => c.connect(p).currentDay()));
  if (state.pulseLastDay && day > state.pulseLastDay) {
    const closed = state.pulseLastDay;
    const sched = new ethers.Contract(await withRpc(ps, p => c.connect(p).schedule()), SCHEDULE_ABI, ps[0]);
    const [entries, emission] = await withRpc(ps, async p => Promise.all([c.connect(p).dayEntries(closed), sched.connect(p).emissionFor(closed)]));
    await send(cfg, pulseRolloverMessage(cfg, closed, entries, emission, day));
    console.log(new Date().toISOString(), "posted pulse rollover", closed, "->", day);
  }
  state.pulseLastDay = day;
  saveState(state);
}

function stakeMessage(cfg, st, usd) {
  const days = Math.round(st.duration / 86400);
  const value = usd ? Number(ethers.formatEther(st.amount)) * usd : null;
  return `🔒 *${esc(fmtTok(st.amount))} $PAMP* staked${value !== null ? ` ≈ ${esc(fmtUsd(value))}` : ""} · *${esc(nf(days))} days* · unlocks ${esc(fmtDate(st.unlockAt))} · [wallet](${cfg.explorer}/address/${st.staker}) · [tx](${cfg.explorer}/tx/${st.tx})`;
}
function parseStake(lg, blockTs) {
  const a = STAKE_IFACE.parseLog({ topics: [...lg.topics], data: lg.data }).args;
  const duration = Number(a.duration);
  return { id: a.stakeId, staker: a.staker, amount: a.amount, duration, unlockAt: blockTs + duration, tx: lg.transactionHash, block: lg.blockNumber };
}


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
const fmtUsd = v => v >= 100 ? "$" + nf(v, 0) : v >= 1 ? "$" + nf(v, 2) : "$" + Number(v).toLocaleString("en-US", { maximumSignificantDigits: 3 });
const esc = s => String(s).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, m => "\\" + m); // MarkdownV2
const hms = secs => { secs = Math.max(0, secs); const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60); return `${h}h ${String(m).padStart(2, "0")}m`; };

function entryMessage(cfg, ev, ctx) {
  const shown = Number(ev.day) - cfg.dayOffset;
  const dayLabel = shown >= 1 ? `Day ${shown}` : "Pre\\-launch day";
  const usd = ctx.usd || {};
  const val = (wei, px) => px ? ` ≈ ${esc(fmtUsd(Number(ethers.formatEther(wei)) * px))}` : "";
  // compact, like the PulseChain one: the count in the title, what burned, the countdown with the links
  const lines = [
    `🟢⛽ *${esc(nf(ev.count))} ${ev.count === 1n ? "entry" : "entries"} on Robinhood* · ${esc(dayLabel)}⛽🟢`,
    `⛽ *${esc(fmtTok(ev.fuelBurned))} $FUEL* burned${val(ev.fuelBurned, usd.fuel)}`,
    `🟢 *${esc(fmtTok(ev.moreBurned ?? 0n))} $MORE* burned${val(ev.moreBurned ?? 0n, usd.more)}`,
    (ctx.secondsLeft != null ? `⏳ Day closes in *${esc(hms(ctx.secondsLeft))}* · ` : "") + `[dashboard](${cfg.dashboard}) · [chart](${cfg.dexscreener})`
  ];
  return lines.join("\n");
}
async function entryPrices(cfg) {
  const u = await tokenUsd(cfg);
  return { eth: u.eth, fuel: u[cfg.fuelToken.toLowerCase()], more: u[MORE_TOKEN.toLowerCase()], pamp: u[PAMP_TOKEN.toLowerCase()] };
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

// One Entered log → the entry plus everything the message needs, read from the chain.
async function describeEntry(cfg, ps, lg) {
  const iface = new ethers.Interface(ABI);
  const ev = iface.parseLog({ topics: [...lg.topics], data: lg.data });
  const e = { buyer: ev.args.buyer, day: ev.args.day, count: ev.args.count, ethPaid: ev.args.ethPaid, fuelBurned: ev.args.fuelBurned, tx: lg.transactionHash };
  if (e.count < BigInt(cfg.minEntries)) return null;
  // the $MORE burned by this same transaction: the burner's LegBurned events in its receipt
  try {
    const rc = await withRpc(ps, p => p.getTransactionReceipt(lg.transactionHash));
    const bi = new ethers.Interface(BURNER_ABI), topic = bi.getEvent("LegBurned").topicHash;
    e.moreBurned = rc.logs.filter(x => x.address.toLowerCase() === cfg.burner.toLowerCase() && x.topics[0] === topic)
      .reduce((sum, x) => sum + bi.parseLog({ topics: [...x.topics], data: x.data }).args.moreBurned, 0n);
  } catch { e.moreBurned = null; }
  const a = new ethers.Contract(cfg.auction, ABI, ps[0]);
  // The wallet's total for the day (all its transactions, this one included) is what its
  // share and its projected $PAMP are based on, not just the entries in this transaction.
  const [t, dayEntries, userEntries, totalEntries] = await withRpc(ps, async p => Promise.all([a.connect(p).today(), a.connect(p).dayEntries(e.day), a.connect(p).userEntries(e.day, e.buyer), a.connect(p).totalEntries()]));
  const ctx = { dayEntries, userEntries, totalEntries, emission: t.day === e.day ? t.emission : null, secondsLeft: t.day === e.day ? Number(t.secondsLeft) : null };
  ctx.usd = await entryPrices(cfg).catch(() => ({}));
  return { e, ctx };
}

// ---------------------------------------------------------------- /burn
// Dollar prices for $FUEL and $MORE from DexScreener (deepest pair per token), cached a minute.
let tokenPriceCache = { at: 0, usd: {} };
async function tokenUsd(cfg) {
  if (Date.now() - tokenPriceCache.at < 60000) return tokenPriceCache.usd;
  const usd = {};
  try {
    const j = await (await fetch(`https://api.dexscreener.com/tokens/v1/robinhood/${cfg.fuelToken},${MORE_TOKEN},${PAMP_TOKEN}`)).json();
    const best = {};
    for (const pr of Array.isArray(j) ? j : []) {
      const k = pr.baseToken.address.toLowerCase(), liq = pr.liquidity && pr.liquidity.usd || 0;
      if (!best[k] || liq > best[k].liq) best[k] = { liq, usd: Number(pr.priceUsd), native: Number(pr.priceNative), quote: pr.quoteToken && pr.quoteToken.symbol };
    }
    for (const k of Object.keys(best)) usd[k] = best[k].usd;
    // ETH itself: any pair quoted in WETH gives it as priceUsd / priceNative
    const q = Object.values(best).find(b => b.native > 0 && /ETH/i.test(b.quote || ""));
    if (q) usd.eth = q.usd / q.native;
  } catch {}
  tokenPriceCache = { at: Date.now(), usd };
  return usd;
}
// What the $PAMP protocol has burned: $FUEL from the auction's own counter; $MORE by summing
// the burner's LegBurned events in transactions that also carry a v2 Entered event (the burner
// is shared with v1, so its own total would overcount). Cached for five minutes.
let burnCache = { at: 0, v: null };
async function burnTotals(cfg, ps) {
  if (burnCache.v && Date.now() - burnCache.at < 300000) return burnCache.v;
  const iface = new ethers.Interface(ABI), bi = new ethers.Interface(BURNER_ABI);
  const a = new ethers.Contract(cfg.auction, ABI, ps[0]);
  const head = await withRpc(ps, p => p.getBlockNumber());
  const [fuel, ethToMore] = await withRpc(ps, async p => Promise.all([a.connect(p).totalFuelBurned(), a.connect(p).totalEthToMore()]));
  let more = null;
  try {
    const [entered, legs] = await withRpc(ps, async p => Promise.all([
      p.getLogs({ address: cfg.auction, topics: [iface.getEvent("Entered").topicHash], fromBlock: cfg.auctionDeployBlock, toBlock: head }),
      p.getLogs({ address: cfg.burner, topics: [bi.getEvent("LegBurned").topicHash], fromBlock: cfg.auctionDeployBlock, toBlock: head })
    ]));
    const txs = new Set(entered.map(l => l.transactionHash));
    more = legs.filter(l => txs.has(l.transactionHash)).reduce((sum, l) => sum + bi.parseLog({ topics: [...l.topics], data: l.data }).args.moreBurned, 0n);
  } catch (e) { console.error("burn scan failed:", e.message || e); }
  burnCache = { at: Date.now(), v: { fuel, more, ethToMore } };
  return burnCache.v;
}
async function burnMessage(cfg, ps) {
  const t = await burnTotals(cfg, ps), usd = await tokenUsd(cfg);
  const fUsd = usd[cfg.fuelToken.toLowerCase()], mUsd = usd[MORE_TOKEN.toLowerCase()];
  const val = (wei, px) => px ? ` ≈ ${esc(fmtUsd(Number(ethers.formatEther(wei)) * px))}` : "";
  return [
    `🔥 *Burned by the $PAMP protocol*`,
    `⛽ *${esc(fmtTok(t.fuel))} $FUEL*${val(t.fuel, fUsd)}`,
    t.more !== null ? `🔥 *${esc(fmtTok(t.more))} $MORE*${val(t.more, mUsd)} · bought with ${esc(fmtEth(t.ethToMore))}` : `🔥 $MORE: ${esc(fmtEth(t.ethToMore))} sent to the burner \\(count unavailable right now\\)`,
    `Every entry burns $FUEL and buys and burns $MORE\\. [Stats](${cfg.dashboard}#stats)`
  ].join("\n");
}
// Commands people type in the chat. Only /burn for now. Telegram hands us each message once
// (the offset is saved in state), so a restart never answers twice.
async function handleCommands(cfg, ps, state) {
  if (DRY || !cfg.telegramBotToken) return;
  const r = await fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/getUpdates`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ offset: state.updateOffset || 0, timeout: 0, allowed_updates: ["message"] })
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error("telegram getUpdates: " + (j.description || r.status));
  for (const u of j.result) {
    state.updateOffset = u.update_id + 1;
    const m = u.message, text = m && m.text || "";
    let cmd = (text.match(/^\/(burn|website|contract)(@\w+)?(\s|$)/i) || [])[1];
    /* A bare mention answers too, so nobody has to know the command exists. Rate
       limited per chat and per word, or a lively conversation about contracts would
       have the bot replying to every line. */
    if (!cmd) {
      for (const [word, re] of [["website", /\bwebsites?\b/i], ["contract", /\bcontracts?\b/i]]) {
        if (!re.test(text)) continue;
        const key = m.chat.id + ":" + word;
        const last = mentionReplyAt.get(key) || 0;
        if (Date.now() - last > 60000) { cmd = word; mentionReplyAt.set(key, Date.now()); }
        break;
      }
    }
    if (!cmd) continue;
    try {
      const c = cmd.toLowerCase();
      const reply = c === "burn" ? await burnMessage(cfg, ps)
        : c === "contract" ? contractMessage(cfg)
        : websiteMessage(cfg);
      await send(cfg, reply, { chatId: m.chat.id, replyTo: m.message_id });
      console.log(new Date().toISOString(), `answered /${cmd.toLowerCase()} in chat`, m.chat.id);
    } catch (e) { console.error(`answering /${cmd} failed:`, e.message || e); }
  }
  if (j.result.length) saveState(state);
}
const mentionReplyAt = new Map();   // "chatId:word" -> when a bare mention was last answered

/* The address goes out three ways on purpose: as a tap-to-copy code span, which is
   what someone pasting it into a wallet actually needs; as a link to the explorer;
   and with the chart beside it. */
function contractMessage(cfg) {
  const a = PAMP_TOKEN;
  const lines = [
    `*$PAMP TOKEN · Robinhood*`,
    "`" + a + "`",
    `[Explorer](${cfg.explorer}/address/${a}) · [Chart](${cfg.dexscreener}) · [Dashboard](${cfg.dashboard})`
  ];
  if (cfg.pulse && cfg.pulseToken) {
    const b = cfg.pulseToken;
    lines.push(
      ``,
      `*$PAMP TOKEN · PulseChain*`,
      "`" + b + "`",
      `[Explorer](${cfg.pulseExplorer}/address/${b}) · [Dashboard](${cfg.pulseDashboard})`
    );
  }
  return lines.join("\n");
}
function websiteMessage(cfg) {
  return [
    `$PAMP PROTOCOL: 🔥${esc("https://willis5555.github.io/PAMP/")}`,
    ...(cfg.pulse && cfg.pulseDashboard ? [`$PAMP PULSECHAIN: 🟣${esc(cfg.pulseDashboard)}`] : []),
    `$FUEL PROTOCOL:   ⛽️${esc("https://willis5555.github.io/FUEL/")}`,
    `$MORE STAKING:     🟢${esc("https://willis5555.github.io/MOREDASHBOARD/")}`
  ].join("\n");
}
async function registerCommands(cfg) {
  if (DRY || !cfg.telegramBotToken) return;
  await fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/setMyCommands`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ commands: [
      { command: "burn", description: "$FUEL and $MORE burned by the $PAMP protocol" },
      { command: "website", description: "links to the $PAMP (Robinhood and PulseChain), $FUEL and $MORE dashboards" },
      { command: "contract", description: "the $PAMP token addresses on Robinhood and PulseChain" }
    ] })
  }).catch(() => {});
}

// ---------------------------------------------------------------- telegram
async function send(cfg, text, { chatId, replyTo } = {}) {
  if (DRY) { console.log("\n--- would post ---\n" + text + "\n"); return; }
  const r = await fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId ?? cfg.telegramChatId, text, parse_mode: "MarkdownV2", disable_web_page_preview: true,
                           ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}) })
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
      const built = await describeEntry(cfg, ps, lg);
      if (!built) continue;
      await send(cfg, entryMessage(cfg, built.e, built.ctx));
      console.log(new Date().toISOString(), "posted entry", short(built.e.buyer), String(built.e.count), "day", String(built.e.day));
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
    // Buys: one line per swap that takes the token out of its pool. Sells stay quiet. Both
    // pools have WETH as token0 and the token as token1, so a negative amount1 is a buy.
    const pools = [
      cfg.pampBuys && cfg.pampPair && { pair: cfg.pampPair, sym: "$PAMP", token: PAMP_TOKEN, emoji: "🟢", min: cfg.pampBuyMinUsd, chart: cfg.dexscreener },
      cfg.fuelBuys && cfg.fuelPair && { pair: cfg.fuelPair, sym: "$FUEL", token: cfg.fuelToken, emoji: "⛽", min: cfg.fuelBuyMinUsd, chart: cfg.fuelDexscreener }
    ].filter(Boolean);
    for (const pool of pools) {
      const swaps = await withRpc(ps, p => p.getLogs({ address: pool.pair, topics: [SWAP_TOPIC], fromBlock: from, toBlock: head }));
      for (const lg of swaps) {
        const sw = SWAP_IFACE.parseLog({ topics: [...lg.topics], data: lg.data });
        const out = -sw.args.amount1;
        if (out <= 0n) continue;
        const usd = (await tokenUsd(cfg))[pool.token.toLowerCase()];
        const value = usd ? Number(ethers.formatEther(out)) * usd : null;
        // With a minimum set, a buy whose value cannot be priced is not announced.
        if (pool.min > 0 && (value === null || value < pool.min)) continue;
        await send(cfg, `${pool.emoji} *${esc(fmtTok(out))} ${pool.sym}* bought${value !== null ? ` ≈ ${esc(fmtUsd(value))}` : ""} · [chart](${pool.chart}) · [tx](${cfg.explorer}/tx/${lg.transactionHash})`);
        console.log(new Date().toISOString(), "posted buy", pool.sym, fmtTok(out), value !== null ? fmtUsd(value) : "", lg.transactionHash.slice(0, 12));
      }
    }
    // $PAMP claims: one line per claim transaction, however many days it collected.
    if (cfg.claimAlerts) {
      const logs = await withRpc(ps, p => p.getLogs({ address: cfg.auction, topics: [CLAIM_TOPIC], fromBlock: from, toBlock: head }));
      for (const c of foldClaims(logs)) {
        const usd = (await tokenUsd(cfg))[PAMP_TOKEN.toLowerCase()];
        const value = usd ? Number(ethers.formatEther(c.amount)) * usd : null;
        if (cfg.claimMinUsd > 0 && (value === null || value < cfg.claimMinUsd)) continue;
        await send(cfg, claimMessage(cfg, c, usd));
        console.log(new Date().toISOString(), "posted claim", fmtTok(c.amount), value !== null ? fmtUsd(value) : "", c.tx.slice(0, 12));
      }
    }
    // $PAMP stakes: one line per stake opened.
    if (cfg.stakeAlerts && cfg.staking) {
      const logs = await withRpc(ps, p => p.getLogs({ address: cfg.staking, topics: [STAKE_TOPIC], fromBlock: from, toBlock: head }));
      for (const lg of logs) {
        const blk = await withRpc(ps, p => p.getBlock(lg.blockNumber));
        const st = parseStake(lg, Number(blk.timestamp));
        const usd = (await tokenUsd(cfg))[PAMP_TOKEN.toLowerCase()];
        const value = usd ? Number(ethers.formatEther(st.amount)) * usd : null;
        if (cfg.stakeMinUsd > 0 && (value === null || value < cfg.stakeMinUsd)) continue;
        await send(cfg, stakeMessage(cfg, st, usd));
        console.log(new Date().toISOString(), "posted stake", fmtTok(st.amount), value !== null ? fmtUsd(value) : "", lg.transactionHash.slice(0, 12));
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
  const pps = cfg.pulse ? pulseProviders(cfg) : null;
  const state = loadState();
  if (DRY && process.argv.includes("--replay")) { state.lastBlock = cfg.auctionDeployBlock - 1; state.pulseLastBlock = cfg.pulseAuctionDeployBlock - 1; }  // dry-run over the whole history
  if (process.argv.includes("--test-last-pulse")) {
    // the most recent PulseChain entry, through the real formatter
    const head = await withRpc(pps, p => p.getBlockNumber());
    const logs = await withRpc(pps, p => p.getLogs({ address: cfg.pulseAuction, topics: [PULSE_ENTERED], fromBlock: cfg.pulseAuctionDeployBlock, toBlock: head }));
    if (!logs.length) { console.log("no PulseChain entry yet"); return; }
    const lg = logs[logs.length - 1];
    const built = await describePulseEntry({ ...cfg, pulseMinEntries: 0 }, pps, lg);
    const blk = await withRpc(pps, p => p.getBlock(lg.blockNumber));
    const ago = Math.round((Date.now() / 1000 - Number(blk.timestamp)) / 60);
    await send(cfg, "🧪 *Test — last PulseChain entry* " + esc(`(${ago} min ago)`) + ":\n\n" + pulseEntryMessage(cfg, built.e, built.ctx));
    if (!DRY) console.log("last pulse entry test sent:", built.e.tx);
    return;
  }
  if (process.argv.includes("--test")) {
    // one sample alert through the real formatter, so the chat and the markup are proven
    const sample = { buyer: "0xB4b28BF331b721a6B99D3DbD58DF5A9907d4DCAa", day: 2n, count: 50n, ethPaid: 30n * 10n ** 14n, fuelBurned: 561870n * 10n ** 18n, moreBurned: 53201n * 10n ** 18n, tx: "0x5b7f31bdfafe17ae60c7370d89ef78913e6bfe008a728f908862d22ad71dc496" };
    await send(cfg, "🧪 *Test alert* — this is what an entry looks like:\n\n" + entryMessage(cfg, sample, { dayEntries: 177n, userEntries: 85n, totalEntries: 1065n, emission: 255739n * 10n ** 18n, secondsLeft: 79620, usd: await entryPrices(cfg).catch(() => ({})) }));
    console.log("test alert sent"); return;
  }
  if (process.argv.includes("--test-last")) {
    // the most recent real entry, through the real formatter
    const iface = new ethers.Interface(ABI);
    const head = await withRpc(ps, p => p.getBlockNumber());
    const logs = await withRpc(ps, p => p.getLogs({ address: cfg.auction, topics: [iface.getEvent("Entered").topicHash], fromBlock: Math.max(cfg.auctionDeployBlock, head - 400000), toBlock: head }));
    if (!logs.length) { console.log("no entry found recently"); return; }
    const built = await describeEntry({ ...cfg, minEntries: 0 }, ps, logs[logs.length - 1]);
    const blk = await withRpc(ps, p => p.getBlock(logs[logs.length - 1].blockNumber));
    const ago = Math.round((Date.now() / 1000 - Number(blk.timestamp)) / 60);
    await send(cfg, "🧪 *Test — last entry* " + esc(`(${ago} min ago)`) + ":\n\n" + entryMessage(cfg, built.e, built.ctx));
    console.log("last entry test sent:", built.e.tx); return;
  }
  if (process.argv.includes("--test-last-claim")) {
    const head = await withRpc(ps, p => p.getBlockNumber());
    const logs = await withRpc(ps, p => p.getLogs({ address: cfg.auction, topics: [CLAIM_TOPIC], fromBlock: Math.max(cfg.auctionDeployBlock, head - 400000), toBlock: head }));
    if (!logs.length) { console.log("no claim found recently"); return; }
    const c = foldClaims(logs).sort((a, b) => b.block - a.block)[0];
    const blk = await withRpc(ps, p => p.getBlock(c.block));
    const ago = Math.round((Date.now() / 1000 - Number(blk.timestamp)) / 60);
    const usd = (await tokenUsd(cfg))[PAMP_TOKEN.toLowerCase()];
    await send(cfg, "🧪 *Test — last claim* " + esc(`(${ago} min ago)`) + ":\n" + claimMessage(cfg, c, usd));
    if (!DRY) console.log("last claim test sent:", c.tx);
    return;
  }
  if (process.argv.includes("--test-last-stake")) {
    const head = await withRpc(ps, p => p.getBlockNumber());
    const logs = await withRpc(ps, p => p.getLogs({ address: cfg.staking, topics: [STAKE_TOPIC], fromBlock: Math.max(cfg.auctionDeployBlock, head - 400000), toBlock: head }));
    if (!logs.length) { console.log("no stake found recently"); return; }
    const lg = logs[logs.length - 1];
    const blk = await withRpc(ps, p => p.getBlock(lg.blockNumber));
    const st = parseStake(lg, Number(blk.timestamp));
    const ago = Math.round((Date.now() / 1000 - Number(blk.timestamp)) / 60);
    const usd = (await tokenUsd(cfg))[PAMP_TOKEN.toLowerCase()];
    await send(cfg, "🧪 *Test — last stake* " + esc(`(${ago} min ago)`) + ":\n" + stakeMessage(cfg, st, usd));
    if (!DRY) console.log("last stake test sent:", st.tx);
    return;
  }
  if (process.argv.includes("--contract-test")) {
    await send(cfg, "🧪 *Test — what /contract answers:*\n\n" + contractMessage(cfg));
    if (!DRY) console.log("contract test sent");
    return;
  }
  if (process.argv.includes("--website-test")) {
    await send(cfg, "🧪 *Test — what /website answers:*\n\n" + websiteMessage(cfg));
    if (!DRY) console.log("website test sent");
    return;
  }
  if (process.argv.includes("--burn-test")) {
    const text = await burnMessage(cfg, ps);
    await send(cfg, "🧪 *Test — what /burn answers:*\n\n" + text);
    if (!DRY) console.log("burn test sent");
    return;
  }
  console.log(`PAMP entry alerts ${DRY ? "(dry run) " : ""}watching ${cfg.auction}${cfg.pulse ? ` and PulseChain ${cfg.pulseAuction}` : ""} every ${cfg.pollSeconds}s`);
  await registerCommands(cfg);
  for (;;) {
    try { await poll(cfg, ps, state); }
    catch (e) { console.error(new Date().toISOString(), "poll failed:", e.message || e); }
    // PulseChain has its own try: a slow or failing PulseChain RPC never holds up Robinhood
    if (pps) {
      try { await pollPulse(cfg, pps, state); }
      catch (e) { console.error(new Date().toISOString(), "pulse poll failed:", e.message || e); }
    }
    try { await handleCommands(cfg, ps, state); }
    catch (e) { console.error(new Date().toISOString(), "commands failed:", e.message || e); }
    if (ONCE || (DRY && process.argv.includes("--replay"))) break;
    await new Promise(r => setTimeout(r, cfg.pollSeconds * 1000));
  }
})();
