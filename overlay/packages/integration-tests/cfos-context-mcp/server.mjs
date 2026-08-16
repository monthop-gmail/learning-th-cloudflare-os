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
//
// ดู README.md ข้าง ๆ สำหรับวิธีต่อเข้า Claude Code

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { newWebSocketRpcSession } from "capnweb";

const URL_ = process.env.CFOS_URL ?? "ws://localhost:8787/api";
const USER = process.env.CFOS_USER ?? "mcpcontextreader";
const SECRET_FILE = process.env.CFOS_SECRET_FILE;

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
  return { api, session: await gk.openSession() };
}

async function session() {
  if (cached) return cached.session;
  cached = await connect();
  return cached.session;
}

async function withSession(fn) {
  try {
    return await fn(await session());
  } catch (err) {
    // การเชื่อมต่อหลุดได้ (DO รีสตาร์ต, เซิร์ฟเวอร์รีโหลด) — ลองใหม่หนึ่งครั้ง
    cached = null;
    return await fn(await session());
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
    run: (s, a) => s.list({ collectionId: a.collectionId, path: a.path }),
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
    run: (s, a) => s.search(a.query, { collectionId: a.collectionId, limit: a.limit ?? 10 }),
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
    run: (s, a) => s.read(a.docId),
  },
];

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
      serverInfo: { name: "cfos-context", version: "0.1.0" },
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
      const out = await withSession(s => tool.run(s, params.arguments ?? {}));
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
session().catch(err => {
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
