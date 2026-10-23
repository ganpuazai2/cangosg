// Runs on every Vercel deploy (see vercel.json). Downloads all bus stops once and
// writes a compact public/stops.json so "nearby" works instantly in the browser.
// Format: [[code, name, road, lat, lng], ...]
// Never fails the build: without a key it keeps whatever file already exists.

import { writeFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const OUT = new URL("../public/stops.json", import.meta.url);
try { process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url))); } catch {} // local runs; Vercel sets env itself
const key = process.env.LTA_ACCOUNT_KEY;

async function exists() {
  try { await access(OUT); return true; } catch { return false; }
}

async function main() {
  if (!key) {
    console.warn("[stops] LTA_ACCOUNT_KEY not set, skipping stop list build");
    if (!(await exists())) await writeFile(OUT, "[]");
    try { await access(new URL("../public/services.json", import.meta.url)); }
    catch { await writeFile(new URL("../public/services.json", import.meta.url), "{}"); }
    return;
  }
  const rows = [];
  for (let skip = 0; skip < 20000; skip += 500) {
    const r = await fetch(
      `https://datamall2.mytransport.sg/ltaodataservice/BusStops?$skip=${skip}`,
      { headers: { AccountKey: key, accept: "application/json" } }
    );
    if (!r.ok) throw new Error(`DataMall ${r.status}`);
    const page = (await r.json()).value || [];
    for (const s of page) {
      if (!s.Latitude || !s.Longitude) continue;
      rows.push([
        s.BusStopCode,
        s.Description,
        s.RoadName,
        Math.round(s.Latitude * 1e6) / 1e6,
        Math.round(s.Longitude * 1e6) / 1e6,
      ]);
    }
    if (page.length < 500) break;
  }
  await writeFile(OUT, JSON.stringify(rows));
  console.log(`[stops] wrote ${rows.length} stops`);
  await buildServices();
}

// public/services.json: { "52": ["5-08", "10-16", "8-10", "12-15"] }
// = minutes between buses for AM peak, AM off-peak, PM peak, PM off-peak.
// Used as a fallback ("usually every 8–12 min") when live timings are missing.
const SVC_OUT = new URL("../public/services.json", import.meta.url);
async function buildServices() {
  try {
    const out = {};
    for (let skip = 0; skip < 5000; skip += 500) {
      const r = await fetch(
        `https://datamall2.mytransport.sg/ltaodataservice/BusServices?$skip=${skip}`,
        { headers: { AccountKey: key, accept: "application/json" } }
      );
      if (!r.ok) throw new Error(`DataMall ${r.status}`);
      const page = (await r.json()).value || [];
      for (const s of page) {
        if (out[s.ServiceNo]) continue; // keep direction 1
        out[s.ServiceNo] = [s.AM_Peak_Freq, s.AM_Offpeak_Freq, s.PM_Peak_Freq, s.PM_Offpeak_Freq].map((f) => String(f || "-"));
      }
      if (page.length < 500) break;
    }
    await writeFile(SVC_OUT, JSON.stringify(out));
    console.log(`[stops] wrote ${Object.keys(out).length} service frequencies`);
  } catch (e) {
    console.warn("[stops] service frequencies failed:", e.message);
    await writeFile(SVC_OUT, "{}").catch(() => {});
  }
}

main().catch(async (e) => {
  console.warn("[stops] failed, keeping previous file:", e.message);
  if (!(await exists())) await writeFile(OUT, "[]");
});
