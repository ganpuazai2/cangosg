import { datamall, send, limited } from "./_lib.js";

// GET /api/arrivals?stop=83139
function pos(b) {
  const lat = Number(b.Latitude), lng = Number(b.Longitude);
  return lat > 1 && lat < 1.6 && lng > 103 && lng < 104.2 ? { lat, lng } : {};
}

export default async function handler(req, res) {
  if (limited(req, res)) return;
  const stop = String(req.query.stop || "").trim();
  if (!/^\d{5}$/.test(stop)) return send(res, 400, { error: "stop must be a 5-digit code" });
  try {
    const d = await datamall(`/v3/BusArrival?BusStopCode=${stop}`);
    const now = Date.now();
    const mins = (iso) => (iso ? Math.max(0, Math.round((Date.parse(iso) - now) / 60000)) : null);
    const services = (d.Services || [])
      .map((s) => ({
        service: s.ServiceNo,
        operator: s.Operator,
        next: [s.NextBus, s.NextBus2, s.NextBus3]
          .filter((b) => b && b.EstimatedArrival)
          .map((b) => ({
            mins: mins(b.EstimatedArrival),
            at: Date.parse(b.EstimatedArrival),
            load: b.Load, // SEA seats, SDA standing, LSD limited standing
            type: b.Type, // SD single, DD double, BD bendy
            live: b.Monitored === 1,
            wab: b.Feature === "WAB", // wheelchair-accessible bus
            // GPS position of the bus (LTA sends "0.0" when unknown)
            ...pos(b),
          })),
      }))
      .sort((a, b) => a.service.localeCompare(b.service, undefined, { numeric: true }));
    send(res, 200, { stop, services, ts: now }, 20);
  } catch (e) {
    send(res, 502, { error: e.message });
  }
}
