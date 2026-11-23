# Travel Expenses

A small web app for business-travel expense reports. Drop in your receipts (photos, PDF invoices, booking emails) and it reads them. It fills in flights, hotels, taxis, meals and other costs, then produces a report for the expenses office.

## Getting started

The app is static, with no build step and no server code. Open it through any static web server:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

It also works when hosted on GitHub Pages, Netlify and similar services.

## How to use it

1. **+ New trip**: fill in the traveller, the business purpose, the dates and the reimbursement currency. If your company pays a daily allowance, also set the per diem.
2. **📥 Add receipts**: drag in photos, PDFs or `.eml`/`.txt` emails, paste a screenshot (Ctrl/⌘+V), or paste an email's text.
3. **✨ Read & fill in automatically**: Claude reads each document. You then review what it found, untick anything wrong, and add the rest. Possible duplicates are unticked for you, e.g. a booking email and the hotel bill showing the same charge.
   - Expenses are sorted into categories: airfare, baggage, train, taxi/rideshare, car rental, fuel, parking, hotel, meals, client entertainment, conference fees, roaming, visa, insurance, laundry, tips, supplies and other.
   - Flight/train segments and hotel stays go into the **Itinerary** tab.
   - Empty trip details (destination, dates, traveller name) are suggested from the documents.
4. **💶 Expenses**: check and edit the items. **↻ Fill exchange rates** looks up the ECB rate for the date of each foreign-currency expense. The app flags missing receipts, missing rates, dates outside the trip and entertainment without attendees.
5. **📄 Report**: **Print / Save as PDF** makes the document for the expenses office. **Download CSV** gives a file that opens in Excel.

### What the report contains

- Employee and trip details: purpose, destination, client, dates, days and hotel nights
- Travel itinerary (flights/trains) and accommodation
- A summary by category and the reimbursement: total, paid by the company card, paid personally, plus per diem, minus cash advance, and the **amount due**
- A daily breakdown (transport / lodging / meals / other)
- An itemised list with the original currency, exchange rate, converted amount, who paid and the receipt number (R1, R2, …)
- Items to review, a certification statement and signature lines
- An appendix with every receipt image and email text, numbered to match the list

## Automatic reading (Claude API key)

To read receipts automatically, open **⚙ Settings** and enter an Anthropic API key from console.anthropic.com. The key is stored only in your browser and is sent only to `api.anthropic.com`. Without a key, receipts are still stored and attached, and you enter the details with ✍️.

The app uses the official Anthropic TypeScript SDK (bundled in `vendor/anthropic-sdk.js`, version 1.6.0) with the model `claude-opus-5-5`, structured JSON output, and server-side refusal fallback (`fallbacks: "default"`) switched on.

## Your data

Trips and receipts are stored in your browser (IndexedDB) on this device only. Use **Backup (JSON)** to save a trip with all its receipts, and **Import** to restore it on another device or browser. Import also accepts a plain trip JSON (`{ "name", "startDate", "expenses": [...] }`), so a trip prepared elsewhere can be loaded directly.

## Files

- `index.html`: page layout and dialogs
- `styles.css`: screen and print styles (A4)
- `app.js`: all app logic
- `vendor/anthropic-sdk.js`: browser bundle of `@anthropic-ai/sdk@1.6.0`

## Hosting on GitHub Pages

The app is published straight from the `ccr-68f98cab-fog57g` branch (Settings → Pages → Deploy from a branch, `/ (root)`). Every push updates the site at `https://geomyll33.github.io/Travelling-expenses-/`.
