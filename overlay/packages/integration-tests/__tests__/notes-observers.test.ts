// สาธิต information-flow control ของ Cloudflare OS ด้วย fixture gatekeeper-notes
//
// พิสูจน์ invariant ที่ docs/observers.md ยกมาจาก overview.md §"Security Model":
//   "If a Gadget can read information that has restricted access, then any user who is not
//    able to read that information will also be prohibited from interacting with the Gadget,
//    to prevent data leaks."
//
// สองกลไกที่ทำงานคนละทิศ (docs/observers.md §5 Step 3 และ Step 5):
//   addObserver()     คุม "คนที่มาทีหลังข้อมูล"  -> ตรวจตอนเปิด gadget
//   excludeObservers  คุม "ข้อมูลที่มาทีหลังคน"  -> ตรวจตอน authorizeObservation()

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi, PublicApi } from "@gadgets/workshop-shared/api";
import { startHarness, type Harness } from "../src/harness";
import {
  accountLabel, connect, listConnectedAccounts, MAX_OBSERVER_PROMPTS, nextUsernames,
  ObserverConfigRecorder, signUp, stubFor, waitFor, type ConnectedAccount,
} from "../src/rpc-client";

const HERE = dirname(fileURLToPath(import.meta.url));
const NOTES_DIR = resolve(HERE, "../fixtures/gatekeeper-notes");
const NOTES_WORKER = "gatekeeper-notes";
const VENDOR_ID = "notes";

let harness: Harness;
beforeAll(async () => {
  harness = await startHarness({ gatekeepers: [{ binding: "NOTES", dir: NOTES_DIR }] });
}, 120_000);
afterAll(async () => { await harness?.server.close(); });

const notebookUrl = (name: string) => `https://notes.example/notebooks/${name}`;

type NotebookStub = {
  list(): Promise<string[]>;
  add(text: string): Promise<{ queuedAs: number }>;
  readRestricted(): Promise<string>;
};

/** ยิงคำสั่ง control ไปที่ worker ของ gatekeeper ตรง ๆ (ไม่ผ่าน Workshop) */
async function control(path: string, body: unknown): Promise<void> {
  const res = await harness.fetchWorker(
    NOTES_WORKER, `http://gatekeeper-notes.test${path}`,
    { method: "POST", body: JSON.stringify(body) });
  if (res.status !== 204) {
    throw new Error(`control ${path} ตอบ ${res.status}: ${await res.text()}`);
  }
}

async function provisionAccount(api: RpcStub<AuthenticatedApi>): Promise<ConnectedAccount> {
  await api.provisionAmbientAccount(VENDOR_ID);
  return waitFor("บัญชี notes ถูกสร้าง", async () => {
    const accounts = await listConnectedAccounts(api);
    return accounts.find(a => a.vendorId === VENDOR_ID) ?? null;
  });
}

type Shared = {
  gadgetId: string;
  notebook: string;
  aliceLabel: string;
  bobLabel: string;
  bobApi: RpcStub<AuthenticatedApi>;
  bobAccountId: number;
  aliceNotes: NotebookStub;
};

/** alice สร้าง workspace ผูก notebook แล้วแชร์ให้ bob เป็น build */
async function shareWithBob(publicApi: RpcStub<PublicApi>, notebook: string): Promise<Shared> {
  const [alice, bob] = nextUsernames("alice", "bob");
  const aliceApi = await signUp(publicApi, alice);
  const bobApi = await signUp(publicApi, bob);          // bob ต้องมีตัวตนก่อนถึงจะถูกเชิญได้

  const aliceAccount = await provisionAccount(aliceApi);
  const overseer = await aliceApi.newGadget();
  const gk = await overseer.newGatekeeper(aliceAccount.id, notebookUrl(notebook)) as
      { openSession(): Promise<unknown> } | null;
  if (!gk) throw new Error("ผูก notebook ไม่สำเร็จ");
  const aliceNotes = (await gk.openSession()) as NotebookStub;

  const { id: gadgetId } = await overseer.getMetadata();
  if (!await overseer.addCollaborator(bob, "build")) {
    throw new Error(`แชร์ให้ ${bob} ไม่สำเร็จ`);
  }

  const bobAccount = await provisionAccount(bobApi);
  return {
    gadgetId, notebook, bobApi,
    aliceLabel: accountLabel(aliceAccount),
    bobLabel: accountLabel(bobAccount),
    bobAccountId: bobAccount.id,
    aliceNotes,
  };
}

/** bob เปิด gadget โดยตอบ prompt เลือกบัญชีให้อัตโนมัติ */
async function bobOpens(shared: Shared) {
  const recorder = new ObserverConfigRecorder().alwaysChoose(shared.bobAccountId, MAX_OBSERVER_PROMPTS);
  const callback = stubFor(recorder);
  try {
    return await shared.bobApi.openGadget(shared.gadgetId, undefined, callback);
  } finally {
    callback[Symbol.dispose]();
  }
}

// ─────────────────────────────────────────────────────────────────────────────

it("addObserver: คนที่ไม่มีสิทธิ์เข้าถึงทรัพยากร เปิด gadget ไม่ได้", async () => {
  const publicApi = connect(harness.url);
  const shared = await shareWithBob(publicApi, "acl-denied");

  // ACL: มีแค่ alice — bob ไม่อยู่ในนั้น
  await control("/control/acl", {
    notebook: shared.notebook,
    allowlist: [shared.aliceLabel],
    secretReaders: [shared.aliceLabel],
  });

  // alice อ่านได้ปกติ (เจ้าของไม่เคยเป็น observer — docs/observers.md §6 ข้อ 1)
  await expect(shared.aliceNotes.list()).resolves.toEqual([]);

  // bob อยู่ใน sharing table แล้ว แต่ gatekeeper ปฏิเสธ -> เปิดไม่ได้
  // "intent vs. configured-and-verified" ต้องผ่านทั้งสองอย่าง (docs/observers.md §3)
  // ข้อความบอกทั้ง "ทรัพยากรไหน", "บัญชีไหน" และ "เพราะอะไร" — ตาม docs/observers.md §5 Step 3
  await expect(bobOpens(shared)).rejects.toThrow(
    new RegExp(`Notebook ${shared.notebook} \\(${shared.bobLabel}\\).*does not have access`, "s"));

  publicApi[Symbol.dispose]();
}, 120_000);

it("addObserver: คนที่มีสิทธิ์ เปิดได้ตามปกติ", async () => {
  const publicApi = connect(harness.url);
  const shared = await shareWithBob(publicApi, "acl-allowed");

  await control("/control/acl", {
    notebook: shared.notebook,
    allowlist: [shared.aliceLabel, shared.bobLabel],   // คราวนี้ bob อยู่ด้วย
    secretReaders: [shared.aliceLabel, shared.bobLabel],
  });

  const bobOverseer = await bobOpens(shared);
  expect((await bobOverseer.getMetadata()).id).toBe(shared.gadgetId);
  bobOverseer[Symbol.dispose]();

  publicApi[Symbol.dispose]();
}, 120_000);

it("excludeObservers: ข้อมูลที่ observer ห้ามเห็น ถูกบล็อกตั้งแต่ตอนอ่าน", async () => {
  const publicApi = connect(harness.url);
  const shared = await shareWithBob(publicApi, "forward-exclusion");

  // bob เข้าสมุดได้ แต่ "อ่านโน้ตลับไม่ได้" — ACL สองชั้น
  await control("/control/acl", {
    notebook: shared.notebook,
    allowlist: [shared.aliceLabel, shared.bobLabel],
    secretReaders: [shared.aliceLabel],                // bob ไม่อยู่ในชั้นใน
  });
  await control("/control/secret", {
    notebook: shared.notebook,
    secret: "เลขบัญชีลับของบริษัท",
  });

  // ตอนนี้ยังไม่มี observer เลย -> alice อ่านโน้ตลับได้
  await expect(shared.aliceNotes.readRestricted()).resolves.toBe("เลขบัญชีลับของบริษัท");

  // bob เปิด gadget สำเร็จ -> กลายเป็น observer ที่ผ่านการตรวจแล้ว
  (await bobOpens(shared))[Symbol.dispose]();

  // 🔑 คราวนี้ alice อ่านโน้ตลับ "ไม่ได้แล้ว"
  //
  // gatekeeper ใส่ bob ลง excludeObservers, overseer เห็นว่า bob ยังมีสิทธิ์ใน sharing graph
  // และ v1 ซ่อนรายเธรดไม่ได้ จึง throw บล็อกการอ่านทั้งดุ้น (docs/observers.md §5 Step 5)
  //
  // สังเกตว่าคนที่โดนบล็อกคือ alice ผู้เป็นเจ้าของ ไม่ใช่ bob — เพราะระบบกันข้อมูล "ไหลเข้า"
  // gadget ที่ bob มองเห็นอยู่ ไม่ได้กัน bob เป็นราย ๆ
  // ข้อความนี้ตรงกับที่ docs/observers.md §5 Step 5 ระบุไว้เป๊ะทุกตัวอักษร
  await expect(shared.aliceNotes.readRestricted()).rejects.toThrow(
    "This observation was blocked because it contains data that a current collaborator " +
    "is not permitted to see.");

  // แต่การอ่านธรรมดายังทำได้ — บล็อกเฉพาะ observation ที่มีข้อมูลต้องห้าม
  await expect(shared.aliceNotes.list()).resolves.toEqual([]);

  publicApi[Symbol.dispose]();
}, 120_000);
