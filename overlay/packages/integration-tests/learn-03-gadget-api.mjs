// บทที่ 3: ทำสิ่งที่ agent ทำ — เรียก API ของ gadget ตรง ๆ แล้วแชร์ผลลัพธ์
//
// ต้องมี `pnpm run-local` รันอยู่ก่อน
// รัน: node packages/integration-tests/learn-03-gadget-api.mjs
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcStub, RpcTarget, newWebSocketRpcSession } from "capnweb";
import * as Y from "../../node_modules/.pnpm/yjs@13.6.31/node_modules/yjs/dist/yjs.mjs";

const api = newWebSocketRpcSession("ws://localhost:8787/api");
const u = "demo" + Date.now().toString(36);
const h = new Uint8Array(createHash("sha256").update("integration-test:" + u).digest());
const auth = await api.authenticate(await api.createAccount(u, "Study Bot", h));
const hr = t => console.log(`\n${"═".repeat(66)}\n  ${t}\n${"═".repeat(66)}`);

const overseer = await auth.newGadgetFromBlueprint("format.document", {});
const meta = await overseer.getMetadata();

// ── ดึงโค้ดมาดูว่า server มีเมธอดอะไรให้เรียกบ้าง ───────────────────────
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
const serverSrc = doc.getMap("").get("server.js").toString();
const dumpPath = join(mkdtempSync(join(tmpdir(), "cfos-learn-")), "docs-server.js");
writeFileSync(dumpPath, serverSrc);
console.log(`\n(เก็บ server.js ฉบับเต็มไว้ที่ ${dumpPath} — เปิดอ่านได้)`);

hr("เมธอดที่ server.js ของ Gadget เปิดให้เรียก");
const methods = [...serverSrc.matchAll(/^\s{2}(?:async\s+)?([a-zA-Z][a-zA-Z0-9]*)\s*\(/gm)]
  .map(m => m[1]).filter(n => n !== "constructor");
console.log([...new Set(methods)].join(", "));

// ── นี่คือท่าไม้ตายของทั้งระบบ: RPC เข้าไปใน Durable Object ของ gadget ──
hr("connectToGadget()  ← ท่าเดียวกับที่ agent ใช้คุยกับแอป");
const gadget = await overseer.getGadget(meta.defaultGadgetId);
const app = await gadget.connectToGadget();

const before = await app.getDocument();
console.log("ก่อนแก้:", JSON.stringify(before).slice(0, 300));

hr("สั่งงานแอปผ่าน API ของมันเอง");
// setDocument() คือ "full-document writer for agents/importers" ตามคอมเมนต์ในโค้ด
const after = await app.setDocument({
  title: "บันทึกการเรียน Cloudflare OS",
  senderId: "study-bot",
  blocks: [
    { id: "b1", html: "<h1>สรุป: Cloudflare OS ทำงานยังไง</h1>" },
    { id: "b2", html: "<p>เอกสารนี้ถูกเขียนโดยสคริปต์ที่เรียก API ของ Gadget ตรง ๆ " +
                      "ผ่าน <code>connectToGadget()</code> โดยไม่ใช้ LLM เลย</p>" },
    { id: "b3", html: "<p>นี่คือเหตุผลที่ agent 'ร่วมงานในแอป' ได้ทันทีโดยไม่ต้องเขียน MCP server " +
                      "— ตัวแอปถูกบังคับให้คุย client/server ผ่าน Cap'n Web อยู่แล้ว " +
                      "API เลยโผล่มาเองโดยปริยาย</p>" },
  ],
});
console.log("→ setDocument() เรียบร้อย");
console.log("title    :", JSON.stringify(after.title));
console.log("revision :", before.revision, "→", after.revision);
console.log("blocks   :", after.blocks.map(b => `${b.id}(v${b.version})`).join(", "));

// อ่านซ้ำจาก Durable Object เพื่อพิสูจน์ว่ามัน persist จริง
const reread = await app.getDocument();
console.log("อ่านซ้ำ  :", JSON.stringify(reread.title), "| revision", reread.revision);

// ── แชร์ให้ดูในเบราว์เซอร์ได้ ────────────────────────────────────────────
hr("createShareLink()  ← ระบบ sharing ทำงานจริง");
const link = await overseer.createShareLink("build", "ให้พี่เลี้ยงดู");
// รูปแบบเดียวกับที่ ShareModal.tsx สร้าง: `${origin}/workspace/${id}#share=${key}`
console.log(`\n  🔗  http://localhost:8787/workspace/${meta.id}#share=${link.key}\n`);
console.log("listShareLinks():", JSON.stringify(await overseer.listShareLinks(), null, 2));

console.log("\n✅ ตอนที่ 3 จบ");
process.exit(0);
