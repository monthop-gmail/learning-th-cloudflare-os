// บทที่ 9: รันบน workerd เปล่า ๆ — ไม่มี wrangler ไม่มี miniflare ไม่มีบัญชี Cloudflare
//
// รัน: node packages/integration-tests/learn-06-bare-workerd.mjs
//
// สคริปต์นี้สตาร์ต workerd ด้วย config.capnp ที่เขียนมือ แล้วยิงสามคำขอเพื่อพิสูจน์ว่า
// primitive ที่ Cloudflare OS พึ่งพาที่สุดสามตัว ทำงานได้บน runtime เปล่า:
//   1. Worker Loader        — โหลดโค้ดที่เพิ่งมีตอน runtime ขึ้นมารัน
//   2. globalOutbound: null — ตัดเน็ตของโค้ดนั้น
//   3. Durable Object + SQL — เก็บ state ลงดิสก์จริง อยู่รอดข้ามการรีสตาร์ต

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(HERE, "../..");
const DEMO = join(HERE, "workerd-demo");
const PORT = 8791;

// หา binary ของ workerd ที่ติดมากับ repo อยู่แล้ว — ไม่ต้องติดตั้งอะไรเพิ่ม
//
// ตัว binary อยู่ในแพ็กเกจเฉพาะแพลตฟอร์ม (@cloudflare/workerd-<os>-<arch>) ซึ่งไม่ใช่ dep
// ของแพ็กเกจนี้ pnpm จึงไม่ยอมให้ require.resolve เห็น — ค้นจาก store ตรง ๆ แทน
function findWorkerd() {
  const store = resolve(ROOT_DIR, "node_modules/.pnpm");
  if (!existsSync(store)) return null;
  for (const entry of readdirSync(store)) {
    if (!entry.startsWith("@cloudflare+workerd-")) continue;
    const inner = join(store, entry, "node_modules/@cloudflare");
    if (!existsSync(inner)) continue;
    for (const pkg of readdirSync(inner)) {
      const bin = join(inner, pkg, "bin/workerd");
      if (existsSync(bin)) return bin;
    }
  }
  return null;
}

const workerd = findWorkerd();
if (!workerd) {
  console.error("หา binary ของ workerd ไม่เจอ — รัน `pnpm install` ที่ราก repo ก่อน");
  process.exit(1);
}

mkdirSync(join(DEMO, "do-data"), { recursive: true });

const hr = t => console.log(`\n${"═".repeat(70)}\n  ${t}\n${"═".repeat(70)}`);
console.log(`workerd: ${workerd}`);

const proc = spawn(workerd, ["serve", "--experimental", "config.capnp"],
  { cwd: DEMO, stdio: ["ignore", "pipe", "pipe"] });
let stderr = "";
proc.stderr.on("data", d => { stderr += d; });
proc.on("exit", code => {
  if (code !== 0 && code !== null) {
    console.error(`\nworkerd ออกด้วยรหัส ${code}\n${stderr}`);
    process.exit(1);
  }
});

const get = async path => {
  const res = await fetch(`http://localhost:${PORT}${path}`);
  return await res.json();
};

// รอให้ซ็อกเก็ตพร้อม
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try { await get("/"); up = true; } catch { await new Promise(r => setTimeout(r, 250)); }
}
if (!up) {
  console.error(`workerd ไม่ขึ้นภายในเวลาที่รอ\n${stderr}`);
  proc.kill();
  process.exit(1);
}

try {
  hr("1) Worker Loader — โหลดโค้ดที่เขียนขึ้นตอน runtime");
  console.log(JSON.stringify(await get("/"), null, 2));
  console.log("\n  โค้ดก้อนนี้เป็นสตริงในไฟล์ main.js ไม่เคยผ่าน build step ใด ๆ");
  console.log("  ของจริงใน Cloudflare OS ดึงมาจาก Yjs doc แทน");

  hr("2) globalOutbound: null — แซนด์บ็อกซ์ตัดเน็ต");
  const escape = await get("/escape");
  console.log(JSON.stringify(escape, null, 2));
  console.log(`\n  ${escape.escaped ? "⚠ หลุดออกไปได้ — ผิดคาด!" : "✓ ออกไม่ได้ ตามคาด"}`);

  hr("3) Durable Object + SQLite บนดิสก์");
  const a = await get("/counter");
  const b = await get("/counter");
  console.log(`  นับสองครั้ง: ${a.count} → ${b.count}`);
  console.log("\n  ปิดสคริปต์แล้วรันใหม่ ตัวเลขจะนับต่อ ไม่กลับไปเริ่มที่ 1");
  console.log(`  (ไฟล์อยู่ที่ ${join(DEMO, "do-data")} — ลบทิ้งเพื่อรีเซ็ต)`);

  hr("สรุป");
  console.log(`  primitive ที่ Cloudflare OS พึ่งพาที่สุด ทำงานบน workerd เปล่าได้ครบ
  สิ่งที่ยังขาดสำหรับสแตกเต็มคือ KV, R2, ASSETS และ BROWSER
  ซึ่ง workerd ไม่ได้ทำเอง แต่เปิดช่องให้เสียบ service เข้าไปแทน`);
} finally {
  proc.kill();
}
