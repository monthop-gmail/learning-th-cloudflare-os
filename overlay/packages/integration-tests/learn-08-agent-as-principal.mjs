// บทที่ 15: ท่า "agent เป็น principal ของตัวเอง"
//
// ต้องมี `pnpm run-local` รันอยู่
// รัน: node packages/integration-tests/learn-08-agent-as-principal.mjs
//
// พิสูจน์ว่าถ้าจะให้ coding agent ภายนอกเข้ามาทำงานใน Cloudflare OS
// ไม่ต้องประดิษฐ์ระบบสิทธิ์ใหม่ — ให้ agent มีบัญชีของตัวเอง แล้วใช้ permission graph
// ที่มีอยู่แล้ว (บทที่ 8) ตัดสินว่ามันแตะอะไรได้
//
// ข้อดีคือทุกอย่างที่ระบบทำอยู่แล้วทำงานถูกต้องทันที:
//   ขอบเขต   = workspace ที่คนเชิญ bot เข้าไป
//   ถอนสิทธิ์ = removeCollaborator (และถอนต่อเป็นทอดได้)
//   audit    = การกระทำขึ้นชื่อ bot แยกจากคน
//   ค่าใช้จ่าย = ลงบัญชี bot ไม่ปนกับของคน
import { createHash } from "node:crypto";
import { newWebSocketRpcSession } from "capnweb";
const h = n => new Uint8Array(createHash("sha256").update("demo:" + n).digest());
const api = newWebSocketRpcSession("ws://localhost:8787/api");
const t = Date.now().toString(36);
// bot เป็นบัญชีคนละใบกับคน — ไม่ต้องรู้รหัสผ่านของคน และถอนแยกกันได้
const HUMAN = "somchai" + t, BOT = "botsomchai" + t;

const human = await api.authenticate(await api.createAccount(HUMAN, "สมชาย", h(HUMAN)));
const bot   = await api.authenticate(await api.createAccount(BOT, "Agent ของสมชาย", h(BOT)));
console.log("human:", JSON.stringify(await human.whoami()));
console.log("bot  :", JSON.stringify(await bot.whoami()));

// คนสร้าง workspace แล้วเชิญ bot ของตัวเองเข้ามาเป็น build
const ws = await human.newGadget();
await ws.setTitle("workspace ของสมชาย");
const { id } = await ws.getMetadata();
console.log("\nเชิญ bot เป็น build:", !!(await ws.addCollaborator(BOT, "build")));

// bot เปิดเองได้ไหม และได้ role อะไร
const botWs = await bot.openGadget(id);
const m = await botWs.getMetadata();
console.log("bot เปิดได้ role =", m.role, "| เจ้าของยังเป็น", m.owner.name);

// bot ลงมือทำงานจริงในนามตัวเอง
const g = await botWs.createGadget("แอปที่ bot สร้าง", undefined, "BOT_APP");
console.log("bot สร้าง gadget id =", await g.getId());

// คนเห็นงานของ bot ไหม
const wps = [];
await new Promise(async r => {
  const { RpcStub, RpcTarget } = await import("capnweb");
  class W extends RpcTarget { entry(w){wps.push(w);} removed(){} ready(){r();} }
  await ws.subscribeToWorkpieces(new RpcStub(new W()));
});
console.log("คนเห็น workpiece:", wps.map(w => w.title).join(", "));

// คนถอน bot ออกเมื่อไหร่ก็ได้
const aff = await ws.removeCollaborator(BOT, []);
console.log("ถอน bot →", JSON.stringify(aff.map(a => ({ who: a.profile.name, newRole: a.newRole }))));
try { await bot.openGadget(id); console.log("⚠️ bot ยังเปิดได้"); }
catch { console.log("bot เปิดไม่ได้แล้ว ✓"); }
process.exit(0);
