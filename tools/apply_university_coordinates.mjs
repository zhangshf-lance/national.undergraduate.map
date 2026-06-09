import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(".");
const DATA_JS = path.join(ROOT, "outputs", "national-undergraduate-map", "data.js");
const CACHE_FILE = path.join(ROOT, "work", "university-coordinate-cache.json");
const README = path.join(ROOT, "outputs", "national-undergraduate-map", "README.md");

function loadDataJs(text) {
  const prefix = "window.UNDERGRAD_MAP_DATA = ";
  if (!text.startsWith(prefix)) throw new Error("Unexpected data.js format");
  return JSON.parse(text.slice(prefix.length).replace(/;\s*$/, ""));
}

function summarize(schools) {
  return {
    high: schools.filter((s) => s.coordinateConfidence === "high").length,
    medium: schools.filter((s) => s.coordinateConfidence === "medium").length,
    low: schools.filter((s) => s.coordinateConfidence === "low").length,
    amap: schools.filter((s) => s.coordinateSource === "amap").length,
    baidu: schools.filter((s) => s.coordinateSource === "baidu").length,
    tianditu: schools.filter((s) => s.coordinateSource === "tianditu").length,
    scatter: schools.filter((s) => s.coordinateSource === "province-scatter").length,
  };
}

const data = loadDataJs(await fs.readFile(DATA_JS, "utf8"));
const cache = JSON.parse(await fs.readFile(CACHE_FILE, "utf8"));

for (const school of data.schools) {
  const entry = cache.schools?.[school.id];
  if (!entry?.selected) {
    school.coordinateConfidence = "low";
    school.coordinateSource = "province-scatter";
    school.coordinateProviders = [];
    school.coordinateScore = 0;
    continue;
  }
  school.point = entry.selected.point;
  school.coordinateConfidence = entry.selected.confidence;
  school.coordinateSource = entry.selected.source;
  school.coordinateProviders = entry.selected.providers || [];
  school.coordinateScore = Math.round(entry.selected.score || 0);
  school.coordinateCandidate = entry.selected.candidate
    ? {
        name: entry.selected.candidate.name,
        address: entry.selected.candidate.address,
        provider: entry.selected.candidate.provider,
        agreementMeters: entry.selected.candidate.agreementMeters,
      }
    : null;
}

data.meta.coordinateCalibration = {
  updatedAt: cache.meta?.updatedAt,
  providersRequested: ["amap", "baidu", "tianditu"],
  providersUsed: ["amap", "tianditu"],
  baiduStatus: "百度 AK 返回 APP IP校验失败，未产生可用候选",
  counts: summarize(data.schools),
  note: "高/中置信坐标来自地图服务检索；低置信坐标保留省级聚合散点。高德坐标已由 GCJ-02 转为 WGS84 近似坐标以匹配网页底图。",
};
data.meta.note = "本页面展示本科层次学校名单。高/中置信点位来自高德、天地图校准；低置信点位保留省级聚合散点，不代表校园精确坐标。";

await fs.writeFile(DATA_JS, `window.UNDERGRAD_MAP_DATA = ${JSON.stringify(data, null, 0)};\n`, "utf8");

const counts = data.meta.coordinateCalibration.counts;
const readme = `# 全国大学本科地图

纯静态网页，可直接打开 \`index.html\` 使用。

- 数据来源：${data.meta.source}
- 数据日期：截至 ${data.meta.asOf}
- 本科院校：${data.meta.total} 所
- 985 高校：${data.meta.rankCounts["985"]} 所；211 高校（不含 985）：${data.meta.rankCounts["211"]} 所
- 坐标校准：高置信 ${counts.high} 所，中置信 ${counts.medium} 所，低置信 ${counts.low} 所
- 地图服务：已使用高德、天地图；百度 AK 返回 APP IP校验失败，未产生可用候选
- 说明：高/中置信坐标来自地图服务检索；低置信点位为省级聚合散点。
`;
await fs.writeFile(README, readme, "utf8");

console.log(JSON.stringify({ total: data.schools.length, coordinateCalibration: data.meta.coordinateCalibration }, null, 2));
