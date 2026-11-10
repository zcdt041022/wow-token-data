/**
 * 时光徽章价格定时抓取脚本 (GitHub Actions)
 * ----------------------------------------------------------------------------
   数据源:
     jiguanqiang.net 首页 — 正式服 + 怀旧服(优先, 最实时)
     正式服兜底: wowdata.top HTML (解析价格)
     (chuanghan.top 已停止服务, 其 JSON API 分支已从脚本移除)

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
  // 唯一的正式服兜底源(仅当 jiguanqiang 首页没抓到正式服时才走这里)。
  // chuanghan.top 已停止服务, 其 JSON API 分支已移除。
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
          return { price, ts: NOW_SEC, source: "wowdata" };
        }
        console.log(`  [wowdata] 价格异常(${price}), 忽略`);
      } else {
        console.log("  [wowdata] 页面未匹配到价格");
      }
    } else {
      console.log(`  [wowdata] HTTP ${res.status}`);
    }
  } catch (e) {
    console.log(`  [wowdata] 失败: ${e.message}`);
  }
  console.log("  ⚠️ 正式服兜底源未取到价格");
  return null;
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
// 一次运行要持续约 5 小时, 若等到整轮结束才提交, 这段时间内
// 仓库和桌面端都读不到任何新数据。因此每完成一次采样就同步一次。
//
// ⚠️ 关键设计: hourly.json / daily.json 是纯生成文件, 远端随时有其它 run
// 在推同一个文件。若沿用 "本地 commit → fetch → rebase origin/main",
// 两边都改同一文件的同一区域, rebase 必然文本冲突; 冲突后 abort 会把旧
// commit 留在分支上, 下一轮再 commit 再 rebase, 要重放的还是那个旧 commit,
// 于是永久失败(实测一次 run 内 16/16 全部失败, 一条数据都没进仓库)。
//
// 现在的做法是"重新生成"而不是"文本合并":
//   1. git fetch origin main
//   2. git reset --hard origin/main  (丢弃本地失效 commit, 工作区对齐远端最新)
//   3. 在远端最新内容之上, 把本轮 + 之前积压的全部采样点重新合并进
//      hourly.json, 并由 hourly 重新聚合 daily.json
//   4. git add → commit → push
// 第 2 步不会丢掉别人刚写入的数据: 第 3 步的合并基线正是刚 reset 下来的
// 远端文件, 别人的桶原样保留, 只在其上追加本轮的桶。
// 推送被拒等极端竞态时整轮重来, 但每次重试前都会 reset 丢弃上一次的失效
// commit, 且有硬上限, 不会在分支上无限累积失败提交。
// 仅在 Actions 中生效(AUTO_COMMIT=1), 本地直接跑脚本不会碰 git。

const AUTO_COMMIT = process.env.AUTO_COMMIT === "1";
/** 单轮同步的硬重试上限: 超过就如实失败(不累积失败 commit)。 */
const MAX_PUSH_ATTEMPTS = 3;
let gitIdentityReady = false;
/** 待推送的采样点(跨轮次累积, 推送成功后清空)。 */
const pendingPoints = [];

function git(args) {
  const r = spawnSync("git", args, { encoding: "utf-8" });
  return {
    ok: r.status === 0,
    code: r.status,
    // 失败原因优先取 stderr(push 被拒等提示都在这里), 没有则退回 stdout
    err: (r.stderr || "").trim() || (r.stdout || "").trim(),
  };
}

function ensureIdentity() {
  if (gitIdentityReady) return;
  git(["config", "user.name", "github-actions[bot]"]);
  git(["config", "user.email", "github-actions[bot]@users.noreply.github.com"]);
  gitIdentityReady = true;
}

/**
 * 把待推送的采样点合并进"当前工作区"的 hourly.json, 并重新聚合 daily.json。
 * 调用前工作区必须已对齐远端最新(reset --hard origin/main), 这样合并基线
 * 就是远端内容, 不会把别人这期间写入的桶冲掉。
 * 返回 { changed } — 没有任何新数据(同桶同价)时返回 false, 不产生提交。
 */
function mergeAndWrite(points) {
  console.log("\n加载当前 hourly.json...");
  const existingHourly = loadJson(HOURLY_PATH);
  const existingDaily = loadJson(DAILY_PATH);
  if (existingHourly) {
    console.log(`  official: ${existingHourly.official?.labels?.length ?? 0} 点`);
    console.log(`  classic : ${existingHourly.classic?.labels?.length ?? 0} 点`);
  } else {
    console.log("  hourly.json 不存在, 将创建新文件");
  }

  console.log("\n合并到 hourly.json...");
  let hourly = existingHourly;
  let changed = false;
  for (const { key, point } of points) {
    if (!point) continue;
    const m = mergeIntoHourly(hourly, point, key);
    hourly = m.data;
    changed = changed || m.changed;
  }

  console.log("\n聚合 daily.json...");
  const d = buildDailyFromHourly(hourly, existingDaily);
  changed = changed || d.changed;

  console.log("\n写入文件...");
  if (!changed) {
    console.log("  本次没有新数据, 不写文件(避免空提交)");
    return { changed: false };
  }
  saveJson(HOURLY_PATH, hourly);
  console.log(`  ✅ ${HOURLY_PATH}`);
  if (d.changed) {
    saveJson(DAILY_PATH, d.data);
    console.log(`  ✅ ${DAILY_PATH}`);
  }

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

  return { changed: true };
}

/**
 * 把待推送的采样点同步到 origin/main:
 *   fetch → reset --hard origin/main → 重新合并(本轮+积压) → add → commit → push
 * 每次尝试前都会 reset 到远端最新, 因此本地不会残留失效 commit;
 * 推送成功后一次性推上所有积压采样点(不是只推一个点)。
 * 返回 { ok, committed }; ok=false 时 pendingPoints 保留在内存, 下一轮再推。
 */
function syncAndPush(sampleIdx, total) {
  if (!AUTO_COMMIT) {
    console.log("  [sync] 未设置 AUTO_COMMIT=1, 跳过同步(视为本地运行)");
    return { ok: true, committed: false };
  }
  if (pendingPoints.length === 0) {
    console.log("  [sync] 没有待推送的采样点");
    return { ok: true, committed: false };
  }
  ensureIdentity();

  let lastStage = "unknown";
  let lastReason = "未知原因";
  for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
    console.log(`  [sync] 第 ${attempt}/${MAX_PUSH_ATTEMPTS} 次同步尝试(待推 ${pendingPoints.length} 点)`);

    // 1. 取远端最新
    const fetched = git(["fetch", "origin", "main"]);
    if (!fetched.ok) {
      lastStage = "fetch";
      lastReason = fetched.err || `退出码 ${fetched.code}`;
      console.error(`  [sync] ✗ fetch 失败: ${lastReason}`);
      continue;
    }

    // 2. 丢弃本地失效 commit, 工作区对齐远端最新(数据还在 pendingPoints 里)
    const reset = git(["reset", "--hard", "origin/main"]);
    if (!reset.ok) {
      lastStage = "reset";
      lastReason = reset.err || `退出码 ${reset.code}`;
      console.error(`  [sync] ✗ reset --hard origin/main 失败: ${lastReason}`);
      continue;
    }

    // 3. 在远端最新内容之上重新合并(重新生成而非文本合并, 不会冲突)
    let mw;
    try {
      mw = mergeAndWrite(pendingPoints);
    } catch (e) {
      lastStage = "merge";
      lastReason = e && e.message ? e.message : String(e);
      console.error(`  [sync] ✗ 合并/写文件失败: ${lastReason}`);
      continue;
    }
    if (!mw.changed) {
      console.log("  [sync] 远端已包含这些桶且价格一致, 无需推送");
      pendingPoints.length = 0;
      return { ok: true, committed: false };
    }

    // 4. 提交
    const added = git(["add", "token-data/hourly.json", "token-data/daily.json"]);
    if (!added.ok) {
      lastStage = "add";
      lastReason = added.err || `退出码 ${added.code}`;
      console.error(`  [sync] ✗ git add 失败: ${lastReason}`);
      continue;
    }
    const msg = `auto: token ${pendingPoints.length} 点 (sample ${sampleIdx}/${total}) @ ${new Date().toISOString()}`;
    // 兜一层: 极端情况下重算后的内容与远端逐字节相同, 不要在这里 commit 失败
    const staged = git(["diff", "--cached", "--quiet"]);
    if (staged.code === 0) {
      console.log("  [sync] 重算结果与远端一致(无实际改动), 无需推送");
      pendingPoints.length = 0;
      return { ok: true, committed: false };
    }
    if (staged.code !== 1) {
      lastStage = "diff";
      lastReason = staged.err || `退出码 ${staged.code}`;
      console.error(`  [sync] ✗ git diff --cached 异常: ${lastReason}`);
      continue;
    }
    const made = git(["commit", "-m", msg]);
    if (!made.ok) {
      lastStage = "commit";
      lastReason = made.err || `退出码 ${made.code}`;
      console.error(`  [sync] ✗ git commit 失败: ${lastReason}`);
      continue;
    }
    console.log(`  [sync] ✅ 已提交: ${msg}`);

    // 5. 推送
    const pushed = git(["push", "origin", "HEAD:main"]);
    if (!pushed.ok) {
      lastStage = "push";
      lastReason = pushed.err || `退出码 ${pushed.code}`;
      console.error(`  [sync] ✗ push 被拒/失败: ${lastReason}`);
      continue; // 下一次尝试会 fetch + reset, 丢弃这个已失效的 commit
    }

    pendingPoints.length = 0;
    console.log("  [sync] ✅ 已推送到 origin/main");
    return { ok: true, committed: true };
  }

  console.error(
    `  [sync] ✗ 第 ${sampleIdx}/${total} 轮同步失败(阶段=${lastStage}, 已尝试 ${MAX_PUSH_ATTEMPTS} 次): ${lastReason}`,
  );
  console.error("  [sync] 采样点保留在内存, 下一轮采样时一并重推");
  return { ok: false, committed: false };
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

  // 2. 抓正式服兜底(wowdata), jiguanqiang 已有则跳过
  let officialPoint = null;
  if (jqPrices.official) {
    console.log(`  jiguanqiang 已有正式服 ${jqPrices.official}, 跳过 wowdata 兜底`);
    officialPoint = { price: jqPrices.official, ts: NOW_SEC, source: "jiguanqiang" };
  } else {
    console.log("  jiguanqiang 未抓到正式服, 回退 wowdata...");
    officialPoint = await fetchOfficial();
  }

  const classicPoint = jqPrices.classic
    ? { price: jqPrices.classic, ts: NOW_SEC, source: "jiguanqiang" }
    : null;

  if (!officialPoint && !classicPoint) {
    console.error("  本次采样未抓到任何服务器价格");
    return { ok: false, points: [] };
  }

  // 只负责抓取, 不落盘: 合并写入统一由 mergeAndWrite(在最新远端内容之上)
  // 执行, 避免"本地旧文件 → 提交 → 与远端冲突"的老问题。
  const points = [];
  if (officialPoint) points.push({ key: "official", point: officialPoint });
  if (classicPoint) points.push({ key: "classic", point: classicPoint });
  console.log(
    `  本轮抓取: ${points.map((p) => `${p.key}=${p.point.price}(${p.point.source})`).join(", ")}`,
  );
  return { ok: true, points };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── 主流程: 一次运行内按固定间隔多次采样 ────────────────────────
// GitHub 的 cron 在低活跃仓库上经常被延迟到数小时才触发, 单次采样会让
// hourly.json 的 20 分钟桶出现大片空洞。这里让一次运行持续约 5 小时
// (默认 16 次 × 20 分钟), 配合 workflow 的 concurrency 串行, 上一轮结束后
// 排队的下一轮会立刻接上, 把缺口压到最小。
// 采样起点严格按固定间隔排布(而不是"抓完再睡 20 分钟"), 否则每轮的网络
// 耗时会让采样点持续后移, 累计漂移足以整桶跳过 20 分钟桶。
// 每轮采样结束立即同步到远端(见 syncAndPush), 不必等整轮跑完才落盘。
// 采样次数/间隔可用环境变量 SAMPLES / INTERVAL_SECONDS 调整。
(async () => {
  const samples = Math.max(1, parseInt(process.env.SAMPLES || "8", 10));
  const intervalSec = Math.max(60, parseInt(process.env.INTERVAL_SECONDS || "1200", 10));
  console.log(`一次运行内采样 ${samples} 次, 间隔 ${intervalSec} 秒`);

  let okCount = 0;
  let failCount = 0;
  let syncFailCount = 0;
  for (let i = 0; i < samples; i++) {
    const sampleStartedAt = Date.now();
    console.log(`\n--- 采样 ${i + 1}/${samples} ---`);
    const r = await runOnce();
    if (r.ok) {
      okCount++;
      if (AUTO_COMMIT) pendingPoints.push(...r.points);
    } else {
      failCount++;
    }
    // 每轮采样后立即同步: 拉最新远端 → 在其上重新合并本轮+积压的全部采样点
    // → 提交 → 推送。同步失败时采样点留在内存, 下一轮一并重推。
    if (AUTO_COMMIT) {
      const cm = syncAndPush(i + 1, samples);
      if (!cm.ok) syncFailCount++;
    } else if (r.points.length) {
      // 本地运行: 直接合并写盘, 不碰 git
      mergeAndWrite(r.points);
    }
    if (i < samples - 1) {
      // 以本轮采样起点为基准计算等待时间: 保证相邻采样起点正好相隔
      // intervalSec, 网络耗时不会逐轮累积成漂移。
      const waitMs = sampleStartedAt + intervalSec * 1000 - Date.now();
      if (waitMs > 0) {
        console.log(`等待 ${Math.round(waitMs / 1000)} 秒后进行下一次采样...`);
        await sleep(waitMs);
      } else {
        console.log("本轮采样耗时超过间隔, 立即开始下一次采样");
      }
    }
  }

  console.log(
    `\n=== 采样汇总: 成功 ${okCount}, 失败 ${failCount}, 同步失败 ${syncFailCount}, 共 ${samples} ===`,
  );
  if (pendingPoints.length > 0) {
    console.log(`尚有 ${pendingPoints.length} 个采样点未推送(将被本次运行丢弃, 下一轮重新抓取)`);
  }
  // 任何一次采样没抓到数据、或任何一次同步失败, 都以非 0 退出,
  // 让 Actions 显示为失败, 不把失败伪装成成功。
  if (failCount > 0 || syncFailCount > 0) {
    console.error(
      `存在 ${failCount} 次采样未抓到数据, ${syncFailCount} 次同步失败, 本次运行标记为失败`,
    );
    process.exit(1);
  }
  console.log("全部采样完成\n");
})().catch((e) => {
  console.error(`未捕获异常: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
