import { datamall, send, limited, haversine } from "./_lib.js";

// GET /api/nearby?lat=1.30&lng=103.85
// Bus stop list (~5,000 stops) is paged 500 at a time; cached in memory per warm instance.
let stopsCache = { at: 0, stops: [] };

async function allStops() {
  if (stopsCache.stops.length && Date.now() - stopsCache.at < 24 * 3600e3) return stopsCache.stops;
  const stops = [];
  for (let skip = 0; skip < 20000; skip += 500) {
    const d = await datamall(`/BusStops?$skip=${skip}`);
    const page = d.value || [];
    stops.push(...page);
    if (page.length < 500) break;
  }
  stopsCache = { at: Date.now(), stops };
  return stops;
}

export default async function handler(req, res) {
  if (limited(req, res)) return;
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return send(res, 400, { error: "lat and lng required" });
  try {
    const stops = await allStops();
    const near = stops
      .map((s) => ({
        code: s.BusStopCode,
        name: s.Description,
        road: s.RoadName,
        lat: s.Latitude,
        lng: s.Longitude,
        metres: Math.round(haversine(lat, lng, s.Latitude, s.Longitude)),
      }))
      .filter((s) => s.metres <= 600)
      .sort((a, b) => a.metres - b.metres)
      .slice(0, 8);
    send(res, 200, { stops: near }, 300);
  } catch (e) {
    send(res, 502, { error: e.message });
  }
}
