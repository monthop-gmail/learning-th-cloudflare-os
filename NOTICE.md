# NOTICE

repo นี้เป็น **สื่อประกอบการเรียนอิสระ** ไม่ได้มีส่วนเกี่ยวข้องกับ Cloudflare, Inc.
และไม่ได้รับการรับรองจาก Cloudflare แต่อย่างใด

## ผลงานที่อ้างอิงถึง

เนื้อหาทั้งหมดในนี้เขียนขึ้นเพื่อใช้ศึกษา:

- **Cloudflare OS** — <https://github.com/cloudflare/cloudflare-os>
  Copyright Cloudflare, Inc. เผยแพร่ภายใต้ Apache License 2.0

repo นี้ **ไม่ได้คัดลอกซอร์สโค้ดของ Cloudflare OS มาเผยแพร่ซ้ำ** ผู้เรียนต้อง clone
ต้นฉบับจาก upstream เอง (ดูวิธีใน `README.md`)

## การอ้างข้อความ

`README.md` มีการยกข้อความสั้น ๆ จาก `README.md`, `AGENTS.md` และ doc comment ใน
ซอร์สโค้ดของ Cloudflare OS มาอ้างอิงเพื่อประกอบคำอธิบาย ทุกจุดระบุที่มาไว้ชัดเจน
ข้อความเหล่านั้นยังเป็นลิขสิทธิ์ของ Cloudflare, Inc. ภายใต้ Apache License 2.0

## ผลงานต้นฉบับในนี้

ไฟล์ต่อไปนี้เขียนขึ้นใหม่โดยผู้จัดทำ repo นี้ เผยแพร่ภายใต้ Apache License 2.0
(ดู `LICENSE`) เพื่อให้เข้ากันได้กับ upstream:

```
README.md
install.sh
overlay/packages/integration-tests/learn-01-explore-api.mjs
overlay/packages/integration-tests/learn-02-blueprint-code.mjs
overlay/packages/integration-tests/learn-03-gadget-api.mjs
overlay/packages/integration-tests/fixtures/gatekeeper-notes/**
overlay/packages/integration-tests/__tests__/notes-approval.test.ts
```

`overlay/.../fixtures/gatekeeper-notes/` เขียนขึ้นใหม่ทั้งหมด แต่ออกแบบตาม
protocol interface ของ Cloudflare OS (`packages/workshop-shared/src/gatekeeper.ts`)
และเดินตามโครงเดียวกับ fixture ต้นฉบับที่ `packages/integration-tests/fixtures/gatekeeper-test/`

## เครื่องหมายการค้า

"Cloudflare", "Cloudflare OS" และ "Cloudflare Workers" เป็นเครื่องหมายการค้าของ
Cloudflare, Inc. ใช้ในที่นี้เพื่อการอ้างถึงเชิงบรรยายเท่านั้น
