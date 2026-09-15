/**
 * 时光徽章数据源可达性测试 (GitHub Actions 环境)
 * ----------------------------------------------------------------------------
   目的: 验证从 GitHub 服务器能不能访问到那几个数据源, 以及返回什么内容。
   不做任何文件写入, 只打印诊断信息到日志。
 */

const SOURCES = [
  {
    name: "chuanghan.top JSON API",
    url: "https://chuanghan.top/api/token/summary",
    note: "纯 JSON 接口, 最干净。期望返回 {count, server, latest_price, ...}",
  },
  {
    name: "jiguanqiang 时光徽章页",
    url: "https://wow.jiguanqiang.net/",
    note: "时光徽章价格主页面(不是股票站!), 含正式服+怀旧服当前价格。",
  },
  {
    name: "wowdata.top 正式服",
    url: "https://wowdata.top/wowtoken_retail",
    note: "后端渲染 HTML, 需按服务器关键词提取价格(如 608946)",
  },
  {
    name: "wowdata.top 怀旧服",
    url: "https://wowdata.top/wowtoken_classic",
    note: "怀旧服价格页面",
  },
];

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function testOne(src) {
  const line = "=".repeat(60);
  console.log("\n" + line);
  console.log("数据源: " + src.name);
  console.log("URL  : " + src.url);
  console.log("说明 : " + src.note);
  console.log(line);

  const start = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);

    const res = await fetch(src.url, {
      headers: { "User-Agent": UA, Accept: "*/*" },
      signal: ctrl.signal,
      redirect: "follow",
    });
    clearTimeout(timer);

    const elapsed = Date.now() - start;
    const text = await res.text();
    const ct = res.headers.get("content-type") || "(无)";

    console.log(`状态码       : ${res.status}`);
    console.log(`耗时         : ${elapsed} ms`);
    console.log(`Content-Type : ${ct}`);
    console.log(`响应长度     : ${text.length} 字符`);

    // 打印前 800 字符, 足够看到关键数据又不刷屏
    const preview = text.slice(0, 800);
    console.log("响应片段(前 800 字符):");
    console.log(preview);

    // 关键字段探测
    const priceMatch = text.match(/(\d{4,})/g);
    if (priceMatch) {
      // 只打印前 5 个 4 位以上数字, 避免刷屏
      console.log(`探测到大数字(前5): ${priceMatch.slice(0, 5).join(", ")}`);
    }

    // 针对 chuanghan JSON, 尝试解析
    if (src.url.includes("/api/token/summary")) {
      try {
        const j = JSON.parse(text);
        console.log("JSON 解析成功:");
        console.log(JSON.stringify(j, null, 2));
      } catch (e) {
        console.log("JSON 解析失败: " + e.message);
      }
    }

    console.log(`\n✅ 可达 — ${src.name}`);
  } catch (err) {
    const elapsed = Date.now() - start;
    console.log(`耗时: ${elapsed} ms`);
    console.log(`❌ 不可达 — ${src.name}`);
    console.log("错误: " + (err && err.message ? err.message : String(err)));
    if (err && err.cause) {
      console.log("原因: " + err.cause);
    }
  }
}

(async () => {
  console.log("环境: Node " + process.version);
  console.log("测试时间: " + new Date().toISOString());
  console.log("测试服务器: GitHub Actions ubuntu-latest");

  for (const src of SOURCES) {
    await testOne(src);
  }

  console.log("\n" + "=".repeat(60));
  console.log("全部测试完成");
  console.log("=".repeat(60));
})();
