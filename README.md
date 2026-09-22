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

On this machine it is already set up: a Task Scheduler job called **"PAMP entry alerts"**
starts the bot hidden at logon and restarts it if it ever stops. Output goes to `alerts.log`
in this folder.

- Check it: open Task Scheduler and look for "PAMP entry alerts", or run
  `schtasks /query /tn "PAMP entry alerts"`.
- Stop it: double-click `stop-alerts.bat`. Start it again: `schtasks /run /tn "PAMP entry alerts"`.
- It only runs while this computer is on and you are logged in. For alerts that survive the
  machine being off, run the same folder on any always-on box with
  `npx pm2 start entry-alerts.js --name pamp-alerts && npx pm2 save`, or a cron entry that runs
  `node entry-alerts.js --once` every minute. Only run one copy at a time, or entries post twice.

## Options (config.json)

| Key | Default | Meaning |
|---|---|---|
| `pollSeconds` | 15 | how often to look for new entries |
| `minEntries` | 1 | ignore transactions with fewer entries than this |
| `fuelMints` | true | also post a one-line "💧 12,345 $FUEL minted" for every transaction that mints $FUEL |
| `fuelMintMin` | 0 | only announce $FUEL mints of at least this many tokens |
| `dayOffset` | 1 | the dashboard shows the contract's day 2 as day 1; the bot says the same |
| `rpc` | official + dRPC | endpoints, tried in order |
| `auction` | v2 auction | the contract to watch |

Never commit `config.json`: it holds the bot token. `state.json` is harmless.
