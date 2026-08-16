// ลอง agent จริง — ตั้งค่าโมเดล Gemini แล้วสั่งงาน แล้วดูว่าที่เราอ่านโค้ดมาตรงไหม
//
// ต้องมี `pnpm run-local` รันอยู่ และไฟล์ key ที่ส่งผ่าน GEMINI_KEY_FILE
// รัน: GEMINI_KEY_FILE=/path/to/key node packages/integration-tests/try-agent.mjs "คำสั่ง"

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { RpcStub, RpcTarget, newWebSocketRpcSession } from "capnweb";
import * as Y from "../../node_modules/.pnpm/yjs@13.6.31/node_modules/yjs/dist/yjs.mjs";

const KEY_FILE = process.env.GEMINI_KEY_FILE;
if (!KEY_FILE) { console.error("ต้องตั้ง GEMINI_KEY_FILE"); process.exit(1); }
const API_KEY = readFileSync(KEY_FILE, "utf8").trim();

const PROMPT = process.argv[2] ?? "Make a tic tac toe game.";
const MODEL_ID = "gemini-3.6-flash";

const api = newWebSocketRpcSession("ws://localhost:8787/api");
const u = "agent" + Date.now().toString(36);
const h = new Uint8Array(createHash("sha256").update("integration-test:" + u).digest());
const auth = await api.authenticate(await api.createAccount(u, "Agent Trial", h));
const hr = t => console.log(`\n${"═".repeat(72)}\n  ${t}\n${"═".repeat(72)}`);

// ── ตั้งค่าโมเดล ─────────────────────────────────────────────────────────
hr("1) ตั้งค่าโมเดล");
console.log("ก่อนตั้ง listModels():", JSON.stringify(await auth.listModels()));
await auth.addModel(
  { type: "agent", id: MODEL_ID, name: "Gemini" },
  { provider: "google", model: MODEL_ID, apiToken: API_KEY });
await auth.setPreferredModel(MODEL_ID);
console.log("หลังตั้ง listModels():", JSON.stringify(await auth.listModels()));

// ── เปิด workspace แล้วเฝ้าดูแชท ─────────────────────────────────────────
hr("2) สั่งงาน agent");
console.log(`คำสั่ง: ${JSON.stringify(PROMPT)}\n`);

const overseer = await auth.newGadget();
const { id: workspaceId } = await overseer.getMetadata();

const seen = new Set();
let done = false;
let lastActivity = Date.now();

class ChatSub extends RpcTarget {
  streamGeneration() {}
  metadata() {}
  deleted() {}
  draftUpdate() {}
  draftCleared() {}
  stream() {}                       // ข้าม token ที่ไหลมาทีละชิ้น เอาเฉพาะข้อความที่ลงหลักแล้ว
  message(msg) {
    lastActivity = Date.now();
    const key = `${msg.chatId}:${msg.sequence}`;
    if (seen.has(key)) return;
    seen.add(key);
    render(msg);
  }
}

function render(msg) {
  const who = msg.author?.name ?? msg.type;
  if (msg.type === "message") {
    // body เป็น union — ข้อความอยู่ที่ .message ไม่ใช่ .text
    const text = (msg.body?.message ?? "").trim();
    if (text) console.log(`\n[${who}] ${text.slice(0, 600)}`);
    // tool call ใช้ field ชื่อ toolName + input (ไม่ใช่ name/arguments)
    for (const call of msg.toolCalls ?? []) {
      const inp = call.input ?? {};
      let brief = inp.filename ?? inp.title ?? inp.name ?? inp.gadget ?? "";
      if (call.toolName === "executeCode") brief = `${(inp.code ?? "").length} ตัวอักษร`;
      console.log(`  🔧 ${call.toolName}${brief ? "  " + JSON.stringify(brief) : ""}` +
                  (call.error ? `  ⚠ ${call.error.slice(0, 120)}` : ""));
    }
    if (msg.stopReason && msg.stopReason !== "toolUse") {
      console.log(`  ⏹ stopReason=${msg.stopReason}`);
      if (msg.stopReason !== "error") done = true;
    }
  } else if (msg.type === "changes") {
    console.log(`  📝 changes: ${JSON.stringify(msg).slice(0, 200)}`);
  } else if (msg.type === "connectionRequest") {
    console.log(`  🔌 ขอเชื่อมต่อ: ${msg.resourceUrl ?? ""} (state=${msg.state})`);
  } else if (msg.type === "error") {
    console.log(`  ❌ error: ${JSON.stringify(msg, null, 1).slice(0, 1200)}`);
    done = true;
  } else {
    console.log(`  · ${msg.type}`);
  }
}

await overseer.subscribeToChat(new RpcStub(new ChatSub()));
await overseer.newChat(PROMPT, MODEL_ID);

// รอจนกว่าจะจบ หรือเงียบไป 90 วินาที
const DEADLINE = Date.now() + 8 * 60_000;
while (!done && Date.now() < DEADLINE && Date.now() - lastActivity < 90_000) {
  await new Promise(r => setTimeout(r, 1000));
}

hr("3) ผลลัพธ์");
const chats = await overseer.listChats();
console.log("chats:", JSON.stringify(chats.map(c => ({ id: c.id, title: c.title })), null, 1));
console.log("totalCost:", (await overseer.getMetadata()).totalCost);

// ── 4) ตรวจของที่ agent เขียน ─────────────────────────────────────────────
hr("4) โค้ดที่ agent เขียน");
const workpieces = [];
{
  let settle; const ready = new Promise(r => { settle = r; });
  class WpSub extends RpcTarget {
    entry(w) { workpieces.push(w); }
    removed() {}
    ready() { settle(); }
  }
  await overseer.subscribeToWorkpieces(new RpcStub(new WpSub()));
  await ready;
}
const doc = new Y.Doc();
{
  let settle; const ready = new Promise(r => { settle = r; });
  class CodeSub extends RpcTarget {
    update(up) { Y.applyUpdateV2(doc, up.update); }
    ready() { settle(); }
  }
  await overseer.subscribeToCode(new RpcStub(new CodeSub()));
  await ready;
}
let serverSrc = "";
for (const wp of workpieces) {
  if (wp.filesRoot === undefined) continue;
  console.log(`workpiece "${wp.title}" (id=${wp.id})`);
  for (const [name, text] of doc.getMap(wp.filesRoot).entries()) {
    const body = text.toString();
    console.log(`   ${String(body.length).padStart(6)} ตัวอักษร  ${name}`);
    if (name === "server.js") serverSrc = body;
  }
}

// ── 5) เรียก API ของแอปที่ agent เพิ่งเขียน ──────────────────────────────
hr("5) เรียก API ของแอปที่ agent เพิ่งเขียน");
const methods = [...new Set([...serverSrc.matchAll(/^\s{2}(?:async\s+)?([a-zA-Z][\w]*)\s*\(/gm)]
  .map(m => m[1]))].filter(n => n !== "constructor");
console.log("เมธอดใน server.js:", methods.join(", ") || "(ไม่พบ)");

const gadgetWp = workpieces.find(w => w.filesRoot !== undefined);
if (gadgetWp) {
  try {
    const gadget = await overseer.getGadget(gadgetWp.id);
    const app = await gadget.connectToGadget();
    for (const m of ["getState", "getBoard", "getGame", "state", "reset", "newGame"]) {
      if (!methods.includes(m)) continue;
      try {
        const out = await app[m]();
        console.log(`  ${m}() →`, JSON.stringify(out).slice(0, 400));
        break;
      } catch (e) { console.log(`  ${m}() ✗ ${String(e).slice(0, 120)}`); }
    }
  } catch (e) { console.log("  connectToGadget ✗", String(e).slice(0, 200)); }
}

const link = await overseer.createShareLink("build", "ดูผลงาน agent");
console.log(`\n🔗 http://localhost:8787/workspace/${workspaceId}#share=${link.key}`);
console.log(done ? "\n✅ agent จบงานแล้ว" : "\n⏱ หมดเวลารอ (ดูลิงก์ข้างบนได้)");
process.exit(0);
