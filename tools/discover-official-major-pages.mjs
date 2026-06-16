import fs from "node:fs/promises";

const DATA_JS = "data.js";
const SEEDS_FILE = "tools/official-major-seeds.json";
const OUT_FILE = "tools/official-major-page-candidates.json";

const KEYWORDS = ["学科评估", "优势学科", "一流本科专业", "专业排名", "王牌专业", "本科专业"];

function loadDataJs(text) {
  const prefix = "window.UNDERGRAD_MAP_DATA = ";
  if (!text.startsWith(prefix)) throw new Error("Unexpected data.js format");
  return JSON.parse(text.slice(prefix.length).replace(/;\s*$/, ""));
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.text();
}

async function queryBing(schoolName) {
  const query = encodeURIComponent(`${schoolName} ${KEYWORDS.join(" OR ")} site:edu.cn`);
  const html = await fetchText(`https://www.bing.com/search?q=${query}&count=10`);
  const matches = [...html.matchAll(/<a href="(https?:\/\/[^"]+)"/g)]
    .map((match) => match[1])
    .filter((url) => /edu\.cn/.test(url))
    .filter((url) => !/bing\.com|microsoft\.com/.test(url));
  return uniq(matches).slice(0, 8);
}

const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : 20;
const data = loadDataJs(await fs.readFile(DATA_JS, "utf8"));
const seeds = JSON.parse(await fs.readFile(SEEDS_FILE, "utf8"));
const seeded = new Set((seeds.schools || []).map((school) => school.name));
const schools = data.schools
  .filter((school) => school.rank === "985" || school.rank === "211" || (school.tags || []).includes("211"))
  .filter((school) => !seeded.has(school.name))
  .slice(0, limit);

const output = {
  generatedAt: new Date().toISOString(),
  keywords: KEYWORDS,
  schools: {},
  errors: [],
};

for (const school of schools) {
  try {
    output.schools[school.name] = await queryBing(school.name);
    await new Promise((resolve) => setTimeout(resolve, 800));
  } catch (error) {
    output.errors.push({ school: school.name, error: error.message });
  }
}

await fs.writeFile(OUT_FILE, JSON.stringify(output, null, 2), "utf8");
console.log(JSON.stringify({
  schools: Object.keys(output.schools).length,
  urls: Object.values(output.schools).reduce((sum, urls) => sum + urls.length, 0),
  errors: output.errors.length,
  out: OUT_FILE,
}, null, 2));
