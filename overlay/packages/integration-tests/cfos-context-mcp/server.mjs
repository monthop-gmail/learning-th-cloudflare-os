#!/usr/bin/env node
// cfos-context-mcp — ต้นแบบ MCP server ที่เปิด Context Library ของ Cloudflare OS
// ให้ coding agent ภายนอก (Claude Code, Cursor, ฯลฯ) อ่านได้
//
// ทิศทาง: coding agent ──MCP──► ตัวนี้ ──Cap'n Web──► Cloudflare OS ──► Context Library
//
// อ่านอย่างเดียวโดยตั้งใจ: เปิดเฉพาะ list / search / read ไม่มีเมธอดเขียนสักตัว
//
// ตั้งค่าผ่าน env:
//   CFOS_URL            ws://localhost:8787/api  (ค่าเริ่มต้น)
//   CFOS_USER           ชื่อบัญชีบริการ (ตัวอักษร+ตัวเลขเท่านั้น ขึ้นต้นด้วยตัวอักษร)
//                       ค่าเริ่มต้น: mcpcontextreader
//   CFOS_SECRET_FILE    ไฟล์ที่เก็บ secret ของบัญชีนี้ (บังคับ)
//   CFOS_AI_KEY_FILE    ไฟล์ที่เก็บ API key ของโมเดล (ใส่เมื่อจะใช้ ask_cfos_agent)
//   CFOS_AI_MODEL       ชื่อโมเดล (ค่าเริ่มต้น: gemini-3.6-flash)
//   CFOS_AI_PROVIDER    ผู้ให้บริการ (ค่าเริ่มต้น: google)
//
// ดู README.md ข้าง ๆ สำหรับวิธีต่อเข้า Claude Code

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { newWebSocketRpcSession } from "capnweb";

const URL_ = process.env.CFOS_URL ?? "ws://localhost:8787/api";
const USER = process.env.CFOS_USER ?? "mcpcontextreader";
const SECRET_FILE = process.env.CFOS_SECRET_FILE;
const AI_KEY_FILE = process.env.CFOS_AI_KEY_FILE;
const AI_MODEL    = process.env.CFOS_AI_MODEL ?? "gemini-3.6-flash";
const AI_PROVIDER = process.env.CFOS_AI_PROVIDER ?? "google";

if (!SECRET_FILE) {
  process.stderr.write("cfos-context-mcp: ต้องตั้ง CFOS_SECRET_FILE\n");
  process.exit(1);
}

// Workshop บังคับให้ชื่อบัญชีเป็น alphanumeric และขึ้นต้นด้วยตัวอักษร — ขีดกลางใช้ไม่ได้
if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(USER)) {
  process.stderr.write(`cfos-context-mcp: CFOS_USER "${USER}" ใช้ไม่ได้ ` +
    "— ต้องเป็นตัวอักษร+ตัวเลขเท่านั้น และขึ้นต้นด้วยตัวอักษร\n");
  process.exit(1);
}

// Workshop เก็บและเทียบไบต์ที่ส่งมาตรง ๆ ไม่ได้ derive ซ้ำ (ดู rpc-client.ts ของ repo)
// จึงใช้ hash อะไรก็ได้ ขอแค่คงที่ — แต่ต้องไม่ใช้ซ้ำกับบัญชีของคน
function passwordHash() {
  const secret = readFileSync(SECRET_FILE, "utf8").trim();
  return new Uint8Array(createHash("sha256").update(`cfos-mcp:${USER}:${secret}`).digest());
}

// ── ต่อกับ Cloudflare OS ──────────────────────────────────────────────────
// เก็บ session ไว้ใช้ซ้ำ ถ้าหลุดค่อยต่อใหม่ตอนเรียกครั้งถัดไป
let cached = null;

async function connect() {
  const api = newWebSocketRpcSession(URL_);
  const hash = passwordHash();

  // ล็อกอินก่อน ถ้ายังไม่มีบัญชีค่อยสร้าง — ทำให้รันซ้ำได้โดยเห็นข้อมูลเดิม
  let token = await api.login(USER, hash);
  if (!token) {
    token = await api.createAccount(USER, "MCP Context Reader", hash);
    if (!token) throw new Error(`สร้างบัญชี "${USER}" ไม่ได้ (ชื่ออาจถูกใช้ไปแล้ว)`);
  }
  const auth = await api.authenticate(token);

  // Context Library เป็นแบบ auto-provision — ขอครั้งแรกครั้งเดียว
  try { await auth.provisionAmbientAccount("context"); } catch { /* มีอยู่แล้ว */ }

  // read session ต้องเปิดจาก workspace หนึ่งอัน
  const overseer = await auth.newGadget();
  const reqs = await overseer.listObserverRequirements("build");
  const ctx = reqs.find(r => r.vendorId === "context");
  if (!ctx) throw new Error("deployment นี้ไม่ได้ผูก gatekeeper-context ไว้");
  const gk = await overseer.getGatekeeperById(ctx.gatekeeperId);
  const session = await gk.openSession();

  // ตั้งโมเดลให้บัญชีนี้ ถ้าผู้ดูแลใส่ key มา — จำเป็นเฉพาะตอนใช้ ask_cfos_agent
  // ค่าใช้จ่ายจะลงบัญชีนี้ ไม่ปนกับของคน (ดูบทที่ 15)
  if (AI_KEY_FILE) {
    try {
      const have = await auth.listModels();
      if (!have.some(m => m.id === AI_MODEL)) {
        await auth.addModel(
          { type: "agent", id: AI_MODEL, name: AI_MODEL },
          { provider: AI_PROVIDER, model: AI_MODEL,
            apiToken: readFileSync(AI_KEY_FILE, "utf8").trim() });
      }
      await auth.setPreferredModel(AI_MODEL);
    } catch (err) {
      process.stderr.write(`cfos-context-mcp: ตั้งโมเดลไม่สำเร็จ: ${err}\n`);
    }
  }

  return { api, auth, session };
}

async function context() {
  if (cached) return cached;
  cached = await connect();
  return cached;
}

async function withCtx(fn) {
  try {
    return await fn(await context());
  } catch (err) {
    // การเชื่อมต่อหลุดได้ (DO รีสตาร์ต, เซิร์ฟเวอร์รีโหลด) — ลองใหม่หนึ่งครั้ง
    cached = null;
    return await fn(await context());
  }
}

// ── นิยาม tool ที่เปิดให้ agent ────────────────────────────────────────────
const TOOLS = [
  {
    name: "list_context",
    description:
      "List the context collections and documents available in the company's Cloudflare OS " +
      "Context Library. Call with no arguments to see all collections, then pass collectionId " +
      "to see the documents inside one.",
    inputSchema: {
      type: "object",
      properties: {
        collectionId: { type: "string", description: "Limit the listing to one collection." },
        path: { type: "string", description: "Limit the listing to one folder path." },
      },
    },
    run: ({ session }, a) => session.list({ collectionId: a.collectionId, path: a.path }),
  },
  {
    name: "search_context",
    description:
      "Full-text search the company's shared context. Use this before answering questions about " +
      "internal conventions, processes, or decisions — it is the team's single source of truth.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for." },
        collectionId: { type: "string", description: "Restrict the search to one collection." },
        limit: { type: "number", description: "Maximum results (default 10)." },
      },
      required: ["query"],
    },
    run: ({ session }, a) => session.search(a.query, { collectionId: a.collectionId, limit: a.limit ?? 10 }),
  },
  {
    name: "read_context_document",
    description:
      "Read one context document in full. Pass the docId returned by search_context or list_context.",
    inputSchema: {
      type: "object",
      properties: { docId: { type: "string", description: "Document id, e.g. <collectionId>/<path>." } },
      required: ["docId"],
    },
    run: ({ session }, a) => session.read(a.docId),
  },

  // ── ฝั่งเขียน: ต้องระบุ workspace เสมอ ──────────────────────────────────
  //
  // กติกาจากบทที่ 15: bot ทำงานได้เฉพาะ workspace ที่ "คนเชิญเข้ามา" เท่านั้น
  // ห้ามสร้างใหม่เอง เพราะถ้าสร้างเอง คนจะไม่ได้เป็น collaborator
  // แล้ว action ที่รออนุมัติจะไปค้างในที่ที่ไม่มีใครเปิดดู

  {
    name: "list_cfos_workspaces",
    description:
      "List the Cloudflare OS workspaces this agent has been invited into. Use it to find the " +
      "workspaceId required by ask_cfos_agent. If the list is empty, a human must invite this " +
      "agent's account as a collaborator first.",
    inputSchema: { type: "object", properties: {} },
    run: async ({ auth }) => {
      const list = await auth.listGadgets();
      return {
        account: await auth.whoami(),
        workspaces: list.map(g => ({ id: g.id, title: g.title, owner: g.owner?.name })),
        // ⚠️ listGadgets() ไม่แสดง workspace ที่ถูกแชร์มาแต่ยังไม่เคยเปิด
        // (docs/sharing.md: "A shared gadget does not appear on a collaborator's home page
        //  until they first open it") — รายการว่างจึงไม่ได้แปลว่าไม่มีสิทธิ์
        hint: list.length ? undefined
          : "รายการว่างไม่ได้แปลว่าไม่มีสิทธิ์ — workspace ที่ถูกแชร์มาจะยังไม่โผล่ " +
            "จนกว่าจะเปิดครั้งแรก ให้คนส่ง workspaceId มาแล้วเรียก ask_cfos_agent " +
            "หรือ check_cfos_chat ด้วย id นั้นสักครั้ง จากนั้นมันจะขึ้นในรายการเอง",
      };
    },
  },

  {
    name: "ask_cfos_agent",
    description:
      "Ask the Cloudflare OS agent to build or change an app inside an EXISTING workspace. " +
      "You must pass a workspaceId from list_cfos_workspaces — this tool never creates a new " +
      "workspace, because a workspace the human is not a collaborator on would hide any action " +
      "waiting for their approval. Returns the transcript so far; the agent may still be running, " +
      "in which case poll with check_cfos_chat.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace to work in (required)." },
        prompt: { type: "string", description: "What the agent should do." },
        waitSeconds: { type: "number", description: "How long to wait before returning (default 60, max 240)." },
      },
      required: ["workspaceId", "prompt"],
    },
    run: async ({ auth }, a) => {
      const overseer = await auth.openGadget(a.workspaceId);   // โยนถ้าไม่ได้ถูกเชิญ
      const meta = await overseer.getMetadata();
      if (meta.role !== "build") {
        return { error: `บัญชีนี้มีสิทธิ์แค่ "${meta.role}" ใน workspace นี้ — สั่งงานไม่ได้` };
      }
      const chatId = await overseer.newChat(a.prompt, AI_MODEL);
      const waited = await waitForChat(overseer, chatId,
        Math.min((a.waitSeconds ?? 60), 240) * 1000);
      return { workspaceId: a.workspaceId, chatId, ...waited };
    },
  },

  {
    name: "check_cfos_chat",
    description:
      "Poll a chat started by ask_cfos_agent: returns the transcript, whether the agent is still " +
      "running, and anything waiting for a human to approve.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        chatId: { type: "number" },
      },
      required: ["workspaceId", "chatId"],
    },
    run: async ({ auth }, a) => {
      const overseer = await auth.openGadget(a.workspaceId);
      return { workspaceId: a.workspaceId, chatId: a.chatId,
               ...(await summarizeChat(overseer, a.chatId)) };
    },
  },
];

// ── ตัวช่วยสำหรับฝั่งเขียน ────────────────────────────────────────────────

/** ย่อประวัติแชทให้เหลือเฉพาะสิ่งที่ agent ภายนอกต้องรู้ */
async function summarizeChat(overseer, chatId) {
  const page = await overseer.getChatHistory(chatId);
  const msgs = page.messages ?? page;
  const transcript = msgs.map(m => {
    if (m.type === "message") {
      return {
        from: m.author?.name ?? "?",
        text: (m.body?.message ?? "").slice(0, 800) || undefined,
        tools: m.toolCalls?.map(t => t.toolName),
        stopReason: m.stopReason,
      };
    }
    if (m.type === "error") {
      return { event: "error", error: String(m.message ?? "").slice(0, 600) };
    }
    return { event: m.type };
  });

  // action ที่รอมนุษย์ — สิ่งสำคัญที่สุดที่ agent ภายนอกต้องเห็น (บทที่ 4)
  const pending = (await overseer.listActions())
    .filter(e => e.type === "action" && e.state === "pending")
    .map(e => ({ id: e.id, title: e.description?.title, resource: e.resourceTitle }));

  // เทิร์นจบเมื่อ: ข้อความสุดท้ายมี stopReason ที่ไม่ใช่ toolUse **หรือ** เป็นข้อความชนิด error
  // (ข้อความ error ไม่มี stopReason — ถ้าไม่ดักตรงนี้จะรอจนหมดเวลาเปล่า ๆ)
  const last = msgs[msgs.length - 1];
  const failed = last?.type === "error";
  const running = !failed && !(last?.stopReason && last.stopReason !== "toolUse");

  return {
    running,
    failed: failed || undefined,
    transcript,
    pendingApprovals: pending,
    note: pending.length
      ? "มี action รอมนุษย์อนุมัติ — agent จะไปต่อไม่ได้จนกว่าจะมีคนตัดสิน"
      : undefined,
  };
}

/** รอจนแชทหยุดเดิน หรือหมดเวลา */
async function waitForChat(overseer, chatId, budgetMs) {
  const deadline = Date.now() + budgetMs;
  let out = await summarizeChat(overseer, chatId);
  while (out.running && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000));
    out = await summarizeChat(overseer, chatId);
  }
  return out;
}


// ── MCP over stdio (JSON-RPC 2.0) ─────────────────────────────────────────
// เขียนเองเพราะ repo มีแต่ MCP SDK ฝั่ง client โปรโตคอลส่วนที่ใช้จริงมีไม่กี่เมธอด

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function fail(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;

  if (method === "initialize") {
    reply(id, {
      // สะท้อนเวอร์ชันที่ client ขอมา ถ้าไม่ระบุใช้ค่าที่รู้จัก
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "cfos-context", version: "0.2.0" },
    });
    return;
  }

  // notification — ไม่มี id ไม่ต้องตอบ
  if (method === "notifications/initialized" || id === undefined) return;

  if (method === "tools/list") {
    reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) =>
      ({ name, description, inputSchema })) });
    return;
  }

  if (method === "tools/call") {
    const tool = TOOLS.find(t => t.name === params?.name);
    if (!tool) return fail(id, -32602, `ไม่รู้จัก tool "${params?.name}"`);
    try {
      const out = await withCtx(c => tool.run(c, params.arguments ?? {}));
      reply(id, {
        content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
      });
    } catch (err) {
      // ส่งกลับเป็นผลลัพธ์ที่บอกว่าพัง ไม่ใช่ error ของโปรโตคอล — agent จะได้อ่านสาเหตุ
      reply(id, {
        isError: true,
        content: [{ type: "text", text: `เรียก ${tool.name} ไม่สำเร็จ: ${err}` }],
      });
    }
    return;
  }

  fail(id, -32601, `ไม่รองรับเมธอด "${method}"`);
}

// อุ่นเครื่องทันทีที่สตาร์ต ไม่ต้องรอ tool call แรก
//
// ครั้งแรกที่แตะ Durable Object ของผู้ใช้หลัง Cloudflare OS รีสตาร์ต ใช้เวลาได้ถึง ~30 วินาที
// (วัดได้จริง: login() 32s ส่วนขั้นที่เหลือรวมกันไม่ถึง 2s) ถ้าปล่อยให้ไปเกิดตอน tool call แรก
// MCP client จะเห็นเป็นอาการค้าง — ย้ายมาให้เกิดตอนสตาร์ตแทน
context().catch(err => {
  process.stderr.write(`cfos-context-mcp: อุ่นเครื่องไม่สำเร็จ (จะลองใหม่ตอนเรียก tool): ${err}\n`);
});

const rl = createInterface({ input: process.stdin });
rl.on("line", line => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  handle(msg).catch(err => {
    process.stderr.write(`cfos-context-mcp: ${err}\n`);
    if (msg?.id !== undefined) fail(msg.id, -32603, String(err));
  });
});
rl.on("close", () => process.exit(0));
