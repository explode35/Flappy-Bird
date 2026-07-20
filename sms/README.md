# SMS check-in engine

Automates the weekly check-in sequence over SMS (Twilio) and shares one data
store with the web app. Node built-ins only — no npm install.

## The sequence

For every **active** client that has a **phone number**, on their configured
**check-in day**:

1. **Request** — at `sendHour` (default 8:00 server time) the client gets the
   check-in questions (weight, sessions, sleep + stress, nutrition,
   win/struggle).
2. **Reminder** — if they haven't replied after `reminderAfterHours`
   (default 6), they get one nudge. Never more than one.
3. **Reply** — their answer is parsed (numbered answers, labeled values, or a
   bare run of numbers all work) into a structured check-in record that shows
   up in the app immediately, tagged `SMS`.
4. **Confirmation** — they get an auto-reply summarising what was logged.

Missed sequences (no reply after 24 h) are flagged on the app dashboard.

## Running it

```
node sms/server.js
```

Then open http://localhost:3000 — when the app is served this way, its data
lives in `sms/data/state.json` (not just browser localStorage) so the SMS
engine and the UI stay in sync, and the sidebar shows the engine status.

**Dry-run mode:** with no Twilio credentials configured, messages are printed
to the console and recorded in the dashboard's SMS activity log instead of
being sent. Everything else behaves identically, so you can trial the whole
sequence before buying a number.

## Going live with Twilio

1. Copy `sms/config.example.json` to `sms/config.json` and fill in
   `accountSid`, `authToken`, and `fromNumber` (or set the
   `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` env
   vars). `sms/config.json` and `sms/data/` are gitignored — never commit
   credentials.
2. Expose the server publicly (reverse proxy, tunnel, or a small VPS) and set
   your Twilio number's inbound-SMS webhook to
   `POST https://your-host/webhooks/sms`.
3. Set `publicUrl` in the config to that public origin — this turns on
   Twilio signature validation for the webhook.

## Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /` | Serves the coach web app |
| `GET /p/<token>` | Client-facing workout portal (token-scoped) |
| `GET /api/portal?t=<token>` | Scoped view: one client's name + assigned program |
| `POST /api/portal/checkin?t=<token>` | Client submits a check-in from the portal |
| `GET/PUT /api/state` | Coach data store (the app syncs through this) |
| `GET /api/sms/status` | Engine status (dry-run, send hour, server time) |
| `POST /api/sms/run-now` | Force a scheduler tick (useful for testing) |
| `POST /webhooks/sms` | Twilio inbound-SMS webhook (also handles STOP/START) |

## Consent & opt-out (TCPA)

The engine only sends to a client whose `smsConsent` flag is set — record it
with the "Client consented to SMS" checkbox on the client's page (capture
consent at intake and keep proof). Inbound `STOP` / `UNSUBSCRIBE` clears
consent and halts any open sequence; `START` re-subscribes. Carriers also
enforce these keywords at the network level; the app mirrors them so it stops
scheduling and flagging opted-out clients. For US A2P traffic you still need
10DLC registration of your Twilio number.

## Client portal

Each client has a private `portalToken` and a link at `/p/<token>`. The portal
API is strictly scoped to that one client — it never returns other clients,
phone numbers, emails, logs, or the coach's full store. Portal check-ins are
saved with `source: "portal"`, shown on the coach dashboard tagged `Portal`,
and close that week's open SMS sequence so the client isn't also nagged by
text. Send a client their link with the "Copy portal message" button on their
page. Set `publicUrl` so the links coaches copy use your real domain.

## Config reference

| Key / env var | Default | Meaning |
|---------------|---------|---------|
| `port` / `PORT` | 3000 | HTTP port |
| `accountSid` / `TWILIO_ACCOUNT_SID` | — | Twilio account SID |
| `authToken` / `TWILIO_AUTH_TOKEN` | — | Twilio auth token |
| `fromNumber` / `TWILIO_FROM_NUMBER` | — | Sending number (E.164) |
| `sendHour` / `FITOPS_SEND_HOUR` | 8 | Local hour to send weekly requests |
| `reminderAfterHours` / `FITOPS_REMINDER_HOURS` | 6 | Hours before the one reminder |
| `coachName` / `FITOPS_COACH_NAME` | Your Coaching | Name used in messages |
| `publicUrl` / `FITOPS_PUBLIC_URL` | — | Public origin; enables webhook signature checks and real portal links |
| `dataFile` / `FITOPS_DATA_FILE` | `sms/data/state.json` | Where shared state is stored |

## Tests

```
node sms/test.js
```
