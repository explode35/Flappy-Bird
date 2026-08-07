/**
 * Triangle Automation — missed-call text-back engine.
 *
 * Flow:
 *   1. Client's Twilio number forwards unanswered calls here (status callback).
 *   2. We fire an opening SMS to the caller within seconds.
 *   3. Incoming SMS replies hit /sms; Claude drives the conversation using the
 *      client's config (services, pricing, hours, tone, guardrails).
 *   4. When Claude marks a booking or an owner-alert, we text the owner.
 *
 * Conversation state is in-memory keyed by caller number. Fine for a handful
 * of clients; move to Redis/SQLite when you pass ~10 clients.
 */

import express from "express";
import twilio from "twilio";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, ANTHROPIC_API_KEY, PORT = 3000 } = process.env;
for (const v of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "ANTHROPIC_API_KEY"]) {
  if (!process.env[v]) { console.error(`Missing env var ${v}`); process.exit(1); }
}

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Load every client config; route inbound traffic by the Twilio number it hit.
const clients = new Map();
const clientsDir = path.join(import.meta.dirname, "clients");
for (const f of readdirSync(clientsDir).filter((f) => f.endsWith(".json"))) {
  const cfg = JSON.parse(readFileSync(path.join(clientsDir, f), "utf8"));
  clients.set(cfg.twilioNumber, cfg);
}
console.log(`Loaded ${clients.size} client config(s)`);

// caller number -> { client, messages: [{role, content}], updatedAt }
const sessions = new Map();
const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // fresh conversation after 6h of silence

function getSession(caller, client) {
  const s = sessions.get(caller);
  if (s && s.client.id === client.id && Date.now() - s.updatedAt < SESSION_TTL_MS) return s;
  const fresh = { client, messages: [], updatedAt: Date.now() };
  sessions.set(caller, fresh);
  return fresh;
}

function systemPrompt(c) {
  return `You are the SMS assistant for ${c.businessName}, a ${c.trade} company. A customer called and nobody could pick up; you are texting them back on the company's behalf.

Your one goal: help them and get them booked on the schedule. Be genuinely useful, never pushy.

BUSINESS FACTS (the only facts you may state):
- Hours: ${c.hours}
- Service area: ${c.serviceArea}
- Services & pricing: ${c.services.join("; ")}
- Scheduling policy: ${c.bookingSlots}

TONE: ${c.tone}

HARD RULES:
${c.neverDo.map((r) => `- ${r}`).join("\n")}
- Keep every message under 300 characters — this is SMS.
- If asked something not covered by the business facts, say you'll have the office confirm, and take a message.
- Never claim to be human. If asked, you're ${c.businessName}'s automated assistant.

When the customer agrees to a specific time window, confirm it and append this tag on its own line: [BOOKED: <service> | <time window> | <address or "address pending">]
If the customer is angry, has an emergency you can't schedule, or needs a human, append: [ALERT: <one-line summary>]
Customers never see text inside brackets.`;
}

async function aiReply(session, userText) {
  session.messages.push({ role: "user", content: userText });
  const resp = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001", // pennies per conversation; bump to claude-sonnet-5 for tricky clients
    max_tokens: 300,
    system: systemPrompt(session.client),
    messages: session.messages,
  });
  const full = resp.content[0].text;
  session.messages.push({ role: "assistant", content: full });
  session.updatedAt = Date.now();

  const booked = full.match(/\[BOOKED:([^\]]+)\]/);
  const alert = full.match(/\[ALERT:([^\]]+)\]/);
  const visible = full.replace(/\[(BOOKED|ALERT):[^\]]*\]/g, "").trim();
  return { visible, booked: booked?.[1]?.trim(), alert: alert?.[1]?.trim() };
}

async function sms(from, to, body) {
  await twilioClient.messages.create({ from, to, body });
}

async function notifyOwner(client, text) {
  if (client.ownerAlertNumber) await sms(client.twilioNumber, client.ownerAlertNumber, text);
}

const app = express();
app.use(express.urlencoded({ extended: false }));
// Reject requests that aren't really from Twilio.
const verify = twilio.webhook({ validate: process.env.NODE_ENV === "production" });

// Point the Twilio number's "call status changes" callback here.
app.post("/missed-call", verify, async (req, res) => {
  res.sendStatus(204);
  const { CallStatus, From: caller, To: line } = req.body;
  if (!["no-answer", "busy", "failed"].includes(CallStatus)) return;
  const client = clients.get(line);
  if (!client || !caller || caller === "Anonymous") return;

  const session = getSession(caller, client);
  const opener = `Hi, this is ${client.businessName} — so sorry we missed your call! We're out on jobs right now, but I can help you right here. What's going on today?`;
  session.messages.push({ role: "assistant", content: opener });
  try {
    await sms(line, caller, opener);
    console.log(`[${client.id}] missed call from ${caller} -> text-back sent`);
  } catch (err) {
    console.error(`[${client.id}] text-back failed for ${caller}:`, err.message);
  }
});

// Point the Twilio number's "a message comes in" webhook here.
app.post("/sms", verify, async (req, res) => {
  res.type("text/xml").send("<Response/>"); // reply out-of-band so slow AI never times out the webhook
  const { From: caller, To: line, Body: body } = req.body;
  const client = clients.get(line);
  if (!client || !body) return;

  const session = getSession(caller, client);
  try {
    const { visible, booked, alert } = await aiReply(session, body);
    if (visible) await sms(line, caller, visible);
    if (booked) {
      console.log(`[${client.id}] BOOKED ${caller}: ${booked}`);
      await notifyOwner(client, `✅ Triangle Automation booked a job: ${booked} — caller ${caller}`);
    }
    if (alert) {
      console.log(`[${client.id}] ALERT ${caller}: ${alert}`);
      await notifyOwner(client, `⚠️ Triangle Automation needs you: ${alert} — caller ${caller}`);
    }
  } catch (err) {
    console.error(`[${client.id}] reply failed for ${caller}:`, err.message);
    await sms(line, caller, `Sorry — having a technical hiccup on our end. Call us back at ${line} and we'll take care of you!`).catch(() => {});
  }
});

app.get("/health", (_req, res) => res.json({ ok: true, clients: clients.size }));

app.listen(PORT, () => console.log(`Triangle Automation listening on :${PORT}`));
