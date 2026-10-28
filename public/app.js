"use strict";

// ================= helpers =================
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const WALK_M_PER_MIN = 75; // relaxed walking pace, a bit slower than 5 km/h for crossings
const LINE_VAR = { NS: "--ns", EW: "--ew", CG: "--ew", CC: "--cc", CE: "--cc", DT: "--dt", NE: "--ne", TE: "--te",
                   BP: "--lrt", SW: "--lrt", SE: "--lrt", PW: "--lrt", PE: "--lrt" };
const CROWD_TXT = { l: "Not crowded", m: "Moderately crowded", h: "Crowded" };

const state = {
  from: null, to: null, here: null,
  when: "now",
  only: "any",        // "bus" = bus-only routes in the planner
  avoid: [],          // MRT line prefixes currently disrupted
  rain: null,         // { raining, forecast, area }
  nearby: [],         // nearby stop objects
  activeStop: null,   // stop whose arrivals are shown
  lastRoutes: null,
};

// ---- preferences (on this device) ----
const PREF_KEY = "gosg.prefs.v1";
const prefs = (() => { try { return { big: false, access: false, fewer: false, haptic: true, ...JSON.parse(localStorage.getItem(PREF_KEY) || "{}") }; } catch { return { big: false, access: false, fewer: false, haptic: true }; } })();
function savePrefs() { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch {} }

// ---- API with offline fallback ----
// Last good arrivals/route responses are kept on the phone. If the network fails
// (underground, no signal), the saved copy is returned with _stale set to when it was saved.
const CACHE_PREFIX = "gosg.cache:";
const CACHEABLE = /^\/api\/(arrivals|route)\b/;
function cachePut(path, d) {
  try {
    localStorage.setItem(CACHE_PREFIX + path, JSON.stringify({ ts: Date.now(), d }));
    // keep at most ~40 cached responses
    const keys = Object.keys(localStorage).filter((k) => k.startsWith(CACHE_PREFIX));
    if (keys.length > 40) {
      keys.map((k) => [k, JSON.parse(localStorage.getItem(k) || "{}").ts || 0]).sort((a, b) => a[1] - b[1])
        .slice(0, keys.length - 40).forEach(([k]) => localStorage.removeItem(k));
    }
  } catch {}
}
function cacheGet(path) {
  try { return JSON.parse(localStorage.getItem(CACHE_PREFIX + path) || "null"); } catch { return null; }
}
function setOffline(on) { const el = $("offline"); if (el) el.hidden = !on; }

async function api(path) {
  let r, d = {};
  try {
    r = await fetch(path);
    try { d = await r.json(); } catch {}
  } catch (netErr) {
    r = null;
  }
  const failed = !r || r.status === 503 || r.status === 0;
  if (r && r.ok) {
    if (CACHEABLE.test(path)) { cachePut(path, d); setOffline(false); }
    return d;
  }
  if (failed && CACHEABLE.test(path)) {
    const c = cacheGet(path);
    if (c) { setOffline(true); return { ...c.d, _stale: c.ts }; }
  }
  if (!r) { setOffline(true); throw new Error("You're offline"); }
  throw new Error(d.error || `Error ${r.status}`);
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const sgTime = (ms) => new Date(ms).toLocaleTimeString("en-SG", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Singapore" });
const ago = (ts) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 10 ? "just now" : s < 60 ? `${s}s ago` : `${Math.round(s / 60)} min ago`;
};
// minutes until a bus arrives, recomputed from its absolute time so numbers stay honest between refreshes
const minsTo = (b) => (Number.isFinite(b.at) ? Math.max(0, Math.round((b.at - Date.now()) / 60000)) : b.mins);
const fmtMins = (m) => (m === 0 ? "Arr" : `${m}m`);
const lineVar = (route) => LINE_VAR[String(route || "").slice(0, 2).toUpperCase()] || "--bus";

// Decode a Google-encoded polyline (precision 5) into [[lat, lng], ...]
function decodePolyline(str) {
  let i = 0, lat = 0, lng = 0;
  const out = [];
  while (i < str.length) {
    for (const k of [0, 1]) {
      let shift = 0, result = 0, b;
      do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20 && i <= str.length);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (k === 0) lat += d; else lng += d;
    }
    out.push([lat / 1e5, lng / 1e5]);
  }
  return out;
}

// ================= favourites (on this device) =================
const FAV_KEY = "gosg.favs.v1";
const favs = (() => {
  try { return { stops: [], places: [], ...JSON.parse(localStorage.getItem(FAV_KEY) || "{}") }; }
  catch { return { stops: [], places: [] }; }
})();
function saveFavs() {
  try { localStorage.setItem(FAV_KEY, JSON.stringify(favs)); } catch {}
  renderFavs();
}
const isFavStop = (code) => favs.stops.some((s) => s.code === code);
const isFavPlace = (p) => !!p && favs.places.some((x) => x.lat === p.lat && x.lng === p.lng);
function toggleStop(stop) {
  if (isFavStop(stop.code)) favs.stops = favs.stops.filter((s) => s.code !== stop.code);
  else favs.stops.push({ code: stop.code, name: stop.name, road: stop.road || "", lat: stop.lat, lng: stop.lng });
  saveFavs();
  refreshStars();
  syncStopSheet();
  const on = isFavStop(stop.code);
  document.querySelectorAll(`[data-star="${stop.code}"]`).forEach(pop);
  toast(on ? "★ Saved to favourites" : "Removed from favourites");
}
function togglePlace(p) {
  if (isFavPlace(p)) favs.places = favs.places.filter((x) => !(x.lat === p.lat && x.lng === p.lng));
  else favs.places.push({ name: p.name, address: p.address, lat: p.lat, lng: p.lng });
  saveFavs();
  syncStarTo();
  pop($("starTo"));
  toast(isFavPlace(p) ? "★ Place saved" : "Place removed");
}
function syncStarTo() {
  const b = $("starTo");
  b.hidden = !state.to;
  const on = isFavPlace(state.to);
  b.textContent = on ? "★" : "☆";
  b.classList.toggle("on", on);
  b.setAttribute("aria-label", on ? "Remove destination from favourites" : "Save destination to favourites");
  updateSaveAs();
}
function refreshStars() {
  document.querySelectorAll("[data-star]").forEach((b) => {
    const on = isFavStop(b.dataset.star);
    b.textContent = on ? "★" : "☆";
    b.classList.toggle("on", on);
    b.setAttribute("aria-label", on ? "Remove stop from favourites" : "Save stop to favourites");
  });
}

// ================= reliability =================
// 1) Per-bus confidence: flag a service "unstable" when its first bus's ETA jumps later
//    without the bus having arrived (the countdown-reset / ghost-bus pattern), or when the
//    ETA says "arriving" but the bus's GPS is still far away.
// 2) System-wide: if most services across recent lookups have no live timing, LTA's ETA
//    feed is probably down (as in Jan 2026), so show a banner and usual frequencies.
const etaMem = {};      // "stop|svc" -> { a1, a2, ts }
const unstable = {};    // "stop|svc" -> flagged until (ms)
const health = [];      // recent { ts, total, bad }

function observeEta(stop, services) {
  const now = Date.now();
  for (const s of services) {
    const k = `${stop.code}|${s.service}`;
    const [b1, b2] = s.next;
    const prev = etaMem[k];
    if (b1 && prev && now - prev.ts < 5 * 60000) {
      const departed = prev.a2 && Math.abs(b1.at - prev.a2) < 150000; // old 2nd bus is now 1st: normal
      const jumped = !!prev.a2 && !departed && prev.a1 - now < 120000 && b1.at - prev.a1 > 180000;
      if (jumped) unstable[k] = now + 10 * 60000;
    }
    if (b1 && b1.live && b1.lat != null && stop.lat != null && minsTo(b1) <= 1 &&
        haversine(b1.lat, b1.lng, stop.lat, stop.lng) > 1200) unstable[k] = now + 5 * 60000;
    etaMem[k] = { a1: b1?.at, a2: b2?.at, ts: now };
  }
  // feed health
  const bad = services.filter((s) => !s.next.some((b) => b.live)).length;
  health.push({ ts: now, total: services.length, bad });
  while (health.length && now - health[0].ts > 5 * 60000) health.shift();
  renderHealth();
}
function renderHealth() {
  const total = health.reduce((n, h) => n + h.total, 0);
  const bad = health.reduce((n, h) => n + h.bad, 0);
  const down = total >= 6 && bad / total >= 0.6;
  if (down !== state.feedDown) setBanner("ltaWarn", `<b>⚠ Bus timings look unreliable right now</b><details class="key"><summary>What to do</summary><p>Most buses aren't reporting their position, so times may be wrong or missing. Buses are likely still running. Use the usual frequencies shown and allow extra time.</p></details>`, down, "bad");
  state.feedDown = down;
}
const isUnstable = (code, svc) => (unstable[`${code}|${svc}`] || 0) > Date.now();

// Usual frequency per service from LTA's timetable (built at deploy time)
let svcFreq = {};
fetch("/services.json").then((r) => r.json()).then((d) => (svcFreq = d || {})).catch(() => {});
function usualFreq(svc) {
  const f = svcFreq[svc];
  if (!f) return "";
  const sg = new Date(Date.now() + 8 * 3600e3);
  const m = sg.getUTCHours() * 60 + sg.getUTCMinutes();
  const band = m >= 390 && m <= 510 ? 0 : m < 1020 ? 1 : m <= 1140 ? 2 : 3;
  const v = String(f[band] || "").replace(/^0+(\d)/, "$1").replace(/-0+(\d)/, "-$1");
  return v && v !== "-" && v !== "0" ? `usually every ${v.replace("-", "–")} min` : "";
}

// ================= arrivals rendering =================
// walkMin: minutes to walk to this stop (null if unknown). Buses you can't reach in time are struck out.
const lastLed = {};
function arrivalRows(services, walkMin, stop = {}) {
  if (!services.length) return "<p class='muted'>No services right now.</p>";
  let anySched = false, anyMiss = false, anyUnstable = false;
  const now = Date.now();
  const rows = services.map((s) => {
    const next = s.next.filter((b) => !Number.isFinite(b.at) || b.at > now - 60000); // drop buses already gone (stale data)
    const times = next.map((b, i) => {
      const m = minsTo(b);
      const miss = walkMin != null && m < walkMin;
      if (!b.live) anySched = true;
      if (miss) anyMiss = true;
      const wab = prefs.access && b.wab ? `<span class="wab" aria-hidden="true">♿</span>` : "";
      const label = `${m === 0 ? "arriving" : m + " minutes"}${b.live ? "" : ", scheduled"}${miss ? ", too soon to reach" : ""}${prefs.access ? (b.wab ? ", wheelchair accessible" : ", not wheelchair accessible") : ""}`;
      // LED pulse when a number changes since the last refresh: amber as it counts down,
      // red if the bus got later (a delay), so a slipping bus catches your eye
      const k = `${stop.code}|${s.service}|${i}`, txt = fmtMins(m);
      const prev = lastLed[k];
      const changed = prev !== undefined && prev.txt !== txt;
      const later = changed && m > prev.m;
      lastLed[k] = { txt, m };
      const cls = ["t", !b.live && "sched", miss && "miss", m === 0 && !miss && "arr", changed && (later ? "tick later" : "tick")].filter(Boolean).join(" ");
      return `<span class="${cls}" aria-label="${label}">${txt}<i class="${esc(b.load)}" aria-hidden="true"></i>${wab}</span>`;
    }).join("");
    const shaky = isUnstable(stop.code, s.service);
    if (shaky) anyUnstable = true;
    const noLive = !next.some((b) => b.live);
    const freq = noLive || state.feedDown ? usualFreq(s.service) : "";
    return `<div class="svc"><div class="no">${esc(s.service)}</div><div>
      <div class="times">${times || "<span class='muted'>No timing</span>"}${shaky ? `<span class="tag unstable" title="This bus's timing jumped or doesn't match its GPS. It may not show up as predicted.">timing unstable</span>` : ""}</div>
      ${freq ? `<div class="freq">${freq}</div>` : ""}</div></div>`;
  }).join("");
  const notes = [
    anySched && "* scheduled, bus not tracked live",
    anyMiss && "struck out = leaves before you can walk there",
    anyUnstable && "unstable = ETA jumped or doesn't match the bus's GPS",
    prefs.access && "♿ = wheelchair accessible",
    "● green circle = seats, ◐ amber half circle = standing only, ■ red square = packed",
  ].filter(Boolean).join(". ");
  return `<div class="board">${rows}</div><details class="key"><summary>What do these mean?</summary><p>${notes}.</p></details>`;
}
function stopCard(stop, inner, ts, stale) {
  const on = isFavStop(stop.code);
  const walk = stop.metres != null ? `, ${Math.max(1, Math.ceil(stop.metres / WALK_M_PER_MIN))} min walk` : "";
  return `<div class="card" data-stopcard="${esc(stop.code)}"><div class="stop-head"><span><b>${esc(stop.name)}</b><br><small><span class="code" aria-label="Stop code">${esc(stop.code)}</span>${esc(stop.road)}${walk}</small></span>
    <button class="star${on ? " on" : ""}" data-star="${esc(stop.code)}" aria-label="${on ? "Remove stop from" : "Save stop to"} favourites">${on ? "★" : "☆"}</button></div>
    ${inner}
    ${stale ? `<div class="stale">Offline. showing timings saved at ${sgTime(stale)}. Countdowns are estimated from then.</div>`
            : ts ? `<div class="updated" data-ts="${ts}">Updated ${ago(ts)}</div>` : ""}
    ${ts || stale ? `<div class="report"><button class="linkbtn" data-report aria-expanded="false" style="margin-left:0">Report a wrong timing</button><div class="report-panel" hidden></div></div>` : ""}</div>`;
}

// Report a wrong timing: pre-fills a note the user can paste into LTA's feedback form
const LTA_FEEDBACK = "https://www.lta.gov.sg/content/ltagov/en/contact_us/contact_form.html";
function wireReport(root, stop, services) {
  const btn = root.querySelector("[data-report]");
  if (!btn) return;
  const panel = btn.nextElementSibling;
  btn.onclick = (e) => {
    e.stopPropagation();
    const open = btn.getAttribute("aria-expanded") === "true";
    btn.setAttribute("aria-expanded", String(!open));
    panel.hidden = open;
    if (open) return;
    const opts = services.map((s) => `<option value="${esc(s.service)}">Bus ${esc(s.service)}</option>`).join("");
    panel.innerHTML = `
      <label class="muted" for="rp-svc-${esc(stop.code)}">Which bus?</label>
      <select id="rp-svc-${esc(stop.code)}">${opts}</select>
      <textarea id="rp-txt-${esc(stop.code)}" aria-label="Report text"></textarea>
      <div class="row"><button class="btn small" data-copy>Copy report</button>
        <a class="btn small ghost" href="${LTA_FEEDBACK}" target="_blank" rel="noopener">Open LTA feedback form</a></div>
      <span class="muted" data-copied role="status"></span>`;
    const sel = panel.querySelector("select"), txt = panel.querySelector("textarea");
    const fill = () => {
      const s = services.find((x) => x.service === sel.value);
      const shown = s?.next.map((b) => fmtMins(minsTo(b)).replace("m", " min")).join(", ") || "no timing";
      txt.value = `Bus stop ${stop.code} (${stop.name}), service ${sel.value}: at ${sgTime(Date.now())} on ${new Date().toLocaleDateString("en-SG", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Singapore" })}, the arrival time showed ${shown}, but the bus actually `;
    };
    sel.onchange = fill; fill();
    panel.onclick = (ev) => ev.stopPropagation();
    panel.querySelector("[data-copy]").onclick = async () => {
      const out = panel.querySelector("[data-copied]");
      try { await navigator.clipboard.writeText(txt.value); out.textContent = "Copied. Paste it into the LTA form."; }
      catch { txt.select(); out.textContent = "Select-all is on, copy it with your phone's Copy."; }
    };
  };
}
// Bus approach strip: each service's next bus as a dot sliding towards the stop (straight-line distance)
const STRIP_M = 3000;
function approachStrip(stop, services) {
  if (stop.lat == null || stop.lng == null) return "";
  const buses = services.map((s) => {
    const b = s.next.find((x) => x.lat != null);
    if (!b) return null;
    return { svc: s.service, d: haversine(b.lat, b.lng, stop.lat, stop.lng), load: b.load };
  }).filter((b) => b && b.d <= STRIP_M + 1500).sort((a, b) => b.d - a.d);
  if (!buses.length) return "";
  // Labels go above or below the track, whichever has room; bunched buses share one label
  const lastX = { up: -99, low: -99 };
  const dots = buses.map((b) => {
    const x = (1 - Math.min(b.d, STRIP_M) / STRIP_M) * 94; // 94% so the last dot sits just before the stop flag
    const where = b.d < 120 ? "at the stop" : `${(b.d / 1000).toFixed(1)} km away`;
    const row = x - lastX.up >= 10 ? "up" : x - lastX.low >= 10 ? "low" : null;
    if (row) lastX[row] = x;
    const label = row ? `<b>${esc(b.svc)}</b>` : "";
    return `<span class="bus-dot ${esc(b.load)}${row === "low" ? " low" : ""}" style="left:${x.toFixed(1)}%" title="Bus ${esc(b.svc)}, ${where}">${label}</span>`;
  }).join("");
  const label = buses.map((b) => `bus ${b.svc} ${b.d < 120 ? "at the stop" : (b.d / 1000).toFixed(1) + " km away"}`).join(", ");
  return `<div class="strip" role="img" aria-label="Buses approaching: ${esc(label)}">
    <div class="track">${dots}<span class="flag" aria-hidden="true">🚏</span></div>
    <div class="strip-scale" aria-hidden="true"><span>3 km</span><span>2 km</span><span>1 km</span><span>Stop</span></div></div>`;
}
function wireStar(root, stop) {
  root.querySelectorAll("[data-star]").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); toggleStop(stop); }));
}
// "Updated 12s ago" labels tick on their own
setInterval(() => document.querySelectorAll("[data-ts]").forEach((el) => {
  const old = Date.now() - +el.dataset.ts > 60000;
  el.innerHTML = `<i class="live-dot${old ? " old" : ""}" aria-hidden="true"></i>Updated ${ago(+el.dataset.ts)}`;
}), 5000);

// ================= favourites UI =================
function renderFavs() {
  $("favPlacesEmpty").hidden = !!favs.places.length;
  setSecCount("favs", favs.places.length ? `${favs.places.length} place${favs.places.length > 1 ? "s" : ""}` : "");
  $("favPlaces").innerHTML = favs.places.map((p, i) =>
    `<button class="chip" data-i="${i}" aria-label="Plan route to ${esc(p.name)}">📍 ${esc(p.name)}<span class="x" data-x="${i}" role="button" aria-label="Remove ${esc(p.name)}">×</span></button>`).join("");
  $("favPlaces").querySelectorAll(".chip").forEach((c) => (c.onclick = (e) => {
    const p = favs.places[c.dataset.i];
    if (e.target.dataset.x !== undefined) return togglePlace(p);
    state.to = p; $("to").value = p.name; syncStarTo(); planTrip();
  }));
  renderHome();
}
function withDistance(stop) {
  if (!state.here || stop.lat == null) return { ...stop, metres: null };
  return { ...stop, metres: Math.round(haversine(state.here.lat, state.here.lng, stop.lat, stop.lng)) };
}
// ================= "Now" home screen =================
// Big glanceable countdowns: your nearest stop first, then favourite stops.
// Long-press (or right-click) a bus number to pin it; pinned buses show first and,
// when any are pinned, the others fold away behind "Show all".
const PIN_KEY = "gosg.pins.v1";
const pins = (() => { try { return JSON.parse(localStorage.getItem(PIN_KEY) || "{}"); } catch { return {}; } })();
const isPinned = (code, svc) => (pins[code] || []).includes(svc);
function togglePin(code, svc) {
  const list = pins[code] || [];
  pins[code] = list.includes(svc) ? list.filter((x) => x !== svc) : [...list, svc];
  if (!pins[code].length) delete pins[code];
  try { localStorage.setItem(PIN_KEY, JSON.stringify(pins)); } catch {}
  toast(isPinned(code, svc) ? `📌 Pinned bus ${svc} here` : `Unpinned bus ${svc}`);
}
const homeOpen = {}; // stop code -> showing all services
const CROWD_WORD = { SEA: "seats available", SDA: "standing only", LSD: "packed" };

function homeStops() {
  const list = [];
  const near = state.nearby[0];
  if (near) list.push({ ...near, near: true });
  favs.stops.forEach((s) => {
    const i = list.findIndex((x) => x.code === s.code);
    if (i < 0) list.push(withDistance(s));
    else list[i].label = s.label; // nearest stop is also saved: keep its nickname
  });
  return list;
}
function renderHome() {
  const box = $("homeList"), list = homeStops();
  $("homeAsk").hidden = !!state.here || !!list.length;
  $("home").hidden = false;
  const want = list.map((s) => s.code + (s.label || "")).join(",");
  if (box.dataset.codes !== want) {
    box.dataset.codes = want;
    box.innerHTML = list.map((s) => `<div class="glance" data-home="${esc(s.code)}">${glanceShell(s)}</div>`).join("");
    enterAnim(box);
  }
  list.forEach((s) => loadHome(box.querySelector(`[data-home="${s.code}"]`), s));
  setSecCount("home", list.length ? `${list.length} stop${list.length > 1 ? "s" : ""}` : "");
  renderFavEdit();
  syncStopSheet();
}
// Edit saved stops: move up/down, rename, remove
function renderFavEdit() {
  const box = $("favEdit");
  $("favEmpty").hidden = !!favs.stops.length;
  setSecCount("savedstops", favs.stops.length ? String(favs.stops.length) : "");
  if (!favs.stops.length) { box.innerHTML = ""; return; }
  box.innerHTML = `<small>Order here is the order on your home screen. Nicknames like "Home stop" are optional.</small><ul>` +
    favs.stops.map((s, i) => `<li data-i="${i}">
      <span class="code">${esc(s.code)}</span>
      <input value="${esc(s.label || "")}" placeholder="${esc(s.name)}" aria-label="Nickname for ${esc(s.name)}" maxlength="30" />
      <button data-mv="-1" aria-label="Move ${esc(s.name)} up"${i === 0 ? " disabled" : ""}>↑</button>
      <button data-mv="1" aria-label="Move ${esc(s.name)} down"${i === favs.stops.length - 1 ? " disabled" : ""}>↓</button>
      <button class="del" data-del aria-label="Remove ${esc(s.name)}">✕</button></li>`).join("") + `</ul>`;
  box.querySelectorAll("li").forEach((li) => {
    const i = +li.dataset.i, s = favs.stops[i];
    li.querySelector("input").onchange = (e) => { s.label = e.target.value.trim() || undefined; saveFavs(); };
    li.querySelectorAll("[data-mv]").forEach((b) => (b.onclick = () => {
      const j = i + +b.dataset.mv;
      [favs.stops[i], favs.stops[j]] = [favs.stops[j], favs.stops[i]];
      saveFavs(); box.querySelector(`li[data-i="${j}"] [data-mv="${b.dataset.mv}"]`)?.focus();
    }));
    li.querySelector("[data-del]").onclick = () => { toggleStop(s); };
  });
}
function glanceShell(s, body = `<div class="skel-rows"><i></i><i></i></div>`) {
  const walk = s.metres == null ? esc(s.road || "") : s.metres > 1500 ? `${(s.metres / 1000).toFixed(1)} km away`
    : `${s.metres} m · ${Math.max(1, Math.ceil(s.metres / WALK_M_PER_MIN))} min walk`;
  const fav = isFavStop(s.code);
  return `<div class="g-head" role="button" tabindex="0" data-open="${esc(s.code)}">
      <span class="g-badge ${s.near ? "near" : "fav"}">${s.near ? "📍 Nearest" : "★ Saved"}</span>
      <b>${esc(s.label || s.name)}</b><small><span class="code">${esc(s.code)}</span>${s.label ? esc(s.name) + " · " : ""}${walk}</small></div>
    <button class="star g-star${fav ? " on" : ""}" data-star="${esc(s.code)}" aria-label="${fav ? "Remove stop from" : "Save stop to"} favourites">${fav ? "★" : "☆"}</button>
    <div class="g-body">${body}</div>`;
}
async function loadHome(el, s) {
  if (!el) return;
  const first = !el.querySelector(".g-board");
  try {
    const { services, ts, _stale } = await api(`/api/arrivals?stop=${s.code}`);
    if (!_stale) observeEta(s, services);
    const walk = s.metres != null && s.metres < 1500 ? Math.ceil(s.metres / WALK_M_PER_MIN) : null;
    el.querySelector(".g-body").innerHTML = glanceRows(s, services, walk, first) + updatedLine(ts, _stale);
  } catch (e) {
    el.querySelector(".g-body").innerHTML = `<p class="err">Couldn't load timings (${esc(e.message)}). Pull down to try again.</p>`;
  }
  wireGlance(el, s);
  renderRemind();
}
// "● Updated 12s ago": green pulsing dot while fresh, amber once it's over a minute old
function updatedLine(ts, stale) {
  if (stale) return `<div class="stale">Offline · showing times saved at ${sgTime(stale)}</div>`;
  const t = ts || Date.now();
  return `<div class="updated" data-ts="${t}"><i class="live-dot" aria-hidden="true"></i>Updated ${ago(t)}</div>`;
}
const BUS_TYPE = { SD: "Single", DD: "Double", BD: "Bendy" };
const OCC_WORD = { SEA: "Seats", SDA: "Standing", LSD: "Full" };
function glanceRows(s, services, walk, fresh) {
  const now = Date.now();
  let rows = services.map((x) => ({ ...x, next: x.next.filter((b) => !Number.isFinite(b.at) || b.at > now - 60000) }))
    .filter((x) => x.next.length)
    .map((x) => ({ ...x, first: minsTo(x.next[0]), pin: isPinned(s.code, x.service) }))
    .sort((a, b) => (b.pin - a.pin) || (a.first - b.first));
  if (!rows.length) return `<p class="muted">No buses right now. Even buses need a rest 😴</p>`;
  const anyPin = rows.some((r) => r.pin), all = rows.length, pinned = rows.filter((r) => r.pin).length;
  const limit = homeOpen[s.code] ? all : anyPin ? pinned : Math.min(4, all);
  const html = rows.slice(0, limit).map((r) => {
    const [b1, b2, b3] = r.next, m1 = minsTo(b1);
    const miss = walk != null && m1 < walk;
    const k = `home|${s.code}|${r.service}`, txt = fmtMins(m1), prev = lastLed[k];
    const changed = prev !== undefined && prev.txt !== txt, later = changed && m1 > prev.m;
    lastLed[k] = { txt, m: m1 };
    // shaky timing (ETA jumped, or GPS disagrees): show a range instead of a precise number
    const shaky = isUnstable(s.code, r.service);
    const cls = ["g-big", !b1.live && "sched", miss && "miss", m1 === 0 && "arr", b1.live && !miss && m1 <= 2 && "soon", shaky && "late",
      changed && (later ? "tick later" : "tick")].filter(Boolean).join(" ");
    const big = shaky && m1 > 0 ? `~${m1}<span class="rng">–${m1 + 3}m</span>` : txt;
    const more = [b2, b3].filter(Boolean).map((b) => `<span class="${b.live ? "" : "sched"}">${minsTo(b)}</span>`).join("");
    // approach track: the next three buses as dots sliding toward the stop (right edge = here, left = 20+ min)
    const dots = r.next.map((b, i) => {
      const m = Math.min(20, minsTo(b));
      return `<i class="${esc(b.load)}${i ? " later" : ""}" style="left:${(100 - m * 5).toFixed(1)}%" title="${minsTo(b)} min · ${CROWD_WORD[b.load] || ""}"></i>`;
    }).join("");
    const go = walk != null && !miss && m1 - walk <= 2 ? `<span class="g-go">Go now 🏃</span>` : "";
    const type = BUS_TYPE[b1.type] ? `<span>${b1.type === "DD" ? "▣" : "▭"} ${BUS_TYPE[b1.type]}</span>` : "";
    const occ = OCC_WORD[b1.load] ? `<span class="occ ${esc(b1.load)}">${OCC_WORD[b1.load]}</span>` : "";
    const wab = prefs.access && b1.wab ? `<span aria-label="wheelchair accessible">♿</span>` : "";
    const label = `${m1 === 0 ? "arriving" : shaky ? `about ${m1} to ${m1 + 3} minutes, timing unstable` : m1 + " minutes"}${b1.live ? "" : ", scheduled"}. ${BUS_TYPE[b1.type] || ""} deck, ${CROWD_WORD[b1.load] || ""}`;
    return `<div class="g-wrap${fresh ? " fresh" : ""}"><div class="g-row${r.pin ? " pinned" : ""}${shaky ? " shaky" : ""}" data-svc="${esc(r.service)}">
      <div class="g-id"><button class="g-no" data-pin="${esc(r.service)}" aria-label="Bus ${esc(r.service)}. Long-press to ${r.pin ? "unpin" : "pin"}">${r.pin ? "📌" : ""}${esc(r.service)}</button>
        <span class="g-meta">${type}${occ}${wab}</span></div>
      <span class="${cls}" aria-label="${label}">${big}</span>
      <span class="g-more">${more}${go}</span>${shaky ? `<span class="tag unstable" title="This bus's timing jumped or doesn't match its GPS">unstable</span>` : ""}
      <span class="g-track" aria-hidden="true"><b></b>${dots}<em>🚏</em></span></div></div>`;
  }).join("");
  const toggle = all > limit ? `<button class="linkbtn g-all" data-all>Show all ${all} buses</button>`
    : homeOpen[s.code] && all > (anyPin ? pinned : 4) ? `<button class="linkbtn g-all" data-all>Show fewer</button>` : "";
  return `<div class="g-board">${html}</div>${toggle}<p class="g-tip">Swipe a bus ← for a 🔔 reminder, → to 📌 pin</p>`;
}
function wireGlance(el, s) {
  wireStar(el, s);
  const head = el.querySelector("[data-open]");
  const open = () => showArrivals(s, true);
  head.onclick = open;
  head.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } };
  const all = el.querySelector("[data-all]");
  if (all) all.onclick = () => { homeOpen[s.code] = !homeOpen[s.code]; loadHome(el, s); };
  el.querySelectorAll("[data-pin]").forEach((btn) => {
    let t = null, long = false;
    const pin = () => { long = true; navigator.vibrate?.(30); togglePin(s.code, btn.dataset.pin); loadHome(el, s); };
    btn.addEventListener("pointerdown", () => { long = false; btn.classList.add("holding"); t = setTimeout(pin, 500); });
    ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => btn.addEventListener(ev, () => { clearTimeout(t); btn.classList.remove("holding"); }));
    btn.addEventListener("contextmenu", (e) => { e.preventDefault(); if (!long) pin(); });
    btn.onclick = () => { if (!long) open(); };
  });
  // swipe a bus row: left = remind me, right = pin
  el.querySelectorAll(".g-row").forEach((row) => {
    const wrap = row.parentElement, svc = row.dataset.svc;
    let x0 = null, y0 = 0, dx = 0, on = false;
    row.addEventListener("pointerdown", (e) => { if (e.pointerType === "mouse" && e.button) return; x0 = e.clientX; y0 = e.clientY; dx = 0; on = false; });
    row.addEventListener("pointermove", (e) => {
      if (x0 == null) return;
      dx = e.clientX - x0;
      if (!on && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(e.clientY - y0) * 1.5) { on = true; row.classList.add("drag"); row.setPointerCapture?.(e.pointerId); }
      if (!on) return;
      const d = Math.max(-120, Math.min(120, dx));
      row.style.transform = `translateX(${d}px)`;
      wrap.classList.toggle("sw-l", d < -24); wrap.classList.toggle("sw-r", d > 24);
    });
    const end = () => {
      if (x0 == null) return;
      x0 = null;
      row.classList.remove("drag"); row.style.transform = "";
      wrap.classList.remove("sw-l", "sw-r");
      if (!on) return;
      row.dataset.swiped = "1"; setTimeout(() => delete row.dataset.swiped, 350);
      if (dx < -80) { navigator.vibrate?.(20); openRemind(s, svc); }
      else if (dx > 80) { navigator.vibrate?.(30); togglePin(s.code, svc); loadHome(el, s); }
    };
    row.addEventListener("pointerup", end); row.addEventListener("pointercancel", end);
  });
}
function refreshHome() {
  homeStops().forEach((s) => loadHome($("homeList").querySelector(`[data-home="${s.code}"]`), s));
}

// ================= "Remind me" bus alerts (in-app) =================
// Tap a bus time, pick "when 2 / 3 / 5 min away". While CanGo SG stays open on screen,
// it checks every 15 s and buzzes + beeps (and shows a notification if allowed).
// A web page is paused when the phone locks, so we keep the screen awake and say so plainly.
// Alerts with the phone locked need server push, which comes with deploying.
const remind = { list: [], timer: null, wake: null, audio: null };
function openRemind(stop, svc) {
  const sh = $("remindSheet");
  sh.querySelector("#remTitle").textContent = `Bus ${svc} at ${stop.label || stop.name}`;
  sh.hidden = false;
  sh.querySelectorAll("[data-lead]").forEach((b) => (b.onclick = () => { addRemind(stop, svc, +b.dataset.lead); sh.hidden = true; }));
  sh.querySelector("#remCancel").onclick = () => (sh.hidden = true);
  sh.querySelector("[data-lead]").focus();
}
async function addRemind(stop, svc, lead) {
  // set up sound now: browsers only allow audio that starts from a tap
  try { remind.audio = remind.audio || new (window.AudioContext || window.webkitAudioContext)(); remind.audio.resume?.(); } catch {}
  if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
  remind.list = remind.list.filter((r) => !(r.code === stop.code && r.svc === svc));
  remind.list.push({ code: stop.code, name: stop.label || stop.name, svc, lead, until: Date.now() + 60 * 60000 });
  toast(`🔔 We'll buzz when bus ${svc} is ${lead} min away. Keep CanGo SG open`);
  renderRemind();
  checkRemind();
}
function dropRemind(i) { remind.list.splice(i, 1); renderRemind(); }
function renderRemind() {
  const bar = $("remindBar");
  bar.hidden = !remind.list.length;
  bar.innerHTML = remind.list.map((r, i) =>
    `<div class="rem"><span>🔔 <b>Bus ${esc(r.svc)}</b> · ${esc(r.name)}<small>Buzz when ${r.lead} min away · keep CanGo SG open</small></span>
      <button class="banner-x" data-drop="${i}" aria-label="Cancel reminder for bus ${esc(r.svc)}">✕</button></div>`).join("");
  bar.querySelectorAll("[data-drop]").forEach((b) => (b.onclick = () => dropRemind(+b.dataset.drop)));
  document.querySelectorAll(".g-row").forEach((row) => {
    const code = row.closest("[data-home]")?.dataset.home;
    row.classList.toggle("reminded", remind.list.some((r) => r.code === code && r.svc === row.dataset.svc));
  });
  if (remind.list.length && !remind.timer) remind.timer = setInterval(checkRemind, 15000);
  if (!remind.list.length && remind.timer) { clearInterval(remind.timer); remind.timer = null; }
  holdScreen();
}
async function holdScreen() {
  try {
    if (remind.list.length && !remind.wake && navigator.wakeLock && document.visibilityState === "visible") {
      remind.wake = await navigator.wakeLock.request("screen");
      remind.wake.addEventListener?.("release", () => (remind.wake = null));
    } else if (!remind.list.length && remind.wake) { remind.wake.release().catch(() => {}); remind.wake = null; }
  } catch {}
}
document.addEventListener("visibilitychange", () => { if (remind.list.length && !document.hidden) { holdScreen(); checkRemind(); } });
async function checkRemind() {
  const now = Date.now();
  remind.list = remind.list.filter((r) => r.until > now);
  for (const r of [...remind.list]) {
    try {
      const { services, _stale } = await api(`/api/arrivals?stop=${r.code}`);
      if (_stale) continue;
      const s = services.find((x) => x.service === r.svc);
      const b = s?.next.find((x) => !Number.isFinite(x.at) || x.at > Math.max(now - 30000, (r.skipAt || 0) + 30000));
      if (!b) continue;
      const m = minsTo(b);
      // first check: this bus is already closer than asked, so watch the one after it instead
      if (!r.checked && m <= r.lead && Number.isFinite(b.at)) { r.skipAt = b.at; r.checked = true; toast(`Bus ${r.svc} is already ${m === 0 ? "arriving" : m + " min away"}. We'll remind you for the next one`); continue; }
      r.checked = true;
      if (m <= r.lead) fireRemind(r, m);
    } catch {}
  }
  renderRemind();
}
function fireRemind(r, m) {
  remind.list = remind.list.filter((x) => x !== r);
  const msg = `Bus ${r.svc} is ${m === 0 ? "arriving" : m + " min away"} at ${r.name}`;
  navigator.vibrate?.([400, 150, 400, 150, 400]);
  try {
    const a = remind.audio;
    if (a) [0, 0.3, 0.6].forEach((dt) => {
      const o = a.createOscillator(), g = a.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(a.destination);
      g.gain.setValueAtTime(0.0001, a.currentTime + dt);
      g.gain.exponentialRampToValueAtTime(0.3, a.currentTime + dt + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dt + 0.2);
      o.start(a.currentTime + dt); o.stop(a.currentTime + dt + 0.22);
    });
  } catch {}
  if ("Notification" in window && Notification.permission === "granted") {
    navigator.serviceWorker?.ready.then((reg) => reg.showNotification("🚌 Time to go", { body: msg, tag: `rem-${r.code}-${r.svc}`, vibrate: [400, 150, 400] }))
      .catch(() => { try { new Notification("🚌 Time to go", { body: msg }); } catch {} });
  }
  const pop = $("remindPop");
  pop.querySelector("b").textContent = "🚌 Time to go!";
  pop.querySelector("span").textContent = msg;
  pop.hidden = false;
  pop.querySelector("button").onclick = () => (pop.hidden = true);
}
// tap a big countdown on a home card, or a bus row on a stop's board, to set a reminder
function setupRemind() {
  document.addEventListener("click", (e) => {
    const big = e.target.closest(".g-big, .g-more");
    if (big && big.closest(".g-row")?.dataset.swiped) return;
    if (big) {
      const code = big.closest("[data-home]")?.dataset.home, svc = big.closest(".g-row")?.dataset.svc;
      const stop = homeStops().find((s) => s.code === code);
      if (stop && svc) openRemind(stop, svc);
      return;
    }
    const row = e.target.closest("#arrivals .svc");
    if (row && state.activeStop) openRemind(state.activeStop, row.querySelector(".no").textContent.trim());
  });
  addEventListener("keydown", (e) => { if (e.key === "Escape") $("remindSheet").hidden = true; });
}

// ================= app shell: tabs, sheets, thumb bar, themes, illustrations =================
function setTab(name) {
  document.querySelectorAll(".view").forEach((v) => (v.hidden = v.dataset.view !== name));
  document.querySelectorAll("[data-tab]").forEach((b) => (b.dataset.tab === name ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")));
  $("thumbbar").classList.toggle("off", !["home", "nearby"].includes(name));
  try { sessionStorage.setItem("gosg.tab", name); } catch {}
  scrollTo({ top: 0 });
  if (name === "map") {
    mapDock("map");
    if (state.here) { ensureMap(); $("mapEmpty").hidden = true; setTimeout(() => map.m?.invalidateSize(), 60); }
  }
  if (name === "favs") renderFavEdit();
}
let sheetReturn = null;
function openSheet(id) {
  const sh = $(id);
  if (!sh.hidden) return;
  sheetReturn = document.activeElement;
  sh.hidden = false;
  document.body.classList.add("sheet-open");
  if (id === "planSheet") { mapDock("plan"); setTimeout(() => (!state.to ? $("to").focus() : null), 300); }
}
function closeSheet(id) {
  const sh = $(id);
  if (sh.hidden) return;
  sh.hidden = true;
  if (![...document.querySelectorAll(".sheet")].some((x) => !x.hidden)) document.body.classList.remove("sheet-open");
  if (id === "planSheet") mapDock("map");
  if (id === "stopSheet") state.sheetStop = null;
  sheetReturn?.focus?.();
}
function setupSheets() {
  document.querySelectorAll(".sheet").forEach((sh) => {
    sh.addEventListener("click", (e) => { if (e.target === sh || e.target.closest("[data-close]")) closeSheet(sh.id); });
    // drag the grab handle (or the top of the sheet) down to close
    const card = sh.querySelector(".sheet-card"), grab = sh.querySelector(".grab");
    let y0 = null, dy = 0;
    const start = (e) => { y0 = e.clientY; dy = 0; card.style.transition = "none"; };
    grab?.addEventListener("pointerdown", (e) => { start(e); grab.setPointerCapture?.(e.pointerId); });
    sh.querySelector(".sheet-head, .sheet-k")?.addEventListener("pointerdown", start);
    sh.addEventListener("pointermove", (e) => { if (y0 == null) return; dy = Math.max(0, e.clientY - y0); card.style.transform = `translateY(${dy}px)`; });
    const end = () => {
      if (y0 == null) return;
      y0 = null; card.style.transition = ""; card.style.transform = "";
      if (dy > 90) closeSheet(sh.id);
    };
    sh.addEventListener("pointerup", end); sh.addEventListener("pointercancel", end);
  });
  addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const open = [...document.querySelectorAll(".sheet")].reverse().find((x) => !x.hidden);
    if (open) closeSheet(open.id);
  });
  $("ssFav").onclick = () => state.activeStop && toggleStop(state.activeStop);
  $("ssMap").onclick = () => {
    const s = state.activeStop; closeSheet("stopSheet"); setTab("map");
    if (s && ensureMap()) { $("mapEmpty").hidden = true; setTimeout(() => map.m.flyTo([s.lat, s.lng], 17, { duration: 0.7 }), 120); }
  };
  $("ssRefresh").onclick = () => state.activeStop && showArrivals(state.activeStop);
}
function syncStopSheet() {
  const s = state.activeStop, on = s && isFavStop(s.code);
  $("ssFav").textContent = on ? "★ Saved" : "☆ Save";
  $("ssFav").classList.toggle("on", !!on);
}
function setupShell() {
  document.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
  $("whereBtn").onclick = () => openSheet("planSheet");
  $("refreshBtn").onclick = async () => {
    const b = $("refreshBtn");
    b.classList.add("spin");
    refreshAll(); await loadAlerts().catch(() => {});
    setTimeout(() => b.classList.remove("spin"), 700);
    toast("↻ Bus times refreshed");
  };
  $("mapLoc").onclick = locate;
  document.querySelectorAll(".themes [data-theme]").forEach((b) => (b.onclick = () => { prefs.theme = b.dataset.theme; savePrefs(); applyPrefs(); }));
  document.querySelectorAll("[data-illo]").forEach((el) => (el.innerHTML = illo(el.dataset.illo)));
  setupSheets();
  let tab = "home";
  try { tab = sessionStorage.getItem("gosg.tab") || "home"; } catch {}
  setTab(tab);
}
// Little Singapore scenes for empty and loading states: HDB blocks, a tree, a bus rolling past.
function illo(kind) {
  const h = Number(new Date().toLocaleString("en-GB", { hour: "numeric", hour12: false, timeZone: "Asia/Singapore" }));
  const night = h < 7 || h >= 19;
  const sky = night ? `<circle cx="262" cy="26" r="11" fill="#ffd77a"/><circle cx="267" cy="22" r="10" fill="var(--card)"/>
      <circle class="twinkle" cx="60" cy="20" r="1.6" fill="#ffd77a"/><circle class="twinkle" cx="200" cy="14" r="1.4" fill="#ffd77a" style="animation-delay:.8s"/>`
    : `<circle cx="262" cy="28" r="13" fill="#ffc94d" opacity=".9"/>`;
  const win = (x, y, w, hgt) => {
    let r = "";
    for (let yy = y + 8; yy < y + hgt - 6; yy += 9) for (let xx = x + 6; xx < x + w - 6; xx += 9)
      r += `<rect x="${xx}" y="${yy}" width="4" height="4" rx="1" fill="${night && (xx * yy) % 7 < 3 ? "#ffd77a" : "currentColor"}" opacity="${night ? ".85" : ".18"}"/>`;
    return r;
  };
  const blocks = [[20, 46, 46, 70], [74, 30, 40, 86], [190, 40, 48, 76], [244, 54, 40, 62]]
    .map(([x, y, w, hgt]) => `<rect x="${x}" y="${y}" width="${w}" height="${hgt}" rx="4" fill="currentColor" opacity=".09"/>${win(x, y, w, hgt)}`).join("");
  const extra = kind === "star" ? `<path transform="translate(140 22)" d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" fill="#ffc94d"/>`
    : kind === "search" || kind === "map" ? `<g transform="translate(138 18)"><path d="M12 2a9 9 0 0 0-9 9c0 6.5 9 16 9 16s9-9.5 9-16a9 9 0 0 0-9-9z" fill="var(--accent)"/><circle cx="12" cy="11" r="3.5" fill="#fff"/></g>` : "";
  return `<svg viewBox="0 0 300 130" role="img" aria-hidden="true" style="color:var(--ink)">
    ${sky}${blocks}
    <g transform="translate(150 70)"><rect x="-2" y="12" width="4" height="34" fill="currentColor" opacity=".2"/><circle cx="0" cy="8" r="16" fill="#2fa36b" opacity=".55"/></g>
    ${extra}
    <rect x="0" y="116" width="300" height="3" rx="1.5" fill="currentColor" opacity=".15"/>
    <g class="bus-go"><g transform="translate(0 92)">
      <rect width="62" height="22" rx="6" fill="var(--accent)"/><rect x="4" y="4" width="10" height="8" rx="2" fill="#fff" opacity=".85"/>
      <rect x="17" y="4" width="10" height="8" rx="2" fill="#fff" opacity=".85"/><rect x="30" y="4" width="10" height="8" rx="2" fill="#fff" opacity=".85"/>
      <rect x="44" y="4" width="14" height="12" rx="2" fill="#fff" opacity=".85"/><rect x="54" y="15" width="6" height="3" rx="1" fill="#ffc94d"/>
      <circle cx="14" cy="23" r="4.5" fill="#222"/><circle cx="48" cy="23" r="4.5" fill="#222"/></g></g>
  </svg>`;
}

// ================= banners =================
// Each banner can be closed. It stays closed for this visit until its message changes.
const hashStr = (t) => { let h = 0; for (const c of t) h = (h * 31 + c.charCodeAt(0)) | 0; return String(h); };
function setBanner(id, html, show, kind = "") {
  const el = $(id);
  el.className = `banner${kind ? " " + kind : ""}`;
  el.querySelector(".banner-body").innerHTML = html;
  el.dataset.h = hashStr(html);
  let closed = false;
  try { closed = sessionStorage.getItem("gosg.closed." + id) === el.dataset.h; } catch {}
  el.hidden = !show || closed;
}
function setupBanners() {
  document.querySelectorAll(".banner-x").forEach((b) => (b.onclick = () => {
    const el = b.closest(".banner");
    el.hidden = true;
    try { sessionStorage.setItem("gosg.closed." + el.id, el.dataset.h || ""); } catch {}
  }));
}

// ================= alerts & weather =================
async function loadAlerts() {
  try {
    const d = await api("/api/alerts");
    state.avoid = d.disrupted ? [...new Set(d.lines.map((l) => l.prefix).filter(Boolean))] : [];
    if (!d.disrupted) return setBanner("alert", "✓ MRT and LRT running normally", true);
    const shuttle = d.lines.find((l) => l.shuttle)?.shuttle;
    const head = d.lines.map((l) => `<b>⚠ ${esc(l.line)} disrupted${l.stations ? `: ${esc(l.stations)}` : ""}</b>`).join("");
    const more = [
      shuttle && `Free bus or shuttle: ${esc(Array.isArray(shuttle) ? shuttle.join(", ") : shuttle)}`,
      d.messages[0] && esc(d.messages[0]),
      "Routes that avoid this line are shown first.",
    ].filter(Boolean).map((t) => `<p>${t}</p>`).join("");
    setBanner("alert", `${head}<details class="key"><summary>Details</summary>${more}</details>`, true, "bad");
  } catch {
    setBanner("alert", "MRT status unavailable right now", true);
  }
}

async function loadWeather(lat, lng) {
  try {
    state.rain = await api(`/api/weather?lat=${lat}&lng=${lng}`);
  } catch { state.rain = null; }
  setBanner("rain", state.rain?.raining ? `🌧 ${esc(state.rain.forecast)} near ${esc(state.rain.area)}. Showing routes with less walking first.` : "",
    !!state.rain?.raining, "rain");
}

// ================= map =================
const map = { m: null, stops: null, route: null, me: null, dock: "map" };
function ensureMap() {
  if (map.m || !window.L) return map.m;
  $("mapWrap").hidden = false;
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  map.m = L.map("map", {
    center: [1.3521, 103.8198], zoom: 12, minZoom: 11, maxZoom: 19,
    maxBounds: L.latLngBounds([1.144, 103.535], [1.494, 104.502]),
    zoomControl: false, attributionControl: true, zoomSnap: 0.5,
  });
  // OneMap's calm "Grey" style by day; "Night" after dark, toned down in CSS so the route stands out
  L.tileLayer(`https://www.onemap.gov.sg/maps/tiles/${dark ? "Night" : "Grey"}/{z}/{x}/{y}.png`, {
    detectRetina: true, maxZoom: 19, minZoom: 11, className: "base-tiles",
    attribution: '<img src="https://www.onemap.gov.sg/web-assets/images/logo/om_logo.png" style="height:14px;width:14px;vertical-align:-2px" alt=""/> ' +
      '<a href="https://www.onemap.gov.sg/" target="_blank" rel="noopener">OneMap</a> &copy; contributors | ' +
      '<a href="https://www.sla.gov.sg/" target="_blank" rel="noopener">Singapore Land Authority</a>',
  }).addTo(map.m);
  map.stops = L.layerGroup().addTo(map.m);
  map.route = L.layerGroup().addTo(map.m);
  map.buses = L.layerGroup().addTo(map.m);
  map.m.on("click", () => focusLeg(null));
  $("mapIn").onclick = () => map.m.zoomIn();
  $("mapOut").onclick = () => map.m.zoomOut();
  $("mapFit").onclick = mapFitAll;
  $("mapMe").onclick = () => (state.here ? map.m.flyTo([state.here.lat, state.here.lng], 17, { duration: 0.8 }) : locate());
  $("mapBig").onclick = () => {
    const big = $("mapWrap").classList.toggle("big");
    $("mapBig").setAttribute("aria-pressed", String(big));
    $("mapBig").textContent = big ? "⤡" : "⤢";
    setTimeout(() => { map.m.invalidateSize(); mapFitAll(); }, 320);
  };
  setTimeout(() => map.m.invalidateSize(), 50);
  return map.m;
}
function mapFitAll() {
  if (!map.m) return;
  if (map.bounds) return map.m.flyToBounds(map.bounds, { padding: [36, 36], duration: 0.7 });
  if (state.here) map.m.flyTo([state.here.lat, state.here.lng], 16, { duration: 0.7 });
}
function mapShowMe() {
  if (!ensureMap() || !state.here) return;
  const ll = [state.here.lat, state.here.lng];
  if (map.me) map.me.setLatLng(ll);
  else map.me = L.marker(ll, { icon: L.divIcon({ className: "me-mk", html: "<i></i>", iconSize: [18, 18] }), keyboard: false, zIndexOffset: 800 })
    .addTo(map.m).bindTooltip("You are here");
}
function mapShowStops(stops) {
  if (!ensureMap()) return;
  map.stops.clearLayers();
  stops.forEach((s) => {
    L.circleMarker([s.lat, s.lng], { radius: 6, color: "#3b4a57", weight: 2, fillColor: "#fff", fillOpacity: 1 })
      .addTo(map.stops).bindTooltip(s.name).on("click", () => showArrivals(s, true));
  });
  if (!map.route.getLayers().length && state.here) {
    const pts = [[state.here.lat, state.here.lng], ...stops.map((s) => [s.lat, s.lng])];
    map.m.fitBounds(pts, { padding: [24, 24], maxZoom: 17 });
  }
}
// Live bus positions for the selected stop (next bus of each service).
// Markers are kept between refreshes and glide to their new GPS spot; in between
// refreshes each bus creeps toward the stop at the pace its ETA implies.
function mapShowBuses(stop, services, fit) {
  if (!ensureMap()) return;
  map.busMk = map.busMk || {};
  if (map.busStop !== stop.code) { map.buses.clearLayers(); map.busMk = {}; map.busStop = stop.code; }
  const pts = stop.lat != null ? [[stop.lat, stop.lng]] : [];
  const seen = new Set();
  services.forEach((s) => {
    const b = s.next.find((x) => x.lat != null);
    if (!b) return;
    seen.add(s.service);
    const m = minsTo(b);
    const html = `<span class="${esc(b.load)}${m <= 1 ? " close" : ""}">${esc(s.service)}<small>${m === 0 ? "Arr" : m + "′"}</small></span>`;
    const tip = `<b>Bus ${esc(s.service)}</b> · ${m === 0 ? "arriving" : m + " min"}${b.live ? "" : " (scheduled)"}<br>` +
      `${{ SEA: "🟢 Seats available", SDA: "🟡 Standing room", LSD: "🔴 Very full" }[b.load] || ""}` +
      `${b.type === "DD" ? " · Double deck" : b.type === "BD" ? " · Bendy bus" : ""}${b.wab ? " · ♿" : ""}`;
    let mk = map.busMk[s.service];
    if (mk) {
      glide(mk, [b.lat, b.lng]);
      mk.setIcon(L.divIcon({ className: "bus-mk", html, iconSize: null }));
      mk.setTooltipContent(tip);
      if (mk.trail) mk.trail.setLatLngs([[b.lat, b.lng], [stop.lat, stop.lng]]);
    } else {
      mk = L.marker([b.lat, b.lng], { icon: L.divIcon({ className: "bus-mk", html, iconSize: null }), keyboard: false, zIndexOffset: 500 })
        .addTo(map.buses).bindTooltip(tip, { direction: "top", offset: [0, -12], className: "leg-tip" });
      mk.trail = L.polyline([[b.lat, b.lng], [stop.lat, stop.lng]], { color: "#8a949c", weight: 2, opacity: 0.5, dashArray: "3 6", interactive: false }).addTo(map.buses);
      mk.on("click", () => { focusBus(s.service); mk.openTooltip(); });
      map.busMk[s.service] = mk;
    }
    mk.eta = b.at; mk.stopLL = [stop.lat, stop.lng];
    pts.push([b.lat, b.lng]);
  });
  Object.keys(map.busMk).forEach((k) => {
    if (seen.has(k)) return;
    const mk = map.busMk[k];
    if (mk.trail) map.buses.removeLayer(mk.trail);
    map.buses.removeLayer(mk); delete map.busMk[k];
  });
  if (!map.stopMk || map.stopMk.code !== stop.code) {
    map.stopMk?.remove();
    map.stopMk = L.marker([stop.lat, stop.lng], { icon: L.divIcon({ className: "stop-mk", html: "<span>🚏</span>", iconSize: [30, 30] }), zIndexOffset: 400 })
      .addTo(map.buses).bindTooltip(esc(stop.name));
    map.stopMk.code = stop.code;
  }
  if (fit && pts.length > 1 && map.dock !== "plan") map.m.flyToBounds(pts, { padding: [40, 40], maxZoom: 16, duration: 0.7 });
  if (!map.creep) map.creep = setInterval(creepBuses, 1000);
}
// smooth move from where the marker is now to a new spot
function glide(mk, to, ms = 1200) {
  const from = mk.getLatLng(), t0 = performance.now();
  if (reduceMotion.matches) return mk.setLatLng(to);
  cancelAnimationFrame(mk.raf);
  const step = (now) => {
    const k = Math.min(1, (now - t0) / ms), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    mk.setLatLng([from.lat + (to[0] - from.lat) * e, from.lng + (to[1] - from.lng) * e]);
    if (mk.trail) mk.trail.setLatLngs([mk.getLatLng(), mk.stopLL || to]);
    if (k < 1) mk.raf = requestAnimationFrame(step);
  };
  mk.raf = requestAnimationFrame(step);
}
// between refreshes, nudge each bus along the straight line to the stop by 1 s of its ETA
function creepBuses() {
  if (document.hidden || !map.busMk || reduceMotion.matches) return;
  Object.values(map.busMk).forEach((mk) => {
    if (!mk.stopLL || !Number.isFinite(mk.eta)) return;
    const left = (mk.eta - Date.now()) / 1000;
    if (left <= 1) return;
    const p = mk.getLatLng(), f = Math.min(0.5, 1 / left);
    mk.setLatLng([p.lat + (mk.stopLL[0] - p.lat) * f, p.lng + (mk.stopLL[1] - p.lng) * f]);
    if (mk.trail) mk.trail.setLatLngs([mk.getLatLng(), mk.stopLL]);
  });
}
// tap a bus on the map: highlight its row on the board
function focusBus(svc) {
  document.querySelectorAll("#arrivals .svc").forEach((row) => {
    const on = row.querySelector(".no")?.textContent.trim() === svc;
    row.classList.toggle("lit", on);
    if (on) row.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
}
// The one map moves between "Plan a trip" (routes) and "Buses near you" (live buses)
function mapDock(where) {
  const wrap = $("mapWrap");
  if (!wrap || map.dock === where) return;
  map.dock = where;
  if (where === "map") $("mapHost").prepend(wrap);
  else $("planMapHost").appendChild(wrap);
  if (map.m) {
    if (where === "plan") { map.route.addTo(map.m); map.buses.remove(); }
    else { map.route.addTo(map.m); map.buses.addTo(map.m); }
    setTimeout(() => map.m.invalidateSize(), 60);
  }
  wrap.querySelector(".map-tip").textContent = where === "plan" ? "Tap a line on the map for details" : "Buses move live · tap one for details";
}

const pinIcon = (cls, txt) => L.divIcon({ className: `pin-mk ${cls}`, html: `<span><b>${txt}</b></span>`, iconSize: [30, 38], iconAnchor: [15, 36], tooltipAnchor: [0, -34] });
const legLabel = (l) => (l.mode === "WALK" ? `🚶 Walk ${l.minutes} min · ${l.metres} m`
  : `${l.mode === "BUS" ? "🚌 Bus" : "🚆"} ${esc(l.route)} · ${l.stops != null ? l.stops + 1 + " stops · " : ""}${l.minutes} min<br><small>${esc(l.from)} → ${esc(l.to)}</small>`);
// Tap a leg on the map to highlight it and fade the rest; tap empty map to show all again
function focusLeg(i) {
  if (!map.legs) return;
  map.legs.forEach((g, k) => {
    if (!g) return;
    const on = i == null || k === i;
    g.lines.forEach((p) => p.setStyle({ opacity: on ? 1 : 0.18 }));
    if (k === i) g.lines.forEach((p) => p.bringToFront());
  });
  const g = i != null && map.legs[i];
  if (g) {
    map.m.flyToBounds(g.bounds, { padding: [40, 40], maxZoom: 17, duration: 0.6 });
    g.hit.openTooltip(g.bounds.getCenter());
  }
  document.querySelectorAll(".card.route.selected .rail li").forEach((li, k) => li.classList.toggle("lit", k === i));
}
function mapShowRoute(it) {
  if (!ensureMap()) return;
  mapDock("plan");
  map.route.clearLayers();
  if (map.pin) { map.pin.remove(); map.pin = null; }
  clearTimeout(map.comet);
  const css = getComputedStyle(document.documentElement);
  const all = [];
  map.legs = [];
  it.legs.forEach((l, i) => {
    if (!l.points) { map.legs.push(null); return; }
    const pts = decodePolyline(l.points);
    all.push(...pts);
    const color = l.mode === "WALK" ? "#8a949c" : l.mode === "BUS" ? css.getPropertyValue("--bus").trim() || "#3b4a57"
      : css.getPropertyValue(lineVar(l.route)).trim() || "#3b4a57";
    const lines = [];
    if (l.mode === "WALK") {
      lines.push(L.polyline(pts, { color, weight: 4, opacity: 0.9, dashArray: "2 8", lineCap: "round", interactive: false }).addTo(map.route));
    } else {
      // white casing under each ride leg, like a printed strip map, then the line "draws" itself
      const casing = L.polyline(pts, { color: "#ffffff", weight: 11, opacity: 1, lineCap: "round", lineJoin: "round", interactive: false }).addTo(map.route);
      const line = L.polyline(pts, { color, weight: 7, opacity: 1, lineCap: "round", lineJoin: "round", className: "route-line", interactive: false }).addTo(map.route);
      [casing, line].forEach((p) => p._path && p._path.setAttribute("pathLength", "1"));
      if (casing._path) casing._path.classList.add("route-line");
      lines.push(casing, line);
      // service badge in the middle of the leg, and a dot where you board
      const mid = pts[Math.floor(pts.length / 2)];
      L.marker(mid, { icon: L.divIcon({ className: "leg-mk", html: `<span style="background:${color}">${l.mode === "BUS" ? "🚌 " : ""}${esc(l.route)}</span>`, iconSize: null }),
        keyboard: false, interactive: false, zIndexOffset: 300 }).addTo(map.route);
      L.circleMarker(pts[0], { radius: 5, color, weight: 3, fillColor: "#fff", fillOpacity: 1, interactive: false }).addTo(map.route);
    }
    // a wide invisible line on top makes the leg easy to tap
    const hit = L.polyline(pts, { weight: 26, opacity: 0 }).addTo(map.route)
      .bindTooltip(legLabel(l), { sticky: true, direction: "top", offset: [0, -14], className: "leg-tip" });
    hit.on("click", (e) => { L.DomEvent.stop(e); focusLeg(i); });
    map.legs.push({ lines, hit, bounds: L.latLngBounds(pts) });
  });
  if (all.length) {
    L.marker(all[0], { icon: pinIcon("a", "A"), zIndexOffset: 900 }).addTo(map.route).bindTooltip(`Start · ${esc(it.legs[0].from || "")}`);
    L.marker(all[all.length - 1], { icon: pinIcon("b", "🏁"), zIndexOffset: 900 }).addTo(map.route).bindTooltip(`End · ${esc(state.to?.name || it.legs.at(-1).to || "")}`);
    map.bounds = L.latLngBounds(all);
    map.m.flyToBounds(map.bounds, { padding: [36, 36], duration: 0.6 });
    // after the line draws, a glowing dot runs along the trip once
    if (!reduceMotion.matches) map.comet = setTimeout(() => runComet(all), 900);
  }
}
function runComet(pts) {
  if (pts.length < 2) return;
  const dot = L.marker(pts[0], { icon: L.divIcon({ className: "comet-mk", html: "<i></i>", iconSize: [14, 14] }), interactive: false, keyboard: false }).addTo(map.route);
  const t0 = performance.now(), dur = 2200;
  const step = (now) => {
    const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 2);
    dot.setLatLng(pts[Math.min(pts.length - 1, Math.floor(e * (pts.length - 1)))]);
    if (k < 1 && map.route.hasLayer(dot)) requestAnimationFrame(step);
    else setTimeout(() => dot.remove(), 300);
  };
  requestAnimationFrame(step);
}

// Highlight one boarding stop/station from a route and zoom to it
function mapShowPin(leg) {
  if (!ensureMap() || leg?.fromLat == null) return;
  mapDock("plan");
  if (map.pin) map.pin.remove();
  map.pin = L.circleMarker([leg.fromLat, leg.fromLng], { radius: 11, color: "#fff", weight: 3, fillColor: "#f2a900", fillOpacity: 1 })
    .addTo(map.m)
    .bindTooltip(`${leg.mode === "BUS" ? "Board bus " + esc(leg.route) + " here" : "Board here"}<br><b>${esc(leg.from)}</b>${leg.fromStopCode ? ` (${esc(leg.fromStopCode)})` : ""}`, { permanent: true, direction: "top", offset: [0, -10] });
  map.m.setView([leg.fromLat, leg.fromLng], 18);
  $("mapWrap").scrollIntoView({ behavior: "smooth", block: "center" });
}

// ================= traffic =================
// Road incidents from LTA, refreshed at most every 2 minutes. Fails quietly without an LTA key.
let traffic = { at: 0, list: [] };
async function loadTraffic() {
  if (Date.now() - traffic.at < 120000) return traffic.list;
  try { traffic = { at: Date.now(), list: (await api("/api/traffic")).incidents || [] }; }
  catch { traffic = { at: Date.now(), list: [] }; }
  return traffic.list;
}
// Incidents within ~150 m of a bus leg's path. MRT legs aren't affected by road traffic.
async function showJams(card, it) {
  const box = card.querySelector("[data-jam]");
  const busLegs = it.legs.filter((l) => l.mode === "BUS" && l.points);
  if (!box || !busLegs.length) return;
  const list = await loadTraffic();
  if (!list.length) return;
  const hits = [];
  busLegs.forEach((l) => {
    const pts = decodePolyline(l.points);
    list.forEach((inc) => {
      if (hits.some((h) => h.inc === inc)) return;
      if (pts.some(([la, ln]) => haversine(la, ln, inc.lat, inc.lng) < 150)) hits.push({ inc, bus: l.route });
    });
  });
  if (!hits.length) return;
  box.innerHTML = hits.slice(0, 3).map((h) =>
    `<div>🚧 <b>${esc(h.inc.type)}</b> on bus ${esc(h.bus)}'s route: ${esc(h.inc.message)}. Expect delays.</div>`).join("");
}

// ================= ride mode =================
// Follows a chosen route step by step: "3 stops to go", then buzz + beep before your stop.
// Uses GPS while riding (and only then), falling back to the timetable when GPS is weak,
// e.g. underground on the MRT. Keeps the screen awake so the page isn't paused mid-ride.
const ride = { it: null, i: 0, k: 0, fix: null, watch: null, wake: null, timer: null, warned: {}, audio: null, atStop: false, done: false };
const isRideLeg = (l) => l && l.mode !== "WALK";

function startRide(it) {
  closeSheet("planSheet");
  endRide();
  Object.assign(ride, { it, i: 0, k: 0, fix: null, warned: {}, atStop: false, done: false });
  try { ride.audio = new (window.AudioContext || window.webkitAudioContext)(); } catch {} // unlocked by this tap
  if (navigator.geolocation) {
    ride.watch = navigator.geolocation.watchPosition(
      (p) => { ride.fix = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, at: Date.now() }; rideTick(); },
      () => {}, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  }
  keepAwake();
  ride.timer = setInterval(rideTick, 5000);
  $("ride").hidden = false;
  $("rideSkip").hidden = false;
  document.body.classList.add("riding");
  rideTick();
}
function endRide() {
  if (ride.watch != null) navigator.geolocation.clearWatch(ride.watch);
  clearInterval(ride.timer);
  ride.wake?.release?.().catch(() => {});
  Object.assign(ride, { it: null, watch: null, wake: null, timer: null });
  if (map.rider) { map.rider.remove(); map.rider = null; }
  $("ride").hidden = true;
  $("ride").classList.remove("alert", "now");
  document.body.classList.remove("riding");
}
async function keepAwake() {
  try { if (ride.it && navigator.wakeLock && document.visibilityState === "visible") ride.wake = await navigator.wakeLock.request("screen"); } catch {}
}
document.addEventListener("visibilitychange", () => { if (ride.it) { keepAwake(); rideTick(); } });

function rideNextStep() {
  if (!ride.it || ride.done) return;
  if (ride.i >= ride.it.legs.length - 1) return arrive();
  ride.i++; ride.k = 0; ride.atStop = false;
  $("ride").classList.remove("alert", "now");
  rideTick();
}

function rideAlert(key, strong) {
  if (ride.warned[key]) return;
  ride.warned[key] = true;
  navigator.vibrate?.(strong ? [400, 150, 400, 150, 400] : [250, 120, 250]);
  try {
    const a = ride.audio; if (a) {
      a.resume?.();
      [0, 0.25, strong ? 0.5 : null].filter((x) => x != null).forEach((dt) => {
        const o = a.createOscillator(), g = a.createGain();
        o.frequency.value = strong ? 880 : 660; o.connect(g); g.connect(a.destination);
        g.gain.setValueAtTime(0.0001, a.currentTime + dt);
        g.gain.exponentialRampToValueAtTime(0.3, a.currentTime + dt + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dt + 0.18);
        o.start(a.currentTime + dt); o.stop(a.currentTime + dt + 0.2);
      });
    }
  } catch {}
  const el = $("ride");
  el.classList.remove("alert"); void el.offsetWidth; el.classList.add("alert");
}

function rideTick() {
  if (!ride.it || ride.done) return;
  const legs = ride.it.legs, l = legs[ride.i], next = legs[ride.i + 1];
  const now = Date.now();
  const fix = ride.fix && now - ride.fix.at < 30000 && ride.fix.acc < 150 ? ride.fix : null;
  if (fix && ensureMap()) {
    const ll = [fix.lat, fix.lng];
    if (map.rider) map.rider.setLatLng(ll);
    else map.rider = L.circleMarker(ll, { radius: 8, color: "#fff", weight: 3, fillColor: "#1a73e8", fillOpacity: 1 }).addTo(map.m).bindTooltip("You");
  }
  const color = l.mode === "WALK" ? "var(--walk)" : l.mode === "BUS" ? "var(--bus)" : `var(${lineVar(l.route)})`;
  $("ride").style.setProperty("--rc", color);
  const nextTxt = !next ? "Last step" : isRideLeg(next)
    ? `Next: ${next.mode === "BUS" ? "bus " : ""}${next.route} from ${next.from}` : `Next: walk ${next.minutes} min${legs[ride.i + 2] ? "" : " to your destination"}`;
  $("rideNext").textContent = nextTxt;
  $("rideSkip").textContent = next ? "Next step ›" : "Finish ✓";
  let n, unit, title, sub, pct, chip;

  if (l.mode === "WALK") {
    chip = "🚶 Walk";
    const dest = next ? next.from : state.to?.name || "your destination";
    title = `to ${dest}`;
    let metres = null;
    if (fix && l.toLat != null) metres = haversine(fix.lat, fix.lng, l.toLat, l.toLng);
    if (metres != null) {
      n = metres < 1000 ? Math.round(metres / 10) * 10 : (metres / 1000).toFixed(1);
      unit = metres < 1000 ? "m to go" : "km to go";
      pct = l.metres ? 1 - Math.min(1, metres / l.metres) : 0;
      if (metres < 40) { rideNextStep(); return; }
    } else {
      const left = l.end ? Math.max(0, Math.ceil((l.end - now) / 60000)) : l.minutes;
      n = left; unit = "min walk";
      pct = l.start && l.end ? Math.min(1, Math.max(0, (now - l.start) / (l.end - l.start))) : 0;
    }
    sub = next && isRideLeg(next)
      ? `Then ${next.mode === "BUS" ? "board <b>bus " + esc(next.route) + "</b>" : "take the <b>" + esc(next.route) + " line</b>"} at ${esc(next.from)}`
      : `Walk to <b>${esc(dest)}</b>`;
  } else {
    chip = `${l.mode === "BUS" ? "🚌 Bus " : ""}${l.route}`;
    title = `to ${l.to}`;
    const list = l.stopList || [];
    const last = Math.max(0, list.length - 1);
    let estimated = false;
    if (list.length) {
      let k = ride.k;
      if (fix) {
        let best = Infinity;
        list.forEach((s, j) => { const d = haversine(fix.lat, fix.lng, s.lat, s.lng); if (d < best) { best = d; k = j; } });
      } else if (list.some((s) => s.t)) {
        estimated = true;
        list.forEach((s, j) => { if (s.t && s.t <= now) k = j; });
      }
      ride.k = Math.max(ride.k, k); // never go backwards
    }
    const togo = last - ride.k;
    pct = last ? ride.k / last : 0;
    const off = `<b>${esc(l.to)}</b>`;
    if (ride.k === 0) {
      n = last || l.stops + 1 || "–"; unit = `stop${last === 1 ? "" : "s"} to ride`;
      sub = `Board ${l.mode === "BUS" ? "bus " + esc(l.route) : "the " + esc(l.route) + " line"} at ${esc(l.from)} · get off at ${off}`;
    } else if (togo <= 0) {
      n = "Now"; unit = "get off";
      sub = `You're at ${off}${l.mode === "BUS" ? "" : ". Mind the gap"}`;
      $("ride").classList.add("now");
      rideAlert(`now${ride.i}`, true);
      // move on once you've reached the stop and walked away from it, or well after the scheduled arrival
      const s = list[last];
      const d = fix && s ? haversine(fix.lat, fix.lng, s.lat, s.lng) : null;
      if (d != null && d < 80) ride.atStop = true;
      if ((ride.atStop && d != null && d > 120) || (l.end && now - l.end > (fix ? 180000 : 60000))) { rideNextStep(); return; }
    } else if (togo === 1) {
      n = "1"; unit = "stop to go";
      sub = `Get off at the next stop: ${off}${l.mode === "BUS" ? ". Press the bell" : ""}`;
      rideAlert(`near${ride.i}`, false);
    } else {
      n = togo; unit = "stops to go";
      // scheduled time from the stop you're at to your stop, so it stays right even if you're running late
      const fromT = list[ride.k]?.t, endT = list[last]?.t || l.end;
      const mins = fromT && endT ? Math.max(1, Math.round((endT - fromT) / 60000)) : null;
      sub = `Get off at ${off}${mins ? ` · about ${mins} min` : ""}`;
    }
    if (estimated && togo > 0) sub += ` <span style="color:var(--panel-muted)">(estimated from timetable, no GPS)</span>`;
  }

  $("rideChip").textContent = chip;
  $("rideTitle").textContent = title;
  $("rideN").textContent = n;
  $("rideUnit").textContent = unit;
  $("rideSub").innerHTML = sub;
  $("rideBar").style.width = `${Math.round((pct || 0) * 100)}%`;
}

function arrive() {
  ride.done = true;
  $("ride").classList.remove("now");
  rideAlert("arrived", false);
  $("rideChip").textContent = "🎉";
  $("rideTitle").textContent = "You've arrived";
  $("rideN").textContent = "";
  $("rideUnit").textContent = state.to?.name || "Destination reached";
  $("rideSub").textContent = "Ride mode will close in a few seconds.";
  $("rideBar").style.width = "100%";
  $("rideSkip").hidden = true;
  $("rideNext").textContent = "";
  clearInterval(ride.timer);
  setTimeout(() => { if (ride.done) endRide(); }, 6000);
}

$("rideEnd").onclick = () => endRide();
$("rideSkip").onclick = () => rideNextStep();

// ================= place search =================
function useHere() {
  const btn = $("useHere"), input = $("from");
  const set = () => {
    state.from = { ...state.here, name: "Current location" };
    input.value = "📍 Current location";
    btn.classList.add("on");
    input.parentElement.querySelector(".suggest")?.remove();
    if (state.to) planTrip();
  };
  if (state.here) return set();
  if (!navigator.geolocation) return toast("Location isn't available on this device");
  btn.textContent = "Finding…"; btn.disabled = true;
  navigator.geolocation.getCurrentPosition((pos) => {
    state.here = { lat: pos.coords.latitude, lng: pos.coords.longitude, name: "Current location" };
    btn.textContent = "📍 Here"; btn.disabled = false;
    set();
    locate(); // also fills Nearby and Home now that we have permission
  }, () => {
    btn.textContent = "📍 Here"; btn.disabled = false;
    toast("Turn on location to use where you are");
  }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
}
function autocomplete(input, key) {
  let timer, box, seq = 0;
  const close = () => { box?.remove(); box = null; };
  // in the From box, offer "Use my current location" as the first choice
  const hereOpt = () => {
    if (key !== "from") return;
    const b = document.createElement("button");
    b.setAttribute("role", "option"); b.className = "here-opt";
    b.innerHTML = `📍 Use my current location<small>Start from where you are now</small>`;
    b.onclick = () => { close(); useHere(); };
    return b;
  };
  if (key === "from") input.addEventListener("focus", () => {
    if (input.value.trim() || box) return;
    box = document.createElement("div"); box.className = "suggest"; box.setAttribute("role", "listbox");
    box.appendChild(hereOpt()); input.parentElement.appendChild(box);
  });
  input.addEventListener("input", () => {
    state[key] = null;
    if (key === "from") $("useHere").classList.remove("on");
    if (key === "to") syncStarTo();
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) return close();
    timer = setTimeout(async () => {
      const mine = ++seq;
      const { results } = await api(`/api/search?q=${encodeURIComponent(q)}`).catch(() => ({ results: [] }));
      if (mine !== seq) return; // a newer search is in flight
      close();
      if (!results.length && key !== "from") return;
      box = document.createElement("div");
      box.className = "suggest";
      box.setAttribute("role", "listbox");
      if (key === "from") box.appendChild(hereOpt());
      results.forEach((r) => {
        const b = document.createElement("button");
        b.setAttribute("role", "option");
        b.innerHTML = `${esc(r.name)}<small>${esc(r.address)}</small>`;
        b.onclick = () => { input.value = r.name; state[key] = r; close(); if (key === "to") syncStarTo(); };
        box.appendChild(b);
      });
      input.parentElement.appendChild(box);
    }, 250);
  });
  input.addEventListener("blur", () => setTimeout(close, 200));
}

// ================= trip planning =================
function setWhen(w) {
  state.when = w;
  document.querySelectorAll("[data-when]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.when === w)));
  moveThumb(document.querySelector("[data-when]").parentElement);
  const t = $("time");
  t.hidden = w === "now";
  if (w !== "now" && !t.value) {
    const d = new Date(Date.now() + 30 * 60000);
    t.value = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Singapore" });
  }
}

function setOnly(o) {
  if (state.only === o) return;
  state.only = o;
  document.querySelectorAll("[data-only]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.only === o)));
  moveThumb(document.querySelector("[data-only]").parentElement);
  if (state.lastRoutes) planTrip(); // re-plan straight away if routes are already showing
}

async function planTrip() {
  setSec("plan", true);
  const from = state.from || (!$("from").value.trim() && state.here);
  const out = $("routes");
  if (!from) return (out.innerHTML = `<p class="err">Pick a starting point, or allow location.</p>`);
  if (!state.to) return (out.innerHTML = `<p class="err">Pick a destination from the suggestions.</p>`);
  if (state.when !== "now" && !$("time").value) return (out.innerHTML = `<p class="err">Choose a time.</p>`);
  out.innerHTML = skeleton(3, "Finding routes");

  // Rain mode: check the forecast at the start point if we haven't yet
  if (!state.rain) await loadWeather(from.lat, from.lng);

  try {
    const d = await fetchRoutes(from, state.to, state.when, state.when !== "now" ? $("time").value : null, state.only);
    state.lastRoutes = { its: d.its, when: state.when, target: d.target, fallback: d.fallback, stale: d._stale };
    renderRoutes();
    enterAnim(out);
  } catch (e) {
    out.innerHTML = `<p class="err">Couldn't get routes (${esc(e.message)}).</p>`;
  }
}

// Shared by the planner and the commute card. Applies rain, accessibility and fewer-transfer preferences.
async function fetchRoutes(from, to, when = "now", time = null, only = "any") {
  const raining = !!state.rain?.raining;
  const lessWalk = raining || prefs.access;
  const qs = new URLSearchParams({
    from: `${from.lat},${from.lng}`, to: `${to.lat},${to.lng}`,
    when, maxWalk: lessWalk ? "500" : "1000",
  });
  if (time) qs.set("time", time);
  if (state.avoid.length) qs.set("avoid", state.avoid.join(","));
  if (prefs.fewer) qs.set("pref", "fewer");
  if (only === "bus") qs.set("only", "bus");
  const d = await api(`/api/route?${qs}`);
  let its = [...(d.itineraries || [])];
  its.sort((a, b) => (a.affected - b.affected) ||
    (prefs.fewer ? a.transfers - b.transfers : 0) ||
    (lessWalk ? a.walkMetres - b.walkMetres : 0) ||
    (a.minutes - b.minutes));
  return { its, target: d.target, fallback: d.fallback, _stale: d._stale };
}

// Big interchanges where changing lines means a long walk; add a few minutes' buffer.
const BIG_XFER = /dhoby ghaut|jurong east|outram park|paya lebar|serangoon|bishan|buona vista|botanic gardens|tampines|newton|little india|bayfront|marina bay|promenade|macpherson|chinatown|city hall|raffles place|bugis|woodlands|expo|caldecott|stevens|harbourfront|bukit panjang|sengkang|punggol|tanah merah/i;
function transferWarnings(it) {
  const rides = it.legs.filter((l) => l.mode !== "WALK");
  const out = [];
  for (let i = 0; i < rides.length - 1; i++) {
    const at = rides[i].to || "";
    const bothRail = rides[i].mode !== "BUS" && rides[i + 1].mode !== "BUS";
    if (bothRail && BIG_XFER.test(at)) out.push(at.replace(/\s*(MRT|LRT)?\s*Station.*$/i, "").trim());
  }
  return [...new Set(out)];
}

function renderRoutes() {
  const out = $("routes");
  const { its, when, target, fallback, stale } = state.lastRoutes || {};
  if (!its?.length) return (out.innerHTML =
    `<p class="muted">No routes at this time. Buses and MRT may have stopped for the night. Try "Leave at" a later time, or a nearby landmark.</p>`);
  out.innerHTML = stale ? `<p class="stale">Offline. these are the routes saved at ${sgTime(stale)}.</p>` : "";
  if (fallback === "bus") out.innerHTML += `<p class="stale">🌙 No bus + MRT route right now (the MRT may have closed). Showing bus-only routes.</p>`;
  if (its.length > 1) out.innerHTML += `<p class="swipe-hint">‹ Swipe a route sideways to switch options ›</p>`;
  its.forEach((it, idx) => {
    const pills = it.legs.map((l) => {
      if (l.mode === "WALK") return `<span class="pill walk" aria-label="Walk ${l.minutes} minutes">🚶 ${l.minutes}m</span>`;
      const bg = l.mode === "BUS" ? "var(--bus)" : `var(${lineVar(l.route)})`;
      return `<span class="pill" style="background:${bg}" aria-label="${l.mode === "BUS" ? "Bus" : "Train"} ${esc(l.route)}">${l.mode === "BUS" ? "🚌 " : ""}${esc(l.route)}</span>`;
    }).join(" › ");
    // Strip map: one coloured rail per leg, a station node where each leg starts
    const steps = it.legs.map((l, li) => {
      if (l.mode === "WALK") {
        const next = it.legs[li + 1];
        const where = next ? (next.mode === "BUS" ? `to the bus stop${next.from ? ` (${esc(next.from)})` : ""}` : `to ${esc(next.from || "the station")}`) : "to your destination";
        return `<li class="walk" style="--c:var(--walk)"><span class="what">Walk ${l.minutes} min</span><span class="sub">${where}</span></li>`;
      }
      const rail = (l.mode === "SUBWAY" || l.mode === "TRAM") && /^[A-Z]{2}\d/.test(l.fromStopCode || "");
      const c = l.mode === "BUS" ? "var(--bus)" : `var(${lineVar(l.route)})`;
      const crowd = rail ? `<span data-crowd="${esc(l.fromStopCode)}"></span>` : "";
      const fc = rail ? `<button class="linkbtn" data-fc="${esc(l.fromStopCode)}" data-fcname="${esc(l.from)}" aria-expanded="false">Crowd forecast</button>
        <div class="fc" data-fcbox hidden></div>` : "";
      const stopsTxt = l.stops != null ? `, ${l.stops + 1} stop${l.stops ? "s" : ""}` : "";
      const fromTxt = l.fromLat != null
        ? `<button class="stop-link" data-pin="${li}" title="Show on map">📍 ${esc(l.from)}</button>` : esc(l.from);
      return `<li style="--c:${c}"><span class="what"><span class="line-chip">${l.mode === "BUS" ? "Bus " : ""}${esc(l.route)}</span>${fromTxt}${crowd}</span>
        <span class="sub">to ${esc(l.to)}${stopsTxt}, about ${l.minutes} min</span>${fc}</li>`;
    }).join("") + `<li class="end" style="--c:var(--ink)"><span class="what">${esc(state.to?.name || "Destination")}</span></li>`;

    let timesLine = "";
    if (it.start && it.end) {
      let late = "";
      if (when === "arrive" && target) {
        const endSg = new Date(it.end + 8 * 3600e3);
        const endMin = endSg.getUTCHours() * 60 + endSg.getUTCMinutes();
        if (endMin > target.h * 60 + target.m && endMin - (target.h * 60 + target.m) < 12 * 60) late = ` <span class="late">· arrives late</span>`;
      }
      timesLine = `<div class="times-line">${when === "now" ? "" : "Leave "}${sgTime(it.start)} → arrive ${sgTime(it.end)}${late}</div>`;
    }

    const xfers = transferWarnings(it);
    const tags = [
      it.affected && `<span class="tag warn">uses disrupted line</span>`,
      idx === 0 && !it.affected && (state.rain?.raining || prefs.access) && `<span class="tag l">least walking</span>`,
      idx === 0 && !it.affected && prefs.fewer && it.transfers === 0 && `<span class="tag l">direct</span>`,
    ].filter(Boolean).join("");
    const xferNote = xfers.length
      ? `<div class="times-line xfer">⏱ Long transfer walk at ${esc(xfers.join(", "))}. Allow 3–5 extra minutes.</div>` : "";

    const firstBusIdx = it.legs.findIndex((l) => l.mode === "BUS" && l.fromStopCode);
    const walkBefore = firstBusIdx > 0 ? it.legs.slice(0, firstBusIdx).reduce((s, l) => s + (l.mode === "WALK" ? l.minutes : 999), 0) : 0;
    const nudge = when === "now" && firstBusIdx >= 0 && walkBefore < 999
      ? `<div class="nudge" data-nudge="${esc(it.legs[firstBusIdx].fromStopCode)}" data-svc="${esc(it.legs[firstBusIdx].route)}" data-walk="${walkBefore}">Checking bus ${esc(it.legs[firstBusIdx].route)}…</div>` : "";

    const card = document.createElement("div");
    card.className = `card route${idx === 0 ? " selected" : ""}${it.affected ? " affected" : ""}`;
    card.tabIndex = 0;
    card.setAttribute("aria-label", `Option ${idx + 1}, ${it.minutes} minutes`);
    card.innerHTML = `
      <div class="it-head"><b>${it.minutes} min${tags}</b>
        <span class="meta">${it.fare ? `<span>$${it.fare.toFixed(2)}</span>` : ""}<span>${it.transfers ? `${it.transfers} transfer${it.transfers > 1 ? "s" : ""}` : "No transfers"}</span><span>${it.walkMetres} m walk</span></span></div>
      ${timesLine}
      <div class="jam" data-jam></div>
      <div class="legs">${pills}</div>
      <ol class="rail" aria-label="Step by step">${steps}</ol>
      ${xferNote}
      ${nudge}
      <button class="btn small take" data-take>I'm taking this route</button>
      <button class="btn ride-go" data-ride hidden>▶ Start ride mode</button>`;
    let logged = null;
    const rideBtn = card.querySelector("[data-ride]");
    card.querySelector("[data-take]").onclick = (e) => {
      e.stopPropagation();
      const b = e.currentTarget;
      if (logged) {
        unlogTrip(logged);
        logged = null;
        b.classList.remove("done");
        b.textContent = "I'm taking this route";
        rideBtn.hidden = true;
        return;
      }
      logged = logTrip(it);
      b.classList.add("done");
      b.textContent = "✓ Added to your trips · tap to undo";
      rideBtn.hidden = false;
    };
    rideBtn.onclick = (e) => { e.stopPropagation(); startRide(it); };
    card.querySelectorAll("[data-pin]").forEach((b) => (b.onclick = (e) => {
      e.stopPropagation();
      if (!card.classList.contains("selected")) select();
      mapShowPin(it.legs[Number(b.dataset.pin)]);
    }));
    showJams(card, it);
    card.querySelectorAll("[data-fc]").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); toggleForecast(b); }));
    const select = () => {
      out.querySelectorAll(".card.route").forEach((c) => c.classList.remove("selected"));
      card.classList.add("selected");
      mapShowRoute(it);
    };
    card.onclick = select;
    card.onkeydown = (e) => { if (e.target === card && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); select(); } };
    out.appendChild(card);
  });
  mapShowRoute(its[0]);
  refreshNudges();
  loadCrowds();
}

// Leave-now nudge: compares your walk to the first stop with live bus ETAs
async function refreshNudges() {
  const els = [...document.querySelectorAll("[data-nudge]")];
  const byStop = {};
  await Promise.all([...new Set(els.map((e) => e.dataset.nudge))].map(async (code) => {
    try { byStop[code] = await api(`/api/arrivals?stop=${code}`); } catch {}
  }));
  els.forEach((el) => {
    const d = byStop[el.dataset.nudge];
    const walk = +el.dataset.walk;
    const svc = d?.services.find((x) => x.service === el.dataset.svc);
    if (!svc?.next.length) { el.className = "nudge"; el.innerHTML = `No timing for bus ${esc(el.dataset.svc)} right now`; return; }
    const catchable = svc.next.map((b) => ({ ...b, m: minsTo(b) })).filter((b) => b.m >= walk);
    const all = svc.next.map((b) => fmtMins(minsTo(b)).replace("m", " min")).join(", ");
    const schedNote = svc.next[0].live ? "" : " (scheduled, not live)";
    const shaky = isUnstable(el.dataset.nudge, svc.service) || state.feedDown ? " · timing may be unreliable" : "";
    const stale = d._stale ? ` · offline, saved ${sgTime(d._stale)}` : "";
    const sub = `<small>${walk} min walk · bus ${esc(svc.service)} in ${all}${schedNote}${shaky}${stale}</small>`;
    if (!catchable.length) { el.className = "nudge"; el.innerHTML = `Next buses leave before you can reach the stop${sub}`; return; }
    const slack = catchable[0].m - walk;
    if (slack <= 1) { el.className = "nudge run"; el.innerHTML = `🏃 Hurry! Leave right now to catch it${sub}`; }
    else if (slack <= 4) { el.className = "nudge go"; el.innerHTML = `🚶 Leave now${sub}`; }
    else { el.className = "nudge"; el.innerHTML = `⏳ Leave in ${slack - 2} min${sub}`; }
  });
}

// MRT platform crowd levels for boarding stations
const crowdCache = {};
async function loadCrowds() {
  const els = [...document.querySelectorAll("[data-crowd]")];
  const lines = [...new Set(els.map((e) => e.dataset.crowd.slice(0, 2)))];
  await Promise.all(lines.map(async (p) => {
    if (crowdCache[p] && Date.now() - crowdCache[p].t < 300000) return;
    try { crowdCache[p] = { t: Date.now(), s: (await api(`/api/crowd?line=${p}`)).stations }; } catch { crowdCache[p] = { t: Date.now(), s: {} }; }
  }));
  els.forEach((el) => {
    const lvl = crowdCache[el.dataset.crowd.slice(0, 2)]?.s[el.dataset.crowd];
    el.innerHTML = lvl ? `<span class="tag ${lvl}" title="Platform crowd now">${CROWD_TXT[lvl]}</span>` : "";
  });
}

// Crowd forecast chart for a boarding station: the next ~3 hours in 30-min slots
const fcCache = {};
const shortTime = (ms) => sgTime(ms).replace(/\s?[ap]\.?m\.?$/i, "");
const LVL_N = { l: 1, m: 2, h: 3 };
async function toggleForecast(btn) {
  const box = btn.nextElementSibling;
  const open = btn.getAttribute("aria-expanded") === "true";
  btn.setAttribute("aria-expanded", String(!open));
  box.hidden = open;
  if (open) return;
  const code = btn.dataset.fc;
  box.innerHTML = `<span class="muted">Loading forecast…</span>`;
  try {
    if (!fcCache[code]) fcCache[code] = (await api(`/api/crowdforecast?station=${code}`)).slots;
    box.innerHTML = forecastChart(fcCache[code], btn.dataset.fcname);
  } catch (e) {
    box.innerHTML = `<span class="err">Forecast unavailable (${esc(e.message)}).</span>`;
  }
}
function forecastChart(slots, name) {
  const now = Date.now();
  const win = slots.filter((s) => s.t > now - 30 * 60000 && s.t < now + 3 * 3600e3).slice(0, 7);
  if (!win.length) return `<span class="muted">No forecast for the rest of today.</span>`;
  const cur = win.find((s) => s.t <= now && now < s.t + 30 * 60000) || win[0];
  const better = win.find((s) => s.t > cur.t && LVL_N[s.lvl] < LVL_N[cur.lvl]);
  const sum = cur.lvl === "l"
    ? `${esc(name)} platform should be quiet now. Good time to go.`
    : better
      ? `${esc(name)} is ${CROWD_TXT[cur.lvl].toLowerCase()} now. Quieter from ${sgTime(better.t)}.`
      : `${esc(name)} stays ${CROWD_TXT[cur.lvl].toLowerCase()} for the next few hours.`;
  const label = win.map((s) => `${shortTime(s.t)} ${CROWD_TXT[s.lvl].toLowerCase()}`).join(", ");
  return `<div class="fc-sum">${sum}</div>
    <div class="fc-bars" role="img" aria-label="Forecast: ${esc(label)}">${win.map((s) =>
      `<div class="fc-bar ${s.lvl}${s === cur ? " now" : ""}" title="${shortTime(s.t)}: ${CROWD_TXT[s.lvl]}"></div>`).join("")}</div>
    <div class="fc-times" aria-hidden="true">${win.map((s) => `<span>${s === cur ? "Now" : shortTime(s.t)}</span>`).join("")}</div>
    <div class="fc-key">Green quiet · amber moderate · red crowded. LTA forecast for the platform.</div>`;
}

// ================= trip history (on this device) =================
const TRIP_KEY = "gosg.trips.v1";
let trips = (() => { try { return JSON.parse(localStorage.getItem(TRIP_KEY) || "[]"); } catch { return []; } })();
function saveTrips() { try { localStorage.setItem(TRIP_KEY, JSON.stringify(trips)); } catch {} renderTrips(); }
function logTrip(it) {
  const fromName = state.from?.name || ($("from").value.trim() || "Current location");
  const trip = {
    t: Date.now(), from: fromName, to: state.to?.name || "Destination",
    minutes: it.minutes, fare: it.fare || 0,
    legs: it.legs.filter((l) => l.mode !== "WALK").map((l) => (l.mode === "BUS" ? "Bus " : "") + l.route).join(" › "),
  };
  trips.unshift(trip);
  trips = trips.slice(0, 500);
  saveTrips();
  return trip;
}
function unlogTrip(trip) {
  trips = trips.filter((t) => t !== trip);
  saveTrips();
}
function renderTrips() {
  const sec = $("tripsSec");
  sec.hidden = !trips.length;
  if (!trips.length) return;
  const sgMonth = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 7);
  const thisMonth = sgMonth(Date.now());
  const month = trips.filter((t) => sgMonth(t.t) === thisMonth);
  const mins = month.reduce((s, t) => s + t.minutes, 0);
  const fares = month.reduce((s, t) => s + (t.fare || 0), 0);
  const hrs = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
  const counts = {};
  trips.forEach((t) => { const k = `${t.from} → ${t.to}`; counts[k] = (counts[k] || 0) + 1; });
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const day = (ms) => new Date(ms).toLocaleDateString("en-SG", { day: "numeric", month: "short", timeZone: "Asia/Singapore" });
  setSecCount("trips", `${month.length} this month`);
  $("trips").innerHTML = `
    <div class="stats">
      <div class="stat"><b>${month.length}</b><span>trips this month</span></div>
      <div class="stat"><b>${hrs}</b><span>on transit</span></div>
      <div class="stat"><b>$${fares.toFixed(2)}</b><span>est. fares</span></div>
    </div>
    ${top.length && top[0][1] > 1 ? `<div class="card"><div class="sub">Most taken</div><ul class="trip-list">${top.map(([k, n]) =>
      `<li><span>${esc(k)}</span><span class="r">×${n}</span></li>`).join("")}</ul></div>` : ""}
    <div class="card"><div class="sub">Recent</div><ul class="trip-list">${trips.slice(0, 3).map((t) =>
      `<li><span>${esc(t.from)} → ${esc(t.to)}<br><small>${esc(t.legs)}</small></span><span class="r">${t.minutes} min<br><small>${day(t.t)}</small></span></li>`).join("")}</ul></div>
    <button class="btn small ghost" id="clearTrips">Clear trip history</button>
    <p class="legend">Saved on this phone only. Fares are OneMap estimates.</p>`;
  const clr = $("clearTrips");
  let armed = false, timer;
  clr.onclick = () => {
    if (!armed) { armed = true; clr.textContent = "Tap again to clear all trips"; timer = setTimeout(() => { armed = false; clr.textContent = "Clear trip history"; }, 4000); return; }
    clearTimeout(timer); trips = []; saveTrips();
  };
}

// ================= my commute =================
// With Home and Work saved, the top of the app answers "when do I leave?" in one glance:
// before 2 pm it plans to Work, after that to Home. Starts from your location when known.
let commuteFlip = false, commuteAt = 0;
function commuteDir() {
  const sg = new Date(Date.now() + 8 * 3600e3);
  const toWork = sg.getUTCHours() < 14;
  return commuteFlip ? !toWork : toWork;
}
function updateSaveAs() {
  const box = $("saveAs");
  box.hidden = !state.to;
  if (!state.to) return;
  const same = (p) => p && state.to && p.lat === state.to.lat && p.lng === state.to.lng;
  $("saveHome").classList.toggle("on", same(favs.home));
  $("saveWork").classList.toggle("on", same(favs.work));
}
function setCommutePlace(kind) {
  if (!state.to) return;
  favs[kind] = { name: state.to.name, address: state.to.address, lat: state.to.lat, lng: state.to.lng };
  saveFavs();
  updateSaveAs();
  commuteAt = 0;
  renderCommute();
}
async function renderCommute(force = false) {
  const sec = $("commute"), box = $("commuteCard");
  const { home, work } = favs;
  if (!home && !work) { sec.hidden = true; return; }
  sec.hidden = false;
  if (!home || !work) {
    box.innerHTML = `<div class="card"><p class="muted">Saved ${home ? "🏠 Home" : "💼 Work"}. Now plan a trip to your ${home ? "workplace or school" : "home"} and tap <b>${home ? "💼 Work" : "🏠 Home"}</b> under the planner to get a one-tap commute.</p></div>`;
    return;
  }
  const toWork = commuteDir();
  const dest = toWork ? work : home;
  const fallbackFrom = toWork ? home : work;
  const from = state.here && haversine(state.here.lat, state.here.lng, dest.lat, dest.lng) > 300 ? state.here : fallbackFrom;
  if (!force && Date.now() - commuteAt < 5 * 60000 && box.dataset.dir === String(toWork)) return;
  commuteAt = Date.now();
  box.dataset.dir = String(toWork);
  box.innerHTML = `<div class="card commute-card"><div class="dir">${toWork ? "To work" : "To home"}</div><p class="muted">Checking the best way…</p></div>`;
  try {
    if (!state.rain) await loadWeather(from.lat, from.lng);
    const { its, _stale } = await fetchRoutes(from, dest, "now");
    const it = its[0];
    if (!it) throw new Error("no route");
    const pills = it.legs.filter((l) => l.mode !== "WALK").map((l) => {
      const bg = l.mode === "BUS" ? "var(--bus)" : `var(${lineVar(l.route)})`;
      return `<span class="pill" style="background:${bg}">${l.mode === "BUS" ? "🚌 " : ""}${esc(l.route)}</span>`;
    }).join(" › ");
    const fb = it.legs.findIndex((l) => l.mode === "BUS" && l.fromStopCode);
    const walkBefore = fb > 0 ? it.legs.slice(0, fb).reduce((s, l) => s + (l.mode === "WALK" ? l.minutes : 999), 0) : 0;
    const nudge = fb >= 0 && walkBefore < 999
      ? `<div class="nudge" data-nudge="${esc(it.legs[fb].fromStopCode)}" data-svc="${esc(it.legs[fb].route)}" data-walk="${walkBefore}">Checking bus ${esc(it.legs[fb].route)}…</div>`
      : `<div class="nudge go">🚶 Head out when ready, first leg is ${it.legs[0]?.mode === "WALK" ? "a walk" : "by train"}</div>`;
    box.innerHTML = `<div class="card commute-card">
      <div class="dir">${toWork ? "To work" : "To home"}, <b>${esc(dest.name)}</b>${it.affected ? ` <span class="tag warn">disruption</span>` : ""}</div>
      <div class="it-head"><span class="big-min">${it.minutes}<small>min</small></span><span>Arrive around<br><b style="color:var(--panel-ink)">${sgTime(Date.now() + it.minutes * 60000)}</b></span></div>
      <div class="legs">${pills}</div>
      ${nudge}
      ${_stale ? `<div class="stale">Offline. route saved at ${sgTime(_stale)}</div>` : ""}
      <div class="commute-actions">
        <button class="btn small ghost" id="commuteFlip">⇄ ${toWork ? "To home" : "To work"} instead</button>
        <button class="btn small" id="commuteGo">Details</button>
      </div></div>`;
    $("commuteFlip").onclick = () => { commuteFlip = !commuteFlip; renderCommute(true); };
    $("commuteGo").onclick = () => {
      state.from = from === state.here ? null : from;
      $("from").value = from === state.here ? "" : from.name;
      state.to = dest; $("to").value = dest.name; syncStarTo(); updateSaveAs();
      setWhen("now"); planTrip();
      $("routes").scrollIntoView({ behavior: "smooth", block: "start" });
    };
    refreshNudges();
  } catch (e) {
    box.innerHTML = `<div class="card commute-card"><div class="dir">${toWork ? "To work" : "To home"}</div><p class="err">Couldn't plan your commute (${esc(e.message)}).</p></div>`;
  }
}

// ================= settings =================
function applyPrefs() {
  document.body.classList.toggle("big", !!prefs.big);
  $("prefBig").checked = !!prefs.big;
  $("prefAccess").checked = !!prefs.access;
  $("prefFewer").checked = !!prefs.fewer;
  $("prefHaptic").checked = !!prefs.haptic;
  document.body.dataset.theme = prefs.theme || "teal";
  document.querySelectorAll(".themes [data-theme]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.theme === (prefs.theme || "teal"))));
}
function setupSettings() {
  const bind = (id, key) => ($(id).onchange = (e) => {
    prefs[key] = e.target.checked; savePrefs(); applyPrefs();
    if (key !== "big" && key !== "haptic") {
      if (state.lastRoutes) planTrip();
      commuteAt = 0; renderCommute(true);
      if (state.activeStop) showArrivals(state.activeStop);
    }
  });
  bind("prefBig", "big"); bind("prefAccess", "access"); bind("prefFewer", "fewer"); bind("prefHaptic", "haptic");
  applyPrefs();
}

// ================= collapsible sections =================
const SEC_KEY = "gosg.sections.v1";
const secState = (() => { try { return JSON.parse(localStorage.getItem(SEC_KEY) || "{}"); } catch { return {}; } })();
function setSec(name, open) {
  const sec = document.querySelector(`.sec[data-sec="${name}"]`);
  if (!sec) return;
  const btn = sec.querySelector(".sec-toggle"), body = sec.querySelector(".sec-body");
  btn.setAttribute("aria-expanded", String(open));
  body.hidden = !open;
  secState[name] = open;
  try { localStorage.setItem(SEC_KEY, JSON.stringify(secState)); } catch {}
  if (open && name === "plan" && map.m) setTimeout(() => map.m.invalidateSize(), 50);
  if (open) sec.querySelectorAll(".seg").forEach(moveThumb);
}
function setupSections() {
  document.querySelectorAll(".sec").forEach((sec) => {
    const name = sec.dataset.sec;
    sec.querySelector(".sec-toggle").onclick = () => setSec(name, sec.querySelector(".sec-body").hidden);
    if (secState[name] === false) setSec(name, false);
  });
}
// Small counts next to closed section titles, so you know what's inside
function setSecCount(name, text) {
  const c = document.querySelector(`[data-count="${name}"]`);
  if (c) c.textContent = text || "";
}

// ================= nearby stops =================
const NEARBY_SHOWN = 3;
let stopsData = null;
async function getStops() {
  if (stopsData) return stopsData;
  try {
    const rows = await (await fetch("/stops.json")).json();
    stopsData = rows.map(([code, name, road, lat, lng]) => ({ code, name, road, lat, lng }));
  } catch { stopsData = []; }
  return stopsData;
}
async function findNearby(lat, lng) {
  const all = await getStops();
  if (all.length) {
    return all
      .map((s) => ({ ...s, metres: Math.round(haversine(lat, lng, s.lat, s.lng)) }))
      .filter((s) => s.metres <= 600)
      .sort((a, b) => a.metres - b.metres)
      .slice(0, 8);
  }
  // fallback if stops.json wasn't built (e.g. key missing at deploy time)
  const { stops } = await api(`/api/nearby?lat=${lat}&lng=${lng}`);
  return stops;
}

async function showArrivals(stop, dock = false) {
  state.activeStop = stop;
  if (dock) openSheet("stopSheet");
  syncStopSheet();
  document.querySelectorAll(".stop-list .card").forEach((c) => c.classList.toggle("active", c.dataset.code === stop.code));
  const box = $("arrivals");
  const first = !box.firstChild || box.dataset.code !== stop.code;
  if (first) box.innerHTML = skeleton(1, `Loading ${stop.name}`);
  box.dataset.code = stop.code;
  try {
    const { services, ts, _stale } = await api(`/api/arrivals?stop=${stop.code}`);
    if (state.activeStop?.code !== stop.code) return;
    if (!_stale) observeEta(stop, services);
    const walk = stop.metres != null ? Math.ceil(stop.metres / WALK_M_PER_MIN) : null;
    // keep an open report panel open across auto-refreshes
    if (box.querySelector('[data-report][aria-expanded="true"]')) return;
    box.innerHTML = stopCard(stop, (_stale ? "" : approachStrip(stop, services)) + arrivalRows(services, walk, stop), ts || Date.now(), _stale);
    wireStar(box, stop);
    wireReport(box, stop, services);
    if (!_stale) mapShowBuses(stop, services, first);
  } catch (e) {
    box.innerHTML = `<div class="card err">Couldn't load arrivals (${esc(e.message)}).</div>`;
  }
}

async function locate() {
  if (!navigator.geolocation) return;
  $("nearby").innerHTML = `<span class="muted">Finding you…</span>`;
  navigator.geolocation.getCurrentPosition(async (pos) => {
    state.here = { lat: pos.coords.latitude, lng: pos.coords.longitude, name: "Current location" };
    mapShowMe();
    renderCommute(true);
    loadWeather(state.here.lat, state.here.lng);
    renderHome(); // favourites can now show walking distance
    try {
      const stops = await findNearby(state.here.lat, state.here.lng);
      state.nearby = stops;
      const el = $("nearby");
      if (!stops.length) return (el.innerHTML = `<div class="empty"><div class="illo">${illo("search")}</div><p><b>No bus stops within 600 m</b><br><span class="muted">Looks like a quiet corner. Try "Where to?" to plan a trip.</span></p></div>`);
      el.className = "stop-list";
      el.innerHTML = stops.map((s, i) =>
        `<div class="card" role="button" tabindex="0" data-i="${i}" data-code="${esc(s.code)}"${i >= NEARBY_SHOWN ? " hidden" : ""}><span><b>${esc(s.name)}</b><br><small><span class="code">${esc(s.code)}</span>${esc(s.road)}</small></span><span><span class="dist">${s.metres} m</span><span class="chev" aria-hidden="true">›</span></span></div>`).join("") +
        (stops.length > NEARBY_SHOWN ? `<button class="btn small ghost more" id="moreStops">Show ${stops.length - NEARBY_SHOWN} more stops</button>` : "");
      const moreBtn = $("moreStops");
      if (moreBtn) moreBtn.onclick = () => {
        const hidden = el.querySelectorAll(".card[hidden]");
        if (hidden.length) { hidden.forEach((c) => (c.hidden = false)); moreBtn.textContent = "Show fewer stops"; }
        else { el.querySelectorAll(".card").forEach((c, i) => (c.hidden = i >= NEARBY_SHOWN)); moreBtn.textContent = `Show ${stops.length - NEARBY_SHOWN} more stops`; }
      };
      setSecCount("nearby", `${stops.length} stops`);
      el.querySelectorAll(".card").forEach((c) => {
        const open = () => showArrivals(stops[c.dataset.i], true);
        c.onclick = open;
        c.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } };
      });
      $("mapEmpty").hidden = true;
      mapShowStops(stops);
      showArrivals(stops[0]);
      renderHome();
    } catch (e) {
      $("nearby").innerHTML = `<span class="err">Couldn't load nearby stops (${esc(e.message)}).</span>`;
    }
  }, () => {
    $("nearby").innerHTML = `<div class="empty"><div class="illo">${illo("search")}</div><p><b>Location is off</b><br><span class="muted">Turn it on in your browser settings and we'll find the stops around you.</span></p><button class="btn" id="locBtn2">Try again</button></div>`;
    $("locBtn2").onclick = locate;
  }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
}

// ================= auto refresh (every 30 s while visible) =================
function refreshAll() {
  if (document.hidden) return;
  refreshHome();
  if (state.activeStop) showArrivals(state.activeStop);
  refreshNudges();       // planner + commute card
  renderCommute();       // replans at most every 5 min
}
setInterval(refreshAll, 30000);

// ================= pull to refresh (touch) =================
// Drag down from the top of the page: refreshes timings, alerts and any routes on screen.
function setupPullRefresh() {
  const ind = $("ptr");
  const LIMIT = 70;
  let y0 = null, dy = 0, busy = false;
  const skip = (t) => t.closest("#mapWrap, .suggest, input, #ride, .fc, .sheet, .tabbar, .thumbbar, .g-row");
  addEventListener("touchstart", (e) => {
    if (busy || scrollY > 0 || e.touches.length > 1 || skip(e.target)) return (y0 = null);
    y0 = e.touches[0].clientY; dy = 0;
  }, { passive: true });
  addEventListener("touchmove", (e) => {
    if (y0 == null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    if (scrollY > 0) dy = 0;
    const pull = Math.min(dy * 0.5, LIMIT + 20);
    ind.style.transition = "none"; // follow the finger exactly
    ind.style.transform = `translate(-50%, ${pull - 48}px)`;
    ind.style.opacity = Math.min(1, pull / LIMIT);
    ind.classList.toggle("ready", pull >= LIMIT);
    ind.querySelector("span").textContent = pull >= LIMIT ? "Release to refresh" : "Pull to refresh";
    ind.querySelector("i").style.transform = `rotate(${Math.min(pull / LIMIT, 1) * 180}deg)`;
  }, { passive: true });
  addEventListener("touchend", async () => {
    if (y0 == null) return;
    const go = dy * 0.5 >= LIMIT;
    y0 = null;
    ind.style.transition = "";
    if (!go) return reset();
    busy = true;
    ind.classList.add("busy");
    ind.querySelector("span").textContent = "Refreshing…";
    ind.style.transform = `translate(-50%, ${LIMIT - 48}px)`;
    navigator.vibrate?.(15);
    const jobs = [loadAlerts()];
    refreshAll();
    if (state.lastRoutes && !state.lastRoutes.stale) jobs.push(planTrip());
    await Promise.allSettled(jobs);
    await new Promise((r) => setTimeout(r, 400)); // let the spinner register
    busy = false;
    reset();
  });
  function reset() {
    ind.classList.remove("ready", "busy");
    ind.style.transform = "";
    ind.style.opacity = "";
  }
}

// ================= swipe between route options =================
// Swipe the chosen route card left/right (or press ←/→) to switch to the next/previous option.
function setupRouteSwipe() {
  const out = $("routes");
  let x0 = null, y0 = 0;
  const move = (dir) => {
    const cards = [...out.querySelectorAll(".card.route")];
    const cur = cards.findIndex((c) => c.classList.contains("selected"));
    const next = cards[cur + dir];
    if (!next) {
      const c = cards[cur]; if (!c) return;
      c.classList.remove("bump"); void c.offsetWidth; c.classList.add("bump"); // end of list: small nudge
      return;
    }
    next.click();
    next.classList.remove("swiped-l", "swiped-r"); void next.offsetWidth;
    next.classList.add(dir > 0 ? "swiped-l" : "swiped-r");
    next.scrollIntoView({ behavior: "smooth", block: "nearest" });
    next.focus({ preventScroll: true });
  };
  out.addEventListener("touchstart", (e) => {
    const c = e.target.closest(".card.route.selected");
    x0 = c && !e.target.closest(".fc, button") ? e.touches[0].clientX : null;
    y0 = e.touches[0]?.clientY;
  }, { passive: true });
  out.addEventListener("touchend", (e) => {
    if (x0 == null) return;
    const t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0;
    x0 = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) move(dx < 0 ? 1 : -1);
  });
  out.addEventListener("keydown", (e) => {
    if (!e.target.matches(".card.route")) return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); move(1); }
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); move(-1); }
  });
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) { refreshAll(); loadAlerts(); } });
setInterval(loadAlerts, 120000);

// ================= install (PWA) =================
let deferredPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); deferredPrompt = e; $("installBtn").hidden = false;
});
function setupInstall() {
  $("installBtn").onclick = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt(); await deferredPrompt.userChoice.catch(() => {});
    deferredPrompt = null; $("installBtn").hidden = true;
  };
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  let dismissed = false;
  try { dismissed = localStorage.getItem("gosg.iosHint") === "1"; } catch {}
  if (ios && !standalone && !dismissed) $("iosHint").hidden = false;
  $("iosHintClose").onclick = () => { $("iosHint").hidden = true; try { localStorage.setItem("gosg.iosHint", "1"); } catch {} };
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
}

// ================= feel: touch feedback, little animations =================
// Ripple from the finger + a tiny buzz on every button, a sliding thumb on the
// segmented controls, a live clock and greeting in the header.
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
function skeleton(n, label) {
  const one = `<div class="skel" aria-hidden="true"><i class="lg"></i><i class="md"></i><i class="sm"></i></div>`;
  return `<div class="sr" role="status">${esc(label)}…</div>` + one.repeat(n);
}
function enterAnim(el) {
  if (reduceMotion.matches) return;
  el.classList.remove("enter"); void el.offsetWidth; el.classList.add("enter");
  setTimeout(() => el.classList.remove("enter"), 800);
}
function pop(el) {
  if (!el) return;
  el.classList.remove("pop"); void el.offsetWidth; el.classList.add("pop");
}
function toast(text) {
  document.querySelector(".toast")?.remove();
  const t = document.createElement("div");
  t.className = "toast"; t.setAttribute("role", "status"); t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2300);
}
function moveThumb(seg) {
  const thumb = seg.querySelector(".thumb"), on = seg.querySelector('[aria-pressed="true"]');
  if (!thumb || !on) return;
  thumb.style.width = `${on.offsetWidth}px`;
  thumb.style.transform = `translateX(${on.offsetLeft}px)`;
}
function setupFeel() {
  document.addEventListener("pointerdown", (e) => {
    const el = e.target.closest("button, .chip, a.btn");
    if (!el || el.disabled || el.closest(".leaflet-container")) return;
    if (prefs.haptic) navigator.vibrate?.(8);
    if (reduceMotion.matches || el.classList.contains("star") || el.classList.contains("sec-toggle")) return;
    const r = el.getBoundingClientRect(), size = Math.max(r.width, r.height) * 2;
    if (getComputedStyle(el).position === "static") el.classList.add("rip-host");
    else el.style.overflow = "hidden";
    const rip = document.createElement("span");
    rip.className = "ripple";
    rip.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
    el.appendChild(rip);
    setTimeout(() => rip.remove(), 600);
  }, { passive: true });
  document.querySelectorAll(".seg").forEach((seg) => {
    const thumb = document.createElement("span");
    thumb.className = "thumb"; thumb.setAttribute("aria-hidden", "true");
    seg.prepend(thumb); seg.classList.add("has-thumb");
    moveThumb(seg);
  });
  addEventListener("resize", () => document.querySelectorAll(".seg").forEach(moveThumb));
  document.fonts?.ready.then(() => document.querySelectorAll(".seg").forEach(moveThumb));
  const tickClock = () => {
    const now = new Date();
    const h = Number(now.toLocaleString("en-GB", { hour: "numeric", hour12: false, timeZone: "Asia/Singapore" }));
    $("greetTxt").textContent = h < 5 ? "Still up? 🌙" : h < 12 ? "Morning! ☀️" : h < 18 ? "Afternoon! 🌤" : "Evening! 🌆";
    $("greetSub").textContent = h < 5 ? " Most buses are asleep" : (h >= 7 && h < 9) || (h >= 17 && h < 20) ? " Peak hour, give yourself a few extra min"
      : h < 12 ? " Let's get you moving" : h < 18 ? " Where are we off to?" : " Heading home?";
    $("clock").textContent = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Singapore" });
  };
  tickClock(); setInterval(tickClock, 15000);
}

// ================= boot =================
function boot() {
  autocomplete($("from"), "from");
  autocomplete($("to"), "to");
  document.querySelectorAll("[data-when]").forEach((b) => (b.onclick = () => setWhen(b.dataset.when)));
  document.querySelectorAll("[data-only]").forEach((b) => (b.onclick = () => setOnly(b.dataset.only)));
  $("swap").onclick = () => {
    // an empty From means "current location", so carry that across when swapping
    if (!state.from && !$("from").value.trim() && state.here) { state.from = { ...state.here, name: "Current location" }; $("from").value = "📍 Current location"; }
    [state.from, state.to] = [state.to, state.from];
    [$("from").value, $("to").value] = [$("to").value, $("from").value];
    $("useHere").classList.toggle("on", state.from?.name === "Current location");
    syncStarTo();
  };
  $("starTo").onclick = () => state.to && togglePlace(state.to);
  $("go").onclick = planTrip;
  $("useHere").onclick = useHere;
  $("locBtn").onclick = locate;
  $("homeLoc").onclick = locate;
  $("saveHome").onclick = () => setCommutePlace("home");
  $("saveWork").onclick = () => setCommutePlace("work");
  setupSettings();
  setupShell();
  setupFeel();
  setupRemind();
  setupSections();
  setupBanners();
  renderFavs();
  renderTrips();
  renderCommute();
  loadAlerts();
  setupInstall();
  setupPullRefresh();
  setupRouteSwipe();
  // Only auto-locate if permission was already granted, so we don't nag on first visit
  if (navigator.permissions?.query) {
    navigator.permissions.query({ name: "geolocation" }).then((p) => { if (p.state === "granted") locate(); }).catch(() => {});
  }
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
