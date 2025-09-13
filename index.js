// The Division 2 — Vendors Status (Deterministic cron, GH Actions)
// Adds ALL vendors + fixed DD:HH:MM countdowns (updated each run).

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const MESSAGE_ID  = process.env.DISCORD_MESSAGE_ID || "";
if (!WEBHOOK_URL) { console.error("Missing DISCORD_WEBHOOK_URL"); process.exit(1); }

/* ---- TZ helpers (define cache FIRST) ---- */
const dtfCache = new Map();
function getDTF(timeZone){
  if(!dtfCache.has(timeZone)){
    dtfCache.set(timeZone,new Intl.DateTimeFormat("en-US",{timeZone,hour12:false,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"}));
  }
  return dtfCache.get(timeZone);
}
function toZonedParts(date,tz){const p=getDTF(tz).formatToParts(date);const m=Object.fromEntries(p.map(x=>[x.type,x.value]));return{year:+m.year,month:+m.month,day:+m.day,hour:+m.hour,minute:+m.minute,second:+m.second,weekday:new Date(Date.UTC(+m.year,+m.month-1,+m.day)).getUTCDay()};}
function addDays(parts,days,tz){const base=Date.UTC(parts.year,parts.month-1,parts.day,parts.hour??0,parts.minute??0,parts.second??0);return toZonedParts(new Date(base+days*86400000),tz);}
function tzOffsetMinutes(tz,epochMs){const m=Object.fromEntries(getDTF(tz).formatToParts(new Date(epochMs)).map(p=>[p.type,p.value]));const asUtc=Date.UTC(+m.year,+m.month-1,+m.day,+m.hour,+m.minute,+m.second);return (asUtc-epochMs)/60000;}
function zonedDateToUnix(parts,tz){const guess=Date.UTC(parts.year,parts.month-1,parts.day,parts.hour??0,parts.minute??0,parts.second??0);const ms=guess - tzOffsetMinutes(tz,guess)*60000;return Math.floor(ms/1000);}

/* ---- Business time rules ---- */
// Weekly reset — pokazujmy jako „Warsaw 09:30”, Discord i tak zrenderuje lokalnie.
function nextWeeklyReset(nowMs){
  const tz="Europe/Warsaw";
  const now=toZonedParts(new Date(nowMs),tz);
  const targetDow=2; // Tue
  const dow=now.weekday;
  let delta=(targetDow-dow+7)%7;
  let target={...now,hour:9,minute:30,second:0};
  if(delta!==0) target=addDays(target,delta,tz);
  else{
    const nowSec=now.hour*3600+now.minute*60+now.second;
    const resetSec=9*3600+30*60;
    if(nowSec>=resetSec) target=addDays(target,7,tz);
  }
  return zonedDateToUnix(target,tz);
}

// Cassie/Danny cycle: 24h OPEN / 32h CLOSED, anchor: Wed 03:00 ET weekly
function currentAndNextWindow(nowMs){
  const tz="America/New_York";
  const nowEt=toZonedParts(new Date(nowMs),tz);
  const monday=addDays(nowEt,-((nowEt.weekday+6)%7),tz);
  const wed=addDays(monday,2,tz); wed.hour=3; wed.minute=0; wed.second=0;
  let anchorMs=zonedDateToUnix(wed,tz)*1000;
  if(nowMs<anchorMs) anchorMs-=7*24*3600*1000;
  const CYCLE=56*3600*1000, OPEN=24*3600*1000;
  const k=Math.floor((nowMs-anchorMs)/CYCLE);
  const openStart=anchorMs+k*CYCLE;
  const closeEnd=openStart+OPEN;
  const nextOpen=openStart+CYCLE;
  const nextClose=nextOpen+OPEN;
  return {
    openStart:Math.floor(openStart/1000),
    closeEnd:Math.floor(closeEnd/1000),
    nextOpenStart:Math.floor(nextOpen/1000),
    nextCloseEnd:Math.floor(nextClose/1000),
  };
}

/* ---- Formatting ---- */
function fmtDDHHMM(seconds){
  if(seconds<0) seconds=0;
  const d=Math.floor(seconds/86400);
  const h=Math.floor((seconds%86400)/3600);
  const m=Math.floor((seconds%3600)/60);
  const dd=String(d).padStart(2,"0");
  const hh=String(h).padStart(2,"0");
  const mm=String(m).padStart(2,"0");
  return `${dd}:${hh}:${mm`;
}
function secondsUntil(unix){ return unix - Math.floor(Date.now()/1000); }

function buildDescription(resetUnix, cassie, danny){
  const nowSec=Math.floor(Date.now()/1000);
  const toReset=secondsUntil(resetUnix);
  const vendorsDC=[
    "White House","Theater Settlement","Campus Settlement","Clan Vendor",
    "Dark Zone East","Dark Zone South","Dark Zone West"
  ];
  const vendorsNY=[ "Haven (NYC)" ];
  const specials=[ "Pentagon" ]; // reset-based; placeholder if potrzebujesz

  const lines=[];
  // Header
  lines.push("**Weekly Vendor Reset**");
  lines.push(`Next reset: <t:${resetUnix}:F> — <t:${resetUnix}:R>  \nCountdown (DD:HH:MM): \`${fmtDDHHMM(toReset)}\``);

  // DC group (all tied to weekly reset)
  lines.push("\n**Washington D.C. Vendors**");
  lines.push(vendorsDC.map(v=>`• ${v} — refresh in \`${fmtDDHHMM(toReset)}\``).join("\n"));

  // NYC group
  lines.push("\n**New York Vendors**");
  lines.push(vendorsNY.map(v=>`• ${v} — refresh in \`${fmtDDHHMM(toReset)}\``).join("\n"));

  // Cassie
  const cassieOpenNow = nowSec>=cassie.openStart && nowSec<cassie.closeEnd;
  lines.push("\n**Cassie Mendoza**");
  if(cassieOpenNow){
    lines.push(
      `**OPEN** — Closes: <t:${cassie.closeEnd}:F> — <t:${cassie.closeEnd}:R>  \n`+
      `Countdown (DD:HH:MM): \`${fmtDDHHMM(secondsUntil(cassie.closeEnd))}\`  \n`+
      `Next open: <t:${cassie.nextOpenStart}:F> — <t:${cassie.nextOpenStart}:R>`
    );
  }else{
    lines.push(
      `Opens: <t:${cassie.nextOpenStart}:F> — <t:${cassie.nextOpenStart}:R>  \n`+
      `Countdown (DD:HH:MM): \`${fmtDDHHMM(secondsUntil(cassie.nextOpenStart))}\`  \n`+
      `Next closes: <t:${cassie.nextCloseEnd}:F> — <t:${cassie.nextCloseEnd}:R>`
    );
  }

  // Danny
  const dannyOpenNow = nowSec>=danny.openStart && nowSec<danny.closeEnd;
  lines.push("\n**Danny Weaver**");
  if(dannyOpenNow){
    lines.push(
      `**OPEN** — Closes: <t:${danny.closeEnd}:F> — <t:${danny.closeEnd}:R>  \n`+
      `Countdown (DD:HH:MM): \`${fmtDDHHMM(secondsUntil(danny.closeEnd))}\`  \n`+
      `Next open: <t:${danny.nextOpenStart}:F> — <t:${danny.nextOpenStart}:R>`
    );
  }else{
    lines.push(
      `Opens: <t:${danny.nextOpenStart}:F> — <t:${danny.nextOpenStart}:R>  \n`+
      `Countdown (DD:HH:MM): \`${fmtDDHHMM(secondsUntil(danny.nextOpenStart))}\`  \n`+
      `Next closes: <t:${danny.nextCloseEnd}:F> — <t:${danny.nextCloseEnd}:R>`
    );
  }

  // Specials (reset-based)
  lines.push("\n**Specials**");
  lines.push(specials.map(v=>`• ${v} — refresh in \`${fmtDDHHMM(toReset)}\``).join("\n"));

  // Links
  lines.push(
    "\n**Useful links**\n"+
    "• Weekly list (Ruben Alamina): https://rubenalamina.mx/the-division-weekly-vendor-reset/\n"+
    "• Reset timers: https://division.zone/the-division-2/reset-timers/\n"
  );
  return lines.join("\n");
}

/* ---- Discord I/O ---- */
(async ()=>{
  try{
    const nowMs=Date.now();
    const resetUnix=nextWeeklyReset(nowMs);
    const cassie=currentAndNextWindow(nowMs);
    const danny=currentAndNextWindow(nowMs);

    const embed={
      title:"The Division 2 — Vendors Status",
      description: buildDescription(resetUnix,cassie,danny),
      color:0xF97316,
      footer:{ text:"Times render in each user's local timezone" }
    };

    if(MESSAGE_ID){
      await editWebhookMessage(WEBHOOK_URL,MESSAGE_ID,{content:null,embeds:[embed]});
      console.log("Edited message:", MESSAGE_ID);
    }else{
      const created=await createWebhookMessage(WEBHOOK_URL,{content:"TD2 Vendors — initializing…",embeds:[embed]},true);
      if(created?.id){ console.log("FIRST RUN: created message id:",created.id); }
    }
  }catch(err){
    console.error("FATAL:", err?.stack||err); process.exit(1);
  }
})();

async function createWebhookMessage(url, body, waitJson=false){
  const u=new URL(url); if(waitJson) u.searchParams.set("wait","true");
  const res=await fetch(u.toString(),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  const txt=await res.text().catch(()=> "");
  if(!res.ok) throw new Error(`Webhook POST failed: ${res.status} ${txt}`);
  return waitJson? JSON.parse(txt||"{}"): true;
}
async function editWebhookMessage(url, messageId, body){
  const m=url.match(/webhooks\/([^/]+)\/([^/]+)/); if(!m) throw new Error("Invalid DISCORD_WEBHOOK_URL");
  const [,wid,token]=m;
  const edit=`https://discord.com/api/webhooks/${wid}/${token}/messages/${messageId}`;
  const res=await fetch(edit,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  const txt=await res.text().catch(()=> "");
  if(!res.ok) throw new Error(`Webhook PATCH failed: ${res.status} ${txt}`);
  return true;
}
