import { datamall, send, limited } from "./_lib.js";

// GET /api/alerts -> MRT/LRT disruptions (status 1 = normal, 2 = disrupted)
export default async function handler(req, res) {
  if (limited(req, res)) return;
  try {
    const d = await datamall(`/TrainServiceAlerts`);
    const v = d.value || {};
    const disrupted = v.Status === 2;
    const lines = (v.AffectedSegments || []).map((s) => ({
      line: s.Line,
      // two-letter prefix used in station codes / route names, e.g. "EWL" -> "EW"
      prefix: String(s.Line || "").slice(0, 2).toUpperCase(),
      direction: s.Direction,
      stations: s.Stations,
      shuttle: s.FreePublicBus || s.FreeMRTShuttle || null,
    }));
    const messages = (v.Message || []).map((m) => m.Content).filter(Boolean);
    send(res, 200, { disrupted, lines, messages }, 60);
  } catch (e) {
    send(res, 502, { error: e.message });
  }
}
