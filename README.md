# vc-bot

Discord bot that sits in a voice channel and rotates VC status + bot presence based on JSON rule files.

## Requirements

- Node.js `>= 22.12.0`
- A Discord bot token with the `Guilds` + `GuildVoiceStates` intents
- **A voice encryption library** — see the install steps below. This is the #1 thing that breaks fresh installs.

## Install

```bash
git clone <repo-url> vc-bot
cd vc-bot
npm install
```

### Install the voice encryption library (REQUIRED)

`@discordjs/voice` needs a crypto backend to encrypt the UDP voice stream. Without one, the bot will connect to the voice gateway but **never reach the `Ready` state** — it'll silently sit in `Signalling` / `Connecting` forever and never actually join voice.

`package.json` lists `libsodium-wrappers` under `optionalDependencies`, which means npm will skip it without erroring if anything goes wrong during install. On a lot of VPS environments it silently doesn't land. Install it explicitly:

```bash
npm install libsodium-wrappers --save
```

Verify it's actually there:

```bash
ls node_modules | grep -iE "sodium|tweetnacl"
# should print: libsodium-wrappers
```

If you want slightly better performance and have build tools available (`python3`, `make`, `g++`), you can use the native version instead:

```bash
npm install sodium-native --save
```

### Configure

Copy the example files into place — the real ones are gitignored so your customizations never get overwritten by `git pull`:

```bash
cp .env.example .env
cp vc_statuses.example.json vc_statuses.json
cp bot_statuses.example.json bot_statuses.json
cp runtime_config.example.json runtime_config.json
```

Then edit `.env`:

| var | required | what |
| --- | --- | --- |
| `DISCORD_TOKEN` | yes | Bot token from the Discord developer portal |
| `CLIENT_ID` | yes | Bot application ID |
| `GUILD_ID` | yes | Server the bot operates in |
| `VOICE_CHANNEL_ID` | yes | The VC the bot joins / sets status on |
| `CDN_API_URL` / `CDN_API_KEY` | only for `/gif` commands | Points at the companion CDN service |
| `DEBUG_STATUS=1` | optional | Enables the per-minute `👥 humans=...` diagnostic line |
| others | optional | See `.env.example` — they all have defaults |

### Register slash commands (one-time, and after any command changes)

```bash
node deploy-commands.js
```

## Run

### Development

```bash
npm run dev   # node --watch index.js
```

### Production (PM2 on a VPS)

```bash
pm2 start index.js --name vc-bot
pm2 save
pm2 startup   # follow the printed command so it survives reboots
```

Useful:

```bash
pm2 logs vc-bot              # tail
pm2 logs vc-bot --lines 500  # recent
pm2 restart vc-bot
pm2 describe vc-bot          # uptime, restart count
```

## Status rule files

Three runtime files drive what the bot says. All three are **gitignored** — the repo only ships `.example.json` templates. Copy them on first setup (see [Configure](#configure)) and edit the live copies freely without worrying about merge conflicts.

| file | purpose |
| --- | --- |
| `vc_statuses.json` | Rules that pick the voice channel status text |
| `bot_statuses.json` | Rules that pick the bot's presence text |
| `runtime_config.json` | `{ "autoStatusEnabled": true, "manualStatus": null }` — toggled at runtime by slash commands |

### Rule format

Each rule in the `rules` array has a `cond` string (space-separated key=value predicates) and a `text` string (the status). The bot evaluates rules every tick, filters by the active condition, and picks one.

Supported `cond` keys:

| key | examples | meaning |
| --- | --- | --- |
| `time` | `time=midnight`, `time=dawn`, `time=morning`, `time=midday`, `time=dusk`, `time=night` | Time-of-day bucket (4-hour windows, server local time) |
| `humans` | `humans=0`, `humans=1`, `humans>=2`, `humans<=3` | Number of non-bot users in the VC |
| `connected` | `connected=true` / `false` | Whether the bot itself is in the VC |
| `vcauto` | `vcauto=true` / `false` | Whether auto-status mode is on |

Supported `text` placeholders:

| placeholder | becomes |
| --- | --- |
| `{humans}` | Number of humans in the VC |
| `{soloUserName}` | Display name when exactly 1 human is present |
| `{watch}` / `{watchers}` | Names of users listed in `VC_WATCH_USER_IDS` currently in the VC |
| `{watchcount}` | Count of the above |
| `{vcauto}` | `ON` or `OFF` |

Look at `vc_statuses.example.json` and `bot_statuses.example.json` for a minimal working set covering all six time buckets.

## Diagnostics — what healthy logs look like

After restart with `DEBUG_STATUS=1` you should see:

```
✅ Logged in as <bot>#0000
✅ Loaded runtime_config.json: auto=true, manual=none
✅ Loaded vc_statuses.json: rules=... pools.any=0 (json)
✅ Loaded bot_statuses.json: rules=... pools.any=0 (json)
🔊 voice state signalling -> connecting
🔊 voice state connecting -> ready
👥 humans=1 connected=true watch=0 membersInChannel=2
```

The key line is `connected=true`. If you see `connected=false` persisting for more than ~30s, something is wrong — jump to Troubleshooting.

## Troubleshooting

### Bot joins the VC (appears in the member list) but `connected=false` forever

Voice encryption library is missing or the voice UDP path is broken.

1. Confirm the crypto lib:
   ```bash
   ls node_modules | grep -iE "sodium|tweetnacl"
   ```
   If empty: `npm install libsodium-wrappers --save`, then `pm2 restart vc-bot`.

2. Check outbound UDP to Discord voice:
   ```bash
   nc -u -v -z -w3 66.22.196.0 50000
   ```
   If this refuses/hangs, the VPS firewall is blocking outbound UDP — open a ticket with the host or add a UFW/iptables rule allowing outbound UDP on ephemeral high ports.

3. Look for `[DAVE]` log lines. If the guild requires Discord's DAVE E2EE protocol, you also need:
   ```bash
   npm install @snazzah/davey --save
   ```

### Bot is silent and logs just show `connected=false` with no errors

The old failure mode (pre-fix) where a stuck voice connection never self-heals. The current code catches non-`Ready` states older than ~20s, destroys them, and retries via `entersState`. If you see a loop of:

```
🔌 Voice connection failed to reach Ready in 20s, destroying for retry
```

…then the bot *is* trying, and the underlying issue is one of the three items above (crypto, UDP, or DAVE).

### Bot doesn't respond to slash commands

Re-run `node deploy-commands.js`. Slash commands need re-registering after any definition change and can take up to an hour to propagate globally (instant for guild-scoped commands).

## Project structure

```
index.js                        main bot (voice + status engines, slash commands)
deploy-commands.js              registers slash commands with Discord

vc_statuses.example.json        template — copy to vc_statuses.json
bot_statuses.example.json       template — copy to bot_statuses.json
runtime_config.example.json     template — copy to runtime_config.json
.env.example                    template — copy to .env

vc_statuses.json                live VC status rule pool   (gitignored)
bot_statuses.json               live bot presence rule pool (gitignored)
runtime_config.json             auto-status toggle state    (gitignored)
.env                            secrets + config            (gitignored)
```
