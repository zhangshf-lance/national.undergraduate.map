import fs from "node:fs/promises";

const SEEDS_FILE = "tools/official-major-seeds.json";
const OUT_FILE = "tools/official-major-profiles.json";

const RANK_ORDER = new Map([
  ["A+", 0],
  ["A", 1],
  ["A-", 2],
  ["B+", 3],
  ["B", 4],
  ["B-", 5],
  ["国家级一流本科专业", 10],
  ["一流本科专业", 11],
  ["优势专业", 12],
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchText(url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
        },
      });
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return decodeText(buffer);
    } catch (error) {
      if (attempt === retries) throw error;
      await sleep(600 + attempt * 700);
    }
  }
}

function decodeText(buffer) {
  const utf8 = buffer.toString("utf8");
  if (!/�/.test(utf8.slice(0, 2000))) return utf8;
  return buffer.toString("latin1");
}

function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function extractProfiles(text) {
  const profiles = new Map();
  const clean = text.replace(/[，,、；;]/g, " ");

  for (const match of clean.matchAll(/([\u4e00-\u9fa5A-Za-z0-9·（）()]{2,30})\s*(A\+|A-|A)\b/g)) {
    addProfile(profiles, match[1], match[2], "官网页面提取：学科评估等级");
  }

  const nationalPattern = /([\u4e00-\u9fa5A-Za-z0-9·（）()]{2,30})\s*(?:专业)?\s*(?:入选|获批|为|是)?\s*国家级一流本科专业/g;
  for (const match of clean.matchAll(nationalPattern)) {
    addProfile(profiles, match[1], "国家级一流本科专业", "官网页面提取：国家级一流本科专业");
  }

  const firstClassPattern = /([\u4e00-\u9fa5A-Za-z0-9·（）()]{2,30})\s*(?:专业)?\s*(?:入选|获批|为|是)?\s*(?:省级)?一流本科专业/g;
  for (const match of clean.matchAll(firstClassPattern)) {
    addProfile(profiles, match[1], "一流本科专业", "官网页面提取：一流本科专业");
  }

  return [...profiles.values()]
    .filter((item) => isLikelyMajorName(item.name))
    .sort((a, b) => rankScore(a.rank) - rankScore(b.rank) || a.name.localeCompare(b.name, "zh-CN"))
    .slice(0, 30);
}

function addProfile(profiles, rawName, rank, source) {
  const name = normalizeMajorName(rawName);
  if (!isLikelyMajorName(name)) return;
  const existing = profiles.get(name);
  if (!existing || rankScore(rank) < rankScore(existing.rank)) {
    profiles.set(name, { name, rank, source });
  }
}

function normalizeMajorName(name) {
  return String(name || "")
    .replace(/^(其中|拥有|获评|学校|学院|本科|专业|建设|国家|教育部|第四轮|第五轮|学科评估|在|的|和)+/, "")
    .replace(/(等|专业|学科|一级学科)$/g, "")
    .replace(/[()（）]/g, "")
    .trim();
}

function isLikelyMajorName(name) {
  if (!name || name.length < 2 || name.length > 24) return false;
  if (/学校|大学|学院|官网|首页|招生|教育部|第四轮|第五轮|排名|评估|国家级|一流|本科|专业建设|点击|查看/.test(name)) return false;
  return /[\u4e00-\u9fa5]/.test(name);
}

function rankScore(rank) {
  return RANK_ORDER.get(rank) ?? 99;
}

const seeds = JSON.parse(await fs.readFile(SEEDS_FILE, "utf8"));
const output = {
  generatedAt: new Date().toISOString(),
  source: "official university websites",
  schools: {},
  errors: [],
};

for (const school of seeds.schools || []) {
  const collected = new Map();
  for (const url of school.urls || []) {
    try {
      const html = await fetchText(url);
      const text = htmlToText(html);
      const profiles = extractProfiles(text);
      for (const profile of profiles) {
        const key = profile.name;
        if (!collected.has(key) || rankScore(profile.rank) < rankScore(collected.get(key).rank)) {
          collected.set(key, { ...profile, url });
        }
      }
      await sleep(400);
    } catch (error) {
      output.errors.push({ school: school.name, url, error: error.message });
    }
  }
  output.schools[school.name] = [...collected.values()]
    .sort((a, b) => rankScore(a.rank) - rankScore(b.rank) || a.name.localeCompare(b.name, "zh-CN"));
}

await fs.writeFile(OUT_FILE, JSON.stringify(output, null, 2), "utf8");
console.log(JSON.stringify({
  schools: Object.keys(output.schools).length,
  profiles: Object.values(output.schools).reduce((sum, items) => sum + items.length, 0),
  errors: output.errors.length,
  out: OUT_FILE,
}, null, 2));
