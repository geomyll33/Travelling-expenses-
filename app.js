// Travel Expenses — business travel expense reports from receipts, PDFs and emails.
// Everything is stored locally in the browser (IndexedDB). Automatic reading of
// receipts uses the Claude API with the user's own key.
import Anthropic from "./vendor/anthropic-sdk.js";

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const MODEL = "claude-opus-5-5";

const CATEGORIES = [
  { key: "airfare", label: "Airfare", icon: "✈️", group: "Transport" },
  { key: "baggage", label: "Baggage / seat fees", icon: "🧳", group: "Transport" },
  { key: "train", label: "Train / bus / public transport", icon: "🚆", group: "Transport" },
  { key: "taxi", label: "Taxi / rideshare", icon: "🚕", group: "Transport" },
  { key: "car_rental", label: "Car rental", icon: "🚗", group: "Transport" },
  { key: "fuel", label: "Fuel / mileage", icon: "⛽", group: "Transport" },
  { key: "parking", label: "Parking / tolls", icon: "🅿️", group: "Transport" },
  { key: "lodging", label: "Hotel / lodging", icon: "🏨", group: "Lodging" },
  { key: "meals", label: "Meals", icon: "🍽", group: "Meals" },
  { key: "entertainment", label: "Client entertainment", icon: "🥂", group: "Meals" },
  { key: "conference", label: "Conference / registration", icon: "🎟", group: "Other" },
  { key: "communication", label: "Phone / internet / roaming", icon: "📶", group: "Other" },
  { key: "visa", label: "Visa / travel documents", icon: "🛂", group: "Other" },
  { key: "insurance", label: "Travel insurance", icon: "🛡", group: "Other" },
  { key: "laundry", label: "Laundry", icon: "👔", group: "Other" },
  { key: "tips", label: "Tips / gratuities", icon: "💰", group: "Other" },
  { key: "supplies", label: "Office supplies / printing", icon: "🖨", group: "Other" },
  { key: "other", label: "Other", icon: "📦", group: "Other" },
];
const CAT = Object.fromEntries(CATEGORIES.map((c) => [c.key, c]));
const GROUPS = ["Transport", "Lodging", "Meals", "Other"];

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const todayISO = () => new Date().toISOString().slice(0, 10);

function fmtMoney(n, ccy) {
  const v = Number(n) || 0;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: ccy || "EUR" }).format(v);
  } catch {
    return `${v.toFixed(2)} ${ccy || ""}`.trim();
  }
}
function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d)) return iso;
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
}
function daysInclusive(a, b) {
  if (!a || !b) return 0;
  const d = (new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 86400000;
  return d >= 0 ? Math.round(d) + 1 : 0;
}
function nightsBetween(a, b) {
  if (!a || !b) return 0;
  const d = (new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 86400000;
  return d > 0 ? Math.round(d) : 0;
}
function fmtSize(b) {
  if (b < 1024) return b + " B";
  if (b < 1048576) return (b / 1024).toFixed(0) + " KB";
  return (b / 1048576).toFixed(1) + " MB";
}
function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setPath(obj, path, val) {
  const ks = path.split(".");
  let o = obj;
  for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]] ??= {};
  o[ks.at(-1)] = val;
}
let toastTimer;
function toast(msg, ms = 3500) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}
function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}
function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1]);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}
function blobToDataURL(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}
async function dataURLToBlob(url) {
  return (await fetch(url)).blob();
}
function download(filename, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}
const safeName = (s) => String(s || "trip").replace(/[^\w\-]+/g, "_").slice(0, 60);

/* ------------------------------------------------------------------ */
/* Storage (IndexedDB)                                                 */
/* ------------------------------------------------------------------ */

const db = await new Promise((res, rej) => {
  const req = indexedDB.open("travel-expenses", 1);
  req.onupgradeneeded = () => {
    const d = req.result;
    d.createObjectStore("trips", { keyPath: "id" });
    const f = d.createObjectStore("files", { keyPath: "id" });
    f.createIndex("tripId", "tripId");
  };
  req.onsuccess = () => res(req.result);
  req.onerror = () => rej(req.error);
});
function idb(store, mode, fn) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, mode);
    const s = tx.objectStore(store);
    const r = fn(s);
    tx.oncomplete = () => res(r?.result);
    tx.onerror = () => rej(tx.error);
  });
}
const dbGetAll = (store) => idb(store, "readonly", (s) => s.getAll());
const dbPut = (store, v) => idb(store, "readwrite", (s) => s.put(v));
const dbDel = (store, id) => idb(store, "readwrite", (s) => s.delete(id));
const dbFilesForTrip = (tripId) => idb("files", "readonly", (s) => s.index("tripId").getAll(tripId));

const settings = (() => {
  let s = {};
  try {
    s = JSON.parse(localStorage.getItem("te-settings") || "{}");
  } catch {}
  return s;
})();
function saveSettings() {
  try {
    localStorage.setItem("te-settings", JSON.stringify(settings));
  } catch {}
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

let trips = [];
let trip = null; // current trip
let files = []; // files for current trip
const urlCache = new Map(); // fileId -> objectURL

function newTrip() {
  return {
    id: uid(),
    name: "New business trip",
    createdAt: new Date().toISOString(),
    traveler: {
      name: settings.travelerName || "",
      employeeId: settings.employeeId || "",
      email: "",
      department: settings.department || "",
      costCenter: settings.costCenter || "",
      manager: settings.manager || "",
    },
    purpose: "",
    destination: "",
    client: "",
    startDate: "",
    endDate: "",
    baseCurrency: settings.defaultCurrency || "EUR",
    advance: 0,
    perDiem: { enabled: false, rate: 0, travelDayPct: 100 },
    notes: "",
    flights: [],
    hotels: [],
    expenses: [],
  };
}

const saveTrip = debounce(async () => {
  if (!trip) return;
  trip.updatedAt = new Date().toISOString();
  await dbPut("trips", trip);
}, 250);
async function saveTripNow() {
  trip.updatedAt = new Date().toISOString();
  await dbPut("trips", trip);
}

function fileURL(f) {
  if (!urlCache.has(f.id)) urlCache.set(f.id, URL.createObjectURL(f.blob));
  return urlCache.get(f.id);
}
function receiptNo(fileId) {
  const i = files.findIndex((f) => f.id === fileId);
  return i >= 0 ? "R" + (i + 1) : "";
}
function baseAmount(e) {
  const base = (trip.baseCurrency || "").toUpperCase();
  const ccy = (e.currency || "").toUpperCase();
  if (!ccy || ccy === base) return round2(e.amount);
  if (!e.rate) return null;
  return round2(e.amount * e.rate);
}

/* ------------------------------------------------------------------ */
/* Rendering: sidebar + header                                         */
/* ------------------------------------------------------------------ */

function renderTripList() {
  const ul = $("#trip-list");
  const sorted = [...trips].sort((a, b) => (b.startDate || b.createdAt).localeCompare(a.startDate || a.createdAt));
  ul.innerHTML = sorted.length
    ? sorted
        .map(
          (t) => `<li data-id="${t.id}" class="${trip?.id === t.id ? "active" : ""}">${esc(t.name)}
            <span class="small muted">${t.startDate ? fmtDate(t.startDate) : "no dates yet"}${t.destination ? " · " + esc(t.destination) : ""}</span></li>`
        )
        .join("")
    : `<li class="muted small">No trips yet</li>`;
}

function renderHeader() {
  $("#trip-title").textContent = trip.name || "Untitled trip";
  const bits = [];
  if (trip.destination) bits.push(trip.destination);
  if (trip.startDate) bits.push(`${fmtDate(trip.startDate)} – ${fmtDate(trip.endDate || trip.startDate)}`);
  const d = daysInclusive(trip.startDate, trip.endDate);
  if (d) bits.push(`${d} day${d > 1 ? "s" : ""}`);
  bits.push(`${trip.expenses.length} expense${trip.expenses.length === 1 ? "" : "s"}`);
  $("#trip-subtitle").textContent = bits.join(" · ");
}

function showView() {
  $("#empty-state").hidden = !!trip;
  $("#trip-view").hidden = !trip;
}

async function openTrip(id) {
  for (const u of urlCache.values()) URL.revokeObjectURL(u);
  urlCache.clear();
  trip = trips.find((t) => t.id === id) || null;
  files = trip ? (await dbFilesForTrip(trip.id)).sort((a, b) => a.addedAt.localeCompare(b.addedAt)) : [];
  try {
    localStorage.setItem("te-last-trip", id || "");
  } catch {}
  showView();
  renderTripList();
  if (trip) renderAll();
}

function renderAll() {
  renderHeader();
  renderInbox();
  renderDetails();
  renderItinerary();
  renderExpenses();
  if (currentTab() === "report") renderReport();
}

/* ------------------------------------------------------------------ */
/* Tabs                                                                */
/* ------------------------------------------------------------------ */

function currentTab() {
  return $("#tabs button.active")?.dataset.tab;
}
function setTab(tab) {
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $$(".tab-panel").forEach((p) => (p.hidden = p.dataset.panel !== tab));
  if (tab === "report") renderReport();
  if (tab === "expenses") renderExpenses();
  if (tab === "itinerary") renderItinerary();
}
$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (b) setTab(b.dataset.tab);
});

/* ------------------------------------------------------------------ */
/* Inbox / receipts                                                    */
/* ------------------------------------------------------------------ */

const isImage = (f) => f.type.startsWith("image/");
const isPDF = (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);
const isText = (f) => !isImage(f) && !isPDF(f);

function fileThumb(f) {
  if (isImage(f)) return `<img class="thumb" src="${fileURL(f)}" alt="" />`;
  if (isPDF(f)) return `<span class="thumb">📄</span>`;
  return `<span class="thumb">✉️</span>`;
}

function linkedExpenses(fileId) {
  return trip.expenses.filter((e) => e.receiptId === fileId);
}

function renderInbox() {
  const pending = files.filter((f) => !f.processed);
  $("#inbox-list").innerHTML = pending.length
    ? pending
        .map(
          (f) => `<li data-id="${f.id}">${fileThumb(f)}
          <span class="name" title="${esc(f.name)}">${esc(f.name)} <span class="muted small">${fmtSize(f.size)}</span></span>
          <button class="btn icon" data-act="view" title="Open">👁</button>
          <button class="btn icon" data-act="manual" title="Enter details by hand">✍️</button>
          <button class="btn icon" data-act="done" title="Mark as handled">✔</button>
          <button class="btn icon danger" data-act="del" title="Remove">✕</button></li>`
        )
        .join("")
    : `<li class="muted small">Nothing waiting. Drop receipts above.</li>`;

  $("#receipt-list").innerHTML = files.length
    ? files
        .map((f, i) => {
          const n = linkedExpenses(f.id).length;
          const badge = !f.processed
            ? `<span class="badge warn">in inbox</span>`
            : n
              ? `<span class="badge ok">${n} expense${n > 1 ? "s" : ""}</span>`
              : `<span class="badge">itinerary / info</span>`;
          return `<li data-id="${f.id}">${fileThumb(f)}
          <span class="name" title="${esc(f.name)}"><strong>R${i + 1}</strong> · ${esc(f.name)}</span>${badge}
          <button class="btn icon" data-act="view" title="Open">👁</button>
          <button class="btn icon" data-act="reread" title="Send back to inbox to read again">↺</button>
          <button class="btn icon danger" data-act="del" title="Delete">✕</button></li>`;
        })
        .join("")
    : `<li class="muted small">No receipts yet.</li>`;

  $("#ai-hint").innerHTML = settings.apiKey
    ? ""
    : `To read receipts automatically, add your Claude API key in <a href="#" class="link" id="lnk-settings">Settings</a>. Without it, use ✍️ to type the details in yourself.`;
  $("#lnk-settings")?.addEventListener("click", (e) => {
    e.preventDefault();
    openSettings();
  });
}

async function onFileListClick(e) {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const id = b.closest("li").dataset.id;
  const f = files.find((x) => x.id === id);
  if (!f) return;
  const act = b.dataset.act;
  if (act === "view") window.open(fileURL(f), "_blank");
  if (act === "done") {
    f.processed = true;
    await dbPut("files", f);
    renderInbox();
  }
  if (act === "reread") {
    f.processed = false;
    await dbPut("files", f);
    renderInbox();
    toast("Moved back to the inbox.");
  }
  if (act === "manual") {
    openExpenseDialog(null, { receiptId: f.id });
  }
  if (act === "del") {
    const n = linkedExpenses(f.id).length;
    if (!confirm(`Delete "${f.name}"?${n ? ` ${n} expense(s) will lose their receipt link.` : ""}`)) return;
    await dbDel("files", f.id);
    files = files.filter((x) => x.id !== f.id);
    trip.expenses.forEach((x) => x.receiptId === f.id && (x.receiptId = ""));
    await saveTripNow();
    renderAll();
  }
}
$("#inbox-list").addEventListener("click", onFileListClick);
$("#receipt-list").addEventListener("click", onFileListClick);

// Shrink big photos so they upload fast and fit API limits; also normalises odd formats.
async function normaliseImage(file) {
  const okTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  try {
    const bmp = await createImageBitmap(file);
    const max = 2000;
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (scale === 1 && okTypes.includes(file.type) && file.size < 3.5 * 1048576) return file;
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.85));
    return new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return file; // browser can't decode it (e.g. HEIC outside Safari) — keep as is
  }
}

async function addFiles(list) {
  if (!trip) return;
  let n = 0;
  for (let file of list) {
    if (file.type.startsWith("image/")) file = await normaliseImage(file);
    const rec = {
      id: uid(),
      tripId: trip.id,
      name: file.name || `pasted-${Date.now()}.png`,
      type: file.type || (/\.pdf$/i.test(file.name) ? "application/pdf" : "text/plain"),
      size: file.size,
      blob: file,
      addedAt: new Date().toISOString(),
      processed: false,
    };
    await dbPut("files", rec);
    files.push(rec);
    n++;
  }
  renderInbox();
  if (n) toast(`${n} file${n > 1 ? "s" : ""} added to the inbox.`);
}

$("#file-input").addEventListener("change", (e) => {
  addFiles([...e.target.files]);
  e.target.value = "";
});
const dz = $("#dropzone");
["dragenter", "dragover"].forEach((ev) =>
  dz.addEventListener(ev, (e) => {
    e.preventDefault();
    dz.classList.add("over");
  })
);
["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, () => dz.classList.remove("over")));
dz.addEventListener("drop", (e) => {
  e.preventDefault();
  addFiles([...e.dataTransfer.files]);
});
document.addEventListener("paste", (e) => {
  if (!trip || $("#trip-view").hidden) return;
  const imgs = [...(e.clipboardData?.files || [])];
  if (imgs.length) {
    e.preventDefault();
    addFiles(imgs);
  }
});
$("#btn-add-email").addEventListener("click", () => {
  const txt = $("#email-text").value.trim();
  if (!txt) return toast("Paste the email text first.");
  const subj = (txt.match(/^subject:\s*(.+)$/im)?.[1] || txt.split("\n")[0]).slice(0, 60);
  const f = new File([txt], `Email – ${subj}.txt`, { type: "text/plain" });
  addFiles([f]);
  $("#email-text").value = "";
});

/* ------------------------------------------------------------------ */
/* Automatic reading with Claude                                       */
/* ------------------------------------------------------------------ */

const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["document_type", "summary", "expenses", "flights", "hotels", "trip"],
  properties: {
    document_type: { type: "string", description: "e.g. taxi receipt, hotel folio, flight e-ticket, restaurant bill, booking confirmation" },
    summary: { type: "string", description: "One short sentence describing the document." },
    expenses: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["date", "category", "vendor", "description", "amount", "currency", "payment", "attendees"],
        properties: {
          date: { type: "string", description: "YYYY-MM-DD; date of the service or charge" },
          category: { type: "string", enum: CATEGORIES.map((c) => c.key) },
          vendor: { type: "string" },
          description: { type: "string", description: "Short, specific: e.g. 'Taxi airport → hotel', 'Dinner with client', 'Hotel 3 nights incl. city tax'" },
          amount: { type: "number", description: "Total actually paid/charged, incl. tax and tip, in the document's currency" },
          currency: { type: "string", description: "ISO 4217 code, e.g. EUR, USD, GBP" },
          payment: { type: "string", enum: ["personal", "company", "unknown"], description: "'company' only if the document shows it was billed to/paid by the company or a company account" },
          attendees: { type: "string", description: "People present for meals/entertainment if stated, else empty" },
        },
      },
    },
    flights: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["mode", "date", "carrier", "number", "from", "to", "depart", "arrive", "cabin", "booking_ref"],
        properties: {
          mode: { type: "string", enum: ["flight", "train", "bus", "ferry"] },
          date: { type: "string", description: "YYYY-MM-DD departure date" },
          carrier: { type: "string" },
          number: { type: "string", description: "Flight/train number, e.g. LH 2471" },
          from: { type: "string", description: "Origin city and airport/station code" },
          to: { type: "string" },
          depart: { type: "string", description: "HH:MM local" },
          arrive: { type: "string", description: "HH:MM local" },
          cabin: { type: "string" },
          booking_ref: { type: "string" },
        },
      },
    },
    hotels: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "city", "check_in", "check_out", "confirmation"],
        properties: {
          name: { type: "string" },
          city: { type: "string" },
          check_in: { type: "string", description: "YYYY-MM-DD" },
          check_out: { type: "string", description: "YYYY-MM-DD" },
          confirmation: { type: "string" },
        },
      },
    },
    trip: {
      type: "object",
      additionalProperties: false,
      required: ["traveler_name", "destination", "start_date", "end_date"],
      properties: {
        traveler_name: { type: "string", description: "Passenger/guest name if shown, else empty" },
        destination: { type: "string", description: "Destination city/country if this document reveals it, else empty" },
        start_date: { type: "string", description: "Earliest travel date this document shows (YYYY-MM-DD) or empty" },
        end_date: { type: "string", description: "Latest travel date this document shows (YYYY-MM-DD) or empty" },
      },
    },
  },
};

function systemPrompt() {
  return `You extract business-travel expense data from receipts, invoices, tickets, booking confirmations and emails for a corporate expense report.

Rules:
- Use "" for any text you cannot find. Never invent numbers, dates or names.
- Dates as YYYY-MM-DD. If the year is missing, infer it from the trip dates given below.
- Create an expense only for money that was actually charged or paid (or prepaid). A booking that says "pay at the property" / "pay at hotel" is NOT an expense yet — record the hotel stay only.
- Use the grand total actually paid (incl. VAT, service, tip). If a tip was added by hand, include it.
- Hotel folios: one "lodging" expense for room + room taxes/city tax. Put restaurant/room-service charges on the folio as separate "meals" expenses and minibar/laundry/parking etc. under their own categories, so the office can see them.
- Flight tickets/e-tickets: one "airfare" expense for the ticket price; extra baggage/seat fees as "baggage". Also list every segment under flights.
- Boarding passes alone are not expenses (no price) — only list the flight segment.
- Uber/Bolt/Lyft/taxi: category "taxi"; describe the route if shown.
- Restaurant bills: "meals" unless clients/guests are clearly present → "entertainment". Fill attendees if names are listed.
- A document may contain zero expenses (e.g. itinerary only) — that is fine.
- currency: ISO code. € → EUR, £ → GBP, $ → USD unless the context clearly indicates another dollar.

Trip context: ${trip.name || "business trip"}${trip.destination ? ", destination " + trip.destination : ""}${
    trip.startDate ? `, travel dates ${trip.startDate} to ${trip.endDate || trip.startDate}` : ""
  }. Traveller: ${trip.traveler?.name || "unknown"}. Reimbursement currency: ${trip.baseCurrency}.`;
}

async function fileToContent(f) {
  if (isImage(f)) {
    const ok = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (!ok.includes(f.type)) throw new Error(`Image format ${f.type || "unknown"} can't be read — convert it to JPG or PNG.`);
    return [{ type: "image", source: { type: "base64", media_type: f.type, data: await blobToBase64(f.blob) } }];
  }
  if (isPDF(f)) {
    return [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: await blobToBase64(f.blob) } }];
  }
  let text = await f.blob.text();
  if (/html?$/i.test(f.name) || /<html|<body|<table/i.test(text.slice(0, 5000))) {
    text = new DOMParser().parseFromString(text, "text/html").body?.innerText || text;
  }
  return [{ type: "text", text: `--- Email / text document "${f.name}" ---\n${text}` }];
}

async function extractFromFile(client, f) {
  const content = [
    ...(await fileToContent(f)),
    { type: "text", text: `File name: "${f.name}". Extract all expenses, flight/train segments, hotel stays and trip hints from this document.` },
  ];
  const resp = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: { type: "json_schema", schema: EXTRACTION_SCHEMA } },
    system: systemPrompt(),
    messages: [{ role: "user", content }],
  });
  if (resp.stop_reason === "refusal") throw new Error("The document could not be processed (declined).");
  if (resp.stop_reason === "max_tokens") throw new Error("The document was too long to finish reading.");
  const text = resp.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  return JSON.parse(text);
}

async function analyzeInbox() {
  const pending = files.filter((f) => !f.processed);
  if (!pending.length) return toast("The inbox is empty — add receipts first.");
  if (!settings.apiKey) {
    toast("Add your Claude API key in Settings to read receipts automatically.");
    return openSettings();
  }
  const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true, maxRetries: 3 });
  const btn = $("#btn-analyze");
  btn.disabled = true;
  const status = $("#ai-status");
  const results = [];
  const errors = [];
  let done = 0;
  status.textContent = `Reading ${pending.length} document(s)…`;

  const queue = [...pending];
  const worker = async () => {
    while (queue.length) {
      const f = queue.shift();
      try {
        results.push({ file: f, data: await extractFromFile(client, f) });
      } catch (err) {
        console.error(err);
        let msg = err?.message || String(err);
        if (err instanceof Anthropic.AuthenticationError) msg = "API key was rejected — check it in Settings.";
        else if (err instanceof Anthropic.RateLimitError) msg = "Rate limited — wait a minute and try again.";
        else if (err instanceof Anthropic.APIConnectionError) msg = "Could not reach the Claude API — check your connection.";
        errors.push({ file: f, msg });
      }
      done++;
      status.textContent = `Read ${done} of ${pending.length}…`;
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  btn.disabled = false;
  status.textContent = errors.length
    ? `Finished with problems: ${errors.map((e) => `"${e.file.name}": ${e.msg}`).join(" · ")}`
    : `Finished reading ${results.length} document(s).`;
  if (results.length) openReview(results);
}
$("#btn-analyze").addEventListener("click", analyzeInbox);

/* ---------- Review of extracted data ---------- */

function normCcy(c) {
  return (c || "").trim().toUpperCase().slice(0, 3) || trip.baseCurrency;
}
function isDupExpense(x) {
  return trip.expenses.some(
    (e) => e.date === x.date && Math.abs((Number(e.amount) || 0) - (Number(x.amount) || 0)) < 0.01 && (e.currency || "").toUpperCase() === normCcy(x.currency)
  );
}
function isDupFlight(x) {
  const n = (s) => (s || "").replace(/\s+/g, "").toUpperCase();
  return trip.flights.some((f) => f.date === x.date && n(f.number) === n(x.number) && n(x.number));
}
function isDupHotel(x) {
  return trip.hotels.some((h) => h.checkIn === x.check_in && (h.name || "").toLowerCase() === (x.name || "").toLowerCase());
}

let pendingReview = null;
function openReview(results) {
  const items = [];
  const hints = {};
  for (const { file, data } of results) {
    (data.expenses || []).forEach((x) => items.push({ kind: "expense", file, x, dup: isDupExpense(x) }));
    (data.flights || []).forEach((x) => items.push({ kind: "flight", file, x, dup: isDupFlight(x) }));
    (data.hotels || []).forEach((x) => items.push({ kind: "hotel", file, x, dup: isDupHotel(x) }));
    const t = data.trip || {};
    if (t.traveler_name && !hints.traveler_name) hints.traveler_name = t.traveler_name;
    if (t.destination && !hints.destination) hints.destination = t.destination;
    if (t.start_date && (!hints.start_date || t.start_date < hints.start_date)) hints.start_date = t.start_date;
    if (t.end_date && (!hints.end_date || t.end_date > hints.end_date)) hints.end_date = t.end_date;
  }
  // flag duplicates between documents in this same batch (e.g. booking email + invoice)
  const key = (it) => {
    const x = it.x, n = (s) => String(s || "").replace(/\s+/g, "").toUpperCase();
    if (it.kind === "expense") return `e|${x.date}|${round2(x.amount)}|${normCcy(x.currency)}`;
    if (it.kind === "flight") return n(x.number) ? `f|${x.date}|${n(x.number)}` : null;
    return `h|${x.check_in}|${n(x.name)}`;
  };
  const seen = new Set();
  for (const it of items) {
    const k = key(it);
    if (k && seen.has(k)) it.dup = true;
    if (k) seen.add(k);
  }
  // also widen with segment / stay dates
  for (const it of items) {
    const ds = it.kind === "flight" ? [it.x.date] : it.kind === "hotel" ? [it.x.check_in, it.x.check_out] : [];
    for (const d of ds.filter(Boolean)) {
      if (!hints.start_date || d < hints.start_date) hints.start_date = d;
      if (!hints.end_date || d > hints.end_date) hints.end_date = d;
    }
  }
  pendingReview = { results, items, hints };

  const row = (it, i, cells) =>
    `<tr><td><input type="checkbox" data-i="${i}" ${it.dup ? "" : "checked"} /></td>${cells}<td class="small muted">${esc(it.file.name)}${
      it.dup ? ' <span class="badge warn">possible duplicate</span>' : ""
    }</td></tr>`;
  const ex = items.map((it, i) => [it, i]).filter(([it]) => it.kind === "expense");
  const fl = items.map((it, i) => [it, i]).filter(([it]) => it.kind === "flight");
  const ho = items.map((it, i) => [it, i]).filter(([it]) => it.kind === "hotel");

  let html = results
    .map(({ file, data }) => `<div class="small"><strong>${esc(file.name)}</strong> — ${esc(data.document_type)}: ${esc(data.summary)}</div>`)
    .join("");
  if (ex.length)
    html += `<h4>Expenses</h4><div class="table-wrap"><table class="grid"><tr><th></th><th>Date</th><th>Category</th><th>Vendor / description</th><th class="num">Amount</th><th>Paid</th><th>Source</th></tr>${ex
      .map(([it, i]) =>
        row(
          it,
          i,
          `<td>${esc(it.x.date)}</td><td>${CAT[it.x.category]?.icon || ""} ${esc(CAT[it.x.category]?.label || it.x.category)}</td><td>${esc(it.x.vendor)}<div class="small muted">${esc(
            it.x.description
          )}</div></td><td class="num">${fmtMoney(it.x.amount, normCcy(it.x.currency))}</td><td>${esc(it.x.payment)}</td>`
        )
      )
      .join("")}</table></div>`;
  if (fl.length)
    html += `<h4>Flights / trains</h4><div class="table-wrap"><table class="grid"><tr><th></th><th>Date</th><th>No.</th><th>Route</th><th>Times</th><th>Source</th></tr>${fl
      .map(([it, i]) =>
        row(it, i, `<td>${esc(it.x.date)}</td><td>${esc(it.x.carrier)} ${esc(it.x.number)}</td><td>${esc(it.x.from)} → ${esc(it.x.to)}</td><td>${esc(it.x.depart)}–${esc(it.x.arrive)}</td>`)
      )
      .join("")}</table></div>`;
  if (ho.length)
    html += `<h4>Hotel stays</h4><div class="table-wrap"><table class="grid"><tr><th></th><th>Hotel</th><th>City</th><th>Dates</th><th>Source</th></tr>${ho
      .map(([it, i]) => row(it, i, `<td>${esc(it.x.name)}</td><td>${esc(it.x.city)}</td><td>${esc(it.x.check_in)} → ${esc(it.x.check_out)}</td>`))
      .join("")}</table></div>`;

  const hintRows = [];
  if (hints.destination && !trip.destination) hintRows.push(["destination", "Destination", hints.destination]);
  if (hints.start_date && !trip.startDate) hintRows.push(["startDate", "Departure date", hints.start_date]);
  if (hints.end_date && !trip.endDate) hintRows.push(["endDate", "Return date", hints.end_date]);
  if (hints.traveler_name && !trip.traveler.name) hintRows.push(["traveler.name", "Traveller name", hints.traveler_name]);
  if (hintRows.length)
    html += `<h4>Trip details</h4>${hintRows
      .map(([k, l, v]) => `<label class="check"><input type="checkbox" data-hint="${k}" data-val="${esc(v)}" checked /> ${l}: <strong>${esc(v)}</strong></label><br/>`)
      .join("")}`;
  if (!items.length && !hintRows.length) html += `<p>Nothing to add was found in these documents. They are kept as attachments.</p>`;

  $("#review-body").innerHTML = html;
  $("#review-dialog").showModal();
}

$("#review-dialog").addEventListener("close", async () => {
  const dlg = $("#review-dialog");
  if (!pendingReview) return;
  const { results, items } = pendingReview;
  pendingReview = null;
  if (dlg.returnValue !== "ok") return;
  const checked = new Set($$("#review-body input[data-i]:checked").map((c) => +c.dataset.i));
  let ne = 0;
  items.forEach((it, i) => {
    if (!checked.has(i)) return;
    const x = it.x;
    if (it.kind === "expense") {
      const ccy = normCcy(x.currency);
      trip.expenses.push({
        id: uid(),
        date: x.date || "",
        category: CAT[x.category] ? x.category : "other",
        vendor: x.vendor || "",
        description: x.description || "",
        amount: round2(x.amount),
        currency: ccy,
        rate: ccy === trip.baseCurrency ? 1 : null,
        payment: x.payment === "company" ? "company" : "personal",
        attendees: x.attendees || "",
        receiptId: it.file.id,
        notes: "",
      });
      ne++;
    } else if (it.kind === "flight") {
      trip.flights.push({ id: uid(), mode: x.mode, date: x.date, carrier: x.carrier, number: x.number, from: x.from, to: x.to, depart: x.depart, arrive: x.arrive, cabin: x.cabin, bookingRef: x.booking_ref });
    } else {
      trip.hotels.push({ id: uid(), name: x.name, city: x.city, checkIn: x.check_in, checkOut: x.check_out, confirmation: x.confirmation });
    }
  });
  $$("#review-body input[data-hint]:checked").forEach((c) => setPath(trip, c.dataset.hint, c.dataset.val));
  trip.flights.sort((a, b) => (a.date + a.depart).localeCompare(b.date + b.depart));
  trip.hotels.sort((a, b) => (a.checkIn || "").localeCompare(b.checkIn || ""));
  for (const { file } of results) {
    file.processed = true;
    await dbPut("files", file);
  }
  await saveTripNow();
  renderTripList();
  renderAll();
  if (ne && trip.expenses.some((e) => baseAmount(e) == null)) fillRates(true);
  toast(`Added ${ne} expense(s). Check the Expenses tab.`);
});

/* ------------------------------------------------------------------ */
/* Trip details form                                                   */
/* ------------------------------------------------------------------ */

function renderDetails() {
  const form = $("#details-form");
  for (const el of form.elements) {
    if (!el.name) continue;
    const v = getPath(trip, el.name);
    if (el.type === "checkbox") el.checked = !!v;
    else el.value = v ?? "";
  }
}
$("#details-form").addEventListener("input", (e) => {
  const el = e.target;
  if (!el.name) return;
  let v = el.type === "checkbox" ? el.checked : el.value;
  if (el.type === "number") v = el.value === "" ? 0 : Number(el.value);
  if (el.name === "baseCurrency") v = v.toUpperCase();
  setPath(trip, el.name, v);
  saveTrip();
  renderHeader();
  renderTripList();
});

/* ------------------------------------------------------------------ */
/* Itinerary                                                           */
/* ------------------------------------------------------------------ */

const inp = (field, val, type = "text", extra = "") => `<input data-f="${field}" type="${type}" value="${esc(val)}" ${extra} />`;

function renderItinerary() {
  $("#flights-table").innerHTML =
    `<tr><th>Type</th><th>Date</th><th>Carrier</th><th>No.</th><th>From</th><th>To</th><th>Dep.</th><th>Arr.</th><th>Class</th><th>Booking ref</th><th></th></tr>` +
    (trip.flights.length
      ? trip.flights
          .map(
            (f) => `<tr data-id="${f.id}">
      <td><select data-f="mode">${["flight", "train", "bus", "ferry"].map((m) => `<option ${f.mode === m ? "selected" : ""}>${m}</option>`).join("")}</select></td>
      <td>${inp("date", f.date, "date")}</td><td>${inp("carrier", f.carrier)}</td><td>${inp("number", f.number)}</td>
      <td>${inp("from", f.from)}</td><td>${inp("to", f.to)}</td><td>${inp("depart", f.depart, "time")}</td><td>${inp("arrive", f.arrive, "time")}</td>
      <td>${inp("cabin", f.cabin)}</td><td>${inp("bookingRef", f.bookingRef)}</td>
      <td><button class="btn icon danger" data-act="del">✕</button></td></tr>`
          )
          .join("")
      : `<tr><td colspan="11" class="muted small">No segments yet — they are filled in automatically from tickets and booking emails.</td></tr>`);

  $("#hotels-table").innerHTML =
    `<tr><th>Hotel</th><th>City</th><th>Check-in</th><th>Check-out</th><th class="num">Nights</th><th>Confirmation</th><th></th></tr>` +
    (trip.hotels.length
      ? trip.hotels
          .map(
            (h) => `<tr data-id="${h.id}">
      <td>${inp("name", h.name)}</td><td>${inp("city", h.city)}</td><td>${inp("checkIn", h.checkIn, "date")}</td><td>${inp("checkOut", h.checkOut, "date")}</td>
      <td class="num">${nightsBetween(h.checkIn, h.checkOut) || ""}</td><td>${inp("confirmation", h.confirmation)}</td>
      <td><button class="btn icon danger" data-act="del">✕</button></td></tr>`
          )
          .join("")
      : `<tr><td colspan="7" class="muted small">No hotel stays yet.</td></tr>`);
}
function bindItineraryTable(sel, key) {
  const t = $(sel);
  t.addEventListener("change", (e) => {
    const el = e.target.closest("[data-f]");
    if (!el) return;
    const item = trip[key].find((x) => x.id === el.closest("tr").dataset.id);
    item[el.dataset.f] = el.value;
    saveTrip();
    if (key === "hotels") renderItinerary();
  });
  t.addEventListener("click", (e) => {
    if (!e.target.closest("[data-act=del]")) return;
    const id = e.target.closest("tr").dataset.id;
    trip[key] = trip[key].filter((x) => x.id !== id);
    saveTrip();
    renderItinerary();
  });
}
bindItineraryTable("#flights-table", "flights");
bindItineraryTable("#hotels-table", "hotels");
$("#btn-add-flight").addEventListener("click", () => {
  trip.flights.push({ id: uid(), mode: "flight", date: trip.startDate || "", carrier: "", number: "", from: "", to: "", depart: "", arrive: "", cabin: "", bookingRef: "" });
  saveTrip();
  renderItinerary();
});
$("#btn-add-hotel").addEventListener("click", () => {
  trip.hotels.push({ id: uid(), name: "", city: trip.destination || "", checkIn: trip.startDate || "", checkOut: trip.endDate || "", confirmation: "" });
  saveTrip();
  renderItinerary();
});

/* ------------------------------------------------------------------ */
/* Expenses                                                            */
/* ------------------------------------------------------------------ */

function sortedExpenses() {
  return [...trip.expenses].sort((a, b) => (a.date || "").localeCompare(b.date || "") || (a.category || "").localeCompare(b.category || ""));
}

function expenseIssues(e) {
  const out = [];
  if (!e.receiptId) out.push("no receipt");
  if (baseAmount(e) == null) out.push("exchange rate missing");
  if (!e.date) out.push("no date");
  else if (trip.startDate && trip.endDate && (e.date < trip.startDate || e.date > trip.endDate) && e.category !== "airfare" && e.category !== "lodging" && e.category !== "visa" && e.category !== "insurance")
    out.push("outside trip dates");
  if (!(Number(e.amount) > 0)) out.push("amount is zero");
  if ((e.category === "entertainment") && !e.attendees) out.push("attendees missing");
  return out;
}

function totals() {
  let total = 0, company = 0, personal = 0, missing = 0;
  const byCat = {}, byGroup = {}, byDay = {};
  for (const e of trip.expenses) {
    const b = baseAmount(e);
    if (b == null) {
      missing++;
      continue;
    }
    total += b;
    if (e.payment === "company") company += b;
    else personal += b;
    byCat[e.category] = (byCat[e.category] || 0) + b;
    const g = CAT[e.category]?.group || "Other";
    byGroup[g] = (byGroup[g] || 0) + b;
    const d = e.date || "—";
    byDay[d] ??= {};
    byDay[d][g] = (byDay[d][g] || 0) + b;
  }
  const days = daysInclusive(trip.startDate, trip.endDate);
  let perDiem = 0, perDiemDays = "";
  if (trip.perDiem?.enabled && days && trip.perDiem.rate) {
    const pct = (trip.perDiem.travelDayPct === 0 || trip.perDiem.travelDayPct ? Number(trip.perDiem.travelDayPct) : 100) / 100;
    const full = Math.max(days - 2, 0);
    const travel = Math.min(days, 2);
    perDiem = round2(trip.perDiem.rate * (full + travel * pct));
    perDiemDays = pct === 1 ? `${days} day(s) × ${fmtMoney(trip.perDiem.rate, trip.baseCurrency)}` : `${full} full day(s) + ${travel} travel day(s) at ${Math.round(pct * 100)}% × ${fmtMoney(trip.perDiem.rate, trip.baseCurrency)}`;
  }
  const advance = round2(trip.advance || 0);
  const due = round2(personal + perDiem - advance);
  return { total: round2(total), company: round2(company), personal: round2(personal), missing, byCat, byGroup, byDay, perDiem, perDiemDays, advance, due, days };
}

function renderExpenses() {
  const base = trip.baseCurrency;
  const list = sortedExpenses();
  $("#expenses-table").innerHTML =
    `<tr><th>Date</th><th>Category</th><th>Vendor / description</th><th class="num">Amount</th><th class="num">${esc(base)}</th><th>Paid</th><th>Receipt</th><th>Check</th></tr>` +
    (list.length
      ? list
          .map((e) => {
            const b = baseAmount(e);
            const issues = expenseIssues(e);
            return `<tr class="clickable" data-id="${e.id}">
        <td>${fmtDate(e.date)}</td>
        <td>${CAT[e.category]?.icon || ""} ${esc(CAT[e.category]?.label || e.category)}</td>
        <td>${esc(e.vendor)}<div class="small muted">${esc(e.description)}</div></td>
        <td class="num">${fmtMoney(e.amount, e.currency)}</td>
        <td class="num">${b == null ? '<span class="badge warn">rate?</span>' : fmtMoney(b, base)}</td>
        <td>${e.payment === "company" ? '<span class="badge">company</span>' : '<span class="badge ok">me</span>'}</td>
        <td>${e.receiptId ? receiptNo(e.receiptId) : "—"}</td>
        <td>${issues.map((i) => `<span class="badge warn">${esc(i)}</span>`).join(" ")}</td></tr>`;
          })
          .join("")
      : `<tr><td colspan="8" class="muted small">No expenses yet. Add receipts in the first tab, or click “+ Add expense”.</td></tr>`);

  const t = totals();
  $("#expense-totals").innerHTML = `
    <span>Total spent: <strong>${fmtMoney(t.total, base)}</strong></span>
    <span>Paid by company: <strong>${fmtMoney(t.company, base)}</strong></span>
    <span>Paid by me: <strong>${fmtMoney(t.personal, base)}</strong></span>
    ${t.perDiem ? `<span>Per diem: <strong>${fmtMoney(t.perDiem, base)}</strong></span>` : ""}
    <span>Due to me: <strong>${fmtMoney(t.due, base)}</strong></span>`;

  const warns = [];
  if (t.missing) warns.push(`${t.missing} expense(s) in a foreign currency have no exchange rate yet — click “Fill exchange rates” or enter them.`);
  const noRec = trip.expenses.filter((e) => !e.receiptId).length;
  if (noRec) warns.push(`${noRec} expense(s) have no receipt attached.`);
  if (!trip.startDate || !trip.endDate) warns.push("Trip dates are not set (Trip details tab).");
  if (!trip.purpose) warns.push("Business purpose is empty (Trip details tab) — most expense offices require it.");
  $("#expense-warnings").innerHTML = warns.length ? `<div class="warning"><strong>Before submitting:</strong><ul>${warns.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>` : "";
}

$("#expenses-table").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-id]");
  if (tr) openExpenseDialog(trip.expenses.find((x) => x.id === tr.dataset.id));
});
$("#btn-add-expense").addEventListener("click", () => openExpenseDialog(null));

let editingExpense = null;
let editingFromInbox = null;
function openExpenseDialog(exp, preset = {}) {
  editingExpense = exp;
  editingFromInbox = preset.receiptId && !exp ? preset.receiptId : null;
  const form = $("#expense-form");
  form.category.innerHTML = CATEGORIES.map((c) => `<option value="${c.key}">${c.icon} ${c.label}</option>`).join("");
  form.receiptId.innerHTML = `<option value="">— none —</option>` + files.map((f, i) => `<option value="${f.id}">R${i + 1} · ${esc(f.name)}</option>`).join("");
  $$(".base-ccy").forEach((s) => (s.textContent = trip.baseCurrency));
  const e = exp || {
    date: trip.startDate || todayISO(),
    category: "meals",
    vendor: "",
    description: "",
    amount: "",
    currency: trip.baseCurrency,
    rate: "",
    payment: "personal",
    attendees: "",
    receiptId: "",
    notes: "",
    ...preset,
  };
  for (const k of ["date", "category", "vendor", "description", "amount", "currency", "rate", "payment", "attendees", "receiptId", "notes"]) form[k].value = e[k] ?? "";
  $("#expense-dialog-title").textContent = exp ? "Edit expense" : "New expense";
  $("#btn-expense-delete").hidden = !exp;
  $("#expense-dialog").showModal();
  if (editingFromInbox) {
    const f = files.find((x) => x.id === editingFromInbox);
    if (f) window.open(fileURL(f), "_blank");
  }
}
$("#expense-dialog").addEventListener("close", async () => {
  const dlg = $("#expense-dialog");
  if (dlg.returnValue !== "save") return;
  const form = $("#expense-form");
  const ccy = form.currency.value.trim().toUpperCase();
  const data = {
    date: form.date.value,
    category: form.category.value,
    vendor: form.vendor.value.trim(),
    description: form.description.value.trim(),
    amount: round2(form.amount.value),
    currency: ccy,
    rate: ccy === trip.baseCurrency ? 1 : form.rate.value ? Number(form.rate.value) : null,
    payment: form.payment.value,
    attendees: form.attendees.value.trim(),
    receiptId: form.receiptId.value,
    notes: form.notes.value.trim(),
  };
  if (editingExpense) Object.assign(editingExpense, data);
  else trip.expenses.push({ id: uid(), ...data });
  if (editingFromInbox) {
    const f = files.find((x) => x.id === editingFromInbox);
    if (f) {
      f.processed = true;
      await dbPut("files", f);
    }
  }
  await saveTripNow();
  renderAll();
  if (data.rate == null) fillRates(true);
});
$("#btn-expense-delete").addEventListener("click", async () => {
  if (!editingExpense || !confirm("Delete this expense?")) return;
  trip.expenses = trip.expenses.filter((x) => x !== editingExpense);
  $("#expense-dialog").close("cancel");
  await saveTripNow();
  renderAll();
});

/* ---------- Exchange rates (ECB reference rates via frankfurter.app) ---------- */

async function fillRates(quiet = false) {
  const base = trip.baseCurrency;
  const todo = trip.expenses.filter((e) => e.currency && e.currency !== base && !e.rate);
  if (!todo.length) return quiet || toast("All expenses already have exchange rates.");
  let ok = 0;
  const failed = new Set();
  for (const e of todo) {
    const d = e.date && e.date <= todayISO() ? e.date : "latest";
    try {
      const r = await fetch(`https://api.frankfurter.app/${d}?from=${encodeURIComponent(e.currency)}&to=${encodeURIComponent(base)}`);
      if (!r.ok) throw new Error(r.status);
      const j = await r.json();
      const rate = j.rates?.[base];
      if (!rate) throw new Error("no rate");
      e.rate = rate;
      e.notes = e.notes && /ECB rate/.test(e.notes) ? e.notes : [e.notes, `ECB rate of ${j.date}`].filter(Boolean).join("; ");
      ok++;
    } catch {
      failed.add(e.currency);
    }
  }
  await saveTripNow();
  renderExpenses();
  if (currentTab() === "report") renderReport();
  toast(
    `Filled ${ok} exchange rate(s).${failed.size ? ` Couldn't find rates for ${[...failed].join(", ")} — please enter them by hand (use your card statement rate).` : ""}`,
    6000
  );
}
$("#btn-rates").addEventListener("click", () => fillRates(false));

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

function reportNumber() {
  const d = (trip.startDate || trip.createdAt || todayISO()).slice(0, 10).replace(/-/g, "");
  return `TE-${d}-${trip.id.slice(0, 4).toUpperCase()}`;
}

function buildReport() {
  const base = trip.baseCurrency;
  const m = (n) => fmtMoney(n, base);
  const t = totals();
  const list = sortedExpenses();
  const tr = trip.traveler || {};
  const nights = trip.hotels.reduce((s, h) => s + nightsBetween(h.checkIn, h.checkOut), 0);

  const flags = [];
  list.forEach((e) => {
    const iss = expenseIssues(e);
    if (iss.length) flags.push(`${fmtDate(e.date)} ${e.vendor || CAT[e.category]?.label}: ${iss.join(", ")}`);
  });
  if (trip.perDiem?.enabled && list.some((e) => e.category === "meals")) flags.push("Per diem claimed and meal receipts also listed — check your company policy.");

  const groupsUsed = GROUPS.filter((g) => t.byGroup[g]);
  const days = Object.keys(t.byDay).sort();

  const html = `<div class="rpt">
  <div class="rpt-head">
    <div><h1>Travel Expense Report</h1><div>${esc(trip.name)}</div></div>
    <div style="text-align:right"><div><strong>Report no.</strong> ${reportNumber()}</div><div><strong>Date</strong> ${fmtDate(todayISO())}</div><div><strong>Currency</strong> ${esc(base)}</div></div>
  </div>

  <h2>Employee</h2>
  <dl class="kv">
    <dt>Name</dt><dd>${esc(tr.name)}</dd><dt>Employee ID</dt><dd>${esc(tr.employeeId)}</dd>
    <dt>Department</dt><dd>${esc(tr.department)}</dd><dt>Cost centre</dt><dd>${esc(tr.costCenter)}</dd>
    <dt>Email</dt><dd>${esc(tr.email)}</dd><dt>Approver</dt><dd>${esc(tr.manager)}</dd>
  </dl>

  <h2>Trip</h2>
  <dl class="kv">
    <dt>Purpose</dt><dd style="grid-column: span 3">${esc(trip.purpose) || "<em>— not given —</em>"}</dd>
    <dt>Destination</dt><dd>${esc(trip.destination)}</dd><dt>Client / customer</dt><dd>${esc(trip.client)}</dd>
    <dt>Departure</dt><dd>${fmtDate(trip.startDate)}</dd><dt>Return</dt><dd>${fmtDate(trip.endDate)}</dd>
    <dt>Duration</dt><dd>${t.days ? `${t.days} day(s)` : ""}${nights ? `, ${nights} hotel night(s)` : ""}</dd><dt>Receipts</dt><dd>${files.length}</dd>
  </dl>

  ${
    trip.flights.length
      ? `<h2>Travel itinerary</h2><table><tr><th>Date</th><th>Type</th><th>Carrier / no.</th><th>From</th><th>To</th><th>Dep.</th><th>Arr.</th><th>Class</th><th>Booking ref</th></tr>
    ${trip.flights
      .map(
        (f) => `<tr><td>${fmtDate(f.date)}</td><td>${esc(f.mode)}</td><td>${esc(f.carrier)} ${esc(f.number)}</td><td>${esc(f.from)}</td><td>${esc(f.to)}</td><td>${esc(f.depart)}</td><td>${esc(f.arrive)}</td><td>${esc(f.cabin)}</td><td>${esc(f.bookingRef)}</td></tr>`
      )
      .join("")}</table>`
      : ""
  }
  ${
    trip.hotels.length
      ? `<h2>Accommodation</h2><table><tr><th>Hotel</th><th>City</th><th>Check-in</th><th>Check-out</th><th class="num">Nights</th><th>Confirmation</th></tr>
    ${trip.hotels
      .map(
        (h) => `<tr><td>${esc(h.name)}</td><td>${esc(h.city)}</td><td>${fmtDate(h.checkIn)}</td><td>${fmtDate(h.checkOut)}</td><td class="num">${nightsBetween(h.checkIn, h.checkOut)}</td><td>${esc(h.confirmation)}</td></tr>`
      )
      .join("")}</table>`
      : ""
  }

  <h2>Summary</h2>
  <div class="summary">
    <table>
      <tr><th>Category</th><th class="num">Amount (${esc(base)})</th></tr>
      ${CATEGORIES.filter((c) => t.byCat[c.key])
        .map((c) => `<tr><td>${c.label}</td><td class="num">${m(t.byCat[c.key])}</td></tr>`)
        .join("")}
      ${t.perDiem ? `<tr><td>Per diem / daily allowance</td><td class="num">${m(t.perDiem)}</td></tr>` : ""}
      <tr class="total"><td>Total cost of trip</td><td class="num">${m(t.total + t.perDiem)}</td></tr>
    </table>
    <table>
      <tr><th>Reimbursement</th><th class="num">${esc(base)}</th></tr>
      <tr><td>Total expenses</td><td class="num">${m(t.total)}</td></tr>
      <tr><td>Less: paid directly by company</td><td class="num">− ${m(t.company)}</td></tr>
      <tr><td>Paid personally by employee</td><td class="num">${m(t.personal)}</td></tr>
      ${t.perDiem ? `<tr><td>Add: per diem<div class="small">${esc(t.perDiemDays)}</div></td><td class="num">${m(t.perDiem)}</td></tr>` : ""}
      ${t.advance ? `<tr><td>Less: cash advance received</td><td class="num">− ${m(t.advance)}</td></tr>` : ""}
      <tr class="total due"><td>${t.due >= 0 ? "Amount due to employee" : "Amount owed back to company"}</td><td class="num">${m(Math.abs(t.due))}</td></tr>
    </table>
  </div>
  ${t.missing ? `<div class="flags"><strong>Note:</strong> ${t.missing} expense(s) are excluded from totals because the exchange rate is missing.</div>` : ""}

  ${
    days.length
      ? `<h2>Daily breakdown</h2><table><tr><th>Date</th>${groupsUsed.map((g) => `<th class="num">${g}</th>`).join("")}<th class="num">Total</th></tr>
    ${days
      .map((d) => {
        const row = t.byDay[d];
        const sum = Object.values(row).reduce((a, b) => a + b, 0);
        return `<tr><td>${d === "—" ? "no date" : fmtDate(d)}</td>${groupsUsed.map((g) => `<td class="num">${row[g] ? m(row[g]) : ""}</td>`).join("")}<td class="num">${m(sum)}</td></tr>`;
      })
      .join("")}
    <tr class="total"><td>Total</td>${groupsUsed.map((g) => `<td class="num">${m(t.byGroup[g])}</td>`).join("")}<td class="num">${m(t.total)}</td></tr></table>`
      : ""
  }

  <h2>Itemised expenses</h2>
  <table>
    <tr><th>#</th><th>Date</th><th>Category</th><th>Vendor / description</th><th class="num">Amount</th><th class="num">Rate</th><th class="num">${esc(base)}</th><th>Paid by</th><th>Receipt</th></tr>
    ${list
      .map((e, i) => {
        const b = baseAmount(e);
        return `<tr><td>${i + 1}</td><td>${fmtDate(e.date)}</td><td>${esc(CAT[e.category]?.label || e.category)}</td>
        <td>${esc(e.vendor)}${e.description ? `<div class="small">${esc(e.description)}</div>` : ""}${e.attendees ? `<div class="small">Attendees: ${esc(e.attendees)}</div>` : ""}${
          e.notes ? `<div class="small"><em>${esc(e.notes)}</em></div>` : ""
        }</td>
        <td class="num">${fmtMoney(e.amount, e.currency)}</td><td class="num">${e.currency === base ? "" : e.rate ? Number(e.rate).toFixed(4) : "?"}</td>
        <td class="num">${b == null ? "—" : m(b)}</td><td>${e.payment === "company" ? "Company" : "Employee"}</td><td>${e.receiptId ? receiptNo(e.receiptId) : "missing"}</td></tr>`;
      })
      .join("")}
    ${t.perDiem ? `<tr><td></td><td></td><td>Per diem</td><td>${esc(t.perDiemDays)}</td><td></td><td></td><td class="num">${m(t.perDiem)}</td><td>Allowance</td><td>n/a</td></tr>` : ""}
    <tr class="total"><td colspan="6">Total</td><td class="num">${m(t.total + t.perDiem)}</td><td colspan="2"></td></tr>
  </table>
  ${flags.length ? `<div class="flags"><strong>Items to review:</strong><ul>${flags.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></div>` : ""}
  ${trip.notes ? `<h2>Notes</h2><p>${esc(trip.notes)}</p>` : ""}

  <p class="small" style="margin-top:18px">I certify that these expenses were incurred wholly, exclusively and necessarily for business purposes and have not been claimed elsewhere.</p>
  <div class="sign"><div>Employee signature &amp; date</div><div>Approved by (manager) &amp; date</div><div>Finance / expenses office</div></div>

  ${$("#opt-receipts").checked && files.length ? receiptsAppendix() : ""}
  </div>`;
  $("#report").innerHTML = html;
}

function receiptsAppendix() {
  return `<div class="receipts-section"><h2>Receipts</h2><div class="receipts">${files
    .map((f, i) => {
      const exps = linkedExpenses(f.id);
      const cap = `<div class="cap"><strong>R${i + 1}</strong> · ${esc(f.name)}${exps.length ? " — " + exps.map((e) => `${fmtDate(e.date)} ${esc(e.vendor)} ${fmtMoney(e.amount, e.currency)}`).join("; ") : ""}</div>`;
      if (isImage(f)) return `<div class="receipt"><img src="${fileURL(f)}" alt="Receipt R${i + 1}" />${cap}</div>`;
      if (isPDF(f)) return `<div class="receipt">📄 PDF document — attach the original file.${cap}</div>`;
      return `<div class="receipt"><div class="email-text" data-id="${f.id}"></div>${cap}</div>`;
    })
    .join("")}</div></div>`;
}
// Build the report, then fill in the text of email receipts for the appendix.
async function renderReport() {
  buildReport();
  for (const el of $$("#report .email-text")) {
    const f = files.find((x) => x.id === el.dataset.id);
    if (!f) continue;
    let txt = await f.blob.text();
    if (/<html|<body/i.test(txt.slice(0, 5000))) txt = new DOMParser().parseFromString(txt, "text/html").body?.innerText || txt;
    el.innerHTML = `<pre style="white-space:pre-wrap;font-size:9px;max-height:420px;overflow:hidden;margin:0">${esc(txt.slice(0, 3000))}</pre>`;
  }
}

$("#opt-receipts").addEventListener("change", () => renderReport());
$("#btn-print").addEventListener("click", async () => {
  await renderReport();
  const imgs = $$("#report img");
  await Promise.all(imgs.map((i) => (i.complete ? null : new Promise((r) => (i.onload = i.onerror = r)))));
  const old = document.title;
  document.title = `Expense report ${reportNumber()} ${trip.traveler?.name || ""}`.trim();
  window.print();
  document.title = old;
});

$("#btn-csv").addEventListener("click", () => {
  const base = trip.baseCurrency;
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = [["Report no.", "Traveller", "Employee ID", "Trip", "Purpose", "Date", "Category", "Vendor", "Description", "Amount", "Currency", "Exchange rate", `Amount ${base}`, "Paid by", "Receipt", "Attendees", "Notes"]];
  for (const e of sortedExpenses()) {
    const b = baseAmount(e);
    rows.push([
      reportNumber(), trip.traveler?.name, trip.traveler?.employeeId, trip.name, trip.purpose, e.date, CAT[e.category]?.label || e.category, e.vendor, e.description,
      e.amount, e.currency, e.currency === base ? 1 : e.rate ?? "", b ?? "", e.payment === "company" ? "Company" : "Employee", e.receiptId ? receiptNo(e.receiptId) : "", e.attendees, e.notes,
    ]);
  }
  const t = totals();
  if (t.perDiem) rows.push([reportNumber(), trip.traveler?.name, trip.traveler?.employeeId, trip.name, trip.purpose, trip.startDate, "Per diem", "", t.perDiemDays, t.perDiem, base, 1, t.perDiem, "Allowance", "", "", ""]);
  const csv = "﻿" + rows.map((r) => r.map(q).join(",")).join("\r\n");
  download(`${safeName(trip.name)}_expenses.csv`, csv, "text/csv;charset=utf-8");
});

/* ------------------------------------------------------------------ */
/* Trips: create / delete / backup / import                            */
/* ------------------------------------------------------------------ */

$("#btn-new-trip").addEventListener("click", async () => {
  const t = newTrip();
  trips.push(t);
  await dbPut("trips", t);
  await openTrip(t.id);
  setTab("details");
  $("#details-form [name=name]").select();
});
$("#trip-list").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-id]");
  if (li) openTrip(li.dataset.id);
});
$("#btn-delete-trip").addEventListener("click", async () => {
  if (!confirm(`Delete the trip "${trip.name}" with all its expenses and receipts? This cannot be undone. (Tip: make a JSON backup first.)`)) return;
  for (const f of files) await dbDel("files", f.id);
  await dbDel("trips", trip.id);
  trips = trips.filter((t) => t.id !== trip.id);
  await openTrip(trips[0]?.id);
});

$("#btn-export-json").addEventListener("click", async () => {
  const out = {
    format: "travel-expenses-backup",
    version: 1,
    trip,
    files: await Promise.all(files.map(async (f) => ({ id: f.id, name: f.name, type: f.type, size: f.size, addedAt: f.addedAt, processed: f.processed, dataURL: await blobToDataURL(f.blob) }))),
  };
  download(`${safeName(trip.name)}_backup.json`, JSON.stringify(out), "application/json");
});

$("#btn-import").addEventListener("click", () => $("#import-file").click());
$("#import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const t = data.trip || data;
    if (!t || typeof t !== "object" || !Array.isArray(t.expenses ?? [])) throw new Error("not a trip file");
    const fresh = { ...newTrip(), ...t, traveler: { ...newTrip().traveler, ...(t.traveler || {}) }, perDiem: { ...newTrip().perDiem, ...(t.perDiem || {}) } };
    fresh.flights = (fresh.flights || []).map((x) => ({ id: uid(), ...x }));
    fresh.hotels = (fresh.hotels || []).map((x) => ({ id: uid(), ...x }));
    fresh.expenses = (fresh.expenses || []).map((x) => ({ id: uid(), payment: "personal", receiptId: "", ...x, currency: (x.currency || fresh.baseCurrency).toUpperCase() }));
    if (!fresh.id || trips.some((x) => x.id === fresh.id)) fresh.id = uid();
    const idMap = {};
    for (const f of data.files || []) {
      const blob = await dataURLToBlob(f.dataURL);
      const rec = { id: uid(), tripId: fresh.id, name: f.name, type: f.type || blob.type, size: blob.size, blob, addedAt: f.addedAt || new Date().toISOString(), processed: f.processed ?? true };
      idMap[f.id] = rec.id;
      await dbPut("files", rec);
    }
    fresh.expenses.forEach((x) => (x.receiptId = idMap[x.receiptId] || ""));
    trips.push(fresh);
    await dbPut("trips", fresh);
    await openTrip(fresh.id);
    toast(`Imported "${fresh.name}".`);
  } catch (err) {
    alert("Could not import this file: " + err.message);
  }
});

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

function openSettings() {
  const f = $("#settings-form");
  for (const k of ["apiKey", "defaultCurrency", "travelerName", "employeeId", "department", "costCenter", "manager"]) f[k].value = settings[k] || "";
  $("#settings-dialog").showModal();
}
$("#btn-settings").addEventListener("click", openSettings);
$("#settings-dialog").addEventListener("close", () => {
  if ($("#settings-dialog").returnValue !== "save") return;
  const f = $("#settings-form");
  for (const k of ["apiKey", "defaultCurrency", "travelerName", "employeeId", "department", "costCenter", "manager"]) settings[k] = f[k].value.trim();
  settings.defaultCurrency = (settings.defaultCurrency || "").toUpperCase();
  saveSettings();
  if (trip) renderInbox();
  toast("Settings saved.");
});

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

trips = await dbGetAll("trips");
let last = "";
try {
  last = localStorage.getItem("te-last-trip") || "";
} catch {}
await openTrip(trips.find((t) => t.id === last)?.id || trips[0]?.id);
