// บทที่ 12: ส่องว่า gatekeeper แต่ละตัว "ทำอะไรได้จริง" ก่อนตัดสินใจเอาไปใช้
//
// ไม่ต้องมีเซิร์ฟเวอร์รันอยู่ ไม่ต้องมี OAuth — อ่านซอร์สอย่างเดียว
// รัน: node packages/integration-tests/learn-07-gatekeeper-surface.mjs [ชื่อ]
//      node packages/integration-tests/learn-07-gatekeeper-surface.mjs github
//
// ประเด็น: อย่าเชื่อชื่อ gatekeeper ให้ดูรายการเมธอด เพราะ "GitHub gatekeeper"
// ไม่ได้แปลว่าทำได้ทุกอย่างที่ GitHub ทำได้

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PKGS = join(ROOT, "packages");
const filter = process.argv[2];

// เมธอดที่ขึ้นต้นด้วยคำพวกนี้ = มีผลข้างเคียง ต้องผ่านคิวอนุมัติ (ดูบทที่ 4)
const WRITE = /^(create|set|add|remove|delete|update|post|reply|merge|close|reopen|send|start|stop|run|invite|archive|move|rename|write|upload|revoke|enable|disable|assign)/i;

const hr = t => console.log(`\n${"═".repeat(70)}\n  ${t}\n${"═".repeat(70)}`);

const dirs = readdirSync(PKGS)
  .filter(d => d.startsWith("gatekeeper-"))
  .filter(d => !filter || d === `gatekeeper-${filter}` || d === filter)
  .sort();

if (dirs.length === 0) {
  console.error(`ไม่พบ gatekeeper ชื่อ "${filter}"`);
  process.exit(1);
}

for (const dir of dirs) {
  const pkg = join(PKGS, dir);
  const typesFile = join(pkg, "src/types.d.ts");
  const name = dir.replace("gatekeeper-", "");

  // ทรัพยากรที่ผูกได้ = ขอบเขตที่แคบที่สุดที่ผู้ใช้เลือกให้ agent เห็นได้
  const resources = [];
  for (const f of readdirSync(join(pkg, "src")).filter(f => f.endsWith(".ts"))) {
    const src = readFileSync(join(pkg, "src", f), "utf8");
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      const up = line.match(/urlPattern:\s*[`"']([^`"']+)[`"']/);
      if (!up) return;
      // title อาจอยู่ก่อนหรือหลัง urlPattern ในระยะไม่กี่บรรทัด
      let title = "(ไม่ระบุชื่อ)";
      for (let j = Math.max(0, i - 3); j < Math.min(lines.length, i + 4); j++) {
        const t = lines[j].match(/^\s*title:\s*[`"']([^`"']+)[`"']/);
        if (t) { title = t[1]; break; }
      }
      resources.push({ pattern: up[1], title });
    });
  }

  if (!existsSync(typesFile)) {
    console.log(`\n■ ${name}  (ไม่มี src/types.d.ts — type ประกาศไว้ในไฟล์ .ts)`);
    continue;
  }

  const types = readFileSync(typesFile, "utf8");
  const ifaces = [];
  let current = null;
  for (const line of types.split("\n")) {
    const iface = line.match(/^export interface (\w+)/);
    if (iface) { current = { name: iface[1], methods: [] }; ifaces.push(current); continue; }
    if (/^\}/.test(line)) { current = null; continue; }
    const meth = line.match(/^\s{2}(\w+)\s*\(/);
    if (meth && current) current.methods.push(meth[1]);
  }

  const all = ifaces.flatMap(i => i.methods);
  const writes = all.filter(m => WRITE.test(m));
  const reads = all.filter(m => !WRITE.test(m));

  hr(`${name}`);
  if (resources.length) {
    console.log("ผูกได้ที่ระดับ:");
    for (const r of resources) console.log(`   ${r.title.padEnd(26)} ${r.pattern}`);
  }
  console.log(`\nอ่าน  (${reads.length}): ${reads.join(", ") || "—"}`);
  console.log(`\nเขียน (${writes.length}) ← ผ่านคิวอนุมัติ: ${writes.join(", ") || "—"}`);
}

hr("อ่านผลยังไง");
console.log(`  ⚠️ การแยก "อ่าน/เขียน" ที่นี่เป็นเพียงการเดาจากชื่อเมธอด ไม่ใช่ความจริงจากโค้ด
     ตัวที่หลุดเกณฑ์มีจริง เช่น callService / turnOn / play / follow / trash ล้วนมีผลข้างเคียง
     ของจริงดูที่จุดเรียก submitAction() ในซอร์สของ gatekeeper นั้น
     (เมธอดไหนเรียก submitAction = ต้องอนุมัติ, เรียก authorizeObservation = แค่จดลง log)

  • "ผูกได้ที่ระดับ" ยิ่งแคบยิ่งดี — เป็นขอบเขตที่ผู้ใช้เลือกให้ agent เห็นได้
  • รายการ "เขียน" คือสิ่งที่จะโผล่ในคิวอนุมัติ ให้ทีมกดอนุมัติ
  • สิ่งที่ "ไม่อยู่ในทั้งสองรายการ" คือสิ่งที่ทำไม่ได้ — จุดนี้แหละที่ต้องดูก่อนตัดสินใจ
    เช่น github ไม่มีเมธอดแตะไฟล์/commit/branch เลย แปลว่าเขียนโค้ดลงรีโปไม่ได้`);
