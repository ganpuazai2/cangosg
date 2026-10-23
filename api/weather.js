import { send, limited, haversine } from "./_lib.js";

// GET /api/weather?lat=..&lng=..  -> { raining, forecast, area }
// Uses NEA's 2-hour forecast from data.gov.sg (no key needed; DATAGOV_API_KEY optional
// for higher rate limits). Tries the v2 API first, then the older v1 API.

const V2 = "https://api-open.data.gov.sg/v2/real-time/api/two-hr-forecast";
const V1 = "https://api.data.gov.sg/v1/environment/2-hour-weather-forecast";

const WET = /rain|shower|thunder|drizzle/i;

async function getJson(url) {
  const headers = {};
  if (process.env.DATAGOV_API_KEY) headers["x-api-key"] = process.env.DATAGOV_API_KEY;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`data.gov.sg ${r.status}`);
  return r.json();
}

// Normalise both API shapes into [{ area, lat, lng, text }]
function normalise(d) {
  const root = d?.data || d; // v2 wraps in { code, data }
  const meta = root?.area_metadata || [];
  const item = (root?.items || [])[0] || {};
  const byArea = {};
  for (const f of item.forecasts || []) {
    const text = typeof f.forecast === "string" ? f.forecast : f.forecast?.text || "";
    byArea[f.area] = text;
  }
  return meta
    .filter((m) => m.label_location && byArea[m.name] !== undefined)
    .map((m) => ({
      area: m.name,
      lat: Number(m.label_location.latitude),
      lng: Number(m.label_location.longitude),
      text: byArea[m.name],
    }));
}

export default async function handler(req, res) {
  if (limited(req, res)) return;
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return send(res, 400, { error: "lat and lng required" });
  try {
    let areas = [];
    try { areas = normalise(await getJson(V2)); } catch {}
    if (!areas.length) areas = normalise(await getJson(V1));
    if (!areas.length) throw new Error("no forecast data");
    const near = areas
      .map((a) => ({ ...a, d: haversine(lat, lng, a.lat, a.lng) }))
      .sort((a, b) => a.d - b.d)[0];
    send(res, 200, { raining: WET.test(near.text), forecast: near.text, area: near.area }, 600);
  } catch (e) {
    send(res, 502, { error: e.message });
  }
}
