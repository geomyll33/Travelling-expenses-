// On-device receipt reader: no API key, nothing leaves the browser.
// Text comes from OCR (Tesseract, English + Greek), PDF text (pdf.js) or email text.
// Simple rules then pick out the total, date, currency, merchant and category.
// Results have the same shape as the Claude extraction, so the app's review step works for both.

const here = (p) => new URL(p, import.meta.url).href;

/* ---------------- text extraction ---------------- */

let workerPromise = null;
async function getOcrWorker(onProgress) {
  if (!workerPromise) {
    workerPromise = (async () => {
      const mod = await import("./vendor/ocr/tesseract.esm.min.js");
      const Tesseract = mod.default || mod;
      return Tesseract.createWorker(["eng", "ell"], 1, {
        workerPath: here("./vendor/ocr/worker.min.js"),
        corePath: here("./vendor/ocr/"),
        langPath: here("./vendor/ocr/lang"),
        gzip: true,
        logger: (m) => progressSink?.(m),
      });
    })();
    workerPromise.catch(() => (workerPromise = null));
  }
  progressSink = onProgress;
  return workerPromise;
}
let progressSink = null;

async function ocr(image, onProgress) {
  const worker = await getOcrWorker(onProgress);
  progressSink = onProgress;
  const { data } = await worker.recognize(image);
  return data.text || "";
}

let pdfjsPromise = null;
async function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import("./vendor/pdfjs/pdf.min.mjs").then((m) => {
      m.GlobalWorkerOptions.workerSrc = here("./vendor/pdfjs/pdf.worker.min.mjs");
      return m;
    });
  }
  return pdfjsPromise;
}

async function pdfText(blob, onProgress) {
  const pdfjs = await getPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
  const pages = Math.min(doc.numPages, 15);
  let text = "";
  for (let i = 1; i <= pages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    // rebuild lines from y positions
    let lastY = null;
    for (const it of tc.items) {
      const y = it.transform?.[5];
      if (lastY !== null && Math.abs(y - lastY) > 2) text += "\n";
      else if (lastY !== null) text += " ";
      text += it.str;
      lastY = y;
    }
    text += "\n";
  }
  // scanned PDF (no text layer): render the first pages and OCR them
  if (text.replace(/\s/g, "").length < 20) {
    text = "";
    for (let i = 1; i <= Math.min(doc.numPages, 3); i++) {
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: 2 });
      const c = document.createElement("canvas");
      c.width = vp.width;
      c.height = vp.height;
      await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
      text += (await ocr(c, onProgress)) + "\n";
    }
  }
  return text;
}

function decodeQuotedPrintable(s) {
  if (!/=\r?\n|=[0-9A-F]{2}/.test(s)) return s;
  const bytes = [];
  const src = s.replace(/=\r?\n/g, "");
  for (let i = 0; i < src.length; i++) {
    if (src[i] === "=" && /^[0-9A-F]{2}$/i.test(src.slice(i + 1, i + 3))) {
      bytes.push(parseInt(src.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      const enc = new TextEncoder().encode(src[i]);
      bytes.push(...enc);
    }
  }
  try {
    return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
  } catch {
    return s;
  }
}

async function emailText(blob, name) {
  let t = await blob.text();
  t = decodeQuotedPrintable(t);
  if (/\.html?$/i.test(name) || /<html|<body|<table|<div/i.test(t.slice(0, 20000))) {
    const htmlPart = t.slice(Math.max(0, t.search(/<html|<body|<table|<div/i)));
    const head = t.slice(0, Math.max(0, t.search(/<html|<body|<table|<div/i)));
    const doc = new DOMParser().parseFromString(htmlPart, "text/html");
    doc.querySelectorAll("style,script").forEach((n) => n.remove());
    $blockify(doc.body);
    t = head + "\n" + (doc.body?.textContent || "");
  }
  return t.replace(/ /g, " ").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n");
}
function $blockify(root) {
  if (!root) return;
  root.querySelectorAll("br,p,div,tr,li,h1,h2,h3,h4,table").forEach((n) => n.append("\n"));
  root.querySelectorAll("td,th").forEach((n) => n.append(" "));
}

/* ---------------- parsing helpers ---------------- */

const CURRENCY_HINTS = [
  ["EUR", /€|\bEUR\b|\bευρώ|\beuro/gi],
  ["GBP", /£|\bGBP\b/gi],
  ["USD", /US\$|\bUSD\b|\$/gi],
  ["CHF", /\bCHF\b/gi],
  ["SEK", /\bSEK\b/gi],
  ["NOK", /\bNOK\b/gi],
  ["DKK", /\bDKK\b/gi],
  ["PLN", /\bPLN\b|zł/gi],
  ["CZK", /\bCZK\b|Kč/gi],
  ["HUF", /\bHUF\b|\bFt\b/gi],
  ["RON", /\bRON\b|\blei\b/gi],
  ["TRY", /\bTRY\b|₺/gi],
  ["AED", /\bAED\b/gi],
  ["JPY", /\bJPY\b|¥/gi],
  ["CAD", /\bCAD\b|C\$/gi],
  ["AUD", /\bAUD\b|A\$/gi],
  ["INR", /\bINR\b|₹/gi],
];
function detectCurrency(text, fallback) {
  let best = null, n = 0;
  for (const [code, re] of CURRENCY_HINTS) {
    const c = (text.match(re) || []).length;
    if (c > n) [best, n] = [code, c];
  }
  return best || fallback;
}

// numbers like 1.234,56 / 1,234.56 / 12,50 / 12.50 / 1 234,56
const NUM_RE = /(?<![\d.,])(\d{1,3}(?:[.,\s]\d{3})+[.,]\d{2}|\d+[.,]\d{2})(?![\d])/g;
function parseNum(s) {
  s = s.replace(/\s/g, "");
  const lastSep = Math.max(s.lastIndexOf(","), s.lastIndexOf("."));
  const intPart = s.slice(0, lastSep).replace(/[.,]/g, "");
  return Number(intPart + "." + s.slice(lastSep + 1));
}
function amountsIn(line) {
  return [...line.matchAll(NUM_RE)].map((m) => parseNum(m[1])).filter((n) => n > 0 && n < 1e6);
}

const STRONG_TOTAL = /grand\s*total|total\s*(amount\s*)?(due|paid|charged|to\s*pay|incl)|amount\s*(due|paid|charged)|balance\s*due|you\s*paid|total\s*price|total\s*cost|trip\s*total|πληρωτέο|συνολο\s*πληρ|σύνολο\s*πληρ|γενικο\s*συνολο|γενικό\s*σύνολο|zu\s*zahlen|gesamtbetrag|montant\s*total|total\s*ttc|importe\s*total|totale\s*complessivo/i;
const TOTAL = /\btotal\b|\bsum\b|\bamount\b|charged|σύνολο|συνολο|συνολικ|ΣΥΝΟΛΟ|πληρωμή|αξία|\bsumme\b|\bgesamt|\bbetrag\b|\bmontant\b|\btotale\b|\bimporte\b|\bpaid\b|\bfare\b/i;
const NOT_TOTAL = /sub\s*-?total|υποσύνολο|μερικό|vat|tax|φπα|φ\.π\.α|mwst|tva|iva|net\b|καθαρ|discount|έκπτωση|change\b|ρέστα|tip\s*suggest|cash\s*tendered|μετρητά/i;

function findTotal(lines) {
  const strong = [], normal = [];
  lines.forEach((ln, i) => {
    if (NOT_TOTAL.test(ln) && !STRONG_TOTAL.test(ln)) return;
    const bucket = STRONG_TOTAL.test(ln) ? strong : TOTAL.test(ln) ? normal : null;
    if (!bucket) return;
    let nums = amountsIn(ln);
    if (!nums.length && lines[i + 1]) nums = amountsIn(lines[i + 1]);
    if (nums.length) bucket.push(nums[nums.length - 1]);
  });
  if (strong.length) return { amount: strong[strong.length - 1], sure: true };
  if (normal.length) return { amount: Math.max(...normal), sure: true };
  const all = lines.flatMap(amountsIn);
  return all.length ? { amount: Math.max(...all), sure: false } : { amount: 0, sure: false };
}

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  ιαν: 1, φεβ: 2, μαρ: 3, απρ: 4, μαι: 5, μαϊ: 5, ιουν: 6, ιουλ: 7, αυγ: 8, σεπ: 9, οκτ: 10, νοε: 11, δεκ: 12,
  mär: 3, mai: 5, okt: 10, dez: 12, janv: 1, févr: 2, avr: 4, juil: 7, août: 8, déc: 12,
};
const pad = (n) => String(n).padStart(2, "0");
function mkDate(y, m, d) {
  y = Number(y);
  if (y < 100) y += 2000;
  m = Number(m);
  d = Number(d);
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}
function findDates(text, usStyle) {
  const out = [];
  const push = (iso, idx) => iso && out.push({ iso, idx });
  for (const m of text.matchAll(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/g)) push(mkDate(m[1], m[2], m[3]), m.index);
  for (const m of text.matchAll(/\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})\b/g)) {
    let [a, b] = [Number(m[1]), Number(m[2])];
    if (usStyle && a <= 12 && b <= 31) [a, b] = [b, a];
    if (a <= 12 && b > 12) [a, b] = [b, a]; // must be month/day
    push(mkDate(m[3], b, a), m.index);
  }
  const mon = "([A-Za-zΑ-Ωα-ωάέήίόύώϊΐäéû]{3,5})[a-zα-ωάέήίόύώäéû]*\\.?";
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${mon},?\\s+(20\\d{2}|\\d{2})\\b`, "gi"))) {
    const mm = MONTHS[m[2].toLowerCase()] || MONTHS[m[2].toLowerCase().slice(0, 3)];
    if (mm) push(mkDate(m[3], mm, m[1]), m.index);
  }
  for (const m of text.matchAll(new RegExp(`\\b${mon}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})\\b`, "gi"))) {
    const mm = MONTHS[m[1].toLowerCase()] || MONTHS[m[1].toLowerCase().slice(0, 3)];
    if (mm) push(mkDate(m[3], mm, m[2]), m.index);
  }
  return out.sort((x, y) => x.idx - y.idx).map((d) => d.iso);
}
function pickDate(dates, ctx) {
  if (!dates.length) return "";
  if (ctx.startDate && ctx.endDate) {
    const lo = shift(ctx.startDate, -3), hi = shift(ctx.endDate, 3);
    const inTrip = dates.find((d) => d >= lo && d <= hi);
    if (inTrip) return inTrip;
  }
  const today = new Date().toISOString().slice(0, 10);
  return dates.find((d) => d <= today) || dates[0];
}
function shift(iso, days) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

const CATEGORY_RULES = [
  ["taxi", /\buber\b|\bbolt\b|\blyft\b|free\s?now|\bbeat\b|\btaxi|\bcab\b|ταξί|ταξι|\bταξ|ride\s*with|your\s*trip\s*with|cabify|grab\b|careem/i],
  ["airfare", /boarding\s*pass|e-?ticket|itinerary\s*receipt|flight|airline|airways|\baegean\b|olympic\s*air|ryanair|easyjet|lufthansa|wizz|sky\s*express|british\s*airways|klm|air\s*france|\bswiss\b|austrian|turkish\s*airlines|emirates|πτήση|εισιτήριο\s*πτ/i],
  ["baggage", /excess\s*baggage|extra\s*bag|checked\s*bag|seat\s*(selection|reservation)|αποσκευ/i],
  ["train", /\btrain\b|railway|\brail\b|bahn|trenitalia|sncf|renfe|eurostar|hellenic\s*train|τρένο|ΟΣΕ|\bmetro\b|\bsubway\b|μετρό|underground|\btube\b|oyster|\bbus\b|λεωφορ|κτελ|ktel|flixbus|tram/i],
  ["car_rental", /car\s*rental|rent\s*a\s*car|hertz|avis|europcar|sixt|enterprise\s*rent|budget\s*rent|ενοικίαση\s*αυτοκ/i],
  ["fuel", /\bfuel\b|petrol|diesel|unleaded|gasoline|\bgas\s*station|καύσιμ|βενζίν|αμόλυβδ|πετρέλαιο\s*κίν|\bshell\b|\bbp\b|\besso\b|eko\b|avin|aral\b|total\s*energies/i],
  ["parking", /parking|car\s*park|στάθμευση|παρκινγκ|toll|διόδια|αττική\s*οδός|ολυμπία\s*οδός|εγνατία|maut|péage|autostrada/i],
  ["lodging", /\bhotel|\binn\b|resort|hostel|suites?\b|lodge|guest\s*folio|\bfolio\b|room\s*charge|room\s*rate|accommodation|booking\.com|airbnb|ξενοδοχ|κατάλυμα|διαμον|δωμάτιο|check-?in|nights?\b/i],
  ["conference", /conference|registration\s*fee|summit|expo\b|congress|συνέδριο|eventbrite|ticket\s*for\s*event/i],
  ["communication", /roaming|e-?sim|\bsim\b|mobile\s*data|wi-?fi|internet\s*access|vodafone|cosmote|\bnova\b|orange|t-mobile/i],
  ["visa", /\bvisa\s*(fee|application)|\besta\b|\betias\b|passport|eta\s*application|διαβατήριο/i],
  ["insurance", /travel\s*insurance|ασφάλιση\s*ταξ/i],
  ["laundry", /laundry|dry\s*clean|πλυντήρ|καθαριστήρ/i],
  ["supplies", /office\s*supplies|printing|stationery|χαρτοπωλ|εκτυπώσ/i],
  ["meals", /restaurant|ristorante|trattoria|bistro|brasserie|\bcafe\b|café|caf[eé]|coffee|starbucks|costa|\bbar\b|pub\b|grill|pizza|burger|sushi|taverna|\bfood\b|breakfast|lunch|dinner|meal|deliveroo|wolt|efood|just\s*eat|εστιατόρ|ταβέρν|καφέ|καφε|ψητοπωλ|σουβλακ|πιτσαρ|μπαρ\b|γεύμα|φαγητ|εστίαση|table\s*\d|covers?\b|server:|waiter/i],
];
function detectCategory(text) {
  for (const [cat, re] of CATEGORY_RULES) if (re.test(text)) return cat;
  return "other";
}

function detectVendor(text, name, isEmail) {
  if (isEmail) {
    const from = text.match(/^from:\s*"?([^"<\n]+?)"?\s*(<[^>]*>)?\s*$/im)?.[1]?.trim();
    if (from && !/no-?reply|noreply/i.test(from)) return from.replace(/\s*(receipts?|bookings?|reservations?)$/i, "");
    const domain = text.match(/^from:.*@([\w-]+)\./im)?.[1];
    if (domain) return domain.charAt(0).toUpperCase() + domain.slice(1);
    const subj = text.match(/^subject:\s*(.+)$/im)?.[1];
    if (subj) return subj.slice(0, 50);
  }
  const brand = text.match(/\b(uber|bolt|lyft|free\s?now|aegean|ryanair|easyjet|lufthansa|wizz\s?air|booking\.com|airbnb|marriott|hilton|hyatt|ibis|novotel|radisson|holiday inn|starbucks|hertz|avis|sixt|europcar|trainline|eurostar)\b/i)?.[1];
  if (brand) return brand.replace(/\b\w/g, (c) => c.toUpperCase());
  const skip = /receipt|invoice|folio|απόδειξη|αποδειξη|τιμολόγιο|τιμολογιο|\btax\b|\bvat\b|αφμ|δου|\btel\b|τηλ|www\.|http|\bdate\b|ημερ|guest|\bname\b|customer|bill\s*to|πελάτ|όνομα|ονομα|\btable\b|server|cashier|ταμ[ιί]|total|σύνολο|συνολο|amount|paid|\d{4,}|^[^\p{L}]+$|:/iu;
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length >= 3 && l.length <= 50 && /\p{L}{3}/u.test(l) && !skip.test(l));
  const business = /hotel|inn\b|resort|restaurant|ristorante|trattoria|taverna|caf[eé]|bar\b|bistro|taxi|ταξί|ταξι|ξενοδοχ|εστιατ|ταβέρν|καφέ|parking|airlines?|airways|rail|bahn|rent/i;
  return lines.slice(0, 8).find((l) => business.test(l)) || lines[0] || name.replace(/\.\w+$/, "");
}

const PAY_LATER = /pay\s*(at|on)\s*(the\s*)?(property|hotel|arrival)|payment\s*at\s*the\s*property|you'?ll\s*pay\s*(at|when)|πληρωμή\s*στο\s*κατάλυμα|no\s*payment\s*(is\s*)?(needed|required)\s*(today|now)/i;
const COMPANY_PAID = /billed\s*to\s*(company|corporate)|corporate\s*(account|card)|company\s*account|direct\s*bill|bill\s*to\s*account|central\s*bill|εταιρικ(ή|ός)\s*(κάρτα|λογαριασμ)/i;

function findFlights(text, ctx, defaultDate) {
  const out = [];
  const seen = new Set();
  const lines = text.split("\n");
  lines.forEach((ln, i) => {
    const ctxText = [lines[i - 1], ln, lines[i + 1]].join(" ");
    for (const m of ln.matchAll(/\b([A-Z][A-Z0-9]|[A-Z0-9][A-Z])\s?(\d{2,4})\b/g)) {
      if (!/\d{1,2}:\d{2}/.test(ctxText) && !/flight|πτήση|flug|vol\b/i.test(ctxText)) continue;
      if (/^(EU|UK|US|VAT|NO|TO|AM|PM|CO|ID)$/.test(m[1])) continue;
      const key = m[1] + m[2];
      if (seen.has(key)) continue;
      seen.add(key);
      const codes = [...ctxText.matchAll(/\(([A-Z]{3})\)|\b([A-Z]{3})\b(?=\s*(?:-|–|→|>|to)\s*[A-Z(]{3,4})|(?:-|–|→|>|to)\s*\(?([A-Z]{3})\)?\b/g)]
        .map((c) => c[1] || c[2] || c[3])
        .filter((c) => c && !/^(EUR|USD|GBP|CHF|VAT|PNR|REF|THE|AND|FOR)$/.test(c));
      const times = ctxText.match(/\b\d{1,2}:\d{2}\b/g) || [];
      out.push({
        mode: "flight",
        date: findDates(ctxText, ctx.usStyle)[0] || defaultDate,
        carrier: "",
        number: `${m[1]} ${m[2]}`,
        from: codes[0] || "",
        to: codes[1] || "",
        depart: times[0] ? times[0].padStart(5, "0") : "",
        arrive: times[1] ? times[1].padStart(5, "0") : "",
        cabin: (ctxText.match(/\b(economy|business|premium economy|first)\b/i) || [""])[0],
        booking_ref: (text.match(/(?:booking\s*(?:ref(?:erence)?|code)|PNR|confirmation\s*(?:code|number)?|κωδικός\s*κράτησης)[:\s#]*([A-Z0-9]{5,8})\b/i) || [])[1] || "",
      });
    }
  });
  return out.slice(0, 8);
}

function findHotel(text, ctx, vendor) {
  const grab = (re) => {
    const m = text.match(re);
    return m ? findDates(m[0], ctx.usStyle)[0] || "" : "";
  };
  const ci = grab(/(check-?\s?in|arrival|arrive|άφιξη|ανάφιξη|anreise|arrivée)[^\n]{0,60}(\n[^\n]{0,40})?/i);
  const co = grab(/(check-?\s?out|departure|depart|αναχώρηση|abreise|départ)[^\n]{0,60}(\n[^\n]{0,40})?/i);
  if (!ci && !co) return null;
  return {
    name: vendor,
    city: "",
    check_in: ci,
    check_out: co,
    confirmation: (text.match(/(?:confirmation|booking|reservation|κράτηση[ς]?)\s*(?:number|no\.?|#|code|αριθμός)?[:\s#]*([A-Z0-9-]{5,14})\b/i) || [])[1] || "",
  };
}

/* ---------------- main entry ---------------- */

export async function readLocally(file, ctx, onProgress = () => {}) {
  const isImg = file.type.startsWith("image/");
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  const isEmail = !isImg && !isPdf;

  let text;
  if (isImg) text = await ocr(file.blob, onProgress);
  else if (isPdf) text = await pdfText(file.blob, onProgress);
  else text = await emailText(file.blob, file.name);

  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const currency = detectCurrency(text, ctx.baseCurrency);
  const usStyle = currency === "USD" || currency === "CAD";
  const ctx2 = { ...ctx, usStyle };
  const date = pickDate(findDates(text, usStyle), ctx2);
  const category = detectCategory(text);
  const vendor = detectVendor(text, file.name, isEmail);
  const { amount, sure } = findTotal(lines);
  const payLater = PAY_LATER.test(text);

  const flights = category === "airfare" || /boarding\s*pass|flight|πτήση/i.test(text) ? findFlights(text, ctx2, date) : [];
  const hotel = category === "lodging" ? findHotel(text, ctx2, vendor) : null;

  // a hotel bill is dated on check-out; a ticket on its first travel date
  const expDate = (category === "lodging" && hotel?.check_out) || (category === "airfare" && flights[0]?.date) || date;
  const expenses = [];
  const isBoardingPass = /boarding\s*pass|κάρτα\s*επιβίβασης/i.test(text) && !/total|σύνολο|fare/i.test(text);
  if (amount > 0 && !payLater && !isBoardingPass) {
    expenses.push({
      date: expDate,
      category,
      vendor,
      description: describe(category, flights, hotel),
      amount: Math.round(amount * 100) / 100,
      currency,
      payment: COMPANY_PAID.test(text) ? "company" : "personal",
      attendees: "",
    });
  }

  const tripDates = [...flights.map((f) => f.date), hotel?.check_in, hotel?.check_out].filter(Boolean).sort();
  const notes = [];
  if (!sure && expenses.length) notes.push("total not clearly labelled — check the amount");
  if (payLater) notes.push("booking to be paid at the hotel — no expense added");
  if (!text.trim()) notes.push("no text could be read — try a sharper, straighter photo");

  return {
    document_type: isImg ? "photo / scan" : isPdf ? "PDF" : "email",
    summary: `Read on this device${notes.length ? " — " + notes.join("; ") : ""}.`,
    expenses,
    flights,
    hotels: hotel ? [hotel] : [],
    trip: {
      traveler_name: "",
      destination: "",
      start_date: tripDates[0] || "",
      end_date: tripDates[tripDates.length - 1] || "",
    },
    _local: true,
    _text: text,
  };
}

function describe(cat, flights, hotel) {
  if (cat === "airfare" && flights.length) return `Flight ${flights.map((f) => [f.from, f.to].filter(Boolean).join("→") || f.number).join(", ")}`;
  if (cat === "lodging" && hotel?.check_in && hotel?.check_out) {
    const n = Math.round((new Date(hotel.check_out) - new Date(hotel.check_in)) / 86400000);
    return n > 0 ? `Hotel ${n} night${n > 1 ? "s" : ""}` : "Hotel";
  }
  return { taxi: "Taxi / ride", meals: "Meal", train: "Train / transport ticket", parking: "Parking / tolls", fuel: "Fuel" }[cat] || "";
}

export async function warmUpOcr(onProgress) {
  await getOcrWorker(onProgress);
}
