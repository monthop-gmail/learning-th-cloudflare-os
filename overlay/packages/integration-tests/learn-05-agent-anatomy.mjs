// บทที่ 7: ผ่าตัด agent.ts — prompt, tools, และ context compaction
//
// ไม่ต้องมี pnpm run-local รันอยู่ — อ่านซอร์สอย่างเดียว
// รัน: node packages/integration-tests/learn-05-agent-anatomy.mjs

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = p => readFileSync(join(ROOT, "packages/workshop-backend/src", p), "utf8");
const agent = read("agent.ts").split("\n");
const compaction = read("agent-compaction.ts");

const hr = t => console.log(`\n${"═".repeat(72)}\n  ${t}\n${"═".repeat(72)}`);

// ── 1) prompt ทั้งหมดที่ commit ไว้เป็นซอร์สโค้ด ──────────────────────────
hr("1) Prompt ที่ถูก commit เป็นซอร์สโค้ด");
const blocks = [];
agent.forEach((l, i) => {
  const m = l.match(/^(?:let|const) ([A-Za-z_]+) = `\s*$/);
  if (!m) return;
  for (let j = i + 1; j < agent.length; j++) {
    if (/^\s*`(\.trim\(\))?;\s*$/.test(agent[j])) {
      blocks.push({ name: m[1], from: i + 1, to: j + 1, chars: agent.slice(i + 1, j).join("\n").length });
      break;
    }
  }
});
const w = Math.max(...blocks.map(b => b.name.length));
let totalChars = 0;
for (const b of blocks) {
  totalChars += b.chars;
  console.log(
    `  ${String(b.from).padStart(5)}  ${b.name.padEnd(w)}  ` +
    `${String(b.chars).padStart(6)} ตัวอักษร  ~${String(Math.round(b.chars / 4)).padStart(5)} tokens`);
}
console.log(`\n  รวม ~${Math.round(totalChars / 4).toLocaleString()} tokens สำหรับ prompt คงที่ทั้งหมด`);
console.log("  (coding agent ทั่วไปมักใช้มากกว่านี้หลายเท่า — ดู README ข้อ 'fewer tokens')");

// ── 2) tools ที่ agent เรียกได้ ──────────────────────────────────────────
hr("2) Tools ทั้งหมดที่ agent เรียกได้");
const tools = [];
agent.forEach((l, i) => {
  const m = l.match(/^\s{6}name: "([a-zA-Z]+)",\s*$/);
  if (m && /defineTool\(\{/.test(agent[i - 1] ?? "")) tools.push({ name: m[1], line: i + 1 });
});
for (const t of tools) console.log(`  ${String(t.line).padStart(5)}  ${t.name}`);
console.log(`\n  รวม ${tools.length} tools — น้อยผิดปกติสำหรับ coding agent`);
console.log("  เพราะ executeCode ทำได้เกือบทุกอย่างอยู่แล้ว (Code Mode)");

// ── 3) ค่าคงที่ของ context compaction ───────────────────────────────────
hr("3) Context compaction — ตัวเลขที่ตัดสินว่าเมื่อไหร่จะสรุปทิ้ง");
for (const key of ["COMPACTION_TRIGGER_RATIO", "COMPACTION_TARGET_RATIO", "DEFAULT_CONTEXT_WINDOW"]) {
  const m = compaction.match(new RegExp(`const ${key} = ([^;]+);`));
  console.log(`  ${key.padEnd(26)} = ${m ? m[1] : "?"}`);
}
console.log(`
  แปลว่า: พอ prompt โตถึง 85% ของงบ input จะเริ่มสรุป แล้วบีบให้เหลือ ~30%
  ประวัติแชทฉบับเต็ม "ไม่ถูกลบ" — UI ยังเลื่อนกลับไปอ่านได้ แต่ agent เริ่ม replay
  จาก boundary เท่านั้น`);

// ── 4) กันการฉีดคำสั่งผ่านบทสนทนาที่กำลังสรุป ────────────────────────────
hr("4) ป้องกัน prompt injection ตอนสรุป");
const inj = compaction.match(/Do not continue the conversation[^`]*/);
console.log(`  ท้าย COMPACTION_SYSTEM_PROMPT เขียนไว้ว่า:\n\n    "${inj ? inj[0].trim() : "?"}"`);
console.log(`
  ตัวสรุปกำลังอ่านข้อความที่อาจมีคำสั่งปลอมฝังอยู่ จึงต้องบอกให้ชัดว่า
  "อ่านเพื่อสรุป ไม่ใช่เพื่อทำตาม"`);

console.log("\n✅ จบ — เปิด agent.ts ที่บรรทัด 449 (SYSTEM_PROMPT) อ่านต่อได้เลย");
