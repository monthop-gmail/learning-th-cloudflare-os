// สาธิต permission graph กับ blueprint round trip
//
// docs/sharing.md อ้างสามอย่างที่เทสต์ได้ตรง ๆ:
//   1. "removing Bob makes Carol unreachable automatically, with no separate cleanup step"
//   2. "revocation is reversible ... re-adding an edge from the owner restores their reachability"
//   3. use collaborator "Every other Overseer method throws Unauthorized" ยกเว้นสองตัวที่คืน
//      subscription เปล่า ๆ แทนที่จะปฏิเสธ
//
// docs/blueprints.md อ้างว่า blueprint จับ "code but not the chat history, SQLite storage,
// or credentials" — ข้อนี้ก็เทสต์ได้
//
// ไม่ต้องมี gatekeeper เลยสักตัว จึงไม่ต้องตอบ observer prompt

import { afterAll, beforeAll, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi, Overseer } from "@gadgets/workshop-shared/api";
import { startHarness, type Harness } from "../src/harness";
import { connect, nextUsernames, signUp } from "../src/rpc-client";

let harness: Harness;
beforeAll(async () => {
  harness = await startHarness({
    gatekeepers: [],
    // startHarness ลบ worker_loaders ทิ้งเพราะเทสต์ส่วนใหญ่ไม่รันโค้ดของ gadget
    // แต่เคส blueprint ข้างล่างต้อง connectToGadget() ซึ่งต้องโหลด Worker จริง
    // patchWorkshop รัน "หลัง" การลบ จึงใส่กลับได้ตรงนี้
    patchWorkshop: config => { config.worker_loaders = [{ binding: "LOADER" }]; },
  });
}, 120_000);
afterAll(async () => { await harness?.server.close(); });

/** เปิด workspace แล้วคืน Overseer — โยนถ้าเปิดไม่ได้ */
function open(api: RpcStub<AuthenticatedApi>, id: string): Promise<RpcStub<Overseer>> {
  return api.openGadget(id) as unknown as Promise<RpcStub<Overseer>>;
}

/** เปิดได้ไหม (ไม่โยน) */
async function canOpen(api: RpcStub<AuthenticatedApi>, id: string): Promise<boolean> {
  try {
    (await open(api, id))[Symbol.dispose]();
    return true;
  } catch {
    return false;
  }
}

it("ถอด bob ออก แล้ว carol หลุดตาม โดยไม่มีใครไปไล่ลบ — และใส่ bob กลับ carol ก็กลับมา", async () => {
  const publicApi = connect(harness.url);
  const [alice, bob, carol] = nextUsernames("alice", "bob", "carol");
  const aliceApi = await signUp(publicApi, alice);
  const bobApi = await signUp(publicApi, bob);
  const carolApi = await signUp(publicApi, carol);

  const aliceOverseer = await aliceApi.newGadget();
  const { id } = await aliceOverseer.getMetadata();

  // alice → bob (build) ; bob → carol (build)
  // ห่วงโซ่: owner → bob → carol โดย carol ไม่มีเส้นตรงจาก alice เลย
  expect(await aliceOverseer.addCollaborator(bob, "build")).toBeTruthy();
  const bobOverseer = await open(bobApi, id);
  expect(await bobOverseer.addCollaborator(carol, "build")).toBeTruthy();
  bobOverseer[Symbol.dispose]();

  expect(await canOpen(carolApi, id)).toBe(true);

  // ── alice ถอด bob ออก ───────────────────────────────────────────────
  // เอกสารบอกว่า "Nothing cascades" — ระบบตัดแค่เส้นที่ให้สิทธิ์ bob
  // ส่วน carol กลายเป็น unreachable เองเพราะคำนวณสดทุกครั้งที่ open()
  const affected = await aliceOverseer.removeCollaborator(bob, []);
  expect(await canOpen(bobApi, id)).toBe(false);
  expect(await canOpen(carolApi, id)).toBe(false);

  // ระบบรู้ตัวว่ากระทบใครบ้าง ไม่ใช่แค่ปล่อยให้หลุดเงียบ ๆ
  expect(affected.map(a => a.newRole)).toEqual([null, null]);

  // ── ใส่ bob กลับ ────────────────────────────────────────────────────
  // เส้นที่ bob เคยแบ่งให้ carol ไม่เคยถูกลบ พอ bob กลับมา carol จึงกลับมาด้วย
  expect(await aliceOverseer.addCollaborator(bob, "build")).toBeTruthy();
  expect(await canOpen(bobApi, id)).toBe(true);
  expect(await canOpen(carolApi, id)).toBe(true);

  aliceOverseer[Symbol.dispose]();
  publicApi[Symbol.dispose]();
}, 120_000);

it("ถอดเส้นทาง build ทิ้ง แล้วเหลือ use — เป็นการลดชั้น ไม่ใช่ตัดขาด", async () => {
  const publicApi = connect(harness.url);
  const [alice, bob, carol] = nextUsernames("dalice", "dbob", "dcarol");
  const aliceApi = await signUp(publicApi, alice);
  const bobApi = await signUp(publicApi, bob);
  const carolApi = await signUp(publicApi, carol);

  const aliceOverseer = await aliceApi.newGadget();
  const { id } = await aliceOverseer.getMetadata();

  // เพชร: carol ได้ build ผ่าน bob และได้ use ตรงจาก alice
  await aliceOverseer.addCollaborator(bob, "build");
  const bobOverseer = await open(bobApi, id);
  await bobOverseer.addCollaborator(carol, "build");
  bobOverseer[Symbol.dispose]();
  await aliceOverseer.addCollaborator(carol, "use");

  // effective role = max ของทุกเส้น → build
  const before = await open(carolApi, id);
  expect((await before.getMetadata()).role).toBe("build");
  before[Symbol.dispose]();

  // ถอด bob → เส้น build หาย เหลือเส้น use ตรงจาก alice
  const affected = await aliceOverseer.removeCollaborator(bob, []);
  // AffectedCollaborator ใช้ field ชื่อ `profile` ไม่ใช่ `user`
  const carolChange = affected.find(a => a.profile.id.startsWith(carol));
  expect(carolChange).toBeDefined();
  expect(carolChange!.oldRole).toBe("build");
  expect(carolChange!.newRole).toBe("use");   // ลดชั้น ไม่ใช่ตัดขาด

  const after = await open(carolApi, id);
  expect((await after.getMetadata()).role).toBe("use");
  after[Symbol.dispose]();

  aliceOverseer[Symbol.dispose]();
  publicApi[Symbol.dispose]();
}, 120_000);

it("use collaborator: อ่าน metadata ได้ แต่เมธอดฝั่ง build โยน Unauthorized", async () => {
  const publicApi = connect(harness.url);
  const [alice, dave] = nextUsernames("ualice", "udave");
  const aliceApi = await signUp(publicApi, alice);
  const daveApi = await signUp(publicApi, dave);

  const aliceOverseer = await aliceApi.newGadget();
  const { id } = await aliceOverseer.getMetadata();
  await aliceOverseer.setTitle("แผนงานไตรมาสหน้า");
  await aliceOverseer.addCollaborator(dave, "use");

  const daveOverseer = await open(daveApi, id);

  // อยู่ใน allowlist
  const meta = await daveOverseer.getMetadata();
  expect(meta.title).toBe("แผนงานไตรมาสหน้า");
  expect(meta.role).toBe("use");

  // นอก allowlist → Unauthorized
  await expect(daveOverseer.listChats()).rejects.toThrow(/Unauthorized/);
  await expect(daveOverseer.listBlueprints()).rejects.toThrow(/Unauthorized/);
  await expect(daveOverseer.addCollaborator("someone", "use")).rejects.toThrow(/Unauthorized/);
  await expect(daveOverseer.createShareLink("use")).rejects.toThrow(/Unauthorized/);

  await expect(daveOverseer.listActions()).rejects.toThrow(/Unauthorized/);

  // หมายเหตุ: `subscribeToActions()` กับ `subscribeToConsoleLogs()` เป็นข้อยกเว้นสองตัว
  // ที่ "ไม่ปฏิเสธ" แต่คืน subscription ที่ ready() ทันทีแล้วไม่ส่งอะไรมาเลย
  // (ดู UseOverseerInterface ใน overseer.ts) ที่นี่ไม่ได้เทสต์ เพราะต้องสร้าง RpcTarget เอง
  // ซึ่งแพ็กเกจนี้ห้าม import ค่าจาก capnweb ตรง ๆ — ดูกฎใน vite.config.ts

  daveOverseer[Symbol.dispose]();
  aliceOverseer[Symbol.dispose]();
  publicApi[Symbol.dispose]();
}, 120_000);

it("blueprint พาโค้ดไป แต่ไม่พาข้อมูลไป", async () => {
  const publicApi = connect(harness.url);
  const [alice, bob] = nextUsernames("balice", "bbob");
  const aliceApi = await signUp(publicApi, alice);
  const bobApi = await signUp(publicApi, bob);

  // alice สร้าง gadget จาก blueprint ที่ deployment แถมมา แล้วใส่ข้อมูลลงไป
  const aliceOverseer = await aliceApi.newGadgetFromBlueprint("format.document", {});
  const meta = await aliceOverseer.getMetadata();
  const gadget = await aliceOverseer.getGadget(meta.defaultGadgetId!);
  const app = await gadget.connectToGadget() as unknown as {
    setDocument(a: unknown): Promise<{ title: string }>;
    getDocument(): Promise<{ title: string; blocks: unknown[] | null }>;
  };
  await app.setDocument({
    title: "ความลับของ alice",
    senderId: "test",
    blocks: [{ id: "b1", html: "<p>ห้ามหลุด</p>" }],
  });

  // alice ปั้น blueprint จาก gadget ตัวนี้
  const summary = await gadget.createBlueprint("เทมเพลตของ alice", "ไว้ให้คนอื่นเอาไปใช้");
  expect(summary.id).toMatch(/^[0-9a-f]+$/);

  // bob สร้าง gadget ของตัวเองจาก blueprint นั้น
  const bobOverseer = await bobApi.newGadgetFromBlueprint(summary.id, {});
  const bobMeta = await bobOverseer.getMetadata();
  const bobGadget = await bobOverseer.getGadget(bobMeta.defaultGadgetId!);
  const bobApp = await bobGadget.connectToGadget() as unknown as {
    getDocument(): Promise<{ title: string; blocks: unknown[] | null }>;
  };

  // เป็นคนละ workspace กันจริง
  expect(bobMeta.id).not.toBe(meta.id);

  // 🔑 โค้ดตามไป แต่ข้อมูลใน SQLite ไม่ตาม — bob ได้เอกสารเปล่า
  const bobDoc = await bobApp.getDocument();
  expect(bobDoc.title).not.toBe("ความลับของ alice");

  // ของ alice ยังอยู่ครบ
  expect((await app.getDocument()).title).toBe("ความลับของ alice");

  bobOverseer[Symbol.dispose]();
  aliceOverseer[Symbol.dispose]();
  publicApi[Symbol.dispose]();
}, 120_000);
