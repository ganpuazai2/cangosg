import { datamall, send, limited, LINE_CODES } from "./_lib.js";

// GET /api/crowdforecast?station=EW23
//   -> { station, slots: [{ t: epoch ms, lvl: "l" | "m" | "h" }] }  (today, 30-min intervals)
// LTA publishes the forecast for the whole line once a day, so it's cached for an hour.
export default async function handler(req, res) {
  if (limited(req, res)) return;
  const station = String(req.query.station || "").toUpperCase();
  const trainLine = LINE_CODES[station.slice(0, 2)];
  if (!/^[A-Z]{2}\d{1,2}$/.test(station) || !trainLine) return send(res, 400, { error: "station must be a code like EW23" });
  try {
    const d = await datamall(`/PCDForecast?TrainLine=${trainLine}`);
    const days = d.value || [];
    const st = days.flatMap((day) => day.Stations || []).find((s) => s.Station === station);
    const slots = (st?.Interval || [])
      .map((i) => ({ t: Date.parse(i.Start), lvl: String(i.CrowdLevel || "").toLowerCase() }))
      .filter((s) => Number.isFinite(s.t) && ["l", "m", "h"].includes(s.lvl))
      .sort((a, b) => a.t - b.t);
    send(res, 200, { station, line: trainLine, slots }, 3600);
  } catch (e) {
    send(res, 502, { error: e.message });
  }
}
