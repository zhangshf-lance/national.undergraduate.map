import fs from "node:fs/promises";

const DATA_JS = "data.js";
const CACHE_FILE = "tools/university-coordinate-cache.json";
const AMAP_KEY = process.env.AMAP_KEY || "";
const TIANDITU_KEY = process.env.TIANDITU_KEY || process.env.TIANDITU_TK || "";

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
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36",
          ...headers,
        },
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
      return JSON.parse(text);
    } catch (error) {
      if (attempt === retries) throw error;
      await sleep(600 + attempt * 800);
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

function normalizeName(value) {
  return String(value || "")
    .replace(/[（(].*?[）)]/g, "")
    .replace(/大学|学院|职业技术大学|科技学院|理工学院|医学院|师范学院|校区|学校/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function scoreCandidate(school, candidate) {
  const target = normalizeName(school.name);
  const name = normalizeName(candidate.name);
  const address = normalizeName(candidate.address);
  let score = 0;
  if (candidate.name === school.name) score += 64;
  else if (name && target && (name.includes(target) || target.includes(name))) score += 52;
  else if (target && address.includes(target)) score += 34;
  if (candidate.city && String(candidate.city).includes(school.city.replace(/[市州地区]/g, ""))) score += 14;
  if (candidate.province && String(candidate.province).includes(school.province.replace(/省|市|自治区|壮族|回族|维吾尔/g, ""))) score += 10;
  if (/大学|学院|学校|校区|高校|军医|国防/.test(`${candidate.name}${candidate.address}${candidate.type || ""}`)) score += 10;
  return Math.min(score, 100);
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
      provider: "amap",
      name: poi.name,
      address: poi.address,
      city: poi.cityname,
      province: poi.pname,
      type: poi.type,
      point: gcj ? gcj02ToWgs84(gcj[0], gcj[1]) : null,
      rawPoint: gcj,
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
  const pois = json.pois || json.suggests || [];
  return pois.map((poi) => {
    const point = parseLngLat(poi.lonlat || poi.location);
    return {
      provider: "tianditu",
      name: poi.name,
      address: poi.address || poi.addressMsg,
      city: poi.city || school.city,
      province: poi.province,
      type: poi.poiType,
      point: point ? [Number(point[0].toFixed(6)), Number(point[1].toFixed(6))] : null,
      rawPoint: point,
    };
  });
}

function chooseCoordinate(school, candidates, fallbackSelected) {
  const usable = candidates
    .filter((c) => c.point && Number.isFinite(c.point[0]) && Number.isFinite(c.point[1]))
    .map((c) => ({ ...c, baseScore: scoreCandidate(school, c) }))
    .filter((c) => c.baseScore >= 45)
    .sort((a, b) => b.baseScore - a.baseScore);

  if (!usable.length) return fallbackSelected;

  const enriched = usable.map((candidate) => {
    const agreements = usable
      .filter((other) => other.provider !== candidate.provider)
      .map((other) => distanceMeters(candidate.point, other.point))
      .filter(Number.isFinite);
    const closeCount = agreements.filter((d) => d <= 2500).length;
    const nearCount = agreements.filter((d) => d <= 8000).length;
    return {
      ...candidate,
      agreementMeters: agreements.length ? Math.round(Math.min(...agreements)) : null,
      finalScore: Math.min(100, candidate.baseScore + closeCount * 22 + nearCount * 10),
    };
  }).sort((a, b) => b.finalScore - a.finalScore);

  const best = enriched[0];
  const confidence = best.finalScore >= 85 && enriched.some((c) => c.provider !== best.provider)
    ? "high"
    : best.finalScore >= 68
      ? "medium"
      : "low";
  if (confidence === "low") return fallbackSelected;

  return {
    point: best.point,
    confidence,
    score: Math.round(best.finalScore),
    source: best.provider,
    providers: [...new Set(enriched.map((c) => c.provider))],
    candidate: {
      provider: best.provider,
      name: best.name,
      address: best.address || "",
      agreementMeters: best.agreementMeters,
    },
  };
}

function summarize(schools) {
  return {
    high: schools.filter((s) => s.coordinateConfidence === "high").length,
    medium: schools.filter((s) => s.coordinateConfidence === "medium").length,
    low: schools.filter((s) => s.coordinateConfidence === "low").length,
    amap: schools.filter((s) => s.coordinateSource === "amap").length,
    tianditu: schools.filter((s) => s.coordinateSource === "tianditu").length,
    manual: schools.filter((s) => String(s.coordinateSource || "").startsWith("manual")).length,
    scatter: schools.filter((s) => s.coordinateSource === "province-scatter").length,
  };
}

function selectedFromSchool(school) {
  return {
    point: school.point,
    confidence: school.coordinateConfidence || "low",
    score: school.coordinateScore || 0,
    source: school.coordinateSource || "province-scatter",
    providers: school.coordinateProviders || [],
    candidate: school.coordinateCandidate || null,
    reason: "kept previous coordinate; no reliable recalibration match",
  };
}

const data = loadDataJs(await fs.readFile(DATA_JS, "utf8"));
const cache = await readJson(CACHE_FILE, { meta: {}, schools: {}, errors: [] });
cache.schools = cache.schools || {};
cache.errors = [];

const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : 0;
const resume = process.argv.includes("--resume");
const schools = limit > 0 ? data.schools.slice(0, limit) : data.schools;
const changes = [];

let done = 0;
for (const school of schools) {
  const before = selectedFromSchool(school);
  const cached = cache.schools[school.id];
  if (resume && cached?.version === 6 && cached?.selected) {
    school.point = cached.selected.point;
    school.coordinateConfidence = cached.selected.confidence;
    school.coordinateSource = cached.selected.source;
    school.coordinateProviders = cached.selected.providers || [];
    school.coordinateScore = cached.selected.score || 0;
    school.coordinateCandidate = cached.selected.candidate || null;

    const changed = JSON.stringify(before.point) !== JSON.stringify(cached.selected.point)
      || before.confidence !== cached.selected.confidence
      || before.source !== cached.selected.source
      || before.score !== cached.selected.score;
    if (changed) {
      changes.push({
        id: school.id,
        name: school.name,
        before: { point: before.point, confidence: before.confidence, source: before.source, score: before.score },
        after: {
          point: cached.selected.point,
          confidence: cached.selected.confidence,
          source: cached.selected.source,
          score: cached.selected.score,
          candidate: cached.selected.candidate?.name || "",
        },
      });
    }
    done += 1;
    if (done % 25 === 0) console.log(JSON.stringify({ done, total: schools.length, changes: changes.length, resumed: true }, null, 0));
    continue;
  }

  const providerResults = {};
  for (const [provider, query] of [["amap", queryAmap], ["tianditu", queryTianditu]]) {
    try {
      providerResults[provider] = await query(school);
      await sleep(160);
    } catch (error) {
      providerResults[provider] = [];
      cache.errors.push({ id: school.id, name: school.name, provider, error: error.message, at: new Date().toISOString() });
    }
  }

  const selected = chooseCoordinate(school, Object.values(providerResults).flat(), before);
  school.point = selected.point;
  school.coordinateConfidence = selected.confidence;
  school.coordinateSource = selected.source;
  school.coordinateProviders = selected.providers;
  school.coordinateScore = selected.score;
  school.coordinateCandidate = selected.candidate;

  const changed = JSON.stringify(before.point) !== JSON.stringify(selected.point)
    || before.confidence !== selected.confidence
    || before.source !== selected.source
    || before.score !== selected.score;
  if (changed) {
    changes.push({
      id: school.id,
      name: school.name,
      before: { point: before.point, confidence: before.confidence, source: before.source, score: before.score },
      after: { point: selected.point, confidence: selected.confidence, source: selected.source, score: selected.score, candidate: selected.candidate?.name || "" },
    });
  }

  cache.schools[school.id] = {
    version: 6,
    id: school.id,
    name: school.name,
    city: school.city,
    province: school.province,
    selected,
    providers: Object.fromEntries(Object.entries(providerResults).map(([provider, results]) => [
      provider,
      results.slice(0, 5).map((result) => ({
        name: result.name,
        address: result.address || "",
        city: result.city || "",
        province: result.province || "",
        type: result.type || "",
        point: result.point,
        baseScore: scoreCandidate(school, result),
      })),
    ])),
    updatedAt: new Date().toISOString(),
  };

  done += 1;
  if (done % 25 === 0) {
    await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
    console.log(JSON.stringify({ done, total: schools.length, changes: changes.length }, null, 0));
  }
}

data.meta.coordinateCalibration = {
  ...(data.meta.coordinateCalibration || {}),
  updatedAt: new Date().toISOString(),
  providersRequested: ["amap", "tianditu"],
  providersUsed: ["amap", "tianditu"],
  counts: summarize(data.schools),
  note: "高/中置信坐标来自地图服务检索；低置信坐标保留省级聚合散点；本次已对全部学校使用高德、天地图重新校准。",
};
data.meta.note = "本页面展示本科层次学校名单。高/中置信点位来自高德、天地图校准；低置信点位保留省级聚合散点，不代表校园精确坐标。";

cache.meta = {
  ...(cache.meta || {}),
  updatedAt: data.meta.coordinateCalibration.updatedAt,
  providers: { amap: Boolean(AMAP_KEY), tianditu: Boolean(TIANDITU_KEY) },
  recalibration: { mode: "all", total: schools.length, changes: changes.length },
};

await fs.writeFile(DATA_JS, `window.UNDERGRAD_MAP_DATA = ${JSON.stringify(data)};\n`, "utf8");
await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");

console.log(JSON.stringify({
  total: schools.length,
  changes: changes.length,
  counts: data.meta.coordinateCalibration.counts,
  sampleChanges: changes.slice(0, 20),
}, null, 2));
