# CallCatch AI — your done-for-you AI agency in a box

A complete launch kit for selling **missed-call text-back** to home-service businesses
(HVAC, plumbing, roofing, electrical). One niche, one offer, one clear number: their
missed calls, turned into booked jobs.

**Business model:** $997 setup + $297/mo per client, month to month.
**Your cost per client:** ~$2–5/mo (Twilio + Claude API on free-tier hosting).
**10 clients ≈ $3,000/mo recurring** on a few hours of maintenance a week.

## What's in the kit

| Path | What it is | When you use it |
|---|---|---|
| `demo/missed-call-demo.html` | Interactive phone demo — a missed call becomes a booked $4,800 job | Every pitch. Open it on the prospect's phone. |
| `landing-page/index.html` | Your agency site with live ROI calculator | Link in every DM/SMS; host free on Netlify/GitHub Pages |
| `sales/pitch-script.md` | Walk-in + phone scripts, the 4 objections, the shadow-mode close | Read it out loud until it's yours |
| `sales/pricing-onepager.md` | One-page pricing + guarantee | Send after every demo |
| `sales/outreach-templates.md` | SMS / DM / email templates + referral ask | Prospecting |
| `production/` | Real Twilio + Claude system + per-client config + deploy guide | The day your first client signs |

## Launch plan — first 14 days

**Days 1–2 — set up shop ($0):**
Rename the brand if you like (it's find-and-replace across these files). Put your real
phone/email into the landing page and one-pager. Host the landing page and demo free on
Netlify or GitHub Pages. Practice the demo until you can drive it while talking.

**Days 3–5 — build a list of 50:**
Google Maps + "[trade] [your city]". For each: business name, owner name if findable,
phone, and — the key step — **call them once during lunch hours and note whether a human
answered.** The ones that went to voicemail are your hot list; "I got your voicemail
Tuesday at 2pm" is your opener.

**Days 6–10 — pitch 5/day:**
Walk-ins first (1–3 PM), SMS for the rest, scripts in `sales/`. Goal is 10 demos.
Expected close from 10 demos with this offer: 1–3. Use the shadow-mode close on every
fence-sitter.

**Days 11–14 — deliver client #1:**
Collect the $997 setup fee **first**, then follow `production/SETUP.md` (~1 hour of real
work + Twilio's A2P registration wait — start that registration on day 1). Send their
first weekly report Friday. Ask for the referral on day 7.

**Then repeat.** Same niche, same offer, same city until saturated. Every client's weekly
report is a case study: "caught 4 calls, booked 2 jobs, $5,300" — screenshot it (with
permission) and it becomes your best outreach asset.

## Rules that keep the business healthy

1. **Sell the outcome, never the technology.** "Missed calls become booked jobs" — the
   word "AI" appears only when they ask how it works.
2. **The weekly report is the product.** Clients renew because a number lands in their
   texts every Friday proving you beat your invoice.
3. **Never let the AI say anything the owner hasn't approved.** The client config file is
   its entire universe of facts. This protects them, you, and the renewal.
4. **Honest by design:** the assistant never claims to be human, quotes only approved
   prices, and escalates anything off-script to the owner's cell.
