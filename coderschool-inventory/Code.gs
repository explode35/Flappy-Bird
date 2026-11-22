/**
 * CoderSchool Inventory Scanner
 * ------------------------------------------------------------
 * A Google Apps Script web app bound to a Google Sheet.
 *  1. Snap a photo of an item on your phone.
 *  2. Claude identifies the product and searches the web for its current price.
 *  3. Review / edit the result, then save it as a row in the "Inventory" sheet.
 *
 * Setup: see README.md. In short — paste these files into Extensions > Apps Script
 * of your inventory Sheet, run "Inventory Scanner > Set up" from the Sheet menu,
 * paste your Anthropic API key, then Deploy > New deployment > Web app.
 */

// ---------- Configuration ----------
const CONFIG = {
  MODEL: 'claude-opus-5-5',
  SHEET_NAME: 'Inventory',
  PHOTO_FOLDER_NAME: 'CoderSchool Inventory Photos',
  MAX_WEB_SEARCHES: 4,
  MAX_CONTINUATIONS: 3,
};

const HEADERS = [
  'Date Added', 'Item Name', 'Category', 'Brand', 'Model / SKU', 'Description',
  'Quantity', 'Condition', 'Location / Room', 'Asset Tag',
  'Est. Unit Price (USD)', 'Price Low', 'Price High', 'Total Value',
  'Price Source 1', 'Price Source 2', 'Price Source 3',
  'AI Confidence', 'Photo', 'Notes', 'Added By',
];

const CATEGORIES = [
  'Computers & Laptops', 'Monitors & Displays', 'Tablets', 'Computer Accessories',
  'Networking', 'Printers & Scanners', 'Audio / Video', 'Robotics & STEM Kits',
  'Desks & Tables', 'Chairs & Seating', 'Cabinets & Storage', 'Whiteboards & Signage',
  'Office Supplies', 'Classroom Supplies', 'Kitchen / Breakroom', 'Software & Licenses', 'Other',
];

// ---------- Sheet menu + setup ----------
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Inventory Scanner')
    .addItem('Set up / set API key', 'setup')
    .addItem('Test API key', 'testApiKey')
    .addItem('Show web app link', 'showWebAppLink')
    .addToUi();
}

function setup() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const props = PropertiesService.getScriptProperties();
  props.setProperty('SPREADSHEET_ID', ss.getId());
  getInventorySheet_();

  const resp = ui.prompt(
    'Anthropic API key',
    'Paste your Anthropic API key (starts with "sk-ant-"). It is stored privately in this ' +
      'script\'s properties and never shown in the sheet. Leave blank to keep the current key.',
    ui.ButtonSet.OK_CANCEL
  );
  if (resp.getSelectedButton() === ui.Button.OK) {
    const key = cleanKey_(resp.getResponseText());
    if (key) {
      if (key.indexOf('sk-ant-') !== 0) {
        ui.alert('That doesn\'t look like an Anthropic API key',
          'API keys start with "sk-ant-". Create one at console.anthropic.com > API Keys ' +
          '(a Claude.ai chat subscription does not include an API key). Nothing was saved.',
          ui.ButtonSet.OK);
        return;
      }
      props.setProperty('ANTHROPIC_API_KEY', key);
      const test = checkKey_(key);
      ui.alert(test.ok ? 'API key works ✅' : 'API key problem ❌', test.message, ui.ButtonSet.OK);
      if (!test.ok) return;
    }
  }
  ui.alert(
    'Setup complete',
    'The "' + CONFIG.SHEET_NAME + '" tab is ready.\n\nNext: in the Apps Script editor choose ' +
      'Deploy > New deployment > Web app, then open the link on your phone.',
    ui.ButtonSet.OK
  );
}

/** Removes spaces, line breaks and quote marks that sneak in when copy/pasting a key. */
function cleanKey_(raw) {
  return String(raw || '').replace(/[\s"'\u201C\u201D\u2018\u2019]/g, '');
}

function getApiKey_() {
  return cleanKey_(PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY'));
}

/** Makes a tiny request to confirm the key is accepted. */
function checkKey_(key) {
  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/models?limit=1', {
    method: 'get',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code === 200) {
    return { ok: true, message: 'Anthropic accepted the key (' + key.slice(0, 10) + '…' + key.slice(-4) + '). You\'re ready to scan.' };
  }
  let detail = '';
  try { detail = JSON.parse(res.getContentText()).error.message; } catch (e) { detail = res.getContentText().slice(0, 200); }
  return {
    ok: false,
    message: 'Anthropic rejected the key (HTTP ' + code + '): ' + detail +
      '\n\nSaved key: ' + key.slice(0, 10) + '…' + key.slice(-4) + ' (' + key.length + ' characters).' +
      '\n\nFix: in console.anthropic.com > API Keys, create a NEW key, copy it with the Copy button, ' +
      'and run Inventory Scanner > Set up again.',
  };
}

function testApiKey() {
  const ui = SpreadsheetApp.getUi();
  const key = getApiKey_();
  if (!key) { ui.alert('No API key saved yet. Run Inventory Scanner > Set up.'); return; }
  const test = checkKey_(key);
  ui.alert(test.ok ? 'API key works ✅' : 'API key problem ❌', test.message, ui.ButtonSet.OK);
}

function showWebAppLink() {
  const url = ScriptApp.getService().getUrl();
  SpreadsheetApp.getUi().alert(url ? 'Open this on your phone:\n\n' + url
    : 'Not deployed yet. In the Apps Script editor: Deploy > New deployment > Web app.');
}

function getSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Spreadsheet not configured. Open the Sheet and run Inventory Scanner > Set up.');
  return ss;
}

function getInventorySheet_() {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(CONFIG.SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length)
      .setFontWeight('bold').setBackground('#1f3a5f').setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    ['K', 'L', 'M', 'N'].forEach(function (col) {
      sheet.getRange(col + '2:' + col).setNumberFormat('$#,##0.00');
    });
    sheet.getRange('A2:A').setNumberFormat('yyyy-mm-dd hh:mm');
  }
  return sheet;
}

// ---------- Web app ----------
function doGet() {
  const t = HtmlService.createTemplateFromFile('Index');
  t.categories = CATEGORIES;
  return t.evaluate()
    .setTitle('CoderSchool Inventory')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Called from the phone: identifies the item in the photo and looks up its price.
 * @param {string} base64Jpeg  JPEG image, base64 (no data: prefix)
 * @param {string} hint        Optional text the user typed (e.g. "Dell laptop, 2022")
 */
function analyzeImage(base64Jpeg, hint) {
  const apiKey = getApiKey_();
  if (!apiKey) throw new Error('No API key set. Open the Sheet and run Inventory Scanner > Set up.');

  const prompt =
    'You are helping a coding school (CoderSchool) catalog its inventory: computers, monitors, ' +
    'desks, chairs, cabinets, classroom and office supplies, etc.\n\n' +
    '1. Identify the item in the photo as specifically as you can (brand, model, size, color). ' +
    'Read any visible labels, logos, model numbers or barcodes.\n' +
    '2. Use web search to find the CURRENT new retail price in USD from reputable retailers ' +
    '(e.g. the manufacturer, Amazon, Best Buy, Staples, Office Depot, IKEA, Walmart, B&H). ' +
    'If the exact model cannot be determined, price a comparable typical item and say so.\n' +
    (hint ? '\nThe user added this note about the item: "' + String(hint).slice(0, 500) + '"\n' : '') +
    '\nWhen done, reply with ONLY a JSON object (no prose, no code fences) with these keys:\n' +
    '{\n' +
    '  "item_name": string,            // short, specific, e.g. "Dell Latitude 5440 14\\" Laptop"\n' +
    '  "category": one of ' + JSON.stringify(CATEGORIES) + ',\n' +
    '  "brand": string or "",\n' +
    '  "model": string or "",\n' +
    '  "description": string,          // one sentence: key specs, color, size\n' +
    '  "condition_guess": "New" | "Like New" | "Good" | "Fair" | "Poor",\n' +
    '  "unit_price": number,           // best single estimate, USD, new\n' +
    '  "price_low": number,\n' +
    '  "price_high": number,\n' +
    '  "sources": [{"title": string, "url": string, "price": number}],  // up to 3\n' +
    '  "confidence": "High" | "Medium" | "Low",\n' +
    '  "notes": string                 // caveats, e.g. "exact model unclear; priced comparable"\n' +
    '}';

  const messages = [{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Jpeg } },
      { type: 'text', text: prompt },
    ],
  }];

  let response = callClaude_(apiKey, messages);
  // The server-side search loop can pause on long searches; send the partial turn back to resume it.
  let assistantSoFar = [];
  for (let i = 0; i < CONFIG.MAX_CONTINUATIONS && response.stop_reason === 'pause_turn'; i++) {
    assistantSoFar = assistantSoFar.concat(response.content);
    response = callClaude_(apiKey, [messages[0], { role: 'assistant', content: assistantSoFar }]);
  }

  if (response.stop_reason === 'refusal') {
    throw new Error('The AI declined to analyze this image. Try another photo or enter details manually.');
  }

  const text = (response.content || [])
    .filter(function (b) { return b.type === 'text'; })
    .map(function (b) { return b.text; })
    .join('');
  const result = parseJson_(text);
  result.sources = (result.sources || []).slice(0, 3);
  return result;
}

function callClaude_(apiKey, messages) {
  const body = {
    model: CONFIG.MODEL,
    max_tokens: 16000,
    // Low effort keeps a scan to roughly 15–40 seconds; raise to "medium" for harder items.
    output_config: { effort: 'low' },
    tools: [{
      type: 'web_search_20260209',
      name: 'web_search',
      max_uses: CONFIG.MAX_WEB_SEARCHES,
      user_location: { type: 'approximate', country: 'US' },
    }],
    // If a request is declined by a safety classifier, retry on a fallback model automatically.
    fallbacks: 'default',
    messages: messages,
  };

  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });

  const code = res.getResponseCode();
  const json = JSON.parse(res.getContentText() || '{}');
  if (code !== 200) {
    const msg = (json.error && json.error.message) || res.getContentText();
    if (code === 401) throw new Error('Anthropic rejected the API key (' + msg + '). In the Sheet, run Inventory Scanner > Test API key for details.');
    if (code === 400 && /credit balance/i.test(msg)) throw new Error('Your Anthropic account is out of credits. Add credits at console.anthropic.com > Billing.');
    if (code === 429 || code === 529) throw new Error('The AI service is busy. Wait a moment and try again.');
    throw new Error('AI request failed (' + code + '): ' + msg);
  }
  return json;
}

function parseJson_(text) {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('Could not read the AI result. Try again or enter details manually.');
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

/**
 * Called from the phone: saves a reviewed item as a new row.
 * @param {Object} item       fields from the review form
 * @param {string} base64Jpeg optional photo to store in Google Drive
 */
function saveItem(item, base64Jpeg) {
  const sheet = getInventorySheet_();
  let photoCell = '';
  if (base64Jpeg) {
    try {
      const blob = Utilities.newBlob(Utilities.base64Decode(base64Jpeg), 'image/jpeg',
        (item.item_name || 'item').replace(/[^\w\- ]+/g, '').slice(0, 60) + ' ' +
        Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss') + '.jpg');
      const file = getPhotoFolder_().createFile(blob);
      photoCell = '=HYPERLINK("' + file.getUrl() + '","View photo")';
    } catch (e) {
      photoCell = 'Photo upload failed: ' + e.message;
    }
  }

  const qty = Math.max(1, parseInt(item.quantity, 10) || 1);
  const unit = toNumber_(item.unit_price);
  const sources = item.sources || [];
  const srcCell = function (s) {
    if (!s || !s.url) return '';
    const label = ((s.title || 'Source') + (s.price ? ' – $' + s.price : '')).replace(/"/g, "'");
    return '=HYPERLINK("' + String(s.url).replace(/"/g, '%22') + '","' + label.slice(0, 80) + '")';
  };
  let user = '';
  try { user = Session.getActiveUser().getEmail(); } catch (e) { /* not available outside domain */ }

  const row = [
    new Date(), item.item_name || '', item.category || '', item.brand || '', item.model || '',
    item.description || '', qty, item.condition || '', item.location || '', item.asset_tag || '',
    unit, toNumber_(item.price_low), toNumber_(item.price_high), unit === '' ? '' : unit * qty,
    srcCell(sources[0]), srcCell(sources[1]), srcCell(sources[2]),
    item.confidence || 'Manual', photoCell, item.notes || '', item.added_by || user,
  ];
  sheet.appendRow(row);
  return { row: sheet.getLastRow(), sheetUrl: getSpreadsheet_().getUrl() };
}

function getRecentItems() {
  const sheet = getInventorySheet_();
  const last = sheet.getLastRow();
  if (last < 2) return { items: [], count: 0, total: 0, sheetUrl: getSpreadsheet_().getUrl() };
  const data = sheet.getRange(2, 1, last - 1, 14).getValues();
  let total = 0;
  data.forEach(function (r) { total += Number(r[13]) || 0; });
  const items = data.slice(-10).reverse().map(function (r) {
    return { name: r[1], category: r[2], qty: r[6], location: r[8], total: Number(r[13]) || 0 };
  });
  return { items: items, count: data.length, total: total, sheetUrl: getSpreadsheet_().getUrl() };
}

function getPhotoFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('PHOTO_FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* recreate below */ }
  }
  const folder = DriveApp.createFolder(CONFIG.PHOTO_FOLDER_NAME);
  props.setProperty('PHOTO_FOLDER_ID', folder.getId());
  return folder;
}

function toNumber_(v) {
  if (v === null || v === undefined || v === '') return '';
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? '' : n;
}
