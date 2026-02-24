#!/usr/bin/env node
/**
 * Convert legacy status .txt format into the new .json format.
 *
 * Usage:
 *   node convert_statuses_txt_to_json.js vc_statuses.txt vc_statuses.json
 *   node convert_statuses_txt_to_json.js bot_statuses.txt bot_statuses.json
 *
 * Output schema:
 * {
 *   "version": 1,
 *   "pools": { "any":[], "empty":[], "solo":[], "crowded":[], "connected":[] },
 *   "rules": [ { "cond":"time=dawn humans=0", "text":"..." }, ... ]
 * }
 */

const fs = require("fs");
const path = require("path");

function usageAndExit() {
  const name = path.basename(process.argv[1] || "convert_statuses_txt_to_json.js");
  console.error(`Usage: node ${name} <input.txt> [output.json]`);
  process.exit(1);
}

const inPath = process.argv[2];
if (!inPath) usageAndExit();

const outPath =
  process.argv[3] ||
  (inPath.toLowerCase().endsWith(".txt")
    ? inPath.slice(0, -4) + ".json"
    : inPath + ".json");

const text = fs.readFileSync(inPath, "utf8");

const pools = { any: [], empty: [], solo: [], crowded: [], connected: [] };
const rules = []; // { cond, text }

for (const raw of text.split(/\r?\n/)) {
  let line = raw.trim();
  if (!line || line.startsWith("#")) continue;

  // [cond] text
  let condStr = null;
  const mCond = line.match(/^\[([^\]]+)\]\s*(.+)$/);
  if (mCond) {
    condStr = mCond[1].trim();
    line = mCond[2].trim();
  }

  // tag: text  (any|empty|solo|crowded|connected)
  const mTag = line.match(/^(any|empty|solo|crowded|connected)\s*:\s*(.+)$/i);
  if (mTag) {
    const tag = mTag[1].toLowerCase();
    const body = mTag[2].trim();

    if (condStr) {
      // In the old format, "tag:" inside a [cond] line forces state=tag
      const forced = condStr.includes("state=") ? condStr : `${condStr} state=${tag}`;
      rules.push({ cond: forced, text: body });
    } else {
      pools[tag].push(body);
    }
    continue;
  }

  if (condStr) {
    rules.push({ cond: condStr, text: line });
  } else {
    pools.any.push(line);
  }
}

const out = {
  version: 1,
  generatedAt: new Date().toISOString(),
  source: path.basename(inPath),
  pools,
  rules,
};

fs.writeFileSync(outPath, JSON.stringify(out, null, 2), "utf8");
console.log(
  `✅ Converted ${path.basename(inPath)} -> ${path.basename(outPath)} (pools.any=${pools.any.length}, rules=${rules.length})`
);
