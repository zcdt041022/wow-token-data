/**
 * 时光徽章数据源可达性测试 (GitHub Actions 环境)
 * 目的: 验证从 GitHub 服务器能不能访问到那几个数据源
 * 不做任何文件写入, 只打印诊断信息到日志
 */

const SOURCES = [
  {
    name: "chuanghan.top JSON API",
    url: "https://chuanghan.top/api/token/summary",
  },
  {
    name: "jiguanqiang.net 首页",
    url: "https://jiguanqiang.net",
  },
  {
    name: "wowdata.top 正式服",
    url: "https://wowdata.top/wowtoken_retail",
  },
  {
    name: "wowdata.top 怀旧服",
    url: "https://wowdata.top/wowtoken_classic",
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

    const preview = text.slice(0, 800);
    console.log("响应片段(前 800 字符):");
    console.log(preview);

    const priceMatch = text.match(/(\d{4,})/g);
    if (priceMatch) {
      console.log(`探测到大数字(前5): ${priceMatch.slice(0, 5).join(", ")}`);
    }

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
