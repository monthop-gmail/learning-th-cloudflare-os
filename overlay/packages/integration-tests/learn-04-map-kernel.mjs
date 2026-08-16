// บทที่ 6: ทำแผนที่เคอร์เนล overseer.ts (9,745 บรรทัด) ก่อนลงไปอ่าน
//
// ไม่ต้องมี pnpm run-local รันอยู่ — สคริปต์นี้อ่านซอร์สอย่างเดียว
// รัน: node packages/integration-tests/learn-04-map-kernel.mjs
//
// แนวคิด: ไฟล์หมื่นบรรทัดอ่านรวดไม่ไหวและไม่ควรอ่าน ให้ทำแผนที่ก่อนว่า
// "อะไรอยู่ตรงไหน ใหญ่แค่ไหน" แล้วค่อยเลือกอ่านเฉพาะส่วนที่ต้องการ

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = join(ROOT, "packages/workshop-backend/src/overseer.ts");
const lines = readFileSync(SRC, "utf8").replace(/\n$/, "").split("\n");

const hr = t => console.log(`\n${"═".repeat(72)}\n  ${t}\n${"═".repeat(72)}`);
console.log(`overseer.ts มี ${lines.length.toLocaleString()} บรรทัด`);

// ── 1) แผนที่คลาส: อะไรอยู่ตรงไหน ใหญ่แค่ไหน ─────────────────────────────
hr("1) แผนที่คลาส (เรียงตามตำแหน่งในไฟล์)");
const marks = [];
lines.forEach((l, i) => {
  const m = l.match(/^(?:export )?(?:abstract )?class (\w+)/);
  if (m) marks.push({ line: i + 1, name: m[1] });
});
marks.push({ line: lines.length, name: null });

const classes = [];
for (let i = 0; i < marks.length - 1; i++) {
  classes.push({ ...marks[i], size: marks[i + 1].line - marks[i].line });
}
const widest = Math.max(...classes.map(c => c.name.length));
for (const c of classes) {
  const bar = "█".repeat(Math.max(1, Math.round(c.size / 120)));
  console.log(
    `  ${String(c.line).padStart(5)}  ${c.name.padEnd(widest)}  ` +
    `${String(c.size).padStart(5)} บรรทัด  ${bar}`);
}

// ── 2) data model: collections ทั้งหมดใน DO storage ──────────────────────
hr("2) Data model — collections ใน Durable Object storage");
const collections = [];
lines.forEach((l, i) => {
  const m = l.match(/^\s+(\w+): collection<(\w+)>\(\)\(\{/);
  if (m) collections.push({ line: i + 1, name: m[1], type: m[2] });
});
const cw = Math.max(...collections.map(c => c.name.length));
for (const c of collections) {
  console.log(`  ${String(c.line).padStart(5)}  ${c.name.padEnd(cw)}  <${c.type}>`);
}
console.log(`\n  รวม ${collections.length} collections`);

// ── 3) จุดที่ควรอ่านก่อน ─────────────────────────────────────────────────
hr("3) จุดตั้งต้นที่แนะนำให้อ่าน");
const landmarks = [
  ["makeOverseerStorage(",   "นิยาม data model ทั้งหมด"],
  ["loadGadgetWorker(",      "สร้าง Dynamic Worker + ตั้งแซนด์บ็อกซ์ (หา globalOutbound)"],
  ["getGadgetFacetFetcher(", "รัน gadget เป็น facet ใต้ DO นี้"],
  ["getGatekeeperFacet(",    "รัน gatekeeper เป็น facet"],
  ["async authorizeObservation(", "ด่านอ่านข้อมูล (บทที่ 5)"],
  ["async ensureObserver(",  "ตรวจ observer ตอนเปิด (บทที่ 5)"],
  ["applyPendingAction(",    "ด่านอนุมัติ action (บทที่ 4)"],
  ["class UseOverseerInterface", "สิทธิ์ role 'use' — default-deny ตอน compile"],
];
// หาเฉพาะ "จุดนิยาม" ไม่ใช่จุดเรียก: บรรทัดต้องขึ้นต้นด้วยชื่อนั้น (ยอมให้มี async / class นำหน้า)
// ถ้าใช้ includes() เฉย ๆ จะไปเจอ call site ก่อน เช่น applyPendingAction ที่ถูกเรียกก่อนถูกนิยาม
for (const [needle, why] of landmarks) {
  const head = needle.replace(/\($/, "");
  const def = new RegExp(`^\\s*(?:export )?(?:async |function |class )?${head}\\b`);
  const at = lines.findIndex(l => def.test(l));
  console.log(`  ${at >= 0 ? String(at + 1).padStart(5) : "  ???"}  ${needle.padEnd(30)} ${why}`);
}

// ── 4) ตัวชี้วัดคุณภาพ: อัตราส่วนคอมเมนต์ ────────────────────────────────
hr("4) ทำไมไฟล์นี้ถึงอ่านไหว");
const comment = lines.filter(l => /^\s*(\/\/|\*|\/\*)/.test(l)).length;
const blank = lines.filter(l => l.trim() === "").length;
const code = lines.length - comment - blank;
const pct = n => `${((n / lines.length) * 100).toFixed(1)}%`;
console.log(`  โค้ด     ${String(code).padStart(5)}  ${pct(code)}`);
console.log(`  คอมเมนต์ ${String(comment).padStart(5)}  ${pct(comment)}   ← สูงผิดปกติ และนั่นคือเหตุผล`);
console.log(`  บรรทัดว่าง ${String(blank).padStart(5)}  ${pct(blank)}`);
console.log(`\n  คอมเมนต์ส่วนใหญ่อธิบาย "ทำไม" ไม่ใช่ "ทำอะไร" — อ่านคอมเมนต์อย่างเดียว`);
console.log("  ก็เข้าใจดีไซน์ได้เกินครึ่งแล้ว");

console.log("\n✅ จบ — เลือกจุดจากข้อ 3 แล้วเปิดอ่านด้วย editor ได้เลย");
