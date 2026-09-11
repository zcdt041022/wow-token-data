/**
 * 时光徽章价格定时抓取脚本 (GitHub Actions)
 * ----------------------------------------------------------------------------
   数据源:
     正式服(official):
       1. chuanghan.top JSON API (优先, 干净 JSON)
       2. wowdata.top HTML (备用, 解析价格)
     怀旧服(classic):
       暂不抓取(依赖本地软件从 jiguanqiang.net 获取), 保留已有数据

   输出:
     token-data/hourly.json  — 20 分钟粒度, 保留最近 35 天
     token-data/daily.json   — 日线聚合, 每天最后一个价格

   格式参考 Gitee 现有 hourly.json / daily.json
 */

const fs = require("fs");
const path = require("path");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const BIN = 20 * 60 * 1000; // 20 分钟一个桶
const RETAIN_MS = 35 * 24 * 3600 * 1000; // 保留 35 天
const NOW_MS = Date.now();
const NOW_SEC = Math.floor(NOW_MS / 1000);

// ── 第 1 步: 抓取正式服价格 ────────────────────────────────────

async function fetchOfficial() {
  const results = [];

  // 源 1: chuanghan.top JSON API
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch("https://chuanghan.top/api/token/summary", {
      headers: { "User-Agent": UA },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      const j = await res.json();
      if (j && j.latest_price && j.latest_price > 100000) {
        // API 返回的是 6297290000, 实际价格是 ÷10000 = 629729
        const price = Math.round(j.latest_price / 10000);
        const ts = j.latest_time || NOW_SEC;
        console.log(
          `  [chuanghan] 正式服 price=${price} ts=${ts} (${new Date(ts * 1000).toISOString()})`,
        );
        results.push({ price, ts: Number(ts), source: "chuanghan" });
      }
    }
  } catch (e) {
    console.log(`  [chuanghan] 失败: ${e.message}`);
  }

  // 源 2: wowdata.top HTML (备用)
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch("https://wowdata.top/wowtoken_retail", {
      headers: { "User-Agent": UA },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      const html = await res.text();
      // 提取 <h2> 或类似标签里的价格, 格式如 608,946
      const m = html.match(/(\d{2,3}),(\d{3})/);
      if (m) {
        const price = parseInt(m[1] + m[2], 10);
        if (price > 100000) {
          console.log(`  [wowdata] 正式服 price=${price} ts=${NOW_SEC}`);
          results.push({ price, ts: NOW_SEC, source: "wowdata" });
        }
      }
    }
  } catch (e) {
    console.log(`  [wowdata] 失败: ${e.message}`);
  }

  if (results.length === 0) {
    console.log("  ⚠️ 所有正式服数据源均失败");
    return null;
  }

  // 取 fetched_at_ms 最新的那个
  results.sort((a, b) => b.ts - a.ts);
  return results[0];
}

// ── 第 1b 步: 尝试抓取怀旧服价格(尽力而为, 失败跳过) ─────────

async function fetchClassic() {
  const results = [];

  // 源 1: wowdata.top 怀旧服页面
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch("https://wowdata.top/wowtoken_classic", {
      headers: { "User-Agent": UA },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      const html = await res.text();
      const m = html.match(/(\d{2,3}),(\d{3})/);
      if (m) {
        const price = parseInt(m[1] + m[2], 10);
        if (price > 50000 && price < 500000) {
          console.log(`  [wowdata] 怀旧服 price=${price} ts=${NOW_SEC}`);
          results.push({ price, ts: NOW_SEC, source: "wowdata" });
        } else {
          console.log(`  [wowdata] 怀旧服 price=${price} 异常范围, 跳过`);
        }
      } else {
        console.log(`  [wowdata] 怀旧服 未匹配到价格`);
      }
    }
  } catch (e) {
    console.log(`  [wowdata] 怀旧服 失败: ${e.message}`);
  }

  // 源 2: jiguanqiang.net (尝试一下, 可能已改版)
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch("https://wow.jiguanqiang.net/", {
      headers: { "User-Agent": UA, "Referer": "https://wow.jiguanqiang.net/" },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      const html = await res.text();
      // 尝试找"熊猫人之谜"或"怀旧"附近的数字
      const keywordHit = html.match(/(熊猫人之谜|怀旧服)[^<]*?(\d{6})/);
      if (keywordHit) {
        const price = parseInt(keywordHit[2], 10);
        if (price > 50000) {
          console.log(`  [jiguanqiang] 怀旧服 price=${price} ts=${NOW_SEC}`);
          results.push({ price, ts: NOW_SEC, source: "jiguanqiang" });
        }
      } else {
        console.log(`  [jiguanqiang] 怀旧服 未匹配(可能已改版)`);
      }
    }
  } catch (e) {
    console.log(`  [jiguanqiang] 怀旧服 失败: ${e.message}`);
  }

  if (results.length === 0) {
    console.log("  ⚠️ 所有怀旧服数据源均失败(可忽略, 柠屿软件本地会补)");
    return null;
  }

  results.sort((a, b) => b.ts - a.ts);
  return results[0];
}

// ── 第 2 步: 加载现有 hourly.json ──────────────────────────────

const DATA_DIR = path.join(__dirname, "..", "..", "token-data");
const HOURLY_PATH = path.join(DATA_DIR, "hourly.json");
const DAILY_PATH = path.join(DATA_DIR, "daily.json");

function loadJson(filepath) {
  try {
    if (fs.existsSync(filepath)) {
      return JSON.parse(fs.readFileSync(filepath, "utf-8"));
    }
  } catch (e) {
    console.log(`  读取 ${filepath} 失败: ${e.message}`);
  }
  return null;
}

function saveJson(filepath, data) {
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2), "utf-8");
}

// ── 第 3 步: 合并价格到 hourly.json ────────────────────────────

/**
 * hourly.json 格式:
 * {
 *   "official": { "labels": ["1789117200", ...], "prices": [629729, ...] },
 *   "classic":  { "labels": [...], "prices": [...] },
 *   "granularity": "hourly",
 *   "updated_at": "2026-09-11T09:43:39Z"
 * }
 */
function mergeIntoHourly(existing, newPoint, key) {
  const data = existing || {
    official: { labels: [], prices: [] },
    classic: { labels: [], prices: [] },
    granularity: "hourly",
    updated_at: "",
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
      // 按时间戳插入
      let insertAt = labels.length;
      for (let i = 0; i < labels.length; i++) {
        if (Number(labels[i]) > bucketSec) {
          insertAt = i;
          break;
        }
      }
      labels.splice(insertAt, 0, bucketLabel);
      prices.splice(insertAt, 0, newPoint.price);
      console.log(`  [${key}] 新增桶 ${bucketLabel} = ${newPoint.price}`);
    }
  }

  // 截断到最近 35 天
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

// ── 第 4 步: 从 hourly 聚合出 daily ────────────────────────────

/**
 * daily.json 格式:
 * {
 *   "official": { "labels": ["1788998400", ...], "prices": [601071, ...] },
 *   "classic":  { "labels": [...], "prices": [...] },
 *   "granularity": "daily",
 *   "updated_at": "2026-09-11T09:43:39Z"
 * }
 * 每天取最后一个价格作为收盘。
 */
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

    // 按天分组, 取每天最后一个
    const dayMap = new Map(); // dayStartSec -> last price
    for (let i = 0; i < labels.length; i++) {
      const dayStart = Math.floor(labels[i] / (24 * 3600)) * 24 * 3600;
      dayMap.set(dayStart, { ts: labels[i], price: prices[i] });
    }

    const sorted = [...dayMap.entries()].sort((a, b) => a[0] - b[0]);
    daily[key].labels = sorted.map(([d]) => String(d));
    daily[key].prices = sorted.map(([, v]) => v.price);
    console.log(`  [daily ${key}] ${sorted.length} 天数据, 最新 ${sorted[sorted.length - 1]?.[1]?.price ?? "无"}`);
  }

  return daily;
}

// ── 主流程 ─────────────────────────────────────────────────────

(async () => {
  console.log(`\n=== 时光徽章定时抓取 ${new Date(NOW_MS).toISOString()} ===\n`);

  // 1. 抓正式服
  console.log("抓取正式服价格...");
  const officialPoint = await fetchOfficial();

  // 1b. 抓怀旧服(尽力而为, 失败跳过)
  console.log("\n抓取怀旧服价格...");
  const classicPoint = await fetchClassic();

  // 2. 加载现有 hourly.json
  console.log("\n加载现有 hourly.json...");
  const existingHourly = loadJson(HOURLY_PATH);
  const existingDaily = loadJson(DAILY_PATH);
  if (existingHourly) {
    console.log(`  official: ${existingHourly.official?.labels?.length ?? 0} 点`);
    console.log(`  classic : ${existingHourly.classic?.labels?.length ?? 0} 点`);
  } else {
    console.log("  hourly.json 不存在, 将创建新文件");
  }

  // 3. 合并到 hourly
  console.log("\n合并到 hourly.json...");
  let hourly = existingHourly;
  hourly = mergeIntoHourly(hourly, officialPoint, "official");
  hourly = mergeIntoHourly(hourly, classicPoint, "classic");

  // 4. 从 hourly 聚合 daily
  console.log("\n聚合 daily.json...");
  const daily = buildDailyFromHourly(hourly);

  // 5. 写回
  console.log("\n写入文件...");
  saveJson(HOURLY_PATH, hourly);
  saveJson(DAILY_PATH, daily);
  console.log(`  ✅ ${HOURLY_PATH}`);
  console.log(`  ✅ ${DAILY_PATH}`);

  // 6. 打印摘要
  const oLabels = hourly.official?.labels ?? [];
  const oPrices = hourly.official?.prices ?? [];
  const cLabels = hourly.classic?.labels ?? [];
  const cPrices = hourly.classic?.prices ?? [];
  const oLatest = oPrices[oPrices.length - 1];
  const cLatest = cPrices[cPrices.length - 1];
  const oLatestLbl = oLabels[oLabels.length - 1];
  const cLatestLbl = cLabels[cLabels.length - 1];
  console.log(`\n=== 摘要 ===`);
  console.log(`  正式服最新: ${oLatest} (${oLatestLbl ? new Date(Number(oLatestLbl) * 1000).toISOString() : "无"})`);
  console.log(`  正式服点数: ${oLabels.length}`);
  console.log(`  怀旧服最新: ${cLatest ?? "无"} (${cLatestLbl ? new Date(Number(cLatestLbl) * 1000).toISOString() : "无"})`);
  console.log(`  怀旧服点数: ${cLabels.length}`);
  console.log(`  总数据量  : ${JSON.stringify(hourly).length} 字节`);
  console.log(`\n完成!\n`);
})();
