import { datamall, send, limited, LINE_CODES } from "./_lib.js";

// GET /api/crowd?line=EW  -> { stations: { EW13: "l" | "m" | "h" } }
// DataMall real-time platform crowd density, updated every ~10 min.
export default async function handler(req, res) {
  if (limited(req, res)) return;
  const prefix = String(req.query.line || "").toUpperCase().slice(0, 2);
  const trainLine = LINE_CODES[prefix];
  if (!trainLine) return send(res, 400, { error: "unknown line" });
  try {
    const d = await datamall(`/PCDRealTime?TrainLine=${trainLine}`);
    const stations = {};
    for (const s of d.value || []) {
      const lvl = String(s.CrowdLevel || "").toLowerCase();
      if (["l", "m", "h"].includes(lvl)) stations[s.Station] = lvl;
    }
    send(res, 200, { line: trainLine, stations }, 300);
  } catch (e) {
    send(res, 502, { error: e.message });
  }
}
