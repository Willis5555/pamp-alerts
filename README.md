# PAMP entry alerts — Telegram bot

Posts a message to a Telegram group or channel every time someone enters the auction, and a
short note when a day closes. One file, plain Node, no server needed: it runs on any machine
that stays on, including the one the dashboard is built on.

Every message carries the wallet (linked to the explorer), how many entries, the ETH and
$FUEL paid, the day's running total, that wallet's share of it, its projected $PAMP if the
day closed now, the time left in the day, and a link to the transaction.

## Setup (about five minutes)

1. **Create the bot.** In Telegram, message [@BotFather](https://t.me/BotFather), send
   `/newbot`, pick a name and a username. It replies with a token like
   `123456789:AAH…`. That is `telegramBotToken`.
2. **Add the bot to the chat.** For a group: add it as a member (as admin if the group
   restricts posting). For a channel: add it as an administrator with "post messages".
3. **Find the chat id.** Post any message in the group/channel, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and read `"chat":{"id":…}`.
   Groups and channels have negative ids, often starting `-100`. That is `telegramChatId`.
   (For a public channel, `"@channelname"` works too.)
4. **Configure.** Copy `config.example.json` to `config.json` and fill in the two values.
   Everything else has sensible defaults.
5. **Install and run.**
   ```sh
   cd bot
   npm install
   node entry-alerts.js --dry-run      # prints what it would post; no token needed
   node entry-alerts.js                # live
   ```

The first live run starts from the current block, so it will not replay old entries into the
chat. It remembers the last block it handled in `state.json`; a restart carries on from there.

## Keeping it running

It runs from GitHub: the repo https://github.com/Willis5555/pamp-alerts has a workflow
(`.github/workflows/pamp-alerts.yml`) that polls every 5 minutes with `--once`, using the
`TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` repository secrets. Nothing local needs to be on.
Edit the bot there (or copy changes from this folder and push) and the next run uses them.

A Task Scheduler job called **"PAMP entry alerts"** also exists on this machine but is
**disabled**, so the two never post twice. Enable it only if GitHub is turned off.

- Check it: open Task Scheduler and look for "PAMP entry alerts", or run
  `schtasks /query /tn "PAMP entry alerts"`.
- Stop it: double-click `stop-alerts.bat`. Start it again: `schtasks /run /tn "PAMP entry alerts"`.
- It only runs while this computer is on and you are logged in. For alerts that survive the
  machine being off, run the same folder on any always-on box with
  `npx pm2 start entry-alerts.js --name pamp-alerts && npx pm2 save`, or a cron entry that runs
  `node entry-alerts.js --once` every minute. Only run one copy at a time, or entries post twice.

## Chat commands

- `/burn` — replies with the $FUEL and $MORE burned by the $PAMP protocol so far, with dollar
  values. Works in the group and in a direct message to the bot. To see the wording without
  waiting for someone to ask: `node entry-alerts.js --burn-test` posts the answer to the group.

- `/website` — replies with the links to the $PAMP, $FUEL and $MORE dashboards. Any message
  that contains the word "website" gets the same reply, at most once a minute per chat.
  `node entry-alerts.js --website-test` posts the answer to the group.

- `/contract` — replies with the $PAMP token address as a tap-to-copy code span plus explorer,
  chart and dashboard links. Any message that contains the word "contract" gets the same reply,
  at most once a minute per chat. `node entry-alerts.js --contract-test` posts the answer.

## Options (config.json)

| Key | Default | Meaning |
|---|---|---|
| `pollSeconds` | 15 | how often to look for new entries |
| `minEntries` | 1 | ignore transactions with fewer entries than this |
| `fuelMints` | false | set true to also post a one-line "⛽ 12,345 $FUEL claimed" for every transaction that mints $FUEL |
| `fuelMintMin` | 5,000,000 | only announce $FUEL claims of at least this many tokens |
| `pampBuys` | true | also post a one-line "🟢 12,345 $PAMP bought ≈ $12.34 · chart · tx" for every buy on the PAMP/WETH pool (sells are not posted) |
| `pampBuyMinUsd` | 4 | only announce $PAMP buys worth at least this many dollars |
| `fuelBuys` | true | also post "⛽ 1,234,567 $FUEL bought ≈ $6.10 · chart · tx" for every buy on the FUEL/WETH pool |
| `fuelBuyMinUsd` | 25 | only announce $FUEL buys worth at least this many dollars |
| `stakeAlerts` | true | also post "🔒 12,345 $PAMP staked ≈ $9 · 90 days · unlocks Dec 22, 2026 · wallet · tx" for every stake opened |
| `stakeMinUsd` | 0 | only announce stakes worth at least this many dollars |
| `pampPair` | PAMP/WETH V3 pool | the pool watched for buys; `dexscreener` is the chart link in the message |
| `dayOffset` | 1 | the dashboard shows the contract's day 2 as day 1; the bot says the same |
| `rpc` | official + dRPC | endpoints, tried in order |
| `auction` | v2 auction | the contract to watch |

Never commit `config.json`: it holds the bot token. `state.json` is harmless.
