// The Division 2 – Vendors Status (Variant A: deterministic cron)
// Runs on GitHub Actions (Node 20). No scraping. Edits ONE Discord webhook message.
// First run (no DISCORD_MESSAGE_ID): posts a new message and prints its ID in logs.
// Copy that ID into GitHub Secret DISCORD_MESSAGE_ID, and from then on the script edits the same message.

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL; // required (secret)
const MESSAGE_ID  = process.env.DISCORD_MESSAGE_ID || ""; // optional (secret). If empty, script will create a new message.

if (!WEBHOOK_URL) {
  console.error("Missing DISCORD_WEBHOOK_URL secret");
  process.exit(1);
}

(async () => {
  try {
    const nowMs = Date.now();

    // Compute timestamps (UNIX seconds)
    const resetUnix = nextWeeklyReset(nowMs);        // Tue 03:30 ET
    const cassie    = currentAndNextWindow(nowMs);   // {openStart, closeEnd, nextOpenStart, nextCloseEnd}
    const danny     = cassie;                        // same pattern as Cassie

    const description = buildDescription(resetUnix, cassie, danny);
    const embed = {
      title: "The Division 2 — Vendors Status",
      description,
      color: 0xF97316,
      footer: { text: "Times render in each user's local timezone" },
    };

    if (MESSAGE_ID) {
      await editWebhookMessage(WEBHOOK_URL, MESSAGE_ID, { content: null, embeds: [embed] });
      console.log("Edited message:", MESSAGE_ID);
    } else {
      // FIRST RUN: create a visible message + embed, and log its ID
      const created = await createWebhookMessage(
        WEBHOOK_URL,
        { content: "TD2 Vendors — initializing…", embeds: [embed] },
        true
      );
      if (created?.id) {
        console.log("FIRST RUN: created message id:", created.id);
        console.log("→ Add this ID as GitHub Secret DISCORD_MESSAGE_ID to enable editing instead of new posts.");
      } else {
        console.log("Posted new message (no ID returned).");
      }
    }
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();

function buildDescription(resetUnix, cassie, danny) {
  const lines = [];
  lines.push(
    "**Weekly Vendor Reset**\n" +
      `Next reset: <t:${resetUnix}:F> — <t:${resetUnix}:R>`
  );

  lines.push("\n**Cassie Mendoza**\n" + windowLines(cassie));
  lines.push("\n**Danny Weaver**\n" + windowLines(danny));

  lines.push(
    "\n**Useful links**\n" +
      "• Weekly list (Ruben Alamina): https://rubenalamina.mx/the-division-weekly-vendor-reset/\n" +
      "• Reset timers: https://division.zone/the-division-2/reset-timers/\n"
  );
  return lines.join("\n");
}

function windowLines(w) {
  const now = Math.floor(Date.now() / 1000);
  const openNow = now >= w.openStart && now < w.closeEnd;
  if (openNow) {
    return (
      `**OPEN** — Closes: <t:${w.closeEnd}:F> — <t:${w.closeEnd}:R>\n` +
      `Next open: <t:${w.nextOpenStart}:F> — <t:${w.nextOpenStart}:R>`
    );
  } else {
    return (
      `Opens: <t:${w.nextOpenStart}:F> — <t:${w.nextOpenStart}:R>\n` +
      `Next closes: <t:${w.nextCloseEnd}:F> — <t:${w.nextCloseEnd}:R>`
    );
  }
}

/** Weekly reset at Tuesday 03:30 ET (America/New_York). */
function nextWeeklyReset(nowMs) {
  const tz = "America/New_York";
  const nowEt = toZonedParts(new Date(nowMs), tz);
  const targetDow = 2; // Tuesday (0=Sun..6=Sat)
  const dow = nowEt.weekday;

  let deltaDays = (targetDow - dow + 7) % 7;
  let target = { ...nowEt, hour: 3, minute: 30, second: 0 };

  if (deltaDays !== 0) {
    target = addDaysEt(target, deltaDays);
  } else {
    const nowSec = nowEt.hour * 3600 + nowEt.minute * 60 + nowEt.second;
    const resetSec = 3 * 3600 + 30 * 60;
    if (nowSec >= resetSec) {
      target = addDaysEt(target, 7);
    }
  }
  return zonedDateToUnix(target, tz);
}

/** Cassie/Danny: 24h OPEN / 32h CLOSED (56h cycle). Anchor: Wednesday 03:00 ET (each week). */
function currentAndNextWindow(nowMs) {
  const tz = "America/New_York";
  const nowEt = toZonedParts(new Date(nowMs), tz);

  // Monday 00:00 of current ET week
  const monday = addDaysEt(nowEt, -((nowEt.weekday + 6) % 7));
  // Wednesday 03:00 ET
  const wed = { ...monday };
  const wedPlus2 = addDaysEt(wed, 2);
  wedPlus2.hour = 3; wedPlus2.minute = 0; wedPlus2.second = 0;

  let anchorMs = zonedDateToUnix(wedPlus2, tz) * 1000;
  if (nowMs < anchorMs) {
    anchorMs -= 7 * 24 * 3600 * 1000; // take last week's anchor if we're before Wednesday 03:00
  }

  const cycleMs = 56 * 3600 * 1000;
  const openMs = 24 * 3600 * 1000;
  const k = Math.floor((nowMs - anchorMs) / cycleMs);
  const currentOpenStart = anchorMs + k * cycleMs;
  const currentCloseEnd = currentOpenStart + openMs;
  const nextOpenStart = currentOpenStart + cycleMs;
  const nextCloseEnd = nextOpenStart + openMs;

  return {
    openStart: Math.floor(currentOpenStart / 1000),
    closeEnd: Math.floor(currentCloseEnd / 1000),
    nextOpenStart: Math.floor(nextOpenStart / 1000),
    nextCloseEnd: Math.floor(nextCloseEnd / 1000),
  };
}

/** ---- Lightweight TZ helpers (no external libs) ---- */
function toZonedParts(date, timeZone) {
  const dtf = getDTF(timeZone);
  const parts = dtf.formatToParts(date);
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
    weekday: new Date(Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day))).getUTCDay(), // 0..6
  };
}

function addDaysEt(parts, days) {
  const base = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0);
  const d2 = new Date(base + days * 86400000);
  const tz = "America/New_York";
  return toZonedParts(d2, tz);
}

function zonedDateToUnix(parts, timeZone) {
  const guess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0);
  const offsetMin = tzOffsetMinutes(timeZone, guess);
  const ms = guess - offsetMin * 60000;
  return Math.floor(ms / 1000);
}

function tzOffsetMinutes(timeZone, epochMs) {
  const dtf = getDTF(timeZone);
  const parts = dtf.formatToParts(new Date(epochMs));
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second)
  );
  return (asUtc - epochMs) / 60000;
}

const dtfCache = new Map();
function getDTF(timeZone) {
  if (!dtfCache.has(timeZone)) {
    dtfCache.set(
      timeZone,
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    );
  }
  return dtfCache.get(timeZone);
}

/** ---- Discord Webhook helpers ---- */
async function createWebhookMessage(webhookUrl, body, waitJson = false) {
  const url = new URL(webhookUrl);
  if (waitJson) url.searchParams.set("wait", "true");
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Webhook POST failed: ${res.status}`);
  return waitJson ? res.json() : true;
}

async function editWebhookMessage(webhookUrl, messageId, body) {
  const m = webhookUrl.match(/webhooks\/([^/]+)\/([^/]+)/);
  if (!m) throw new Error("Invalid DISCORD_WEBHOOK_URL format");
  const [, wid, token] = m;
  const editUrl = `https://discord.com/api/webhooks/${wid}/${token}/messages/${messageId}`;
  const res = await fetch(editUrl, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Webhook PATCH failed: ${res.status}`);
  return true;
}
