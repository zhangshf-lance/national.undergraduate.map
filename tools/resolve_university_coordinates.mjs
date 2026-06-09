import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(".");
const DATA_JS = path.join(ROOT, "outputs", "national-undergraduate-map", "data.js");
const CACHE_FILE = path.join(ROOT, "work", "university-coordinate-cache.json");

const AMAP_KEY = process.env.AMAP_KEY || "";
const BAIDU_AK = process.env.BAIDU_AK || "";
const TIANDITU_KEY = process.env.TIANDITU_KEY || "";
const disabledProviders = new Set();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadDataJs(text) {
  const prefix = "window.UNDERGRAD_MAP_DATA = ";
  if (!text.startsWith(prefix)) throw new Error("Unexpected data.js format");
  return JSON.parse(text.slice(prefix.length).replace(/;\s*$/, ""));
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function fetchJson(url, retries = 2, headers = {}) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
          ...headers,
        },
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);
      return JSON.parse(text);
    } catch (error) {
      if (attempt === retries) throw error;
      await sleep(500 + attempt * 700);
    }
  }
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function distanceMeters(a, b) {
  if (!a || !b) return Infinity;
  const earth = 6371000;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earth * Math.asin(Math.sqrt(x));
}

function outOfChina(lng, lat) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x, y) {
  let ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  ret += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3;
  ret += ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3;
  return ret;
}

function transformLng(x, y) {
  let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  ret += ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3;
  ret += ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3;
  return ret;
}

function gcj02ToWgs84(lng, lat) {
  if (outOfChina(lng, lat)) return [lng, lat];
  const a = 6378245.0;
  const ee = 0.00669342162296594323;
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((a * (1 - ee)) / (magic * sqrtMagic)) * Math.PI);
  dLng = (dLng * 180.0) / ((a / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return [Number((lng - dLng).toFixed(6)), Number((lat - dLat).toFixed(6))];
}

function bd09ToGcj02(lng, lat) {
  const x = lng - 0.0065;
  const y = lat - 0.006;
  const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * Math.PI * 3000.0 / 180.0);
  const theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * Math.PI * 3000.0 / 180.0);
  return [Number((z * Math.cos(theta)).toFixed(6)), Number((z * Math.sin(theta)).toFixed(6))];
}

function parseLngLat(value) {
  if (!value) return null;
  if (Array.isArray(value)) return [Number(value[0]), Number(value[1])];
  if (typeof value === "string") {
    const parts = value.split(",").map(Number);
    if (parts.length >= 2 && parts.every(Number.isFinite)) return [parts[0], parts[1]];
  }
  if (typeof value === "object") {
    const lng = Number(value.lng ?? value.lon ?? value.x);
    const lat = Number(value.lat ?? value.y);
    if (Number.isFinite(lng) && Number.isFinite(lat)) return [lng, lat];
  }
  return null;
}

function normalizeName(text) {
  return String(text || "")
    .replace(/[（）()]/g, "")
    .replace(/校区|学院路|大学城/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function baseScore(school, candidate) {
  const target = normalizeName(school.name);
  const name = normalizeName(candidate.name);
  const address = normalizeName(`${candidate.address || ""} ${candidate.area || ""}`);
  let score = 0;
  if (name === target) score += 62;
  else if (name.includes(target) || target.includes(name)) score += 48;
  else {
    const core = target.replace(/大学$/, "");
    if (core && name.includes(core)) score += 28;
  }
  if (candidate.city && String(candidate.city).includes(school.city.replace(/市$/, ""))) score += 14;
  if (address.includes(normalizeName(school.city.replace(/市$/, "")))) score += 7;
  if (candidate.province && String(candidate.province).includes(school.province.replace(/省|市|自治区|壮族|回族|维吾尔/g, ""))) score += 7;
  if (/大学|学院|学校|校区|高校|高等/.test(`${candidate.name}${candidate.address}${candidate.type || ""}`)) score += 8;
  return Math.min(score, 100);
}

function bestCandidate(school, provider, candidates) {
  const scored = candidates
    .filter((c) => c.point && Number.isFinite(c.point[0]) && Number.isFinite(c.point[1]))
    .map((c) => ({ ...c, provider, baseScore: baseScore(school, c) }))
    .sort((a, b) => b.baseScore - a.baseScore);
  return scored[0] || null;
}

async function queryAmap(school) {
  if (!AMAP_KEY) return [];
  const params = new URLSearchParams({
    key: AMAP_KEY,
    keywords: school.name,
    city: school.city,
    citylimit: "true",
    offset: "10",
    page: "1",
    extensions: "base",
  });
  const json = await fetchJson(`https://restapi.amap.com/v3/place/text?${params}`);
  return (json.pois || []).map((poi) => {
    const gcj = parseLngLat(poi.location);
    return {
      name: poi.name,
      address: poi.address,
      city: poi.cityname,
      province: poi.pname,
      type: poi.type,
      point: gcj ? gcj02ToWgs84(gcj[0], gcj[1]) : null,
      rawPoint: gcj,
      coordSystem: "GCJ-02",
    };
  });
}

async function queryBaidu(school) {
  if (!BAIDU_AK || disabledProviders.has("baidu")) return [];
  const params = new URLSearchParams({
    query: school.name,
    region: school.city,
    city_limit: "true",
    output: "json",
    ak: BAIDU_AK,
    ret_coordtype: "gcj02ll",
    scope: "2",
  });
  const json = await fetchJson(`https://api.map.baidu.com/place/v2/search?${params}`);
  if (json.status && json.status !== 0) {
    if (Number(json.status) === 210) disabledProviders.add("baidu");
    throw new Error(`Baidu status ${json.status}: ${json.message || "unknown"}`);
  }
  return (json.results || []).map((item) => {
    const raw = parseLngLat(item.location);
    let point = null;
    if (raw) point = gcj02ToWgs84(raw[0], raw[1]);
    return {
      name: item.name,
      address: item.address,
      city: item.city,
      province: item.province,
      type: item.detail_info?.tag,
      point,
      rawPoint: raw,
      coordSystem: "GCJ-02",
    };
  });
}

async function queryTianditu(school) {
  if (!TIANDITU_KEY) return [];
  const postStr = JSON.stringify({
    keyWord: school.name,
    queryType: 12,
    start: 0,
    count: 10,
    specify: school.city,
  });
  const params = new URLSearchParams({ postStr, type: "query", tk: TIANDITU_KEY });
  const json = await fetchJson(`https://api.tianditu.gov.cn/v2/search?${params}`, 2, {
    referer: "https://www.tianditu.gov.cn/",
    origin: "https://www.tianditu.gov.cn",
  });
  if (json.status && json.status.infocode && Number(json.status.infocode) !== 1000) {
    throw new Error(`Tianditu status ${json.status.infocode}: ${json.status.cndesc || "unknown"}`);
  }
  const pois = json.pois || json.suggests || [];
  return pois.map((poi) => {
    const point = parseLngLat(poi.lonlat || poi.location);
    return {
      name: poi.name,
      address: poi.address || poi.addressMsg,
      city: poi.city || school.city,
      province: poi.province,
      type: poi.poiType,
      point: point ? [Number(point[0].toFixed(6)), Number(point[1].toFixed(6))] : null,
      rawPoint: point,
      coordSystem: "CGCS2000/WGS84",
    };
  });
}

function chooseCoordinate(school, providerResults, fallbackPoint) {
  const candidates = Object.entries(providerResults)
    .map(([provider, results]) => bestCandidate(school, provider, results))
    .filter(Boolean)
    .filter((candidate) => candidate.baseScore >= 45);

  if (!candidates.length) {
    return {
      point: fallbackPoint,
      confidence: "low",
      score: 0,
      source: "province-scatter",
      providers: [],
      reason: "no reliable provider match",
    };
  }

  const enriched = candidates.map((candidate) => {
    const agreements = candidates
      .filter((other) => other.provider !== candidate.provider)
      .map((other) => distanceMeters(candidate.point, other.point))
      .filter(Number.isFinite);
    const closeCount = agreements.filter((d) => d <= 2500).length;
    const nearCount = agreements.filter((d) => d <= 8000).length;
    const agreementScore = closeCount * 22 + nearCount * 10;
    return {
      ...candidate,
      agreementMeters: agreements.length ? Math.round(Math.min(...agreements)) : null,
      finalScore: Math.min(100, candidate.baseScore + agreementScore),
    };
  }).sort((a, b) => b.finalScore - a.finalScore);

  const best = enriched[0];
  const confidence = best.finalScore >= 85 && enriched.length >= 2
    ? "high"
    : best.finalScore >= 68
      ? "medium"
      : "low";

  if (confidence === "low") {
    return {
      point: fallbackPoint,
      confidence,
      score: best.finalScore,
      source: "province-scatter",
      providers: enriched.map((c) => c.provider),
      reason: "provider match did not reach confidence threshold",
      candidate: summarizeCandidate(best),
    };
  }

  return {
    point: best.point,
    confidence,
    score: best.finalScore,
    source: best.provider,
    providers: enriched.map((c) => c.provider),
    candidate: summarizeCandidate(best),
  };
}

function summarizeCandidate(candidate) {
  return {
    provider: candidate.provider,
    name: candidate.name,
    address: candidate.address || "",
    city: candidate.city || "",
    province: candidate.province || "",
    point: candidate.point,
    baseScore: candidate.baseScore,
    finalScore: candidate.finalScore,
    agreementMeters: candidate.agreementMeters,
  };
}

async function resolveOne(school, cache) {
  const cached = cache.schools[school.id];
  if (cached && cached.name === school.name && cached.version === 4) return cached;

  const providerResults = {};
  for (const [name, query] of [
    ["amap", queryAmap],
    ["baidu", queryBaidu],
    ["tianditu", queryTianditu],
  ]) {
    try {
      providerResults[name] = await query(school);
      await sleep(110);
    } catch (error) {
      providerResults[name] = [];
      cache.errors.push({ id: school.id, name: school.name, provider: name, error: error.message });
    }
  }

  const selected = chooseCoordinate(school, providerResults, school.point);
  return {
    version: 4,
    id: school.id,
    name: school.name,
    city: school.city,
    province: school.province,
    selected,
    providers: Object.fromEntries(
      Object.entries(providerResults).map(([provider, results]) => [
        provider,
        results.slice(0, 5).map((result) => ({
          name: result.name,
          address: result.address || "",
          city: result.city || "",
          province: result.province || "",
          type: result.type || "",
          point: result.point,
          baseScore: baseScore(school, result),
        })),
      ]),
    ),
    updatedAt: new Date().toISOString(),
  };
}

async function main() {
  const limit = Number(process.argv.find((arg) => arg.startsWith("--limit="))?.split("=")[1] || "0");
  const onlyLow = process.argv.includes("--only-low");
  const data = loadDataJs(await fs.readFile(DATA_JS, "utf8"));
  const cache = await readJson(CACHE_FILE, { meta: {}, schools: {}, errors: [] });
  cache.meta = {
    updatedAt: new Date().toISOString(),
    providers: {
      amap: Boolean(AMAP_KEY),
      baidu: Boolean(BAIDU_AK),
      tianditu: Boolean(TIANDITU_KEY),
    },
  };
  cache.errors = cache.errors || [];
  cache.schools = cache.schools || {};

  let schools = data.schools;
  if (onlyLow) {
    schools = schools.filter((school) => {
      const cached = cache.schools[school.id];
      return !cached || cached.selected?.confidence === "low";
    });
  }
  if (limit > 0) schools = schools.slice(0, limit);

  let done = 0;
  for (const school of schools) {
    const result = await resolveOne(school, cache);
    cache.schools[school.id] = result;
    done += 1;
    if (done % 10 === 0) {
      await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
      const stats = summarize(cache);
      console.log(JSON.stringify({ done, total: schools.length, stats }, null, 0));
    }
  }
  await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
  console.log(JSON.stringify({ done, total: schools.length, stats: summarize(cache) }, null, 2));
}

function summarize(cache) {
  const values = Object.values(cache.schools || {});
  return {
    total: values.length,
    high: values.filter((v) => v.selected?.confidence === "high").length,
    medium: values.filter((v) => v.selected?.confidence === "medium").length,
    low: values.filter((v) => v.selected?.confidence === "low").length,
    amap: values.filter((v) => v.selected?.source === "amap").length,
    baidu: values.filter((v) => v.selected?.source === "baidu").length,
    tianditu: values.filter((v) => v.selected?.source === "tianditu").length,
  };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
