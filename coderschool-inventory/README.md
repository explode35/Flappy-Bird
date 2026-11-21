# CoderSchool Inventory Scanner

A phone-friendly web app for taking inventory. You photograph an item (a computer, desk, chair, cabinet, supplies), AI works out what it is and **searches the web for its current price**, you check the details, and it saves a row to a **Google Sheet**.

It runs on **Google Apps Script** attached to your Sheet, so there's no app store, no server and no hosting. Open the link on any phone and add it to your home screen so it works like an app.

## What it does

1. **📷 Scan:** take a photo with your phone camera. You can add a hint such as "Dell laptop".
2. **🔎 Identify & price:** Claude (Anthropic's AI) reads labels and logos, finds the brand and model, and checks retailers (Amazon, Best Buy, Staples, IKEA and others) for the current price. You get a best estimate, a price range and up to 3 source links.
3. **✏️ Review:** fix anything that's wrong, then add quantity, condition, room or location, an asset tag and notes.
4. **✅ Save:** the item is added as a row in the `Inventory` tab. The photo is saved to a Google Drive folder and linked from the row.
5. **📊 Running total:** the app shows the item count, total value and your most recent items.

### Columns in the Sheet

Date Added · Item Name · Category · Brand · Model / SKU · Description · Quantity · Condition · Location / Room · Asset Tag · Est. Unit Price · Price Low · Price High · Total Value · Price Source 1–3 (links) · AI Confidence · Photo (link) · Notes · Added By

The categories include Computers & Laptops, Monitors, Networking, Robotics & STEM Kits, Desks & Tables, Chairs & Seating, Cabinets & Storage, Office Supplies, Classroom Supplies and more. To change them, edit `CATEGORIES` in `Code.gs`.

---

## One-time setup (about 10 minutes)

### 1. Get an Anthropic API key
- Go to <https://console.anthropic.com>, sign in, add a payment method, then go to **API Keys → Create Key**.
- Copy the key. It starts with `sk-ant-`.
- Each scan costs a few cents: one AI call plus a few web searches.

### 2. Create the Google Sheet and add the code
1. Create a new Google Sheet, for example **"CoderSchool Inventory"**.
2. Go to **Extensions → Apps Script**.
3. Replace everything in `Code.gs` with the contents of [`Code.gs`](Code.gs).
4. Click **+ → HTML** and name the file `Index` (exactly that). Paste in the contents of [`Index.html`](Index.html).
5. *(Optional)* Click the ⚙️ **Project Settings** gear, tick **"Show appsscript.json manifest file in editor"**, and paste in [`appsscript.json`](appsscript.json). Change the time zone if you need to.
6. Click 💾 **Save**.

### 3. Run setup
1. Go back to the Sheet and reload the page. A new **Inventory Scanner** menu appears.
2. Click **Inventory Scanner → Set up / set API key**.
3. Google asks you to authorize the script. Click **Continue**, pick your account, then **Advanced → Go to (project) → Allow**. This happens because it's your own unpublished script.
4. Paste your API key when asked. This creates the `Inventory` tab with formatted headers.

### 4. Deploy the web app
1. In the Apps Script editor, click **Deploy → New deployment**.
2. Click ⚙️ next to "Select type" and choose **Web app**.
3. Settings:
   - **Execute as:** *Me*. Every row then goes into your Sheet and your Drive.
   - **Who has access:** *Anyone with a Google account*. If your school uses Google Workspace, choose *Anyone within [your school]* so only staff can use it.
4. Click **Deploy** and copy the **Web app URL**. You can also find it later under **Inventory Scanner → Show web app link**.

### 5. Put it on your phone
- Open the URL on your phone.
- **iPhone (Safari):** Share → **Add to Home Screen**.
- **Android (Chrome):** ⋮ menu → **Add to Home screen**.

Send the same link to any staff or volunteers who are helping with the count.

---

## Tips for good results
- **Fill the frame** with the item, and use good lighting.
- For electronics, **photograph the label or sticker** (model number or service tag). That gives the most accurate price.
- For furniture, a hint like "IKEA" or "60-inch table" helps.
- Prices are **new retail estimates**. For depreciated or insurance values, adjust the price or the Condition column.
- For several of the same item (say 20 chairs), scan one and set **Quantity**.
- Check anything marked **Confidence: Low**.

## Updating the code later
After editing the code, go to **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**. The URL stays the same.

## Troubleshooting
| Problem | Fix |
|---|---|
| "No API key set" | Run **Inventory Scanner → Set up** again from the Sheet. |
| "Invalid Anthropic API key" | Create a new key in the Anthropic console and run Set up again. |
| "AI service is busy" | Wait a few seconds and try again. |
| Scan takes too long or times out | Try again, or add a hint. Lower `MAX_WEB_SEARCHES` in `Code.gs` to make scans faster. |
| Camera doesn't open | Make sure the browser has camera/photo permission. You can also pick an existing photo. |
| Need to fix a row | Edit the Sheet directly. It's a normal Google Sheet. |

## How it works (technical)
- `Code.gs`: server code. It serves the page (`doGet`), calls the Claude API (`claude-opus-5-5`) with the photo and the `web_search` tool (`analyzeImage`), and adds rows and Drive photos (`saveItem`). It turns on server-side fallback so a declined request is retried automatically.
- `Index.html`: the mobile page. It shrinks photos to 1280px before upload and remembers the rooms you've used on each phone.
- The API key is kept in Apps Script **Script Properties**. It never appears in the Sheet or on users' phones.
