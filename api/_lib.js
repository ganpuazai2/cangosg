// Shared helpers for the API routes. Files starting with "_" are not exposed as endpoints.

const DATAMALL = "https://datamall2.mytransport.sg/ltaodataservice";
const ONEMAP = "https://www.onemap.gov.sg";

export async function datamall(path) {
  const key = process.env.LTA_ACCOUNT_KEY;
  if (!key) throw new Error("LTA_ACCOUNT_KEY is not set");
  const r = await fetch(`${DATAMALL}${path}`, {
    headers: { AccountKey: key, accept: "application/json" },
  });
  if (!r.ok) throw new Error(`DataMall ${r.status}`);
  return r.json();
}

// OneMap tokens last ~3 days. Cache in module scope so warm functions reuse it.
let tokenCache = { token: null, exp: 0 };

export async function onemapToken() {
  const now = Date.now() / 1000;
  if (tokenCache.token && tokenCache.exp - 3600 > now) return tokenCache.token;
  const email = process.env.ONEMAP_EMAIL;
  const password = process.env.ONEMAP_PASSWORD;
  if (!email || !password) throw new Error("ONEMAP_EMAIL / ONEMAP_PASSWORD not set");
  const r = await fetch(`${ONEMAP}/api/auth/post/getToken`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`OneMap auth ${r.status}`);
  const d = await r.json();
  tokenCache = {
    token: d.access_token,
    exp: Number(d.expiry_timestamp) || now + 3 * 86400,
  };
  return tokenCache.token;
}

export async function onemap(path, { auth = false } = {}) {
  const headers = {};
  if (auth) headers.Authorization = await onemapToken();
  const r = await fetch(`${ONEMAP}${path}`, { headers });
  if (!r.ok) throw new Error(`OneMap ${r.status}`);
  return r.json();
}

export function send(res, status, body, cacheSeconds = 0) {
  if (cacheSeconds) {
    res.setHeader("Cache-Control", `s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds}`);
  }
  res.status(status).json(body);
}

// Simple per-IP rate limit (per warm instance). Stops casual abuse of your API quotas.
// For stronger protection, also add a rate-limit rule in Vercel → Firewall.
const hits = new Map();
export function limited(req, res, max = 60, windowMs = 60_000) {
  const ip = String(req.headers["x-forwarded-for"] || "anon").split(",")[0].trim();
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.start > windowMs) {
    hits.set(ip, { start: now, n: 1 });
    if (hits.size > 5000) for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
    return false;
  }
  h.n++;
  if (h.n > max) {
    res.setHeader("Retry-After", Math.ceil((h.start + windowMs - now) / 1000));
    send(res, 429, { error: "Too many requests, try again shortly" });
    return true;
  }
  return false;
}

export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// MRT/LRT station code prefix -> DataMall TrainLine code
export const LINE_CODES = {
  NS: "NSL", EW: "EWL", CG: "CGL", CC: "CCL", CE: "CEL", DT: "DTL",
  NE: "NEL", TE: "TEL", BP: "BPL", SW: "SLRT", SE: "SLRT", PW: "PLRT", PE: "PLRT",
};
