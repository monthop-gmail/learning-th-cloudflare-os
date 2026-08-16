// สาธิต human-in-the-loop แบบ async ครบวงจร ด้วย fixture gatekeeper-notes
//
// เดินตามคำอ้างใน README ทีละข้อ แล้วดูว่าโค้ดทำได้จริงไหม:
//   "the Gatekeeper will simulate the outcome locally, allowing the agent to proceed and queue up
//    more actions ... Once the agent is done, the user may approve or reject the actions in bulk"

import { resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startHarness, type Harness } from "../src/harness";
import { connect, listConnectedAccounts, nextUsernames, signUp, waitFor } from "../src/rpc-client";

const HERE = dirname(fileURLToPath(import.meta.url));
const NOTES_DIR = resolve(HERE, "../fixtures/gatekeeper-notes");
const VENDOR_ID = "notes";

let harness: Harness;
beforeAll(async () => {
  harness = await startHarness({ gatekeepers: [{ binding: "NOTES", dir: NOTES_DIR }] });
}, 120_000);
afterAll(async () => { await harness?.server.close(); });

const notebookUrl = (name: string) => `https://notes.example/notebooks/${name}`;

/**
 * ชนิดของ session ที่ gatekeeper-notes เปิดให้
 *
 * `Overseer.newGatekeeper()` ประกาศคืน `GatekeeperClient<any>` เพราะ Workshop ไม่รู้จัก vendor
 * ตอน compile — session แต่ละเจ้ามีเมธอดไม่เหมือนกัน ฝั่งผู้เรียกจึงต้องบอกชนิดเอง
 * (ตัวแอปจริงไม่เจอปัญหานี้ เพราะ agent อ่าน getTypeScriptTypes() ตอน runtime แทน)
 */
type NotebookStub = {
  list(): Promise<string[]>;
  add(text: string): Promise<{ queuedAs: number }>;
};

/** ผูก notebook เข้า workspace แล้วเปิด session ที่ระบุชนิดไว้แล้ว */
async function openNotebook(
    overseer: { newGatekeeper(accountId: number, url: string): Promise<unknown> },
    accountId: number, url: string): Promise<NotebookStub> {
  const gk = await overseer.newGatekeeper(accountId, url) as
      { openSession(): Promise<unknown> } | null;
  if (!gk) throw new Error(`newGatekeeper() refused ${url}`);
  return (await gk.openSession()) as NotebookStub;
}

async function setup(prefix: string) {
  const [username] = nextUsernames(prefix);
  const publicApi = connect(harness.url);
  const api = await signUp(publicApi, username);
  await api.provisionAmbientAccount(VENDOR_ID);
  const account = await waitFor("the notes account to appear", async () => {
    const accounts = await listConnectedAccounts(api);
    return accounts.find(a => a.vendorId === VENDOR_ID) ?? null;
  });
  const overseer = await api.newGadget();
  return { api, overseer, account };
}

it("ทำงานต่อได้ทันทีหลัง submit แล้วค่อยอนุมัติทีหลัง", async () => {
  const { overseer, account } = await setup("writer");
  const notes = await openNotebook(overseer, account.id, notebookUrl("study"));

  // ── เริ่มจากว่างเปล่า ────────────────────────────────────────────────
  expect(await notes.list()).toEqual([]);

  // ── agent ยิงงานรัว ๆ 3 ชิ้น โดยไม่หยุดรออนุมัติสักครั้ง ─────────────
  const t0 = Date.now();
  const a1 = await notes.add("Gadget = process");
  const a2 = await notes.add("Gatekeeper = device driver");
  const a3 = await notes.add("Blueprint = executable");
  const elapsed = Date.now() - t0;

  // ไม่มีการบล็อกรอมนุษย์ ทั้งสามชิ้นเสร็จในพริบตา
  expect(elapsed).toBeLessThan(5_000);
  expect([a1.queuedAs, a2.queuedAs, a3.queuedAs]).toEqual([1, 2, 3]);

  // ── นี่คือหัวใจ: อ่านกลับแล้ว "เห็นงานตัวเอง" ทั้งที่ยังไม่มีใครอนุมัติ ──
  expect(await notes.list()).toEqual([
    "Gadget = process",
    "Gatekeeper = device driver",
    "Blueprint = executable",
  ]);

  // ── แต่ฝั่งผู้ใช้ ทั้งสามยังค้างรออนุมัติอยู่ ─────────────────────────
  const pending = await overseer.listActions();
  const actions = pending.filter(e => e.type === "action");
  expect(actions).toHaveLength(3);
  expect(actions.every(a => a.state === "pending")).toBe(true);
  expect(actions[0].description.title).toBe("Add a note to study");

  // ── ผู้ใช้กลับมาทีหลัง อนุมัติสองปฏิเสธหนึ่ง ─────────────────────────
  await overseer.approveAction(actions[0].id);
  await overseer.approveAction(actions[1].id);
  await overseer.rejectAction(actions[2].id);

  const resolved = (await overseer.listActions()).filter(e => e.type === "action");
  expect(resolved.map(a => a.state)).toEqual(["approved", "approved", "rejected"]);

  // ── โลกจริงหลังตัดสิน: ที่ถูกปฏิเสธหายไป ─────────────────────────────
  expect(await notes.list()).toEqual([
    "Gadget = process",
    "Gatekeeper = device driver",
  ]);
}, 120_000);

it("การอ่านถูกบันทึกเป็น observation ไม่ต้องอนุมัติ", async () => {
  const { overseer, account } = await setup("reader");
  const notes = await openNotebook(overseer, account.id, notebookUrl("readonly"));

  await notes.list();
  await notes.list();

  const log = await overseer.listActions();
  // การอ่านไม่สร้างรายการชนิด "action" ที่ต้องอนุมัติเลย
  expect(log.filter(e => e.type === "action")).toHaveLength(0);
}, 120_000);
