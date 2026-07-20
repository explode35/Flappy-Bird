# Production setup — deploy this when a client signs

You do **not** need any of this to start selling. The demo (`../demo/missed-call-demo.html`)
is what you pitch with. Deploy this the day you collect your first setup fee — total cost
is about **$2–5/month per client** until they generate real volume, all covered by the
client's $297/mo.

## Stack

| Piece | Service | Cost |
|---|---|---|
| Phone number + SMS | Twilio | ~$1.15/mo per number + ~$0.008/SMS |
| AI replies | Claude API (Haiku) | ~$0.01 per full conversation |
| Hosting | Render / Railway / Fly.io free tier | $0 |

## One-time (your agency)

1. Create a [Twilio account](https://www.twilio.com) and an [Anthropic API key](https://console.anthropic.com).
2. Register for A2P 10DLC in the Twilio console (US business texting compliance).
   Takes a few days — start this **before** your first client signs.
3. Deploy this folder to Render/Railway with env vars:
   `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `NODE_ENV=production`.

```bash
npm install
npm start          # local test: npx ngrok http 3000 to expose webhooks
```

## Per client (~30 minutes)

1. Buy a Twilio number local to the client's area code.
2. Copy `clients/apex-hvac.json` → `clients/<client-id>.json` and fill in their real
   services, prices, hours, zips, and tone. **Read every line to the owner and get a
   yes** — this file is the AI's entire universe of allowed facts.
3. In the Twilio console for that number:
   - **A call comes in** → forward to the client's real business line
     (TwiML `<Dial>` with a 20-second timeout, `action="/missed-call"`)
   - **A message comes in** → webhook `POST https://your-app.example.com/sms`
4. Redeploy (configs load at boot). Test: call the number, don't pick up, watch the text arrive.
5. Put the owner's cell in `ownerAlertNumber` so every booked job pings them —
   that ping is what makes them renew.

### Call-forwarding TwiML (paste as a TwiML Bin on the number)

```xml
<Response>
  <Dial timeout="20" action="https://your-app.example.com/missed-call" method="POST">
    CLIENT_REAL_BUSINESS_LINE
  </Dial>
</Response>
```

With this setup the client's phone rings exactly as before; CallCatch only acts when
nobody answers within 20 seconds.

## Weekly report (your retention engine)

Every Friday, grep the logs for `BOOKED` per client and text the owner:
"This week CallCatch caught 4 missed calls and booked 2 jobs (~$5,300). Have a good weekend."
Automate later; for the first ten clients, doing this by hand keeps you close to the numbers
that justify your invoice.

## Compliance notes

- Texting a caller back about their own inquiry is standard practice, but A2P 10DLC
  registration (step 2) is mandatory for US business SMS — don't skip it.
- The AI never claims to be human (enforced in the system prompt).
- Honor "STOP" replies — Twilio handles opt-outs automatically on standard numbers.
