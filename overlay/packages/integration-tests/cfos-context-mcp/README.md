# cfos-context-mcp

ต้นแบบ MCP server ที่เปิด **Context Library** ของ Cloudflare OS ให้ coding agent ภายนอก
(Claude Code, Cursor, ฯลฯ) อ่านได้ — เพื่อให้ทุก agent ในทีมอ่านบริบทเดียวกัน แก้ที่เดียว

```
coding agent ──MCP(stdio)──► cfos-context-mcp ──Cap'n Web──► Cloudflare OS
                                                                  │
                                                          Context Library
```

**ฝั่งอ่าน** — Context Library:

| tool | ทำอะไร |
|---|---|
| `list_context` | ดูว่ามี collection/เอกสารอะไรบ้าง |
| `search_context` | ค้นข้อความเต็ม (ภาษาไทยก็ค้นได้) |
| `read_context_document` | อ่านเอกสารเต็ม ๆ ด้วย `docId` |

**ฝั่งเขียน** — สั่งงาน agent ข้างใน (ต้องตั้ง `CFOS_AI_KEY_FILE`):

| tool | ทำอะไร |
|---|---|
| `list_cfos_workspaces` | ดู workspace ที่บัญชีนี้ถูกเชิญเข้า |
| `ask_cfos_agent` | สั่ง agent สร้าง/แก้แอป **ใน workspace ที่ระบุเท่านั้น** |
| `check_cfos_chat` | ตามผล + ดูว่ามี action รอมนุษย์อนุมัติไหม |

> 🔒 **`ask_cfos_agent` ไม่สร้าง workspace ใหม่เด็ดขาด** — ต้องมีคนเชิญบัญชีนี้เข้าไปก่อน
> เพราะ workspace ที่คนไม่ได้เป็น collaborator จะซ่อน action ที่รออนุมัติจากสายตาคน
> (เหตุผลเต็มอยู่ในบทที่ 15 ของคู่มือ)

---

## ติดตั้ง

### 1. สร้าง secret ของบัญชีบริการ

```bash
umask 077
head -c 32 /dev/urandom | base64 > ~/.cfos-mcp.secret
chmod 600 ~/.cfos-mcp.secret
```

### 2. ใส่บริบทของทีมเข้าไป

เปิด Cloudflare OS แล้วไปหน้า **Context & Skills** (`/gatekeepers/context`) สร้าง collection
แล้วเพิ่มเอกสาร

> 🔑 **ให้ใช้ collection แบบ `public`** ถ้าอยากให้เป็น single source ของทีม
> `private` จะเห็นเฉพาะเจ้าของบัญชี ส่วน `public` ทุกคนใน deployment อ่านได้
> — และ **สร้าง public ได้เฉพาะ deployment admin** (ดู `ADMINS`)

อยากลองเร็ว ๆ มีสคริปต์ตัวอย่างให้:

```bash
node seed-demo.mjs      # สร้าง public collection พร้อมเอกสาร 2 ชิ้น ผ่านบัญชี admin
```

### 3. ต่อเข้ากับ Claude Code

```bash
claude mcp add cfos-context \
  --env CFOS_SECRET_FILE=$HOME/.cfos-mcp.secret \
  --env CFOS_URL=ws://localhost:8787/api \
  -- node /path/to/packages/integration-tests/cfos-context-mcp/server.mjs
```

หรือ MCP client อื่นที่รองรับ stdio ก็ตั้งค่าแบบเดียวกัน (command + args + env)

---

## ตั้งค่าได้

| env | ค่าเริ่มต้น | หมายเหตุ |
|---|---|---|
| `CFOS_URL` | `ws://localhost:8787/api` | ใช้ `wss://` สำหรับ deployment จริง |
| `CFOS_USER` | `mcpcontextreader` | ⚠️ **ตัวอักษร+ตัวเลขเท่านั้น ขึ้นต้นด้วยตัวอักษร** — มีขีดกลางไม่ได้ |
| `CFOS_SECRET_FILE` | — | **บังคับ** ไฟล์ที่เก็บ secret ของบัญชีบริการ |
| `CFOS_AI_KEY_FILE` | — | ใส่เมื่อจะใช้ `ask_cfos_agent` — ค่าใช้จ่ายลงบัญชีนี้ |
| `CFOS_AI_MODEL` | `gemini-3.6-flash` | |
| `CFOS_AI_PROVIDER` | `google` | |

รันครั้งแรกจะสร้างบัญชีให้เอง ครั้งถัดไปจะ login ด้วย secret เดิม

---

## ทดสอบโดยไม่ต้องมี MCP client

```bash
{
  echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}'
  echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_context","arguments":{}}}'
  sleep 10
} | CFOS_SECRET_FILE=~/.cfos-mcp.secret node server.mjs
```

---

## ⚠️ ข้อจำกัดของต้นแบบนี้ (อ่านก่อนเอาไปใช้จริง)

**1. ไม่มี API token ในระบบ — ต้องใช้บัญชีบริการ + รหัสผ่าน**
Cloudflare OS ไม่มี PAT/service account มาให้ (auth มีแค่ password / OAuth / Cloudflare Access)
ต้นแบบนี้จึงสร้างบัญชีธรรมดาขึ้นมาหนึ่งใบ ผลคือ **ไม่มี scope ไม่มี revoke รายตัว**
ใครได้ไฟล์ secret ไปคือได้สิทธิ์บัญชีนั้นทั้งใบ

**2. สร้าง workspace ทิ้งไว้ทุกครั้งที่สตาร์ต**
read session ต้องเปิดจาก workspace หนึ่งอัน ต้นแบบจึงเรียก `newGadget()` ตอนเชื่อมต่อ
workspace พวกนี้เป็น *provisional* (ไม่มีกิจกรรม) และถูกลบอัตโนมัติ แต่ก็ยังเป็นขยะระหว่างทาง
ของจริงควรใช้ workspace เดิมซ้ำ

**3. ครั้งแรกหลัง Cloudflare OS รีสตาร์ตช้ามาก**
Durable Object ของผู้ใช้ต้อง cold start — วัดได้จริงว่า `login()` ใช้เวลา **~32 วินาที**
ส่วนขั้นตอนที่เหลือรวมกันไม่ถึง 2 วินาที server ตัวนี้จึงอุ่นเครื่องตั้งแต่สตาร์ต
(เรียก `session()` แบบไม่รอผล) เพื่อให้ tool call แรกไม่ค้าง — หลังแก้แล้วเหลือ ~3 วินาที
ถ้ายังเจออาการค้าง ให้เช็คว่า Cloudflare OS เพิ่งรีสตาร์ตหรือเปล่า

**4. ไม่มี cache**
ทุก tool call วิ่งไปที่ Cloudflare OS จริง ถ้าเซิร์ฟเวอร์ล่ม agent ทั้งทีมเสียบริบท
ควรใส่ cache ระยะสั้นฝั่งนี้ก่อนใช้งานจริง

**5. อ่านได้เฉพาะสิ่งที่บัญชีบริการเห็น**
= public collection ทั้งหมด + private ของบัญชีนั้นเอง (ซึ่งไม่ควรมี)
ถ้าอยากให้ agent เห็นบริบทของ *ผู้ใช้แต่ละคน* ต้องออกแบบใหม่ทั้งหมด

**6. `list_cfos_workspaces` ว่าง ไม่ได้แปลว่าไม่มีสิทธิ์**
`docs/sharing.md`: *"A shared gadget does not appear on a collaborator's home page until they
first open it."* — workspace ที่เพิ่งถูกแชร์มาจะยังไม่โผล่ ต้องให้คนส่ง `workspaceId` มา
แล้วเรียก `ask_cfos_agent` / `check_cfos_chat` ด้วย id นั้นสักครั้งก่อน จากนั้นจึงขึ้นในรายการ

**7. การอ่านถูกบันทึกเป็น observation**
ทุก `search`/`read` ผ่าน `authorizeObservation()` และถูกจดลง log — เป็นเรื่องดี
แต่แปลว่า **log จะโตตามการใช้งานของ agent** ไม่ใช่ของคน

---

## ทำไมถึงเลือกทิศทางนี้

Cloudflare OS มีทางเข้าจากภายนอกอีกทาง (`ExternalMessageGateway` — ยิง prompt เข้าไปให้ agent
ข้างในทำงาน) แต่ทางนั้น **เอกสารของมันบอกเองว่า** *"the backend trusts the gateway: supplying
this email grants access as that account"* คือ gateway กลายเป็นขอบเขตความปลอดภัย

ทิศ "อ่านบริบทอย่างเดียว" ปลอดภัยกว่ามากและพิสูจน์คุณค่าของ single source ได้เร็วกว่า
จึงเหมาะกับการเริ่มต้น
