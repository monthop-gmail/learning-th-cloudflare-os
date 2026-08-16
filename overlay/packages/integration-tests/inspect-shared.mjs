// เปิด workspace ผ่าน share link แล้วส่องของข้างใน — ไม่เรียก LLM สักครั้ง
//
// รัน: node packages/integration-tests/inspect-shared.mjs <workspaceId> <shareKey>

import { createHash } from "node:crypto";
import { RpcStub, RpcTarget, newWebSocketRpcSession } from "capnweb";
import * as Y from "../../node_modules/.pnpm/yjs@13.6.31/node_modules/yjs/dist/yjs.mjs";

const [workspaceId, shareKey] = process.argv.slice(2);
if (!workspaceId || !shareKey) {
  console.error("ใช้: node inspect-shared.mjs <workspaceId> <shareKey>");
  process.exit(1);
}

const api = newWebSocketRpcSession("ws://localhost:8787/api");
const u = "peek" + Date.now().toString(36);
const h = new Uint8Array(createHash("sha256").update("integration-test:" + u).digest());
const auth = await api.authenticate(await api.createAccount(u, "Peeker", h));
const hr = t => console.log(`\n${"═".repeat(72)}\n  ${t}\n${"═".repeat(72)}`);

// redeem + open ในคอลเดียว (บทที่ 8: "happen atomically in a single RPC call")
const overseer = await auth.openGadget(workspaceId, shareKey);
const meta = await overseer.getMetadata();
hr("workspace");
console.log(JSON.stringify(meta, null, 1));

// ── โค้ดที่ agent เขียน ───────────────────────────────────────────────────
const workpieces = [];
{
  let settle; const ready = new Promise(r => { settle = r; });
  class WpSub extends RpcTarget {
    // entry() เป็น upsert — ถูกเรียกซ้ำเมื่อ workpiece เปลี่ยนสถานะ (เช่นหลัง merge)
    // ถ้า push ทื่อ ๆ จะได้รายการซ้ำ
    entry(w) {
      const i = workpieces.findIndex(x => x.id === w.id);
      if (i >= 0) workpieces[i] = w; else workpieces.push(w);
    }
    removed(id) {
      const i = workpieces.findIndex(x => x.id === id);
      if (i >= 0) workpieces.splice(i, 1);
    }
    ready() { settle(); }
  }
  await overseer.subscribeToWorkpieces(new RpcStub(new WpSub()));
  await ready;
}
// งานของ agent เป็น "ข้อเสนอ" ที่ผูกกับแชท จนกว่ามนุษย์จะรับ
// workpiece ที่มี chatId = ยังไม่ถาวร (ดู WorkpieceSummary.chatId)
hr("สถานะก่อนรับข้อเสนอ");
for (const wp of workpieces) {
  console.log(`  "${wp.title}" id=${wp.id} chatId=${wp.chatId ?? "(ถาวรแล้ว)"}`);
}
const pending = workpieces.find(w => w.chatId !== undefined);
if (pending && process.env.MERGE === "1") {
  // ⚠️ mergeChanges(chatId, null) ไม่ได้แปลว่า "ทั้งหมด" — และมันเงียบ ไม่ error
  // ต้องหา sequence ของข้อความ "changes" ตัวสุดท้ายมาระบุเอง
  const page = await overseer.getChatHistory(pending.chatId);
  const msgs = page.messages ?? page;
  const last = [...msgs].reverse().find(m => m.type === "changes");
  if (!last) {
    console.log("\n  (ไม่พบข้อความ changes ในแชทนี้)");
  } else {
    console.log(`\n  → mergeChanges(chatId=${pending.chatId}, through=${last.sequence})`);
    await overseer.mergeChanges(pending.chatId, last.sequence);
    await new Promise(r => setTimeout(r, 2000));
    // อ่านสถานะ workpiece ใหม่ เพื่อยืนยันว่าไม่ provisional แล้ว
    const after = [];
    let settle2; const ready2 = new Promise(r => { settle2 = r; });
    class WpSub2 extends RpcTarget {
      entry(w) {
        const i = after.findIndex(x => x.id === w.id);
        if (i >= 0) after[i] = w; else after.push(w);
      }
      removed() {}
      ready() { settle2(); }
    }
    await overseer.subscribeToWorkpieces(new RpcStub(new WpSub2()));
    await ready2;
    for (const w of after) {
      console.log(`  หลัง merge: "${w.title}" chatId=${w.chatId ?? "(ถาวรแล้ว)"}`);
    }
  }
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

hr("ไฟล์ที่ agent เขียน");
let serverSrc = "";
let gadgetWp = null;
for (const wp of workpieces) {
  if (wp.filesRoot === undefined) continue;
  gadgetWp = wp;
  console.log(`workpiece "${wp.title}" (id=${wp.id}, filesRoot="${wp.filesRoot}")`);
  for (const [name, text] of doc.getMap(wp.filesRoot).entries()) {
    const body = text.toString();
    console.log(`   ${String(body.length).padStart(6)} ตัวอักษร  ${name}`);
    if (name === "server.js") serverSrc = body;
  }
}

hr("server.js — 40 บรรทัดแรก");
console.log(serverSrc.split("\n").slice(0, 40).join("\n"));

hr("เมธอดที่ server เปิดให้เรียก");
const methods = [...new Set([...serverSrc.matchAll(/^\s{2}(?:async\s+)?([a-zA-Z][\w]*)\s*\(/gm)]
  .map(m => m[1]))].filter(n => !["constructor", "if", "for", "while", "switch"].includes(n));
console.log(methods.join(", ") || "(ไม่พบ)");

// ── เรียก API ของแอปที่ AI เขียน ──────────────────────────────────────────
hr("เรียก API จริง");
if (gadgetWp) {
  const gadget = await overseer.getGadget(gadgetWp.id);
  const app = await gadget.connectToGadget();
  for (const m of methods) {
    if (!/^(get|list|read|state|load)/i.test(m)) continue;
    try {
      const out = await app[m]();
      console.log(`  ${m}() →`, JSON.stringify(out).slice(0, 500));
    } catch (e) {
      console.log(`  ${m}() ✗ ${String(e).slice(0, 140)}`);
    }
  }
}

hr("action log");
console.log(JSON.stringify(await overseer.listActions(), null, 1).slice(0, 400));
process.exit(0);
