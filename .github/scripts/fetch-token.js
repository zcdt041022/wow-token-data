/**
 * 时光徽章价格定时抓取脚本 (GitHub Actions)
 */

const fs = require("fs");
const path = require("path");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const BIN = 20 * 60 * 1000;
const RETAIN_MS = 35 * 24 * 3600 * 1000;
const NOW_MS = Date.now();
const NOW_SEC = Math.floor(NOW_MS / 1000);

async function fetchOfficial() {
  const results = [];
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch("https://chuanghan.top/api/token/summary", {
      headers: { "User-Agent": UA }, signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      const j = await res.json();
      if (j && j.latest_price && j.latest_price > 100000) {
        const price = Math.round(j.latest_price / 10000);
        const ts = j.latest_time || NOW_SEC;
        console.log(`  [chuanghan] 正式服 price=${price} ts=${ts}`);
        results.push({ price, ts: Number(ts), source: "chuanghan" });
      }
    }
  } catch (e) { console.log(`  [chuanghan] 失败: ${e.message}`); }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch("https://wowdata.top/wowtoken_retail", {
      headers: { "User-Agent": UA }, signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      const html = await res.text();
      const m = html.match(/(\d{2,3}),(\d{3})/);
      if (m) {
        const price = parseInt(m[1] + m[2], 10);
        if (price > 100000) {
          console.log(`  [wowdata] 正式服 price=${price} ts=${NOW_SEC}`);
          results.push({ price, ts: NOW_SEC, source: "wowdata" });
        }
      }
    }
  } catch (e) { console.log(`  [wowdata] 失败: ${e.message}`); }

  if (results.length === 0) { console.log("  ⚠️ 所有正式服数据源均失败"); return null; }
  results.sort((a, b) => b.ts - a.ts);
  return results[0];
}

const DATA_DIR = path.join(__dirname, "..", "..", "token-data");
const HOURLY_PATH = path.join(DATA_DIR, "hourly.json");
const DAILY_PATH = path.join(DATA_DIR, "daily.json");

function loadJson(fp) {
  try { if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, "utf-8")); }
  catch (e) { console.log(`  读取 ${fp} 失败: ${e.message}`); }
  return null;
}

function saveJson(fp, data) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(data, null, 2), "utf-8");
}

function mergeIntoHourly(existing, newPoint, key) {
  const data = existing || {
    official: { labels: [], prices: [] },
    classic: { labels: [], prices: [] },
    granularity: "hourly", updated_at: "",
  };
  if (!data[key]) data[key] = { labels: [], prices: [] };
  const labels = data[key].labels.map(String);
  const prices = data[key].prices.slice();

  if (newPoint) {
    const bucketMs = Math.floor(newPoint.ts * 1000 / BIN) * BIN;
    const bucketSec = Math.floor(bucketMs / 1000);
    const bucketLabel = String(bucketSec);
    const idx = labels.indexOf(bucketLabel);
    if (idx >= 0) {
      prices[idx] = newPoint.price;
      console.log(`  [${key}] 更新桶 ${bucketLabel} = ${newPoint.price}`);
    } else {
      let insertAt = labels.length;
      for (let i = 0; i < labels.length; i++) {
        if (Number(labels[i]) > bucketSec) { insertAt = i; break; }
      }
      labels.splice(insertAt, 0, bucketLabel);
      prices.splice(insertAt, 0, newPoint.price);
      console.log(`  [${key}] 新增桶 ${bucketLabel} = ${newPoint.price}`);
    }
  }
  const cutoffSec = Math.floor((NOW_MS - RETAIN_MS) / 1000);
  const keepFrom = labels.findIndex((l) => Number(l) >= cutoffSec);
  if (keepFrom > 0) {
    console.log(`  [${key}] 截断: 移除前 ${keepFrom} 条(超过 35 天)`);
    data[key].labels = labels.slice(keepFrom);
    data[key].prices = prices.slice(keepFrom);
  } else {
    data[key].labels = labels;
    data[key].prices = prices;
  }
  data.granularity = "hourly";
  data.updated_at = new Date(NOW_MS).toISOString();
  return data;
}

function buildDailyFromHourly(hourly) {
  const daily = {
    official: { labels: [], prices: [] },
    classic: { labels: [], prices: [] },
    granularity: "daily",
    updated_at: new Date(NOW_MS).toISOString(),
  };
  for (const key of ["official", "classic"]) {
    if (!hourly[key] || !hourly[key].labels) continue;
    const labels = hourly[key].labels.map(Number);
    const prices = hourly[key].prices;
    const dayMap = new Map();
    for (let i = 0; i < labels.length; i++) {
      const dayStart = Math.floor(labels[i] / (24 * 3600)) * 24 * 3600;
      dayMap.set(dayStart, { ts: labels[i], price: prices[i] });
    }
    const sorted = [...dayMap.entries()].sort((a, b) => a[0] - b[0]);
    daily[key].labels = sorted.map(([d]) => String(d));
    daily[key].prices = sorted.map(([, v]) => v.price);
    console.log(`  [daily ${key}] ${sorted.length} 天数据`);
  }
  return daily;
}

(async () => {
  console.log(`\n=== 时光徽章定时抓取 ${new Date(NOW_MS).toISOString()} ===\n`);
  console.log("抓取正式服价格...");
  const officialPoint = await fetchOfficial();

  console.log("\n加载现有数据...");
  const existingHourly = loadJson(HOURLY_PATH);
  if (existingHourly) {
    console.log(`  official: ${existingHourly.official?.labels?.length ?? 0} 点`);
    console.log(`  classic : ${existingHourly.classic?.labels?.length ?? 0} 点`);
  }

  console.log("\n合并到 hourly.json...");
  let hourly = existingHourly;
  hourly = mergeIntoHourly(hourly, officialPoint, "official");
  if (!hourly.classic) hourly.classic = { labels: [], prices: [] };

  console.log("\n聚合 daily.json...");
  const daily = buildDailyFromHourly(hourly);

  console.log("\n写入文件...");
  saveJson(HOURLY_PATH, hourly);
  saveJson(DAILY_PATH, daily);
  console.log(`  ✅ hourly.json (official ${hourly.official.labels.length} 点)`);
  console.log(`  ✅ daily.json`);

  const oPrices = hourly.official?.prices ?? [];
  const latestPrice = oPrices[oPrices.length - 1];
  console.log(`\n=== 最新正式服价格: ${latestPrice} ===\n`);
})();
