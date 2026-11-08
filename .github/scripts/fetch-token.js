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
const { spawnSync } = require("child_process");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const BIN = 20 * 60 * 1000; // 20 分钟一个桶
const RETAIN_MS = 35 * 24 * 3600 * 1000; // 保留 35 天
// 一次运行内会多次采样, 每次采样前用 setNow() 刷新
let NOW_MS = Date.now();
let NOW_SEC = Math.floor(NOW_MS / 1000);

function setNow(ms) {
  NOW_MS = ms;
  NOW_SEC = Math.floor(ms / 1000);
}

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

  // 固定优先级: wowdata > chuanghan
  // 理由: chuanghan.top 是插件收集数据, 有约 40 分钟滞后; 它的 latest_time
  //       字段是 API 响应时间而非数据时间, 不能用 ts 排序判断新鲜度。
  //       wowdata.top 接近实时, 与官方价格一致, 应优先采用。
  const PRIORITY = ["wowdata", "chuanghan"];
  for (const src of PRIORITY) {
    const hit = results.find((r) => r.source === src);
    if (hit) {
      console.log(`  [selected] 正式服 选用 ${src} price=${hit.price}`);
      return hit;
    }
  }
  return results[0];
}

// ── 第 1b 步: 从 jiguanqiang.net 同时抓正式服 + 怀旧服价格 ──────
// 页面 HTML 结构(按 token5 div 分块):
//   <div class="token5">
//     <div class="top">国服·地心之战</div>
//     <div class="middle"> 614462 <img ...></div>
//     <div class="bottom">更新于：2 分 47 秒前</div>
//   </div>
//   <div class="token5">
//     <div class="top">国服·熊猫人之谜</div>
//     <div class="middle"> 436863 <img ...></div>
//     <div class="bottom">更新于：2 分 47 秒前</div>
//   </div>
async function fetchJqSnapshot() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch("https://wow.jiguanqiang.net/", {
      headers: {
        "User-Agent": UA,
        "Referer": "https://wow.jiguanqiang.net/",
      },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.log(`  [jiguanqiang] HTTP ${res.status}, 跳过`);
      return {};
    }
    const html = await res.text();

    // 按 token5 div 分块(正则匹配, 兼容不同引号/空格/缩进)
    const token5Re = /<div[^>]*class\s*=\s*['"]([^'"]*token5[^'"]*)['"][^>]*>/gi;
    const tagPositions = [];
    let m;
    while ((m = token5Re.exec(html)) !== null) {
      tagPositions.push({ start: m.index, end: m.index + m[0].length });
    }
    console.log(`  [jiguanqiang] 找到 ${tagPositions.length} 个 token5 div`);

    const prices = {}; // { official: 561323, classic: 476767 }
    for (let i = 0; i < tagPositions.length; i++) {
      const blockStart = tagPositions[i].start;
      const blockEnd = i + 1 < tagPositions.length ? tagPositions[i + 1].start : html.length;
      const block = html.slice(blockStart, blockEnd);

      // 去掉 HTML 标签, 得到纯文本
      const text = block.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

      let role = null;
      if (text.includes("国服") && text.includes("地心之战")) {
        role = "official";
      } else if (text.includes("国服") && (text.includes("熊猫人之谜") || text.includes("怀旧"))) {
        role = "classic";
      }

      if (role) {
        // 文本里第一个 5-6 位数就是价格
        const priceMatch = text.match(/\b(\d{5,6})\b/);
        if (priceMatch) {
          prices[role] = parseInt(priceMatch[1], 10);
          console.log(`  [jiguanqiang] ${role} price=${prices[role]} ts=${NOW_SEC} (块${i})`);
        } else {
          console.log(`  [jiguanqiang] ${role} 块未找到价格, 文本="${text.slice(0, 80)}..."`);
        }
      } else {
        console.log(`  [jiguanqiang] 块${i} 非目标服务器, 文本="${text.slice(0, 80)}..."`);
      }
    }

    if (Object.keys(prices).length === 0) {
      console.log("  [jiguanqiang] 未匹配到任何时光徽章价格");
    } else {
      console.log(`  [jiguanqiang] 共抓到 ${Object.keys(prices).length} 个服:`, prices);
    }
    return prices;
  } catch (e) {
    console.log(`  [jiguanqiang] 失败: ${e.message}`);
    return {};
  }
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

// ── 每轮采样后立即提交 ──────────────────────────────────────────
// 一次运行要持续约 140 分钟, 若等到整轮结束才提交, 这 140 分钟内
// 仓库和桌面端都读不到任何新数据。因此每完成一次采样就提交一次,
// 让 20 分钟桶"边采边落"; 提交失败不吞掉, 由主循环计入失败次数。
// 仅在 Actions 中生效(AUTO_COMMIT=1), 本地直接跑脚本不会碰 git。

const AUTO_COMMIT = process.env.AUTO_COMMIT === "1";
let gitIdentityReady = false;
// 上一轮提交没能推上去时置 true, 下一轮即使没有新数据也会重试推送
let pendingPush = false;

function git(args) {
  const r = spawnSync("git", args, { encoding: "utf-8" });
  return {
    ok: r.status === 0,
    code: r.status,
    err: (r.stderr || "").trim(),
  };
}

function ensureIdentity() {
  if (gitIdentityReady) return;
  git(["config", "user.name", "github-actions[bot]"]);
  git(["config", "user.email", "github-actions[bot]@users.noreply.github.com"]);
  gitIdentityReady = true;
}

/**
 * 提交本轮到手的部分并推送。
 * 返回 { ok, committed }: ok=false 表示提交/同步/推送失败(已在日志里说明原因),
 * 主循环据此把整次运行标红; 失败的提交会留在本地, 下一轮自动补推。
 */
function commitAndPush(sampleIdx, total) {
  if (!AUTO_COMMIT) {
    console.log("  [commit] 未设置 AUTO_COMMIT=1, 跳过提交(视为本地运行)");
    return { ok: true, committed: false };
  }
  ensureIdentity();

  const add = git(["add", "token-data/hourly.json", "token-data/daily.json"]);
  if (!add.ok) {
    console.error(`  [commit] git add 失败: ${add.err}`);
    return { ok: false, committed: false };
  }

  // git diff --cached --quiet: 退出码 0 = 没有暂存改动, 1 = 有改动
  const staged = git(["diff", "--cached", "--quiet"]);
  if (staged.code !== 0 && staged.code !== 1) {
    console.error(`  [commit] git diff 异常退出(${staged.code}): ${staged.err}`);
    return { ok: false, committed: false };
  }
  let committed = false;
  if (staged.code === 1) {
    // 提交信息带采样序号与时间, 8 轮最多 8 条, 便于回溯
    const msg = `auto: token sample ${sampleIdx}/${total} @ ${new Date().toISOString()}`;
    const c = git(["commit", "-m", msg]);
    if (!c.ok) {
      console.error(`  [commit] git commit 失败: ${c.err}`);
      return { ok: false, committed: false };
    }
    committed = true;
    console.log(`  [commit] ✅ 已提交: ${msg}`);
  } else if (!pendingPush) {
    console.log("  [commit] 本轮无新数据, 不提交");
    return { ok: true, committed: false };
  }

  // 用 fetch + rebase 而不是 pull, 在 detached HEAD 下同样可用
  const fetched = git(["fetch", "origin", "main"]);
  if (!fetched.ok) {
    console.error(`  [commit] git fetch 失败: ${fetched.err}; 提交留在本地, 下一轮重试`);
    pendingPush = true;
    return { ok: false, committed };
  }
  const rebased = git(["rebase", "origin/main"]);
  if (!rebased.ok) {
    git(["rebase", "--abort"]);
    console.error(`  [commit] rebase 失败: ${rebased.err}; 已回滚, 提交留在本地, 下一轮重试`);
    pendingPush = true;
    return { ok: false, committed };
  }
  const pushed = git(["push", "origin", "HEAD:main"]);
  if (!pushed.ok) {
    console.error(`  [commit] git push 失败: ${pushed.err}; 提交留在本地, 下一轮重试`);
    pendingPush = true;
    return { ok: false, committed };
  }
  pendingPush = false;
  console.log("  [commit] ✅ 已推送到 origin/main");
  return { ok: true, committed };
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
  let changed = false;

  if (newPoint) {
    const bucketMs = Math.floor(newPoint.ts * 1000 / BIN) * BIN;
    const bucketSec = Math.floor(bucketMs / 1000);
    const bucketLabel = String(bucketSec);

    const idx = labels.indexOf(bucketLabel);
    if (idx >= 0) {
      if (prices[idx] !== newPoint.price) {
        prices[idx] = newPoint.price;
        changed = true;
        console.log(`  [${key}] 更新桶 ${bucketLabel} = ${newPoint.price}`);
      } else {
        console.log(`  [${key}] 桶 ${bucketLabel} 价格未变 (${newPoint.price}), 不算新数据`);
      }
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
      changed = true;
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
    changed = true;
  } else {
    data[key].labels = labels;
    data[key].prices = prices;
  }

  data.granularity = "hourly";
  // 只有真正产生新数据(新桶/价格变化/截断)才动 updated_at,
  // 否则"没抓到新数据"会被伪装成一次成功更新并产生提交。
  if (changed) {
    data.updated_at = new Date(NOW_MS).toISOString();
  }
  return { data, changed };
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
function buildDailyFromHourly(hourly, existingDaily) {
  const daily = {
    official: { labels: [], prices: [] },
    classic: { labels: [], prices: [] },
    granularity: "daily",
    updated_at: "",
  };
  let changed = false;

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

    // 与现存 daily 对比, 只在内容真变了才算改动
    const old = existingDaily?.[key];
    const same =
      Array.isArray(old?.labels) &&
      old.labels.length === daily[key].labels.length &&
      old.labels.every((l, i) => String(l) === daily[key].labels[i] && old.prices?.[i] === daily[key].prices[i]);
    if (!same) changed = true;
  }

  if (changed) {
    daily.updated_at = new Date(NOW_MS).toISOString();
  } else if (existingDaily?.updated_at) {
    daily.updated_at = existingDaily.updated_at;
  }
  return { data: daily, changed };
}

// ── 主流程 ─────────────────────────────────────────────────────

// ── 单次采样 ───────────────────────────────────────────────────

async function runOnce() {
  setNow(Date.now());
  console.log(`\n=== 时光徽章采样 ${new Date(NOW_MS).toISOString()} ===\n`);

  // 1. 先抓 jiguanqiang(同时覆盖正式服+怀旧服两个服, 数据最实时)
  console.log("从 jiguanqiang.net 抓时光徽章价格...");
  const jqPrices = await fetchJqSnapshot();

  // 2. 抓正式服备用(chuanghan / wowdata, jiguanqiang 已有则跳过)
  let officialPoint = null;
  if (jqPrices.official) {
    console.log(`  jiguanqiang 已有正式服 ${jqPrices.official}, 跳过 chuanghan/wowdata`);
    officialPoint = { price: jqPrices.official, ts: NOW_SEC, source: "jiguanqiang" };
  } else {
    console.log("  jiguanqiang 未抓到正式服, 回退 chuanghan/wowdata...");
    officialPoint = await fetchOfficial();
  }

  const classicPoint = jqPrices.classic
    ? { price: jqPrices.classic, ts: NOW_SEC, source: "jiguanqiang" }
    : null;

  if (!officialPoint && !classicPoint) {
    console.error("  本次采样未抓到任何服务器价格");
    return { ok: false };
  }

  // 3. 加载现有 hourly.json
  console.log("\n加载现有 hourly.json...");
  const existingHourly = loadJson(HOURLY_PATH);
  const existingDaily = loadJson(DAILY_PATH);
  if (existingHourly) {
    console.log(`  official: ${existingHourly.official?.labels?.length ?? 0} 点`);
    console.log(`  classic : ${existingHourly.classic?.labels?.length ?? 0} 点`);
  } else {
    console.log("  hourly.json 不存在, 将创建新文件");
  }

  // 4. 合并到 hourly
  console.log("\n合并到 hourly.json...");
  let hourly = existingHourly;
  let changed = false;
  const o = mergeIntoHourly(hourly, officialPoint, "official");
  hourly = o.data;
  changed = changed || o.changed;
  const c = mergeIntoHourly(hourly, classicPoint, "classic");
  hourly = c.data;
  changed = changed || c.changed;

  // 5. 从 hourly 聚合 daily
  console.log("\n聚合 daily.json...");
  const d = buildDailyFromHourly(hourly, existingDaily);
  changed = changed || d.changed;

  // 6. 写回: 没产生新数据就不写文件, 让 workflow 的提交步骤自然跳过
  console.log("\n写入文件...");
  if (!changed) {
    console.log("  本次没有新数据, 不写文件(避免空提交)");
  } else {
    saveJson(HOURLY_PATH, hourly);
    console.log(`  ✅ ${HOURLY_PATH}`);
    if (d.changed) {
      saveJson(DAILY_PATH, d.data);
      console.log(`  ✅ ${DAILY_PATH}`);
    }
  }

  // 7. 打印摘要
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

  return { ok: true };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── 主流程: 一次运行内按固定间隔多次采样 ────────────────────────
// GitHub 的 cron 在低活跃仓库上经常被延迟到数小时才触发, 单次采样会让
// hourly.json 的 20 分钟桶出现大片空洞。这里让一次运行持续约 2.5 小时
// (默认 8 次 × 20 分钟), 配合 workflow 的 concurrency 串行, 把缺口压到最小。
// 每轮采样结束立即提交并推送(见 commitAndPush), 不必等整轮跑完才落盘。
// 采样次数/间隔可用环境变量 SAMPLES / INTERVAL_SECONDS 调整。
(async () => {
  const samples = Math.max(1, parseInt(process.env.SAMPLES || "8", 10));
  const intervalSec = Math.max(60, parseInt(process.env.INTERVAL_SECONDS || "1200", 10));
  console.log(`一次运行内采样 ${samples} 次, 间隔 ${intervalSec} 秒`);

  let okCount = 0;
  let failCount = 0;
  let commitFailCount = 0;
  for (let i = 0; i < samples; i++) {
    console.log(`\n--- 采样 ${i + 1}/${samples} ---`);
    const r = await runOnce();
    if (r.ok) okCount++;
    else failCount++;
    // 每轮采样后立即提交(失败轮次也会重试上次没推上去的提交),
    // 让 20 分钟桶在 140 分钟的运行过程中就能被仓库/桌面端读到。
    const cm = commitAndPush(i + 1, samples);
    if (!cm.ok) commitFailCount++;
    if (i < samples - 1) {
      console.log(`等待 ${intervalSec} 秒后进行下一次采样...`);
      await sleep(intervalSec * 1000);
    }
  }

  console.log(
    `\n=== 采样汇总: 成功 ${okCount}, 失败 ${failCount}, 提交/推送失败 ${commitFailCount}, 共 ${samples} ===`,
  );
  // 任何一次采样没抓到数据、或任何一次提交/推送失败, 都以非 0 退出,
  // 让 Actions 显示为失败, 不把失败伪装成成功。
  if (failCount > 0 || commitFailCount > 0) {
    console.error(
      `存在 ${failCount} 次采样未抓到数据, ${commitFailCount} 次提交/推送失败, 本次运行标记为失败`,
    );
    process.exit(1);
  }
  console.log("全部采样完成\n");
})().catch((e) => {
  console.error(`未捕获异常: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
