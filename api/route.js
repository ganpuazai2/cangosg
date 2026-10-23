import { onemap, send, limited } from "./_lib.js";

// GET /api/route?from=lat,lng&to=lat,lng
//   &when=now|depart|arrive  &time=HH:MM (SG time, for depart/arrive)
//   &maxWalk=1000            (metres; lowered in rain mode)
//   &avoid=EW,NS             (MRT line prefixes to steer away from during disruptions)
//   &pref=fewer              (prefer fewer transfers / direct buses)
//   &only=bus                (bus-only routes, no MRT)

const pad = (n) => String(n).padStart(2, "0");

function sgDateTime(when, hhmm) {
  const sg = new Date(Date.now() + 8 * 3600e3); // shift to SG wall clock, read via UTC getters
  let date = `${pad(sg.getUTCMonth() + 1)}-${pad(sg.getUTCDate())}-${sg.getUTCFullYear()}`;
  let time = `${pad(sg.getUTCHours())}:${pad(sg.getUTCMinutes())}:00`;
  if (when !== "now" && /^\d{1,2}:\d{2}$/.test(hhmm || "")) {
    const [h, m] = hhmm.split(":").map(Number);
    time = `${pad(h)}:${pad(m)}:00`;
    // a time earlier than now means tomorrow
    if (h * 60 + m < sg.getUTCHours() * 60 + sg.getUTCMinutes() - 5) {
      const t = new Date(sg.getTime() + 86400e3);
      date = `${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}-${t.getUTCFullYear()}`;
    }
  }
  return { date, time };
}

async function plan(from, to, { date, time, mode, maxWalk, arriveBy, n }) {
  const qs = new URLSearchParams({
    start: from, end: to, routeType: "pt", date, time, mode,
    maxWalkDistance: String(maxWalk), numItineraries: String(n),
  });
  if (arriveBy) qs.set("arriveBy", "true");
  const d = await onemap(`/api/public/routingsvc/route?${qs}`, { auth: true });
  return d.plan?.itineraries || [];
}

function shape(it, avoid) {
  const legs = (it.legs || []).map((l) => ({
    mode: l.mode, // WALK, BUS, SUBWAY, TRAM
    route: l.route || l.routeShortName || null,
    from: l.from?.name,
    fromStopCode: l.from?.stopCode || null,
    fromLat: l.from?.lat ?? null,
    fromLng: l.from?.lon ?? null,
    to: l.to?.name,
    minutes: Math.max(1, Math.round(l.duration / 60)),
    metres: Math.round(l.distance || 0),
    stops: l.numIntermediateStops ?? null,
    start: l.startTime || null,
    end: l.endTime || null,
    toLat: l.to?.lat ?? null,
    toLng: l.to?.lon ?? null,
    // Every stop on a ride, boarding to alighting, with scheduled arrival (for ride mode)
    stopList: l.mode === "WALK" ? null : [l.from, ...(l.intermediateStops || []), l.to]
      .filter((s) => s && s.lat != null)
      .map((s) => ({ n: s.name, lat: s.lat, lng: s.lon, t: s.arrival || s.departure || null })),
    points: l.legGeometry?.points || null, // Google-encoded polyline
  }));
  const affected = legs.some(
    (l) => (l.mode === "SUBWAY" || l.mode === "TRAM") &&
      avoid.some((p) => String(l.route || "").toUpperCase().startsWith(p) ||
                        String(l.fromStopCode || "").toUpperCase().startsWith(p))
  );
  return {
    minutes: Math.round(it.duration / 60),
    walkMetres: Math.round(it.walkDistance || 0),
    transfers: it.transfers,
    fare: it.fare ? Number(it.fare) : null,
    start: it.startTime || null,
    end: it.endTime || null,
    affected,
    legs,
  };
}

export default async function handler(req, res) {
  if (limited(req, res, 30)) return; // routing is the expensive call
  const parse = (v) => String(v || "").split(",").map(Number);
  const [fLat, fLng] = parse(req.query.from);
  const [tLat, tLng] = parse(req.query.to);
  if (![fLat, fLng, tLat, tLng].every(Number.isFinite)) {
    return send(res, 400, { error: "from and to must be lat,lng" });
  }
  const when = ["depart", "arrive"].includes(req.query.when) ? req.query.when : "now";
  const maxWalk = Math.min(2000, Math.max(200, Number(req.query.maxWalk) || 1000));
  const avoid = String(req.query.avoid || "")
    .split(",").map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z]{2}$/.test(s));

  const { date, time } = sgDateTime(when, req.query.time);
  const base = { date, time, maxWalk, arriveBy: when === "arrive" };
  const from = `${fLat},${fLng}`;
  const to = `${tLat},${tLng}`;

  try {
    const fewer = req.query.pref === "fewer";
    const busOnly = req.query.only === "bus";
    // OneMap answers 404 when nothing runs at that time (e.g. MRT closed after midnight): treat as "no routes"
    const none = (e) => { if (e.message === "OneMap 404") return []; throw e; };
    const bus = (n) => plan(from, to, { ...base, mode: "BUS", n }).catch(none);
    const jobs = [busOnly ? bus(3) : plan(from, to, { ...base, mode: "TRANSIT", n: 3 }).catch(none)];
    // During a disruption, or when the user wants fewer transfers, also ask for bus-only
    // options: these often surface a direct bus the transit search skipped.
    if (!busOnly && (avoid.length || fewer)) jobs.push(bus(2).catch(() => []));
    let raw = (await Promise.all(jobs)).flat();
    // No bus + MRT route (usually the MRT has closed for the night): fall back to buses only
    let fallback = null;
    if (!busOnly && !raw.length) {
      raw = await bus(3);
      if (raw.length) fallback = "bus";
    }
    const results = raw.map((it) => shape(it, avoid));

    // de-duplicate identical leg sequences
    const seen = new Set();
    const itineraries = results.filter((it) => {
      const k = it.legs.map((l) => l.mode + (l.route || "")).join(">");
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    // Unaffected first, then fastest (or fewest transfers if asked)
    itineraries.sort((a, b) => (a.affected - b.affected) ||
      (fewer ? (a.transfers - b.transfers) || (a.minutes - b.minutes) : (a.minutes - b.minutes)));

    let target = null;
    if (when === "arrive") {
      const [h, m] = String(req.query.time).split(":").map(Number);
      target = { h, m };
    }
    send(res, 200, { itineraries: itineraries.slice(0, 4), when, date, time, target, fallback });
  } catch (e) {
    send(res, 502, { error: e.message });
  }
}
