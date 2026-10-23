import { datamall, send, limited } from "./_lib.js";

// GET /api/traffic -> current road incidents (accidents, roadworks, heavy traffic, breakdowns...)
export default async function handler(req, res) {
  if (limited(req, res)) return;
  try {
    const d = await datamall(`/TrafficIncidents`);
    const incidents = (d.value || [])
      .map((i) => ({
        type: i.Type,
        lat: Number(i.Latitude),
        lng: Number(i.Longitude),
        message: String(i.Message || "").replace(/^\(\d+\/\d+\)\d{1,2}:\d{2}\s*/, ""), // drop "(22/10)08:15 "
      }))
      .filter((i) => Number.isFinite(i.lat) && Number.isFinite(i.lng));
    send(res, 200, { incidents }, 120);
  } catch (e) {
    send(res, 502, { error: e.message });
  }
}
