// ตอนที่ 2: สร้าง Gadget จาก Blueprint แล้วอ่านซอร์สโค้ดของมันผ่าน Yjs
import { createHash } from "node:crypto";
import { RpcStub, RpcTarget, newWebSocketRpcSession } from "capnweb";
// yjs ไม่ใช่ dep ของแพ็กเกจนี้ (pnpm แยก node_modules เข้ม) ชี้ไปที่ store ตรง ๆ
import * as Y from "../../node_modules/.pnpm/yjs@13.6.31/node_modules/yjs/dist/yjs.mjs";

const api = newWebSocketRpcSession("ws://localhost:8787/api");
const u = "play" + Date.now().toString(36);
const h = new Uint8Array(createHash("sha256").update("integration-test:" + u).digest());
const auth = await api.authenticate(await api.createAccount(u, "Study Bot", h));

const hr = t => console.log(`\n${"═".repeat(66)}\n  ${t}\n${"═".repeat(66)}`);

// ── 1) สร้าง gadget จาก blueprint "Workspace Docs" ───────────────────────
hr("1) newGadgetFromBlueprint('format.document', {})");
const overseer = await auth.newGadgetFromBlueprint("format.document", {});
console.log("metadata:", JSON.stringify(await overseer.getMetadata(), null, 2));

// ── 2) ดูว่ามี workpiece อะไรอยู่ใน workspace บ้าง ───────────────────────
hr("2) subscribeToWorkpieces()  ← workpiece = 'สิ่งของ' ใน workspace");
const workpieces = [];
{
  let settle;
  const ready = new Promise(r => { settle = r; });
  class WpSub extends RpcTarget {
    entry(summary) {   // upsert: ทั้งตอน subscribe ครั้งแรก และเมื่อมีการเปลี่ยนแปลง
      const i = workpieces.findIndex(w => w.id === summary.id);
      if (i >= 0) workpieces[i] = summary; else workpieces.push(summary);
    }
    removed(id) {
      const i = workpieces.findIndex(w => w.id === id);
      if (i >= 0) workpieces.splice(i, 1);
    }
    ready() { settle(); }
  }
  const sub = new RpcStub(new WpSub());
  await overseer.subscribeToWorkpieces(sub);
  await ready;
}
console.log(JSON.stringify(workpieces, null, 2));

// ── 3) ดึงซอร์สโค้ดออกมา — โค้ดทั้ง workspace = Y.Doc ก้อนเดียว ─────────
hr("3) subscribeToCode()  ← โค้ดเป็น CRDT (Yjs) ไม่ใช่ไฟล์ธรรมดา");
const doc = new Y.Doc();
let version = 0;
{
  let settle;
  const ready = new Promise(r => { settle = r; });
  class CodeSub extends RpcTarget {
    update(up) {
      Y.applyUpdateV2(doc, up.update);   // ต้อง apply แบบ sync เพื่อรักษาลำดับ
      version = up.version;
    }
    ready() { settle(); }
  }
  const sub = new RpcStub(new CodeSub());
  await overseer.subscribeToCode(sub);
  await ready;
}
console.log(`code version = ${version}`);

// แต่ละ workpiece ที่มีไฟล์ จะมี root Y.Map ของตัวเอง ชื่อตาม filesRoot
for (const wp of workpieces) {
  if (wp.filesRoot === undefined) continue;
  const files = doc.getMap(wp.filesRoot);
  console.log(`\n workpiece "${wp.title}"  (filesRoot="${wp.filesRoot}")`);
  for (const [name, text] of files.entries()) {
    const body = text.toString();
    console.log(`   ${String(body.length).padStart(7)} ตัวอักษร  ${name}`);
  }
}

// ── 4) เปิดดูโค้ดจริงสัก 2 ไฟล์ ──────────────────────────────────────────
hr("4) เนื้อโค้ดจริง (หัวไฟล์)");
for (const wp of workpieces) {
  if (wp.filesRoot === undefined) continue;
  const files = doc.getMap(wp.filesRoot);
  for (const [name, text] of files.entries()) {
    if (!/server|index|main/i.test(name)) continue;
    console.log(`\n───── ${name} ─────`);
    console.log(text.toString().split("\n").slice(0, 40).join("\n"));
    break;
  }
}

console.log("\n✅ ตอนที่ 2 จบ");
process.exit(0);
