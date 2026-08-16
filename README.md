# เรียน Cloudflare OS แบบลงมือทำ (ฉบับภาษาไทย)

คู่มือเรียน [Cloudflare OS](https://github.com/cloudflare/cloudflare-os) ภาษาไทย 5 บท
แบบลงมือทำ พร้อมสคริปต์และ fixture ที่รันได้จริง

> ⚠️ repo นี้ **ไม่ใช่ของ Cloudflare** และไม่ได้รับการรับรองจาก Cloudflare
> เป็นบันทึกการเรียนที่เขียนขึ้นเพื่อให้คนอื่นเดินตามได้โดยไม่ต้องลองผิดลองถูกซ้ำ
> เอกสารทางการอยู่ใน repo ต้นฉบับ (`README.md`, `AGENTS.md`, `docs/`)
> รายละเอียดลิขสิทธิ์และการอ้างอิงดูที่ [`NOTICE.md`](NOTICE.md)

**แนวคิดหลัก: รันก่อน อ่านทีหลัง** ทุกบทมีคำสั่งที่รันได้จริงและผลลัพธ์ที่ควรได้
ถ้าผลไม่ตรง แปลว่ามีอะไรผิด ให้หยุดแก้ก่อนไปต่อ

---

## เริ่มยังไง

repo นี้เก็บเฉพาะสื่อการเรียน **ไม่ได้คัดลอกโค้ดของ Cloudflare OS มา** ต้อง clone ต้นฉบับเองก่อน
แล้วค่อยวางไฟล์ประกอบทับลงไป:

```bash
# 1) clone ต้นฉบับ
git clone https://github.com/cloudflare/cloudflare-os.git
# 2) clone repo นี้
git clone https://github.com/monthop-gmail/learning-th-cloudflare-os.git
# 3) วางไฟล์ประกอบการเรียนลงไป
./learning-th-cloudflare-os/install.sh ./cloudflare-os
```

`install.sh` แตะเฉพาะไฟล์ใน `overlay/` เท่านั้น ไม่ยุ่งกับไฟล์อื่นของ upstream เลย
ถอนออกได้ด้วย `./install.sh --uninstall ./cloudflare-os`

จากนั้นเริ่มที่ [บทที่ 0](#บทที่-0-ทำให้มันรันให้ได้)

---

## สารบัญ

| บท | เรื่อง | ต้องมี AI key? | เวลาโดยประมาณ |
|---|---|---|---|
| [0](#บทที่-0-ทำให้มันรันให้ได้) | ทำให้มันรันให้ได้ | ไม่ | 5 นาที |
| [1](#บทที่-1-คุยกับระบบโดยไม่ผ่านเบราว์เซอร์) | คุยกับระบบโดยไม่ผ่านเบราว์เซอร์ | ไม่ | 15 นาที |
| [2](#บทที่-2-blueprint-คือซอร์สโค้ดจริง) | Blueprint คือซอร์สโค้ดจริง | ไม่ | 20 นาที |
| [3](#บทที่-3-เรียก-api-ของ-gadget-แบบที่-agent-ทำ) | เรียก API ของ Gadget แบบที่ agent ทำ | ไม่ | 20 นาที |
| [4](#บทที่-4-เขียน-gatekeeper-เองเพื่อเข้าใจ-approval-queue) | เขียน Gatekeeper เองเพื่อเข้าใจ approval queue | ไม่ | 60 นาที |
| [5](#บทที่-5-ไปต่อทางไหน) | ไปต่อทางไหน | — | — |

> 💡 บทที่ 0–4 **ไม่ต้องใช้ API key ของ LLM เลย** ตั้งใจออกแบบมาแบบนั้น เพราะส่วนที่น่าเรียนที่สุด
> ของ repo นี้คือสถาปัตยกรรม ไม่ใช่ตัวโมเดล

---

## ปูพื้น 3 นาที: มันคืออะไร

Cloudflare OS **ไม่ใช่** operating system แบบ Linux แต่ผู้เขียนใช้คำนี้เพราะโครงสร้างเทียบกันได้ตรง ๆ
(ตารางนี้มาจาก `README.md`):

| OS ปกติ | Cloudflare OS | ในโค้ด |
|---|---|---|
| kernel | ตัวจัดการ workspace/สิทธิ์ | `packages/workshop-backend` |
| device drivers | ตัวต่อกับบริการภายนอก | `packages/gatekeeper-*` |
| shell | UI | `packages/workshop-frontend` |
| processes | **Gadget** (แอปส่วนตัว) | รันใน Dynamic Worker |
| executables | **Blueprint** (เทมเพลตแอป) | |
| ACLs | shared permissions | `sharing.ts` |
| — | **Agent** | `agent.ts` |

สามคำที่ต้องเข้าใจก่อน ไม่งั้นอ่านโค้ดไม่รู้เรื่อง:

- **Gadget** — แทนที่จะเรียก SaaS กลาง ทุกคนได้ *สำเนาแอปของตัวเอง* รันในแซนด์บ็อกซ์แยก
  ทำสไลด์ = ระบบสร้าง instance ของโปรแกรมสไลด์ให้คุณคนเดียว
- **Gatekeeper** — เหมือน MCP server ที่อัปเกรดแล้ว จุดขายคือ **human-in-the-loop แบบ async**
  (บทที่ 4 พิสูจน์ให้ดู)
- **Capability-based security** — agent/gadget เริ่มด้วยสิทธิ์ **ศูนย์** ต้อง "แนะนำ" ทรัพยากรให้ทีละอย่าง

---

## บทที่ 0: ทำให้มันรันให้ได้

### สิ่งที่ต้องมี

- **Node.js 22+** (ทดสอบกับ v22.22.2)
- **pnpm** — repo pin ไว้ที่ 11.17.0 ผ่าน field `packageManager` ใน `package.json`
- พื้นที่ว่างประมาณ 2 GB

```bash
git clone https://github.com/cloudflare/cloudflare-os.git
git clone https://github.com/monthop-gmail/learning-th-cloudflare-os.git
./learning-th-cloudflare-os/install.sh ./cloudflare-os   # วางไฟล์ประกอบการเรียน

cd cloudflare-os
corepack enable pnpm      # ได้ pnpm เวอร์ชันที่ repo pin ไว้พอดี
pnpm install              # ~25 วินาที, 677 packages
pnpm run-local            # ครั้งแรก ~2 นาที (build frontend)
```

เปิด <http://localhost:8787>

> **ถ้ารันบนเซิร์ฟเวอร์** ให้เปิด tunnel จากเครื่องตัวเอง:
> `ssh -L 8787:localhost:8787 <user>@<server>`

### สิ่งที่เกิดขึ้นเบื้องหลัง (น่าสนใจในตัวมันเอง)

`scripts/run-local.mjs` ทำ 3 อย่าง:

1. build `typed-storage` — **แพ็กเกจเดียวใน repo ที่ emit จริง** ที่เหลือเป็น `noEmit` หมด
   เพราะ wrangler กับ vite bundle จาก source ตรง ๆ ไม่มีใคร import `dist` ของกันและกัน
2. build frontend (chunk ใหญ่สุดคือหน้า workspace ~2.9 MB)
3. `wrangler dev` → รัน **workerd** ซึ่งคือ Workers runtime ตัวจริง ไม่ใช่ emulator

มันแฮชไฟล์ทั้งหมดเก็บไว้ใน `.run-local-stamp` ถ้าไม่มีอะไรเปลี่ยนจะข้าม build ไปเลย

**ข้อมูลเก็บใน `.wrangler/`** — ลบทิ้งได้ = reset ทุกอย่างกลับเป็นศูนย์

### 🎓 จุดที่ควรจำ

สิ่งที่รันอยู่บนเครื่องคุณ **คือ Workers runtime ตัวจริง** ที่ open source
([workerd](https://github.com/cloudflare/workerd)) นี่คือเหตุผลที่ README บอกว่า deploy บน
เซิร์ฟเวอร์ตัวเองได้ ไม่ต้องผูกกับ Cloudflare

### ✅ ตรวจว่าผ่าน

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8787/    # ควรได้ 200
```

---

## บทที่ 1: คุยกับระบบโดยไม่ผ่านเบราว์เซอร์

### ทำไมต้องทำแบบนี้

frontend เป็น SPA ล้วน คุยกับ backend ผ่าน **Cap'n Web RPC บน WebSocket เส้นเดียว
ไม่มี REST endpoint สักเส้น** ถ้าคุยกับ RPC เป็น แปลว่าคุณทำอะไรก็ได้ที่ UI ทำได้ — และเห็นชัดกว่าด้วย

`packages/integration-tests/src/rpc-client.ts` มีท่าพร้อมใช้อยู่แล้ว

```bash
node packages/integration-tests/learn-01-explore-api.mjs
```

### ผลลัพธ์ที่ควรได้

```
── getServerConfig() ───────────────────────
{ "passwordAuthEnabled": true, "signupsEnabled": true, ... }

── whoami() ────────────────────────────────
{ "type": "user", "name": "Study Bot", "id": "mentormsvh5bia" }

── listModels()  ← ว่าง = ยังไม่ได้ใส่ API key
[]

── listFeaturedBlueprints() ────────────────
[ format.document, format.slides, format.spreadsheet ]

── listGatekeeperVendors() ─────────────────
12 ตัว: confluence, email, github, google, homeassistant, linear,
        mcp, notion, slack, spotify, supabase, zoominfo
```

### 🎓 3 อย่างที่เรียนรู้

**1. `newGadget()` คืน stub ไม่ใช่ id**

```js
const overseer = await auth.newGadget();       // ได้ Overseer stub มาเลย
await overseer.getMetadata();                   // เรียกต่อได้ทันที
```

นี่คือ *promise pipelining* ของ Cap'n Web — เรียกเมธอดต่อบน stub ได้โดยไม่ต้องรอ round trip
เป็นเหตุผลที่ทั้งแอปใช้ WebSocket เส้นเดียวได้อย่างมีประสิทธิภาพ

**2. มี type validation ข้ามเครือข่ายจริง**

เรียกผิดชนิดจะเจอ:

```
capnweb-validate: at AuthenticatedApiImpl.openGadget[0]: expected string, got function
```

ไม่ใช่แค่ตอน compile — capnweb มี `@validateRpc` transform ที่ generate ตัวตรวจ runtime
จาก TypeScript types

**3. Workspace ใหม่เป็น "provisional"**

doc comment ใน `api.ts` บอกว่ามันจะไม่โผล่หน้าแรกและ **ถูกลบทิ้งอัตโนมัติ** จนกว่าจะมีกิจกรรมจริง
(แชท/แก้โค้ด) — กันขยะจากคนกดสร้างแล้วไม่ทำอะไร

### ⚠️ กับดัก

สคริปต์สมัครสมาชิกด้วย **sha256 แทน argon2id** (ลอกจาก `rpc-client.ts` ซึ่งข้าม argon2id
เพราะกิน 64 MiB ต่อครั้ง) ผลคือ **บัญชีที่สร้างจากสคริปต์ล็อกอินผ่านหน้าเว็บไม่ได้**
ถ้าอยากดูผลงานในเบราว์เซอร์ ให้ใช้ share link (บทที่ 3)

### 📝 แบบฝึกหัด

ลองเรียก `auth.listOutputFormats()` แล้วเทียบกับ `listFeaturedBlueprints()` —
ทำไมข้อมูลถึงซ้ำกันบางส่วน? มันตอบคำถามคนละข้อยังไง?

---

## บทที่ 2: Blueprint คือซอร์สโค้ดจริง

```bash
node packages/integration-tests/learn-02-blueprint-code.mjs
```

### ผลลัพธ์ที่ควรได้

```
workpiece "Workspace Docs"  (filesRoot="")
   10,649 ตัวอักษร  server.js
    5,879 ตัวอักษร  README.md
   70,113 ตัวอักษร  client.js
```

นี่คือแอป Docs ตัวจริงที่พนักงาน Cloudflare ใช้ และมันมาอยู่ในมือคุณแบบแก้ได้ทั้งดุ้น

### 🎓 โค้ดไม่ใช่ไฟล์ — มันเป็น CRDT

```
subscribeToCode(sub) → update({ version, timestamp, update: Uint8Array })
                         ↓ Y.applyUpdateV2(doc, update)
doc.getMap(filesRoot) → Map<ชื่อไฟล์, Y.Text>
```

โค้ด **ทั้ง workspace** คือ Yjs doc ก้อนเดียว แต่ละ workpiece มี root `Y.Map` ของตัวเอง
ชื่อตาม `WorkpieceSummary.filesRoot`

**ทำไมถึงสำคัญ:** เพราะเป็น CRDT → คุณกับ agent **แก้โค้ดไฟล์เดียวกันพร้อมกันได้**
ไม่ต้อง lock ไม่ต้อง merge conflict และ replay ประวัติย้อนหลังได้

### ⚠️ กับดัก 2 ข้อ

**1. subscriber ต้องใช้ชื่อเมธอดให้ตรงเป๊ะ** — `WorkpiecesSubscriber` ใช้ `entry()` / `removed()`
ไม่ใช่ `add()` / `remove()` ถ้าใส่ผิดจะ **ไม่ error แต่ได้ list ว่าง** เป็นบั๊กที่หายากที่สุดในบทนี้
ให้เปิด `packages/workshop-shared/src/api.ts` อ่าน interface ก่อนเสมอ

**2. ต้อง apply update แบบ synchronous** — doc comment เตือนไว้ว่า server อาจยิง `update()`
รัว ๆ โดยไม่รอ ถ้าไปทำ async ระหว่างนั้นลำดับจะเพี้ยน

**3. yjs ไม่ใช่ dependency ของ `integration-tests`** — pnpm แยก `node_modules` เข้มมาก
สคริปต์เลยต้อง import จาก store ตรง ๆ:

```js
import * as Y from "../../node_modules/.pnpm/yjs@13.6.31/node_modules/yjs/dist/yjs.mjs";
```

ถ้าเวอร์ชัน yjs เปลี่ยน path นี้จะพัง — แก้เลขเวอร์ชันตาม `pnpm why yjs`

### 📝 แบบฝึกหัด

เปิด `README.md` ที่อยู่ใน blueprint (ไม่ใช่ของ repo) — มันเขียนไว้ให้ **agent อ่าน**
ลองดูว่าเขาเขียนคู่มือให้ AI ยังไง ต่างจากคู่มือมนุษย์ตรงไหน

---

## บทที่ 3: เรียก API ของ Gadget แบบที่ agent ทำ

```bash
node packages/integration-tests/learn-03-gadget-api.mjs
```

### ผลลัพธ์ที่ควรได้

```
เมธอดที่ server.js เปิดให้เรียก:
  getDocument, initializeBlocks, setDocument, applyOperation,
  subscribe, updatePresence, getGoogleDocInfo, syncToGoogleDoc, ...

ก่อนแก้: { "revision": 0, "title": "Untitled document", ... }
→ setDocument() เรียบร้อย
revision : 0 → 1
อ่านซ้ำ  : "บันทึกการเรียน Cloudflare OS" | revision 1

🔗 http://localhost:8787/workspace/<id>#share=<key>
```

เปิดลิงก์สุดท้ายในเบราว์เซอร์ได้เลย — จะเห็นเอกสารที่สคริปต์เขียนเข้าไป

### 🎓 นี่คือคำตอบของคำถามสำคัญที่สุดใน repo นี้

> *"ทำไม agent ถึงร่วมงานในแอปได้ทันที ทั้งที่ไม่มีใครสอนมันว่าแอปนี้มี API อะไร?"*

```js
const gadget = await overseer.getGadget(0);
const app    = await gadget.connectToGadget();   // RPC เข้า Durable Object ของแอป
await app.setDocument({ title: "...", blocks: [...] });
```

เพราะ Cap'n Web **บังคับ** ให้ client/server ของทุก Gadget คุยกันผ่าน RPC อยู่แล้ว
พอบังคับแบบนั้น API ที่ agent เรียกได้ก็ **โผล่มาเองโดยปริยาย** ไม่มีใครต้องเขียน MCP server เพิ่ม

doc comment ของ `connectToGadget()` พูดตรง ๆ ว่า:
*"It can also permit the coding agent to make direct calls."*

และในโค้ดของ Docs blueprint เองก็มีเมธอดที่เขียนไว้ให้ agent โดยเฉพาะ:

```js
// Explicit full-document writer for agents/importers. Unlike initializeBlocks,
// this always applies, so callers never need to inspect revision state...
setDocument(args) { ... }
```

### ⚠️ กับดัก

URL ของ share link ต้องเป็น `#share=<key>` ไม่ใช่ `#<key>` เฉย ๆ
(ดูของจริงที่ `packages/workshop-frontend/src/ShareModal.tsx`)

### 📝 แบบฝึกหัด

`listShareLinks()` คืน `linkId` แต่ **ไม่คืน key** ลองอ่าน doc comment ของ `newShareLinkKey()`
ว่าทำไมถึงออกแบบแบบนั้น แล้วมันบอกอะไรเกี่ยวกับวิธีเก็บ secret ของระบบ

---

## บทที่ 4: เขียน Gatekeeper เองเพื่อเข้าใจ approval queue

บทนี้ยาวที่สุดและคุ้มที่สุด เพราะเป็น**แก่นจริง ๆ** ของ repo

### ปัญหาที่ Gatekeeper แก้

README อ้างไว้แบบนี้:

> ปกติ human-in-the-loop ต้องอนุมัติแบบ **synchronous** — agent ต้องหยุดรอ น่ารำคาญจนคนยอม
> เปิด auto-approve ซึ่งอันตราย
>
> Gatekeeper ทำอีกแบบ: **จำลองผลลัพธ์** ให้ agent ทำงานต่อได้ทันที แล้วผู้ใช้ค่อยมาอนุมัติทีหลัง
> เป็นชุด

**เราจะพิสูจน์ว่าจริงไหม ด้วยการเขียน Gatekeeper ขึ้นมาเองแล้วเทสต์**

### ทำไมต้องเขียนเอง

- gatekeeper จริงทั้ง 12 ตัว **ต้องมี OAuth** ทดสอบไม่ได้ถ้าไม่มีบัญชีจริง
- fixture ที่ repo ให้มา (`fixtures/gatekeeper-test/`) **จงใจไม่ยิง action เลย** —
  `applyAction()` ของมัน `throw` ทิ้ง เพราะออกแบบมาทดสอบ *observer verification* คนละเรื่อง

เราจึงเติมอีกครึ่งที่ขาด: `fixtures/gatekeeper-notes/`

### รันเลย

```bash
pnpm --filter @gadgets/integration-tests exec vitest run __tests__/notes-approval.test.ts
```

ควรได้ `Tests 2 passed (2)` ใน ~25 วินาที

### โครงของ Gatekeeper

```
GatekeeperVendor   (Worker entrypoint)  ← "ยี่ห้อนี้คืออะไร" + สร้าง account
      └─ Account   (Worker entrypoint)  ← ตัวตนผู้ใช้ + แปลง URL → Gatekeeper class
            └─ Gatekeeper (Durable Object, รันเป็น facet ใต้ Overseer ของ workspace)
                  ├─ startSession(approvalQueue) → Session ที่ agent เรียกได้
                  ├─ addObserver / removeObserver     ← ใครมีสิทธิ์เห็น
                  └─ applyAction / rejectAction / revertAction
```

**จุดที่ฉลาด:** Gatekeeper รันเป็น *facet* ใต้ Durable Object ของ workspace นั้น ๆ
ไม่ใช่ service กลาง แปลว่า state ของการเชื่อมต่อ (pending actions, observers) อยู่ติดกับ
workspace ที่ใช้มัน

### กลไกการจำลอง

ลอกกลยุทธ์มาจากคอมเมนต์ใน `packages/gatekeeper-confluence/src/confluence-actions.ts`:

> *"cache the **base** truth ... and overlay pending (submitted-but-unapplied) actions at read time"*

```
        อ่าน                          เขียน
         │                              │
    ┌────▼────────────────┐      submitAction() → คืนค่าทันที
    │  committed (จริง)   │             │
    │      +              │◄── overlay ─┘  (เก็บใน gatekeeper DO)
    │  pending (จำลอง)    │
    └─────────────────────┘
              │
     approveAction() → applyAction() → commit ลงของจริง
     rejectAction()  → ทิ้ง pending  → overlay คำนวณใหม่
```

### 🎓 อ่าน กับ เขียน เดินคนละทาง

| | เมธอด | พฤติกรรม |
|---|---|---|
| อ่าน | `authorizeObservation()` | **synchronous** — ต้องรอผลก่อนคืนข้อมูล ไม่ผ่านก็ throw |
| เขียน | `submitAction()` | **asynchronous** — คืนทันที รออนุมัติเป็นวันก็ได้ |

doc comment ของ `authorizeObservation()` มีรายละเอียดที่คนมักพลาด:
ให้เรียก **หลัง** ดึงข้อมูลมาแล้วได้ ตราบใดที่ยังไม่ส่งคืนให้ผู้เรียก — เพื่อให้ description
บอกได้ว่าอ่านอะไรไปจริง ๆ

### 🎓 การจำลองไม่ได้ฟรี — gatekeeper ต้องทำเอง

README ทำให้รู้สึกว่าระบบจัดการให้ แต่จริง ๆ เป็นความรับผิดชอบของคนเขียน gatekeeper แต่ละตัว
มีธง `awaitDecision` ไว้ให้ยอมแพ้ และคอมเมนต์อธิบายเหตุผลแบบมาจากประสบการณ์จริง:

> *"Set this for actions whose effects the gatekeeper does NOT simulate. Because a not-yet-approved
> action isn't reflected by later reads, an agent that keeps going would observe a world where its
> action 'didn't happen' — and tends to **get confused: re-trying, second-guessing, or undoing its
> own work**."*

### 🎓 Auto-approve มีสองชั้น

```js
getAutoApprovableActions() → [{ tag: "notes.add", ... }]  // ผู้ใช้เปิดสวิตช์ได้
{ autoApprovable: true }                                   // และต้องอนุญาตต่อ action อีกที
```

ในโค้ดมี TODO ยอมรับเองว่ายังไม่ดีพอ:

> *"A single opaque boolean isn't the ideal long-term shape. Eventually the gatekeeper should
> describe the **nature** of the action — destructive vs. additive, reversible vs. not..."*

### ⚠️ กับดักที่เจอจริง (สำคัญมาก)

**1. fixture ตัวที่สองห้ามมี `src/env.d.ts`**

`packages/integration-tests/tsconfig.json` ใช้ `"include": ["src", "__tests__", "fixtures"]`
ยัดทุก fixture เข้า TS program เดียวกัน และ `Cloudflare.GlobalProps` เป็น **global interface**
ประกาศ `mainModule` ซ้ำไม่ได้ — ตัวหลังจะทับตัวแรกจน **fixture เดิม type check พัง**

นี่อธิบายว่าทำไม repo ถึงมี fixture gatekeeper แค่ตัวเดียว มันเป็นข้อจำกัดเชิงโครงสร้าง
ไม่ใช่ความขี้เกียจ

วิธีแก้ที่เราใช้: ประกาศชนิดของ `ctx.exports` ไว้ในไฟล์ตัวเองแล้ว cast — ผลเสียจำกัดอยู่ใน fixture นั้น

**2. repo มี custom lint rule ของตัวเอง**

`gadgets/prefer-jsdoc` (นิยามใน `scripts/oxlint-plugin.mjs` และมี unit test ของ rule เองที่
`scripts/oxlint-plugin.test.js`) บังคับให้ **ทุก exported declaration มี JSDoc**
คอมเมนต์ `//` ธรรมดาไม่ผ่าน

**3. `newGatekeeper()` คืน `GatekeeperClient<any>`**

Workshop ไม่รู้จัก vendor ตอน compile เพราะ session แต่ละเจ้ามีเมธอดไม่เหมือนกัน
ฝั่งผู้เรียกจึงต้องบอกชนิดเอง (ตัวแอปจริงไม่เจอปัญหานี้ เพราะ agent อ่าน `getTypeScriptTypes()`
ตอน runtime แทน)

**4. ปิด harness ด้วย `server.close()`** ไม่ใช่ `dispose()`

### ✅ ตรวจว่าไม่พังของเดิม

```bash
pnpm --filter @gadgets/integration-tests exec tsc --noEmit   # ต้องไม่มี error
pnpm --filter @gadgets/integration-tests test:run            # 20/20 ผ่าน
pnpm lint:check                                              # ไม่มี error (warning เดิมมี ~64 อัน)
```

### 📝 แบบฝึกหัด

1. ลองตั้ง `awaitDecision: true` ใน `notes-gatekeeper.ts` แล้วดูว่าเทสต์เปลี่ยนไหม —
   ทำไมถึงเป็นแบบนั้น? (คำใบ้: doc บอกว่ามันเป็น *advisory hint* ไม่ใช่ enforcement)
2. เพิ่มเมธอด `remove(index)` ที่ลบโน้ต แล้วทำให้ `revertAction()` ทำงานถูกต้อง
3. ลองทำให้ `addObserver()` ปฏิเสธบางคน แล้วดูว่า overseer รายงานยังไง
   (เทียบกับ `fixtures/gatekeeper-test/` ที่ทำเรื่องนี้ไว้แล้ว)

---

## บทที่ 5: ไปต่อทางไหน

ตอนนี้คุณรู้จัก workpiece / binding / action / observer / blueprint หมดแล้ว พร้อมอ่านของจริง

| ลำดับ | เป้าหมาย | ไฟล์ |
|---|---|---|
| 1 | Information-flow control — ถ้า gadget อ่านข้อมูลลับมาแล้วคุณแชร์ให้เพื่อน เพื่อนควรเห็นไหม | `docs/observers.md` (555 บรรทัด เอกสารยาวสุดใน repo) |
| 2 | สัญญากลางของทั้งระบบ | `packages/workshop-shared/src/api.ts` (3,535 บรรทัด) |
| 3 | **เคอร์เนล** | `packages/workshop-backend/src/overseer.ts` (9,745 บรรทัด) |
| 4 | agent loop / Code Mode / compaction | `packages/workshop-backend/src/agent.ts` (3,310 บรรทัด) |
| 5 | Blueprint / sharing | `docs/blueprints.md`, `docs/sharing.md` |

**อย่าข้าม `AGENTS.md`** — ยาวเป็นพันบรรทัด อธิบายเหตุผลเชิงสถาปัตยกรรมและ trade-off
ละเอียดกว่า `README.md` มาก รวมถึงเรื่อง build cache, tsgo single-threaded, release pipeline

### ถ้าอยากลอง agent จริง

ต้องใส่ API key ใน UI (หน้า providers) รองรับ **Anthropic / OpenAI / Google / Workers AI / Ollama**
ตรวจว่าพร้อมหรือยังด้วย:

```js
await auth.getAiConfig();   // { enabled: false } = AI Gateway ปิด, ต้องใส่ key เอง
await auth.listModels();    // [] = ยังไม่มีโมเดล
```

---

## ภาคผนวก: ไฟล์ใน repo นี้

```
README.md            ← เอกสารที่คุณกำลังอ่าน
NOTICE.md            ← ลิขสิทธิ์และการอ้างอิง
LICENSE              ← Apache-2.0
install.sh           ← วาง/ถอน overlay ลงใน clone ของ cloudflare-os
overlay/packages/integration-tests/
  learn-01-explore-api.mjs                   ← บทที่ 1
  learn-02-blueprint-code.mjs                ← บทที่ 2
  learn-03-gadget-api.mjs                    ← บทที่ 3
  fixtures/gatekeeper-notes/wrangler.jsonc   ← บทที่ 4
  fixtures/gatekeeper-notes/src/notes-gatekeeper.ts
  __tests__/notes-approval.test.ts           ← บทที่ 4
```

ทุกไฟล์เขียนคอมเมนต์ภาษาไทยไว้ อ่านเป็นบทเรียนต่อได้เลย

> ⚠️ ไฟล์ชุดนี้ **ไม่ได้อยู่ใน upstream** และไม่ควรพยายามส่ง PR กลับไป —
> `cloudflare/cloudflare-os` ประกาศชัดว่า **ไม่รับ contribution จากภายนอก**
> (รับแค่ PR แก้บั๊กเล็ก ๆ ไม่เกิน ~12 บรรทัด)
>
> ถ้า upstream อัปเดตแล้วสคริปต์พัง ให้ดูหัวข้อ "กับดัก" ของแต่ละบทก่อน —
> จุดที่เปราะที่สุดคือ path ของ yjs ในบทที่ 2 และชื่อเมธอดใน RPC interface

## เจอปัญหา / อยากเพิ่มบท

เปิด issue หรือ PR ใน repo นี้ได้เลย (ที่นี่รับ ไม่เหมือน upstream 🙂)

ทดสอบครั้งล่าสุดกับ: Node v22.22.2 · pnpm 11.17.0 · cloudflare-os `main` (ส.ค. 2026)

---

## สรุปสั้นที่สุด

ถ้าจำได้แค่ 5 ข้อ ให้จำ 5 ข้อนี้:

1. **ทุกอย่างคุยผ่าน Cap'n Web RPC บน WebSocket เส้นเดียว** ไม่มี REST — และ pipelining
   ทำให้เรียกต่อได้โดยไม่รอ round trip
2. **โค้ดของ workspace เป็น Yjs CRDT ก้อนเดียว** ไม่ใช่ไฟล์ → คนกับ agent แก้พร้อมกันได้
3. **API ของ Gadget โผล่มาเองโดยปริยาย** เพราะระบบบังคับให้ client/server คุยผ่าน RPC
   → agent ใช้ได้ทันทีโดยไม่ต้องเขียน MCP server
4. **Gatekeeper จำลองผลลัพธ์ของ action ที่ยังไม่อนุมัติ** เพื่อไม่ให้ agent ต้องหยุดรอมนุษย์ —
   แต่เป็นความรับผิดชอบของ gatekeeper แต่ละตัว ไม่ได้ฟรี
5. **เริ่มด้วยสิทธิ์ศูนย์เสมอ** ทั้ง agent และ gadget ต้องถูก "แนะนำ" ให้รู้จักทรัพยากรทีละอย่าง
