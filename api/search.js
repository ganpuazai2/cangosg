import { onemap, send, limited } from "./_lib.js";

// GET /api/search?q=novena  -> places with coordinates (OneMap search; now requires a token)
export default async function handler(req, res) {
  if (limited(req, res)) return;
  const q = String(req.query.q || "").trim();
  if (q.length < 2) return send(res, 200, { results: [] });
  try {
    const d = await onemap(
      `/api/common/elastic/search?searchVal=${encodeURIComponent(q)}&returnGeom=Y&getAddrDetails=Y&pageNum=1`,
      { auth: true }
    );
    const results = (d.results || []).slice(0, 8).map((r) => ({
      name: r.BUILDING && r.BUILDING !== "NIL" ? r.BUILDING : r.SEARCHVAL,
      address: r.ADDRESS,
      lat: Number(r.LATITUDE),
      lng: Number(r.LONGITUDE),
    }));
    send(res, 200, { results }, 3600);
  } catch (e) {
    send(res, 502, { error: e.message });
  }
}
