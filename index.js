require("dotenv").config();

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionFlagsBits,
  ActivityType,
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  AttachmentBuilder,
} = require("discord.js");
const { joinVoiceChannel, getVoiceConnection, VoiceConnectionStatus } = require("@discordjs/voice");

// Prevent crashes from unhandled errors (especially DAVE protocol errors)
process.on('unhandledRejection', (err) => {
  if (err?.message?.includes('DAVE protocol')) {
    // Silently ignore DAVE errors - they don't affect basic presence
    return;
  }
  console.error('Unhandled rejection:', err);
});

process.on('uncaughtException', (err) => {
  if (err?.message?.includes('DAVE protocol')) {
    // Silently ignore DAVE errors - they don't affect basic presence
    return;
  }
  console.error('Uncaught exception:', err);
});

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID;

// GIF CDN API config
const CDN_API_URL = process.env.CDN_API_URL || "";
const CDN_API_KEY = process.env.CDN_API_KEY || "";
const GIF_UPLOAD_ROLE_ID = process.env.GIF_UPLOAD_ROLE_ID || "";
const GIF_MANAGE_ROLE_ID = process.env.GIF_MANAGE_ROLE_ID || "";
// Default tags to always exclude from /gif random (comma-separated in .env)
const GIF_DEFAULT_EXCLUDE = process.env.GIF_DEFAULT_EXCLUDE
  ? process.env.GIF_DEFAULT_EXCLUDE.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean)
  : [];

// Per-channel tag exclusions storage
const CHANNEL_EXCLUSIONS_FILE = path.join(__dirname, "channel_exclusions.json");

function loadChannelExclusions() {
  try {
    if (fs.existsSync(CHANNEL_EXCLUSIONS_FILE)) {
      return JSON.parse(fs.readFileSync(CHANNEL_EXCLUSIONS_FILE, "utf8"));
    }
  } catch (e) {
    console.error("Failed to load channel exclusions:", e);
  }
  return {};
}

function saveChannelExclusions(data) {
  fs.writeFileSync(CHANNEL_EXCLUSIONS_FILE, JSON.stringify(data, null, 2));
}

// Load channel exclusions on startup
let channelExclusions = loadChannelExclusions();

const LEAVE_DELAY_MS = Number(process.env.LEAVE_DELAY_MS ?? 15000);

// Prevent spam to the VC status endpoint
const VC_STATUS_MIN_INTERVAL_MS = Number(process.env.VC_STATUS_MIN_INTERVAL_MS ?? 15000);
const VC_STATUS_MIN_INTERVAL_ON_CHANGE_MS = Number(
  process.env.VC_STATUS_MIN_INTERVAL_ON_CHANGE_MS ?? 750
);

// OPTIONAL: rotate status while humans=0
const VC_IDLE_ROTATE_MS = Number(process.env.VC_IDLE_ROTATE_MS ?? 10 * 60_000);

// OPTIONAL: rotate status even when humans>0 (set to 0 to disable)
const VC_ROTATE_MS = Number(process.env.VC_ROTATE_MS ?? 0);

// Optional debug logs
const DEBUG = String(process.env.DEBUG_STATUS ?? "").toLowerCase() === "1";

// Watchlist: if any of these user IDs are in the voice channel, we can show them in the VC status
const VC_WATCH_USER_IDS = new Set(
  String(process.env.VC_WATCH_USER_IDS ?? "")
    .split(/[, ]+/)
    .map((s) => s.trim())
    .filter(Boolean)
);

// Optional: prefix emoji/text when appending watch users
const VC_WATCH_PREFIX = String(process.env.VC_WATCH_PREFIX ?? "👀");

// How to inject watch users into the status:
// - "auto": append only if the chosen template doesn't already reference {watch}/{watchers}/{watchcount}
// - "always": always append
// - "never": never auto-append
const VC_WATCH_APPEND_MODE = String(process.env.VC_WATCH_APPEND_MODE ?? "auto").toLowerCase();

// Status file names (JSON)
const VC_STATUS_FILE = String(process.env.VC_STATUS_FILE ?? "vc_statuses.json");
const BOT_STATUS_FILE = String(process.env.BOT_STATUS_FILE ?? "bot_statuses.json");

if (!TOKEN || !CLIENT_ID || !GUILD_ID || !VOICE_CHANNEL_ID) {
  console.error("Missing env vars. Need DISCORD_TOKEN, CLIENT_ID, GUILD_ID, VOICE_CHANNEL_ID");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// -------------------- Persistent runtime config --------------------
const RUNTIME_CONFIG_FILE = path.join(__dirname, "runtime_config.json");

let runtimeConfig = {
  autoStatusEnabled: true,
  manualStatus: null, // only used when autoStatusEnabled === false
};

function loadRuntimeConfig() {
  try {
    const raw = fs.readFileSync(RUNTIME_CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw);
    runtimeConfig.autoStatusEnabled =
      typeof parsed.autoStatusEnabled === "boolean" ? parsed.autoStatusEnabled : true;
    runtimeConfig.manualStatus =
      typeof parsed.manualStatus === "string" || parsed.manualStatus === null
        ? parsed.manualStatus
        : null;

    console.log(
      `✅ Loaded runtime_config.json: auto=${runtimeConfig.autoStatusEnabled}, manual=${
        runtimeConfig.manualStatus ? "set" : "none"
      }`
    );
  } catch {
    // defaults
  }
}

function saveRuntimeConfig() {
  try {
    fs.writeFileSync(RUNTIME_CONFIG_FILE, JSON.stringify(runtimeConfig, null, 2));
  } catch (e) {
    console.warn("⚠️ Failed to save runtime_config.json:", e?.message || e);
  }
}

// -------------------- Time buckets --------------------
const TIMEZONE = "Australia/Sydney";
const NAMED_WINDOWS = {
  midnight: { start: "00:00", end: "04:00" },
  dawn: { start: "04:00", end: "08:00" },
  morning: { start: "08:00", end: "12:00" },
  midday: { start: "12:00", end: "16:00" },
  dusk: { start: "16:00", end: "20:00" },
  night: { start: "20:00", end: "00:00" }, // wraps
};

function hhmmToMin(hhmm) {
  const [h, m] = String(hhmm).split(":").map((x) => parseInt(x, 10));
  return h * 60 + m;
}

function inWindow(nowMin, startMin, endMin) {
  if (startMin <= endMin) return nowMin >= startMin && nowMin < endMin;
  return nowMin >= startMin || nowMin < endMin;
}

function getLocalNow() {
  const now = new Date();
  const hhmm = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  const nowMin = hhmmToMin(hhmm);
  return { hhmm, nowMin };
}

function currentTimeBucket(nowMin) {
  for (const [name, w] of Object.entries(NAMED_WINDOWS)) {
    if (inWindow(nowMin, hhmmToMin(w.start), hhmmToMin(w.end))) return name;
  }
  return "night";
}

function computeState(humans) {
  if (humans === 0) return "empty";
  if (humans === 1) return "solo";
  return "crowded";
}

// -------------------- Voice state cache --------------------
function formatNameList(names, maxItems = 3) {
  if (!Array.isArray(names) || names.length === 0) return "";
  const shown = names.slice(0, maxItems);
  const extra = names.length - shown.length;
  return extra > 0 ? `${shown.join(", ")} +${extra}` : shown.join(", ");
}

function getHumanCountAndSoloNameFromChannel(channel) {
  const members = channel?.members;
  if (!members) return { humansCount: 0, soloUserName: null, watchNames: [], watchIds: [] };

  const humans = members.filter((m) => m?.user && !m.user.bot);

  // Watch users that are present in the channel (matched by user ID)
  const watchMap = new Map();
  if (VC_WATCH_USER_IDS.size) {
    for (const m of humans.values()) {
      if (VC_WATCH_USER_IDS.has(m.id)) {
        const name = m.displayName ?? m.user?.username ?? m.id;
        watchMap.set(m.id, name);
      }
    }
  }

  const watchIds = Array.from(watchMap.keys()).sort();
  const watchNames = watchIds.map((id) => watchMap.get(id)).filter(Boolean);

  return {
    humansCount: humans.size,
    soloUserName: humans.size === 1 ? humans.first()?.displayName ?? null : null,
    watchNames,
    watchIds,
  };
}

// -------------------- Re-entry counters (reroll on 2->3->2) --------------------
const entryCounts = new Map(); // key -> number
const sessionByGuild = new Map(); // guildId -> { vcFp, vcEntry, botFp, botEntry }

function bumpEntry(prefix, guildId, fp) {
  const k = `${prefix}|${guildId}|${fp}`;
  const n = (entryCounts.get(k) ?? 0) + 1;
  entryCounts.set(k, n);
  return n;
}

function getSession(guildId) {
  let s = sessionByGuild.get(guildId);
  if (!s) {
    s = { vcFp: null, vcEntry: 0, botFp: null, botEntry: 0 };
    sessionByGuild.set(guildId, s);
  }
  return s;
}

// -------------------- Status engine (JSON) --------------------
function parseCondToken(token) {
  const ops = [">=", "<=", "="];
  for (const op of ops) {
    const idx = token.indexOf(op);
    if (idx > 0) {
      const key = token.slice(0, idx).trim().toLowerCase();
      const val = token.slice(idx + op.length).trim();
      return { key, op, val };
    }
  }
  return null;
}

function parseBetweenRange(val) {
  const m = String(val).match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
  if (!m) return null;
  return { startMin: hhmmToMin(m[1]), endMin: hhmmToMin(m[2]) };
}

function makeStatusEngine(filename) {
  const filePath = path.join(__dirname, filename);

  let pools = { any: [], empty: [], solo: [], crowded: [], connected: [] };
  let rules = []; // { conds, text }

  // Sticky random: cache the index per stableKey so it doesn't change constantly
  const choiceCache = new Map(); // cacheKey -> idx

  function randInt(max) {
    return crypto.randomInt(0, max);
  }

  function chooseIdx(cacheKey, len) {
    if (!len || len <= 1) return 0;

    const existing = choiceCache.get(cacheKey);
    if (typeof existing === "number" && existing >= 0 && existing < len) return existing;

    const idx = randInt(len);
    choiceCache.set(cacheKey, idx);
    return idx;
  }

  function buildCondsFromCondString(condStr) {
    const tokens = String(condStr || "")
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean);

    const conds = {};
    for (const t of tokens) {
      const parsed = parseCondToken(t);
      if (!parsed) continue;
      const { key, op, val } = parsed;
      conds[key] = conds[key] || [];
      conds[key].push({ op, val });
    }
    return conds;
  }

  function buildCondsFromWhen(whenObj) {
    const conds = {};
    if (!whenObj || typeof whenObj !== "object" || Array.isArray(whenObj)) return conds;

    for (const [rawKey, rawVal] of Object.entries(whenObj)) {
      const key = String(rawKey).toLowerCase();

      // { "humans": { ">=": 2 } }
      if (rawVal && typeof rawVal === "object" && !Array.isArray(rawVal)) {
        for (const [op, v] of Object.entries(rawVal)) {
          const opNorm = String(op).trim();
          conds[key] = conds[key] || [];
          conds[key].push({ op: opNorm, val: String(v) });
        }
        continue;
      }

      // primitive -> "="
      conds[key] = conds[key] || [];
      conds[key].push({ op: "=", val: String(rawVal) });
    }

    return conds;
  }

  function parseFromJson(text) {
    const obj = JSON.parse(text);

    const p = { any: [], empty: [], solo: [], crowded: [], connected: [] };
    const srcPools = obj?.pools && typeof obj.pools === "object" ? obj.pools : {};

    for (const k of Object.keys(p)) {
      if (Array.isArray(srcPools[k])) p[k] = srcPools[k].map((x) => String(x));
    }

    const r = [];
    if (Array.isArray(obj?.rules)) {
      for (const rule of obj.rules) {
        if (!rule || typeof rule !== "object") continue;
        const textVal = rule.text ?? rule.template ?? rule.value;
        if (typeof textVal !== "string" || !textVal.trim()) continue;

        let conds = {};
        if (typeof rule.cond === "string" && rule.cond.trim()) {
          conds = buildCondsFromCondString(rule.cond);
        } else if (rule.when) {
          conds = buildCondsFromWhen(rule.when);
        } else {
          // no conditions -> treat as "any pool"
          p.any.push(textVal.trim());
          continue;
        }

        r.push({ conds, text: textVal.trim() });
      }
    }

    return { p, r };
  }

  function load() {
    try {
      const text = fs.readFileSync(filePath, "utf8");
      const ext = path.extname(filePath).toLowerCase();

      let parsed;
      if (ext === ".json") {
        parsed = parseFromJson(text);
      } else {
        throw new Error(`Expected .json status file, got: ${ext || "(no extension)"}`);
      }

      const { p, r } = parsed;

      const poolTotal =
        p.any.length + p.empty.length + p.solo.length + p.crowded.length + p.connected.length;

      if (poolTotal > 0) pools = p;
      rules = r;

      choiceCache.clear(); // file changed => allow new picks
      console.log(
        `✅ Loaded ${filename}: rules=${rules.length} pools.any=${pools.any.length} (json)`
      );
    } catch (e) {
      console.warn(`⚠️ Could not read ${filename}: ${e.message}`);
    }
  }

  function watch() {
    try {
      fs.watch(filePath, { persistent: false }, () => setTimeout(load, 200));
    } catch (e) {
      console.warn(`⚠️ fs.watch failed for ${filename}: ${e.message}`);
    }
  }

  function condMatches(conds, ctx) {
    const { nowMin } = getLocalNow();
    const timeBucket = currentTimeBucket(nowMin);

    for (const [key, checks] of Object.entries(conds)) {
      for (const c of checks) {
        const { op, val } = c;

        if (key === "time") {
          if (op !== "=") return false;
          if (timeBucket !== String(val).toLowerCase()) return false;
          continue;
        }

        // Optional: exact time window, e.g. between=06:00-10:00
        if (key === "between") {
          if (op !== "=") return false;
          const range = parseBetweenRange(val);
          if (!range) return false;
          if (!inWindow(nowMin, range.startMin, range.endMin)) return false;
          continue;
        }

        if (key === "humans") {
          const n = ctx.humans;
          const x = parseInt(val, 10);
          if (Number.isNaN(x)) return false;
          if (op === "=" && n !== x) return false;
          if (op === ">=" && n < x) return false;
          if (op === "<=" && n > x) return false;
          continue;
        }

        if (key === "connected") {
          if (op !== "=") return false;
          const want = String(val).toLowerCase() === "true";
          if (ctx.connected !== want) return false;
          continue;
        }

        if (key === "state") {
          if (op !== "=") return false;
          if (ctx.state !== String(val).toLowerCase()) return false;
          continue;
        }

        if (key === "auto") {
          if (op !== "=") return false;
          const want = String(val).toLowerCase() === "true";
          if (ctx.auto !== want) return false;
          continue;
        }

        if (key === "vcauto") {
          if (op !== "=") return false;
          const want = String(val).toLowerCase() === "true";
          if (ctx.vcauto !== want) return false;
          continue;
        }

        if (key === "leaving") {
          if (op !== "=") return false;
          const want = String(val).toLowerCase() === "true";
          if (ctx.leaving !== want) return false;
          continue;
        }
      }
    }
    return true;
  }

  function pick(ctx, fallbackText, stableKey = "default") {
    const matches = rules.filter((r) => condMatches(r.conds, ctx));
    let template = null;

    if (matches.length) {
      // prefer most specific
      matches.sort((a, b) => Object.keys(b.conds).length - Object.keys(a.conds).length);
      const bestK = Object.keys(matches[0].conds).length;
      const best = matches.filter((r) => Object.keys(r.conds).length === bestK);

      const cacheKey = `${filename}|rules|${stableKey}|len=${best.length}`;
      const idx = chooseIdx(cacheKey, best.length);
      template = best[idx].text;

      if (DEBUG) console.log(`🎲 ${filename} best=${best.length} idx=${idx} key=${stableKey}`);
    } else {
      const k = ctx.connected ? "connected" : pools[ctx.state]?.length ? ctx.state : "any";
      const pool = pools[k]?.length ? pools[k] : pools.any;

      if (pool?.length) {
        const cacheKey = `${filename}|pool|${stableKey}|k=${k}|len=${pool.length}`;
        const idx = chooseIdx(cacheKey, pool.length);
        template = pool[idx];
      }
    }

    return template || fallbackText;
  }

  return { load, watch, pick };
}

const vcEngine = makeStatusEngine(VC_STATUS_FILE);
const botEngine = makeStatusEngine(BOT_STATUS_FILE);

// -------------------- Voice channel status API --------------------
let lastVcStatus = "";
let lastVcStatusAt = 0;
let lastVcKey = "";

let lastVcHumans = null; // Track last human count for rate limiting decisions

async function setVoiceChannelStatus(text, key, { force = false, humans = null } = {}) {
  const now = Date.now();
  
  // Skip if text hasn't changed at all
  if (text === lastVcStatus) {
    console.log(`[VC Status] Skipped - same text: "${text}"`);
    return;
  }

  // Check if human count changed (significant context change)
  const humansChanged = lastVcHumans !== null && lastVcHumans !== humans;

  if (!force) {
    // Allow fast updates when human count changes (context shift)
    // Apply longer rate limit only when idle AND humans count is stable
    let minInterval;
    if (humansChanged) {
      minInterval = VC_STATUS_MIN_INTERVAL_ON_CHANGE_MS; // 750ms for context changes
    } else if (humans === 0) {
      minInterval = Math.max(VC_STATUS_MIN_INTERVAL_MS, 60000); // 60s when stable & idle
    } else {
      minInterval = VC_STATUS_MIN_INTERVAL_MS; // Normal interval when humans present
    }
    
    const elapsed = now - lastVcStatusAt;
    if (elapsed < minInterval) {
      console.log(`[VC Status] Rate limited - elapsed ${elapsed}ms < ${minInterval}ms, humans=${humans}, changed=${humansChanged}`);
      return;
    }
  }
  
  console.log(`[VC Status] Updating: "${lastVcStatus}" -> "${text}" (humans=${humans}, force=${force})`)

  try {
    await client.rest.put(`/channels/${VOICE_CHANNEL_ID}/voice-status`, {
      body: { status: String(text ?? "").slice(0, 500) },
    });
    lastVcStatus = text;
    lastVcKey = key;
    lastVcStatusAt = now;
    lastVcHumans = humans;
  } catch (e) {
    console.warn("⚠️ Failed to set voice channel status:", e?.rawError?.message || e?.message || e);
  }
}

// -------------------- Bot presence --------------------
let lastPresence = "";
let lastPresenceKey = "";
let lastPresenceAt = 0;

function setBotPresence(text, key) {
  const now = Date.now();
  if (key === lastPresenceKey && now - lastPresenceAt < 15000) return;

  const clipped = String(text ?? "").slice(0, 120);
  if (!clipped) return;

  if (clipped === lastPresence && key === lastPresenceKey) return;

  client.user.setPresence({
    status: "online",
    activities: [{ type: ActivityType.Custom, name: "Custom Status", state: clipped }],
  });

  lastPresence = clipped;
  lastPresenceKey = key;
  lastPresenceAt = now;
}

// -------------------- Leave delay timers --------------------
const leaveTimers = new Map(); // guildId -> Timeout

function cancelLeaveTimer(guildId) {
  const t = leaveTimers.get(guildId);
  if (t) clearTimeout(t);
  leaveTimers.delete(guildId);
}
function leavingPending(guildId) {
  return leaveTimers.has(guildId);
}

function fill(template, vars) {
  const { nowMin } = getLocalNow();
  const time = currentTimeBucket(nowMin);

  return String(template ?? "")
    .replaceAll("{channel}", vars.channel ?? "")
    .replaceAll("{humans}", String(vars.humans ?? ""))
    .replaceAll("{user}", vars.user ?? "someone")
    .replaceAll("{time}", time)
    .replaceAll("{state}", vars.state ?? "")
    .replaceAll("{auto}", vars.auto ? "ON" : "OFF")
    .replaceAll("{vcauto}", vars.vcauto ? "ON" : "OFF")
    .replaceAll("{leaving}", vars.leaving ? "YES" : "NO")
    .replaceAll("{watch}", vars.watch ?? "")
    .replaceAll("{watchers}", vars.watch ?? "")
    .replaceAll("{watchcount}", String(vars.watchcount ?? ""));
}

async function scheduleDelayedLeave(guildId) {
  if (leaveTimers.has(guildId)) return;

  leaveTimers.set(
    guildId,
    setTimeout(async () => {
      leaveTimers.delete(guildId);

      const guild = await client.guilds.fetch(guildId).catch(() => null);
      if (!guild) return;
      const channel = await guild.channels.fetch(VOICE_CHANNEL_ID).catch(() => null);
      if (!channel) return;

      const isVoice =
        channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice;
      if (!isVoice) return;

      const { humansCount } = getHumanCountAndSoloNameFromChannel(channel);

      if (humansCount >= 2) {
        const conn = getVoiceConnection(guild.id);
        if (conn) conn.destroy();
      }

      await evaluateAndAct(guildId);
    }, LEAVE_DELAY_MS)
  );
}

// -------------------- Commands (same as before) --------------------
function requireAdmin(interaction) {
  return (
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)
  );
}

// -------------------- GIF Command Handlers --------------------
function hasUploadRole(interaction) {
  if (!GIF_UPLOAD_ROLE_ID) return true;
  return interaction.member.roles.cache.has(GIF_UPLOAD_ROLE_ID);
}

async function handleGifUpload(interaction) {
  // Check role permission
  if (!hasUploadRole(interaction)) {
    return interaction.reply({
      content: "❌ You don't have permission to upload GIFs.",
      ephemeral: true,
    });
  }

  if (!CDN_API_URL || !CDN_API_KEY) {
    return interaction.reply({
      content: "❌ GIF CDN is not configured. Set CDN_API_URL and CDN_API_KEY in .env",
      ephemeral: true,
    });
  }

  const attachment = interaction.options.getAttachment("file", true);

  // Validate it's a GIF
  if (!attachment.name.toLowerCase().endsWith(".gif")) {
    return interaction.reply({
      content: "❌ Only GIF files are allowed.",
      ephemeral: true,
    });
  }

  // Validate size (10MB)
  if (attachment.size > 10 * 1024 * 1024) {
    return interaction.reply({
      content: "❌ File too large (max 10MB).",
      ephemeral: true,
    });
  }

  // Always show tag selection menu
  const availableTags = await fetchAvailableTags();
  const customId = `slash_tags_${interaction.id}`;
  const selectMenu = createTagSelectMenu(availableTags, customId);
  
  const customTagsBtn = new ButtonBuilder()
    .setCustomId(`slash_customtags_${interaction.id}`)
    .setLabel("✏️ Type Custom Tags")
    .setStyle(ButtonStyle.Primary);
  
  const uploadBtn = new ButtonBuilder()
    .setCustomId(`slash_upload_${interaction.id}`)
    .setLabel("Upload without tags")
    .setStyle(ButtonStyle.Secondary);
  
  const cancelBtn = new ButtonBuilder()
    .setCustomId(`slash_cancel_${interaction.id}`)
    .setLabel("Cancel")
    .setStyle(ButtonStyle.Danger);
  
  const row1 = new ActionRowBuilder().addComponents(selectMenu);
  const row2 = new ActionRowBuilder().addComponents(customTagsBtn, uploadBtn, cancelBtn);
  
  // Store pending upload
  pendingUploads.set(interaction.id, {
    gifUrl: attachment.url,
    originalName: attachment.name,
    userId: interaction.user.id,
    channelId: interaction.channel.id,
    selectedTags: [],
  });
  
  // Auto-expire after 2 minutes
  setTimeout(() => pendingUploads.delete(interaction.id), 120000);
  
  await interaction.reply({
    content: "📤 **Select tags from dropdown** or click **Type Custom Tags** to enter your own:",
    components: [row1, row2],
    ephemeral: true,
  });
}

async function handleGifRandom(interaction) {
  if (!CDN_API_URL) {
    return interaction.reply({
      content: "❌ GIF CDN is not configured. Set CDN_API_URL in .env",
      ephemeral: true,
    });
  }

  const includeTags = interaction.options.getString("tags") || "";
  const userExclude = interaction.options.getString("exclude") || "";
  const ephemeral = interaction.options.getBoolean("hidden") ?? false;

  // Get channel-specific exclusions
  const channelId = interaction.channelId;
  const channelExcludeList = channelExclusions[channelId] || [];

  // Merge user exclusions with default and channel exclusions
  const userExcludeList = userExclude
    ? userExclude.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean)
    : [];
  const allExclusions = [...new Set([...GIF_DEFAULT_EXCLUDE, ...channelExcludeList, ...userExcludeList])];
  const exclude = allExclusions.join(",");

  // Process include tags
  const includeTagsList = includeTags
    ? includeTags.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean)
    : [];
  const tags = includeTagsList.join(",");

  await interaction.deferReply({ ephemeral });

  try {
    let url = CDN_API_URL.replace(/\/$/, "") + "/api-random.php";
    const params = new URLSearchParams();
    if (tags) params.append("tags", tags);
    if (exclude) params.append("exclude", exclude);
    if (params.toString()) url += `?${params.toString()}`;

    console.log("Fetching random GIF from:", url);
    const response = await fetch(url);
    const responseText = await response.text();
    console.log("Random GIF response:", responseText);
    
    let result;
    try {
      result = JSON.parse(responseText);
    } catch (parseErr) {
      console.error("GIF random parse error:", responseText);
      return interaction.editReply({ content: "❌ Server returned invalid response." });
    }
    
    console.log("Parsed result:", JSON.stringify(result));

    if (result.success && result.url) {
      // Ensure the URL is a valid absolute URL
      let gifUrl = result.url;
      if (!gifUrl.startsWith('http://') && !gifUrl.startsWith('https://')) {
        gifUrl = CDN_API_URL.replace(/\/$/, "") + gifUrl;
      }

      // Just send the URL - Discord will auto-preview the GIF
      return interaction.editReply({ content: gifUrl });
    } else if (result.success && !result.url) {
      // Success but no URL - shouldn't happen but handle it
      console.error("GIF random: success but no URL", result);
      return interaction.editReply({ content: "❌ Server returned no GIF URL. Try again." });
    } else {
      return interaction.editReply({
        content: `❌ ${result.error || "No GIFs found"}`,
      });
    }
  } catch (e) {
    console.error("GIF random error:", e);
    return interaction.editReply({ content: `❌ Failed to fetch GIF: ${e.message}` });
  }
}

async function handleGifTags(interaction) {
  if (!CDN_API_URL) {
    return interaction.reply({
      content: "❌ GIF CDN is not configured.",
      ephemeral: true,
    });
  }

  await interaction.deferReply();

  try {
    const url = CDN_API_URL.replace(/\/$/, "") + "/api.php";
    const response = await fetch(url);
    const result = await response.json();

    if (result.status !== "success" || !result.gifs) {
      return interaction.editReply({ content: "❌ Failed to fetch GIF data." });
    }

    // Collect all unique tags and count usage
    const tagCounts = new Map();
    for (const gif of result.gifs) {
      if (gif.tags && Array.isArray(gif.tags)) {
        for (const tag of gif.tags) {
          const lower = tag.toLowerCase();
          tagCounts.set(lower, (tagCounts.get(lower) || 0) + 1);
        }
      }
    }

    // Sort by count (descending)
    const sorted = Array.from(tagCounts.entries()).sort((a, b) => b[1] - a[1]);

    if (sorted.length === 0) {
      return interaction.editReply({ content: "No tags found." });
    }

    // Format tags compactly
    const tagLines = sorted.map(([tag, count]) => `\`${tag}\` ×${count}`);

    // Split into 3 columns for inline fields
    const itemsPerColumn = Math.ceil(tagLines.length / 3);
    const columns = [[], [], []];
    
    tagLines.forEach((line, i) => {
      const colIndex = Math.floor(i / itemsPerColumn);
      if (colIndex < 3) columns[colIndex].push(line);
    });

    const embed = new EmbedBuilder()
      .setColor(0xeb459e)
      .setTitle("🏷️ GIF Tags");

    // Add columns as inline fields
    columns.forEach((col, i) => {
      if (col.length > 0) {
        embed.addFields({ 
          name: i === 0 ? "Tags" : "\u200b", 
          value: col.join("\n"), 
          inline: true 
        });
      }
    });

    embed.setFooter({ 
      text: `${sorted.length} tags • ${result.count} GIFs • /gif random tags:name` 
    });

    return interaction.editReply({ embeds: [embed] });
  } catch (e) {
    console.error("GIF tags error:", e);
    return interaction.editReply({ content: `❌ Failed to fetch tags: ${e.message}` });
  }
}

// -------------------- Channel Exclusion Management --------------------
function hasManageRole(interaction) {
  if (!GIF_MANAGE_ROLE_ID) return true; // No role configured = allow all
  return interaction.member?.roles?.cache?.has(GIF_MANAGE_ROLE_ID) ?? false;
}

async function handleGifExclude(interaction) {
  const sub = interaction.options.getSubcommand();
  const channelId = interaction.channelId;

  // Check for manage role
  if (!hasManageRole(interaction)) {
    return interaction.reply({
      content: "❌ You don't have permission to manage channel exclusions.",
      ephemeral: true,
    });
  }

  if (sub === "add") {
    const input = interaction.options.getString("tags", true);
    const tags = input.split(",").map(t => t.toLowerCase().trim()).filter(Boolean);
    
    if (tags.length === 0) {
      return interaction.reply({
        content: "❌ Please provide at least one tag.",
        ephemeral: true,
      });
    }
    
    if (!channelExclusions[channelId]) {
      channelExclusions[channelId] = [];
    }
    
    const added = [];
    const skipped = [];
    
    for (const tag of tags) {
      if (channelExclusions[channelId].includes(tag)) {
        skipped.push(tag);
      } else {
        channelExclusions[channelId].push(tag);
        added.push(tag);
      }
    }
    
    if (added.length > 0) {
      saveChannelExclusions(channelExclusions);
    }
    
    let message = "";
    if (added.length > 0) {
      message += `✅ Added: ${added.map(t => `\`${t}\``).join(", ")}`;
    }
    if (skipped.length > 0) {
      message += `${message ? "\n" : ""}⚠️ Already excluded: ${skipped.map(t => `\`${t}\``).join(", ")}`;
    }
    
    return interaction.reply({
      content: message || "No changes made.",
      ephemeral: true,
    });
  }

  if (sub === "remove") {
    const input = interaction.options.getString("tags", true);
    const tags = input.split(",").map(t => t.toLowerCase().trim()).filter(Boolean);
    
    if (tags.length === 0) {
      return interaction.reply({
        content: "❌ Please provide at least one tag.",
        ephemeral: true,
      });
    }
    
    if (!channelExclusions[channelId]) {
      return interaction.reply({
        content: "⚠️ No tags are excluded in this channel.",
        ephemeral: true,
      });
    }
    
    const removed = [];
    const notFound = [];
    
    for (const tag of tags) {
      if (channelExclusions[channelId].includes(tag)) {
        channelExclusions[channelId] = channelExclusions[channelId].filter(t => t !== tag);
        removed.push(tag);
      } else {
        notFound.push(tag);
      }
    }
    
    if (channelExclusions[channelId].length === 0) {
      delete channelExclusions[channelId];
    }
    
    if (removed.length > 0) {
      saveChannelExclusions(channelExclusions);
    }
    
    let message = "";
    if (removed.length > 0) {
      message += `✅ Removed: ${removed.map(t => `\`${t}\``).join(", ")}`;
    }
    if (notFound.length > 0) {
      message += `${message ? "\n" : ""}⚠️ Not found: ${notFound.map(t => `\`${t}\``).join(", ")}`;
    }
    
    return interaction.reply({
      content: message || "No changes made.",
      ephemeral: true,
    });
  }

  if (sub === "list") {
    const tags = channelExclusions[channelId] || [];
    
    if (tags.length === 0) {
      return interaction.reply({
        content: "📋 No tags are excluded in this channel.\n" +
          (GIF_DEFAULT_EXCLUDE.length > 0 
            ? `\n**Server-wide exclusions:** ${GIF_DEFAULT_EXCLUDE.map(t => `\`${t}\``).join(", ")}`
            : ""),
        ephemeral: true,
      });
    }
    
    return interaction.reply({
      content: `📋 **Excluded tags in this channel:**\n${tags.map(t => `\`${t}\``).join(", ")}` +
        (GIF_DEFAULT_EXCLUDE.length > 0 
          ? `\n\n**Server-wide exclusions:** ${GIF_DEFAULT_EXCLUDE.map(t => `\`${t}\``).join(", ")}`
          : ""),
      ephemeral: true,
    });
  }

  if (sub === "clear") {
    if (!channelExclusions[channelId] || channelExclusions[channelId].length === 0) {
      return interaction.reply({
        content: "⚠️ No tags are excluded in this channel.",
        ephemeral: true,
      });
    }
    
    const count = channelExclusions[channelId].length;
    delete channelExclusions[channelId];
    saveChannelExclusions(channelExclusions);
    
    return interaction.reply({
      content: `✅ Cleared ${count} excluded tag(s) from this channel.`,
      ephemeral: true,
    });
  }
}

// -------------------- Reply-Based Upload System --------------------
// Cache for pending uploads: messageId -> { gifUrl, userId, channelId, originalName }
const pendingUploads = new Map();

// Fetch available tags from the API
async function fetchAvailableTags() {
  try {
    const url = CDN_API_URL.replace(/\/$/, "") + "/api.php";
    const response = await fetch(url);
    const result = await response.json();
    
    if (result.status !== "success" || !result.gifs) return [];
    
    const tagCounts = new Map();
    for (const gif of result.gifs) {
      if (gif.tags && Array.isArray(gif.tags)) {
        for (const tag of gif.tags) {
          const lower = tag.toLowerCase();
          tagCounts.set(lower, (tagCounts.get(lower) || 0) + 1);
        }
      }
    }
    
    // Sort by count and return top 25 (Discord limit)
    return Array.from(tagCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([tag, count]) => ({ tag, count }));
  } catch (e) {
    console.error("Failed to fetch tags:", e);
    return [];
  }
}

// Create tag selection components
function createTagSelectMenu(availableTags, customId) {
  const options = availableTags.map(({ tag, count }) => ({
    label: tag,
    value: tag,
    description: `Used ${count} times`,
  }));
  
  if (options.length === 0) {
    options.push({ label: "No tags available", value: "_none", description: "Upload some GIFs first" });
  }
  
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder("Select tags (optional)")
    .setMinValues(0)
    .setMaxValues(Math.min(options.length, 10))
    .addOptions(options);
  
  return selectMenu;
}

// Upload a GIF to the CDN
async function uploadGifToCdn(gifUrl, originalName, tags = []) {
  const fileResponse = await fetch(gifUrl);
  if (!fileResponse.ok) throw new Error("Failed to download GIF");
  
  const fileBuffer = Buffer.from(await fileResponse.arrayBuffer());
  
  const form = new FormData();
  const blob = new Blob([fileBuffer], { type: "image/gif" });
  form.append("file", blob, originalName);
  if (tags.length > 0) form.append("tags", tags.join(","));
  
  const uploadUrl = CDN_API_URL.replace(/\/$/, "") + "/api-upload.php";
  const uploadResponse = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CDN_API_KEY}`,
      "X-API-Key": CDN_API_KEY,
    },
    body: form,
  });
  
  const responseText = await uploadResponse.text();
  console.log("Upload response status:", uploadResponse.status);
  console.log("Upload response headers:", Object.fromEntries(uploadResponse.headers.entries()));
  console.log("Upload response body length:", responseText.length);
  console.log("Upload response body:", responseText.substring(0, 1000));
  
  if (!responseText || responseText.length === 0) {
    throw new Error(`Server returned empty response (status: ${uploadResponse.status})`);
  }
  
  let result;
  try {
    result = JSON.parse(responseText);
  } catch (e) {
    console.error("JSON parse error:", e.message);
    console.error("Full response:", responseText);
    throw new Error(`Server returned invalid JSON (status: ${uploadResponse.status})`);
  }
  
  return { result, status: uploadResponse.status };
}

// Create upload result embed
function createUploadResultEmbed(result, status) {
  if (result.success) {
    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle("✅ GIF Uploaded!")
      .setImage(result.url)
      .addFields({ name: "Filename", value: result.filename, inline: true });
    
    if (result.tags?.length) {
      embed.addFields({ name: "Tags", value: result.tags.join(", "), inline: true });
    }
    return { embeds: [embed], components: [] };
  } else if (status === 409) {
    const isExact = result.duplicate_type === "exact";
    const embed = new EmbedBuilder()
      .setColor(isExact ? 0xed4245 : 0xfee75c)
      .setTitle(isExact ? "🚫 Exact Duplicate" : "⚠️ Similar Image Detected")
      .setDescription(
        isExact
          ? "This exact GIF already exists!"
          : `Similar to existing GIF${result.similarity ? ` (${result.similarity} match)` : ""}!`
      )
      .setImage(result.existing?.url)
      .addFields({ name: "Existing File", value: result.existing?.filename || "Unknown" });
    return { embeds: [embed], components: [] };
  } else {
    return { content: `❌ Upload failed: ${result.error || "Unknown error"}`, embeds: [], components: [] };
  }
}

// Check if member has upload role
function memberHasUploadRole(member) {
  if (!GIF_UPLOAD_ROLE_ID) return true;
  return member.roles.cache.has(GIF_UPLOAD_ROLE_ID);
}

// Handle message-based upload (reply to GIF with bot mention)
client.on("messageCreate", async (message) => {
  // Ignore bots and DMs
  if (message.author.bot || !message.guild) return;
  
  // Check if bot is mentioned
  if (!message.mentions.has(client.user)) return;
  
  // Check if this is a reply to another message
  if (!message.reference?.messageId) return;
  
  // Check role permission
  if (!memberHasUploadRole(message.member)) {
    return message.reply({ content: "❌ You don't have permission to upload GIFs.", allowedMentions: { repliedUser: false } });
  }
  
  if (!CDN_API_URL || !CDN_API_KEY) {
    return message.reply({ content: "❌ GIF CDN is not configured.", allowedMentions: { repliedUser: false } });
  }
  
  try {
    // Fetch the replied-to message
    const repliedMessage = await message.channel.messages.fetch(message.reference.messageId);
    
    // Look for GIF in attachments or embeds
    let gifUrl = null;
    let originalName = "uploaded.gif";
    
    // Check attachments
    const gifAttachment = repliedMessage.attachments.find(a => 
      a.name?.toLowerCase().endsWith(".gif") || a.contentType === "image/gif"
    );
    if (gifAttachment) {
      gifUrl = gifAttachment.url;
      originalName = gifAttachment.name || "uploaded.gif";
    }
    
    // Check embeds for GIF
    if (!gifUrl) {
      for (const embed of repliedMessage.embeds) {
        if (embed.image?.url?.includes(".gif")) {
          gifUrl = embed.image.url;
          break;
        }
        if (embed.thumbnail?.url?.includes(".gif")) {
          gifUrl = embed.thumbnail.url;
          break;
        }
      }
    }
    
    // Check for Tenor/Giphy links in content
    if (!gifUrl && repliedMessage.content) {
      const tenorMatch = repliedMessage.content.match(/https:\/\/tenor\.com\/view\/[^\s]+/);
      const giphyMatch = repliedMessage.content.match(/https:\/\/giphy\.com\/gifs\/[^\s]+/);
      const directGifMatch = repliedMessage.content.match(/https?:\/\/[^\s]+\.gif/i);
      
      if (directGifMatch) gifUrl = directGifMatch[0];
      // Note: Tenor/Giphy would need their API to get direct GIF URLs
    }
    
    if (!gifUrl) {
      return message.reply({ 
        content: "❌ No GIF found in that message. Reply to a message with a GIF attachment.", 
        allowedMentions: { repliedUser: false } 
      });
    }
    
    // Store pending upload data
    pendingUploads.set(message.id, {
      gifUrl,
      originalName,
      userId: message.author.id,
      channelId: message.channel.id,
      selectedTags: [],
    });
    
    // Auto-expire after 2 minutes
    setTimeout(() => pendingUploads.delete(message.id), 120000);
    
    // Create a button to open the tag selector (ephemeral when clicked)
    const selectTagsBtn = new ButtonBuilder()
      .setCustomId(`gif_openselect_${message.id}`)
      .setLabel("Select Tags & Upload")
      .setStyle(ButtonStyle.Primary)
      .setEmoji("🏷️");
    
    const quickUploadBtn = new ButtonBuilder()
      .setCustomId(`gif_upload_${message.id}`)
      .setLabel("Upload without tags")
      .setStyle(ButtonStyle.Secondary);
    
    const row = new ActionRowBuilder().addComponents(selectTagsBtn, quickUploadBtn);
    
    await message.reply({
      content: `📤 **GIF detected!** Click below to upload.`,
      components: [row],
      allowedMentions: { repliedUser: false },
    });
    
  } catch (e) {
    console.error("Reply upload error:", e);
    message.reply({ content: `❌ Error: ${e.message}`, allowedMentions: { repliedUser: false } });
  }
});

// Handle select menu and button interactions for uploads
client.on("interactionCreate", async (interaction) => {
  // Handle modal submission for custom tags
  if (interaction.isModalSubmit()) {
    const isGifModal = interaction.customId.startsWith("gif_modal_");
    const isSlashModal = interaction.customId.startsWith("slash_modal_");
    
    if (!isGifModal && !isSlashModal) return;
    
    const prefix = isGifModal ? "gif" : "slash";
    const sessionId = interaction.customId.replace(`${prefix}_modal_`, "");
    const pending = pendingUploads.get(sessionId);
    
    if (!pending || pending.userId !== interaction.user.id) {
      return interaction.reply({ content: "❌ This upload session expired or isn't yours.", ephemeral: true });
    }
    
    const tagsInput = interaction.fields.getTextInputValue("tags_input") || "";
    pending.selectedTags = tagsInput.split(",").map(t => t.trim().toLowerCase()).filter(Boolean);
    
    // Proceed with upload
    await interaction.deferUpdate();
    
    try {
      await interaction.editReply({ content: "⏳ Uploading...", components: [] });
      const { result, status } = await uploadGifToCdn(pending.gifUrl, pending.originalName, pending.selectedTags);
      const response = createUploadResultEmbed(result, status);
      await interaction.editReply(response);
    } catch (e) {
      console.error("Upload error:", e);
      await interaction.editReply({ content: `❌ Upload failed: ${e.message}`, components: [] });
    }
    
    pendingUploads.delete(sessionId);
    return;
  }
  
  // Handle tag selection (both reply-based "gif_" and slash command "slash_")
  if (interaction.isStringSelectMenu()) {
    const isGifTags = interaction.customId.startsWith("gif_tags_");
    const isSlashTags = interaction.customId.startsWith("slash_tags_");
    
    if (!isGifTags && !isSlashTags) return;
    
    const prefix = isGifTags ? "gif" : "slash";
    const sessionId = interaction.customId.replace(`${prefix}_tags_`, "");
    const pending = pendingUploads.get(sessionId);
    
    if (!pending || pending.userId !== interaction.user.id) {
      return interaction.reply({ content: "❌ This upload session expired or isn't yours.", ephemeral: true });
    }
    
    pending.selectedTags = interaction.values.filter(v => v !== "_none");
    
    // Update message to show selected tags and add confirm button
    const confirmBtn = new ButtonBuilder()
      .setCustomId(`${prefix}_confirm_${sessionId}`)
      .setLabel(`Upload with ${pending.selectedTags.length} tag(s)`)
      .setStyle(ButtonStyle.Success);
    
    const cancelBtn = new ButtonBuilder()
      .setCustomId(`${prefix}_cancel_${sessionId}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Danger);
    
    const row = new ActionRowBuilder().addComponents(confirmBtn, cancelBtn);
    
    await interaction.update({
      content: `📤 **Selected tags:** ${pending.selectedTags.length > 0 ? pending.selectedTags.map(t => `\`${t}\``).join(", ") : "None"}\n\nClick **Upload** to confirm.`,
      components: [row],
    });
    return;
  }
  
  // Handle upload buttons (both "gif_" and "slash_" prefixes)
  if (interaction.isButton()) {
    const parts = interaction.customId.split("_");
    const prefix = parts[0]; // "gif" or "slash"
    const type = parts[1];   // "upload", "confirm", "cancel", or "openselect"
    const sessionId = parts.slice(2).join("_"); // rejoin in case ID has underscores
    
    if (prefix !== "gif" && prefix !== "slash") return;
    
    const pending = pendingUploads.get(sessionId);
    
    // Handle "Select Tags" button - shows ephemeral tag menu
    if (type === "openselect" && pending) {
      if (pending.userId !== interaction.user.id) {
        return interaction.reply({ content: "❌ This isn't your upload.", ephemeral: true });
      }
      
      const availableTags = await fetchAvailableTags();
      const selectMenu = createTagSelectMenu(availableTags, `${prefix}_tags_${sessionId}`);
      
      const customTagsBtn = new ButtonBuilder()
        .setCustomId(`${prefix}_customtags_${sessionId}`)
        .setLabel("✏️ Type Custom Tags")
        .setStyle(ButtonStyle.Primary);
      
      const uploadBtn = new ButtonBuilder()
        .setCustomId(`${prefix}_upload_${sessionId}`)
        .setLabel("Upload without tags")
        .setStyle(ButtonStyle.Secondary);
      
      const cancelBtn = new ButtonBuilder()
        .setCustomId(`${prefix}_cancel_${sessionId}`)
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Danger);
      
      const row1 = new ActionRowBuilder().addComponents(selectMenu);
      const row2 = new ActionRowBuilder().addComponents(customTagsBtn, uploadBtn, cancelBtn);
      
      // Reply with ephemeral message containing the tag selector
      return interaction.reply({
        content: "📤 **Select tags from dropdown** or click **Type Custom Tags** to enter your own:",
        components: [row1, row2],
        ephemeral: true,
      });
    }
    
    // Handle "Custom Tags" button - opens a modal
    if (type === "customtags" && pending) {
      if (pending.userId !== interaction.user.id) {
        return interaction.reply({ content: "❌ This isn't your upload.", ephemeral: true });
      }
      
      const modal = new ModalBuilder()
        .setCustomId(`${prefix}_modal_${sessionId}`)
        .setTitle("Enter Tags");
      
      const tagsInput = new TextInputBuilder()
        .setCustomId("tags_input")
        .setLabel("Tags (comma-separated)")
        .setPlaceholder("femboy, cute, cozy, ears")
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(200);
      
      if (pending.selectedTags.length > 0) {
        tagsInput.setValue(pending.selectedTags.join(", "));
      }
      
      const row = new ActionRowBuilder().addComponents(tagsInput);
      modal.addComponents(row);
      
      return interaction.showModal(modal);
    }
    
    if (type === "cancel") {
      pendingUploads.delete(sessionId);
      // Try to update the original message, or just reply
      try {
        await interaction.update({ content: "❌ Upload cancelled.", components: [] });
      } catch {
        await interaction.reply({ content: "❌ Upload cancelled.", ephemeral: true });
      }
      return;
    }
    
    if ((type === "upload" || type === "confirm") && pending) {
      if (pending.userId !== interaction.user.id) {
        return interaction.reply({ content: "❌ This isn't your upload.", ephemeral: true });
      }
      
      // Try to update, otherwise reply
      try {
        await interaction.update({ content: "⏳ Uploading...", components: [] });
      } catch {
        await interaction.deferReply({ ephemeral: true });
      }
      
      try {
        const { result, status } = await uploadGifToCdn(pending.gifUrl, pending.originalName, pending.selectedTags);
        const response = createUploadResultEmbed(result, status);
        await interaction.editReply(response);
      } catch (e) {
        console.error("Upload error:", e);
        await interaction.editReply({ content: `❌ Upload failed: ${e.message}`, components: [] });
      }
      
      pendingUploads.delete(sessionId);
      return;
    }
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // Handle GIF commands (separate permissions)
  if (interaction.commandName === "gif") {
    const sub = interaction.options.getSubcommand();
    if (sub === "upload") return handleGifUpload(interaction);
    if (sub === "random") return handleGifRandom(interaction);
    if (sub === "tags") return handleGifTags(interaction);
    if (sub === "add" || sub === "remove" || sub === "list" || sub === "clear") {
      return handleGifExclude(interaction);
    }
    return;
  }

  if (!requireAdmin(interaction)) {
    return interaction.reply({
      content: "You need Manage Server or Manage Channels to do that.",
      ephemeral: true,
    });
  }

  if (interaction.commandName === "autostatus") {
    const mode = interaction.options.getString("mode", true);
    runtimeConfig.autoStatusEnabled = mode === "on";

    if (runtimeConfig.autoStatusEnabled) runtimeConfig.manualStatus = null;

    saveRuntimeConfig();
    await evaluateAndAct(GUILD_ID);

    return interaction.reply({
      content: `Auto VC-status is now **${runtimeConfig.autoStatusEnabled ? "ON" : "OFF"}**.`,
      ephemeral: true,
    });
  }

  if (interaction.commandName === "vcstatus") {
    const sub = interaction.options.getSubcommand();

    if (sub === "show") {
      return interaction.reply({
        content:
          `Auto: **${runtimeConfig.autoStatusEnabled ? "ON" : "OFF"}**\n` +
          `Stored manual (only used when auto OFF): **${runtimeConfig.manualStatus ? "SET" : "none"}**`,
        ephemeral: true,
      });
    }

    if (sub === "clear") {
      runtimeConfig.manualStatus = null;
      saveRuntimeConfig();

      await setVoiceChannelStatus("", "manual|cleared", { force: true });
      await evaluateAndAct(GUILD_ID);

      return interaction.reply({
        content: "Cleared stored manual status (and cleared VC status).",
        ephemeral: true,
      });
    }

    if (sub === "set") {
      const text = interaction.options.getString("text", true).slice(0, 500);
      const lock = interaction.options.getBoolean("lock") ?? false;

      if (lock) {
        runtimeConfig.autoStatusEnabled = false;
        runtimeConfig.manualStatus = text;
        saveRuntimeConfig();
        await setVoiceChannelStatus(text, "manual|locked", { force: true });

        return interaction.reply({
          content: "Set VC status and **turned AUTO OFF** (manual will stick).",
          ephemeral: true,
        });
      }

      if (!runtimeConfig.autoStatusEnabled) {
        runtimeConfig.manualStatus = text;
        saveRuntimeConfig();
      }

      await setVoiceChannelStatus(text, "manual|oneshot", { force: true });

      return interaction.reply({
        content: runtimeConfig.autoStatusEnabled
          ? "Set VC status **now** (AUTO is ON, so it may change on the next auto update)."
          : "Set VC status (AUTO is OFF, so it will stay).",
        ephemeral: true,
      });
    }
  }
});

// -------------------- Debounce + main logic --------------------
const pending = new Map();
function scheduleEvaluate(guildId) {
  if (pending.has(guildId)) clearTimeout(pending.get(guildId));
  pending.set(
    guildId,
    setTimeout(() => {
      pending.delete(guildId);
      evaluateAndAct(guildId).catch((e) => console.error("evaluateAndAct error:", e));
    }, 500)
  );
}

async function evaluateAndAct(guildId) {
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;
  const channel = await guild.channels.fetch(VOICE_CHANNEL_ID).catch(() => null);
  if (!channel) return;

  const isVoice =
    channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice;
  if (!isVoice) return;

  const { humansCount: humans, soloUserName, watchNames, watchIds } =
    getHumanCountAndSoloNameFromChannel(channel);

  const watchCount = Array.isArray(watchIds) ? watchIds.length : 0;
  const watchList = formatNameList(watchNames);
  const watchSig =
    watchCount > 0
      ? crypto.createHash("sha1").update(watchIds.join(",")).digest("hex").slice(0, 8)
      : "none";

  let conn = getVoiceConnection(guild.id);

  // If the connection object exists but is actually disconnected/destroyed,
  // destroy it so we can create a fresh one. Without this, the bot thinks
  // it's still in the VC when Discord has actually kicked it.
  if (conn) {
    const status = conn.state?.status;
    if (status === VoiceConnectionStatus.Disconnected || status === VoiceConnectionStatus.Destroyed) {
      console.log(`🔌 Voice connection in bad state (${status}), destroying for reconnect...`);
      try { conn.destroy(); } catch {}
      conn = null;
    }
  }

  // cancel leave timer if <=1 human
  if (humans <= 1) cancelLeaveTimer(guild.id);

  // join/leave logic
  // Bot should be in VC when 0 or 1 humans, leave when 2+
  if (humans <= 1) {
    if (!conn) {
      try {
        const newConn = joinVoiceChannel({
          channelId: channel.id,
          guildId: guild.id,
          adapterCreator: guild.voiceAdapterCreator,
          selfDeaf: true,
          selfMute: true,
        });
        // Handle DAVE protocol errors gracefully (missing @snazzah/davey package)
        newConn.on('error', (err) => {
          if (err.message?.includes('DAVE protocol')) {
            // Silently ignore DAVE errors - they don't affect basic presence
          } else {
            console.error('Voice connection error:', err);
          }
        });
        // Auto-reconnect if the connection gets disconnected
        newConn.on('stateChange', (oldState, newState) => {
          if (newState.status === VoiceConnectionStatus.Disconnected) {
            console.log('🔌 Voice connection disconnected, will reconnect on next evaluate cycle');
            // Trigger a re-evaluate so the bot rejoins
            scheduleEvaluate(guild.id);
          }
        });
        conn = newConn;
      } catch (err) {
        console.error('Failed to join voice channel:', err);
      }
    }
  } else {
    // humans >= 2 -> schedule leave
    if (conn) await scheduleDelayedLeave(guild.id);
  }

  const connected = Boolean(getVoiceConnection(guild.id)) && 
    getVoiceConnection(guild.id)?.state?.status === VoiceConnectionStatus.Ready;

  if (DEBUG) {
    console.log(
      `👥 humans=${humans} connected=${connected} watch=${watchCount} membersInChannel=${channel.members.size}`
    );
  }

  const state = computeState(humans);
  const { nowMin } = getLocalNow();
  const time = currentTimeBucket(nowMin);

  const vcauto = runtimeConfig.autoStatusEnabled;
  const leaving = leavingPending(guildId);

  // rotation slots
  const rotateSlot = VC_ROTATE_MS > 0 ? Math.floor(Date.now() / VC_ROTATE_MS) : 0;
  const idleSlot =
    VC_IDLE_ROTATE_MS > 0 && humans === 0 ? Math.floor(Date.now() / VC_IDLE_ROTATE_MS) : 0;

  const session = getSession(guildId);

  // ---- VC Status behavior ----
  if (vcauto) {
    const fpVC = `t=${time}|h=${humans}|c=${connected}|lv=${leaving}|rot=${rotateSlot}|idle=${idleSlot}|vcauto=${vcauto}|w=${watchCount}|ws=${watchSig}`;

    if (session.vcFp !== fpVC) {
      session.vcFp = fpVC;
      session.vcEntry = bumpEntry("vc", guildId, fpVC);
    }

    const stableKeyVC = `vc|${fpVC}|entry=${session.vcEntry}`;

    const template = vcEngine.pick(
      { humans, connected, state, auto: vcauto, vcauto, leaving },
      `${channel.name} • ${humans} • ${time}`,
      stableKeyVC
    );

    let text = fill(template, {
      channel: channel.name,
      humans,
      user: soloUserName,
      state,
      auto: vcauto,
      vcauto,
      leaving,
      watch: watchList,
      watchcount: watchCount,
    });

    // Auto-append watch users unless template already uses {watch}/{watchers}/{watchcount}
    if (watchCount > 0) {
      const tplHasWatch =
        String(template).includes("{watch}") ||
        String(template).includes("{watchers}") ||
        String(template).includes("{watchcount}");

      const mode = VC_WATCH_APPEND_MODE;
      const shouldAppend = mode === "always" || (mode !== "never" && !tplHasWatch);

      if (shouldAppend && watchList) {
        const soloDup =
          humans === 1 && watchCount === 1 && soloUserName && watchList === soloUserName;
        if (!soloDup) {
          const suffix = ` • ${VC_WATCH_PREFIX} ${watchList}`;
          text = String(text + suffix).slice(0, 500);
        }
      }
    }

    const key = `auto|${fpVC}|entry=${session.vcEntry}`;
    await setVoiceChannelStatus(text, key, { humans });
  } else {
    if (runtimeConfig.manualStatus) {
      await setVoiceChannelStatus(runtimeConfig.manualStatus, "manual|stored", { humans });
    }
  }

  // ---- Bot presence ----
  const botAuto = true;
  const fpBot = `t=${time}|h=${humans}|c=${connected}|lv=${leaving}|rot=${rotateSlot}|idle=${idleSlot}|vcauto=${vcauto}|w=${watchCount}|ws=${watchSig}`;

  if (session.botFp !== fpBot) {
    session.botFp = fpBot;
    session.botEntry = bumpEntry("bot", guildId, fpBot);
  }

  const stableKeyBot = `bot|${fpBot}|entry=${session.botEntry}`;

  const botTemplate = botEngine.pick(
    { humans, connected, state, auto: botAuto, vcauto, leaving },
    `Auto ON • ${channel.name}`,
    stableKeyBot
  );

  const botText = fill(botTemplate, {
    channel: channel.name,
    humans,
    user: soloUserName,
    state,
    auto: botAuto,
    vcauto,
    leaving,
    watch: watchList,
    watchcount: watchCount,
  });

  const botKey = `bot|${fpBot}|entry=${session.botEntry}`;
  setBotPresence(botText, botKey);
}

client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  loadRuntimeConfig();

  vcEngine.load();
  vcEngine.watch();

  botEngine.load();
  botEngine.watch();

  scheduleEvaluate(GUILD_ID);

  // time-bucket refresh once per minute
  setInterval(() => scheduleEvaluate(GUILD_ID), 60_000);
});

client.on("voiceStateUpdate", (oldState, newState) => {
  const touchedTarget =
    oldState.channelId === VOICE_CHANNEL_ID || newState.channelId === VOICE_CHANNEL_ID;
  if (!touchedTarget) return;

  const guildId = newState.guild?.id || oldState.guild?.id;
  if (guildId !== GUILD_ID) return;

  scheduleEvaluate(guildId);
});

client.login(TOKEN);
