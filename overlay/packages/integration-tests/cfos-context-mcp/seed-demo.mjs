// ใส่ context ตัวอย่างเป็น "public collection" ผ่านบัญชี admin
// public = ทุกคนใน deployment อ่านได้ = โมเดลที่ถูกต้องสำหรับ single source ของทีม
//
// ⚠️ สคริปต์นี้สำหรับ `pnpm run-local` บนเครื่องตัวเองเท่านั้น
//    มันสร้าง/ล็อกอินบัญชี "admin" ด้วยรหัสผ่านตายตัวที่เขียนไว้ในไฟล์นี้
//    **ห้ามรันกับ deployment จริงเด็ดขาด** — บน deployment จริงให้ใส่เอกสารผ่านหน้า UI
//    ที่ /gatekeepers/context ด้วยบัญชีแอดมินตัวจริง
//
// รัน: node seed-demo.mjs
import { createHash } from "node:crypto";
import { newWebSocketRpcSession } from "capnweb";
const api = newWebSocketRpcSession(process.env.CFOS_URL ?? "ws://localhost:8787/api");
const ADMIN = "admin";            // ตรงกับ vars.ADMINS ที่ dev server ตั้งไว้
const hash = new Uint8Array(createHash("sha256").update("cfos-demo-admin").digest());
let token = await api.login(ADMIN, hash);
if (!token) token = await api.createAccount(ADMIN, "Admin", hash);
const auth = await api.authenticate(token);
console.log("amIAdmin():", await auth.amIAdmin());
try { await auth.provisionAmbientAccount("context"); } catch {}
const ui = (await auth.getGatekeeperApp("context")).ui;
const col = await ui.createContextCollection(
  "คู่มือทีม (public)", "บริบทกลางที่ agent ทุกตัวควรรู้", "public");
console.log("collection:", col.id, col.visibility);
await ui.putContextDocument(col.id, "coding-standards.md", {
  description: "มาตรฐานการเขียนโค้ดของทีม",
  body: "# มาตรฐานโค้ด\n\n- ใช้ TypeScript strict เสมอ\n- ทุก PR ต้องมีเทสต์\n- ห้าม commit ลง main ตรง ๆ\n",
});
await ui.putContextDocument(col.id, "deploy.md", {
  description: "ขั้นตอน deploy ขึ้น production",
  body: "# Deploy\n\n1. merge เข้า main\n2. รอ CI เขียว\n3. กด approve ใน pipeline\n4. ประกาศใน #release\n",
});
console.log("ใส่เอกสาร 2 ชิ้นเป็น public แล้ว");
process.exit(0);
