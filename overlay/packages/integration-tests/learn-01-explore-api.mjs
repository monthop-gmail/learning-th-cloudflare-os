// บทที่ 1: สำรวจ API ของ Cloudflare OS ผ่าน Cap'n Web RPC — ช่องทางเดียวกับที่เบราว์เซอร์ใช้
//
// ต้องมี `pnpm run-local` รันอยู่ก่อน
// รัน: node packages/integration-tests/learn-01-explore-api.mjs
import { createHash } from "node:crypto";
import { newWebSocketRpcSession } from "capnweb";

const BASE = process.env.OS_URL ?? "http://localhost:8787";
const wsUrl = new URL("/api", BASE);
wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";

const hashFor = name =>
  new Uint8Array(createHash("sha256").update(`integration-test:${name}`).digest());

const log = (label, value) =>
  console.log(`\n── ${label} ` + "─".repeat(Math.max(0, 60 - label.length)) + "\n" +
    (typeof value === "string" ? value : JSON.stringify(value, null, 2)));

const api = newWebSocketRpcSession(wsUrl.toString());

// 1) ข้อมูลเซิร์ฟเวอร์ (เรียกได้โดยไม่ต้องล็อกอิน)
log("getServerConfig()", await api.getServerConfig());

// 2) สมัครสมาชิก แล้วแลก token เป็น AuthenticatedApi capability
const user = `mentor${Date.now().toString(36)}`;
const token = await api.createAccount(user, "Study Bot", hashFor(user));
if (!token) throw new Error("สมัครไม่ผ่าน");
const auth = await api.authenticate(token);
log("whoami()", await auth.whoami());
log("amIAdmin()", await auth.amIAdmin());

// 3) มีโมเดล AI ให้ใช้ไหม (ตัวชี้ขาดว่าสั่ง agent ได้หรือยัง)
const models = await auth.listModels();
log("listModels()  ← ว่าง = ยังไม่ได้ใส่ API key", models);

// 4) Blueprints ที่ deployment นี้แถมมา (= "executables" ในอุปมา OS)
const featured = await auth.listFeaturedBlueprints();
log("listFeaturedBlueprints()", featured);

const formats = await auth.listOutputFormats();
log("listOutputFormats()", formats);

// 5) สร้าง workspace ใหม่ — คืน Overseer stub มาเลย ไม่ใช่ id
//    (Cap'n Web: เรียกเมธอดต่อบน stub ได้ทันทีโดยไม่ต้องรอ round trip = "promise pipelining")
const overseer = await auth.newGadget();
log("newGadget() → getMetadata()", await overseer.getMetadata());
log("listChats()", await overseer.listChats());
log("listBlueprints()", await overseer.listBlueprints());
log("listSlashCommands()", await overseer.listSlashCommands());

// 6) gadget นี้ถูก "แนะนำ" ให้รู้จักทรัพยากรอะไรบ้าง (capability-based security)
log("listActions()  ← log ทุกอย่างที่ agent/gadget ทำ", await overseer.listActions());
log("listPreApprovableActions()", await overseer.listPreApprovableActions());

// 7) มี gatekeeper (= device driver) ตัวไหนติดตั้งอยู่บ้าง
log("listGatekeeperVendors()", await auth.listGatekeeperVendors());
log("listAddableGatekeepers()", await auth.listAddableGatekeepers());

console.log("\n✅ จบ — ทั้งหมดนี้คุยผ่าน WebSocket เส้นเดียว ไม่มี REST เลยสักเส้น");
process.exit(0);
