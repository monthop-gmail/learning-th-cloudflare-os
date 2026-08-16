// Fixture gatekeeper ที่ "ยิง action จริง" เพื่อสาธิต human-in-the-loop แบบ async
//
// ต่างจาก fixtures/gatekeeper-test ตรงที่ตัวนั้นออกแบบมาทดสอบ observer verification จึงไม่ยิง action
// เลย (applyAction ของมัน throw) ตัวนี้เติมอีกครึ่งที่ขาด: วงจร submitAction -> pending ->
// approve/reject -> applyAction
//
// กลยุทธ์ simulation ลอกมาจาก gatekeeper-confluence/src/confluence-actions.ts:
//   "cache the *base* truth ... and overlay pending (submitted-but-unapplied) actions at read time"
// คือ NotesStore เก็บความจริงที่ commit แล้ว ส่วน pending อยู่ใน NotesGatekeeper แล้วเอามาซ้อนตอนอ่าน
// ผลคือ agent เขียนแล้วอ่านกลับเห็นงานตัวเองทันที ทั้งที่ยังไม่มีใครอนุมัติ -> ทำงานต่อได้ไม่ต้องหยุดรอ

import { DurableObject, RpcTarget, WorkerEntrypoint, type RpcStub } from "cloudflare:workers";
import type {
  AccountDescription, ActionKind, ApprovalQueue, Gatekeeper, GatekeeperConnectCallback,
  GatekeeperUser, GatekeeperUserVerifier, ResourceDescription, ResourceConfiguratorFrame,
  SupportedResource, VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";

const VENDOR_HOST = "notes.example";

const SUPPORTED_RESOURCES: SupportedResource[] = [{
  urlPattern: `https://${VENDOR_HOST}/notebooks/*`,
  title: "Notebook",
  description: "A notebook whose notes can be read and appended.",
}];

const TYPES_CODE = `
/** A notebook of plain-text notes. */
interface Notebook {
  /** Read every note. This is an observation -- it is logged but never needs approval. */
  list(): Promise<string[]>;

  /** Append a note. Has a side effect, so it is queued for the user's approval. */
  add(text: string): Promise<{ queuedAs: number }>;
}
`;

const AVATAR = {
  url: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
};

const ACTION_KIND: ActionKind = { tag: "notes.add", label: "Add a note" };

// ---------------------------------------------------------------------------
// ctx.exports แบบมีชนิด — ทำไมไม่ใช้ env.d.ts เหมือน fixtures/gatekeeper-test
//
// tsconfig ของแพ็กเกจนี้ include ทั้ง "fixtures" เข้า program เดียวกัน และ Cloudflare.GlobalProps
// เป็น global interface ประกาศ `mainModule` ซ้ำสอง fixture ไม่ได้ — ตัวหลังจะทับตัวแรกจนของเดิมพัง
// จึงประกาศชนิดไว้ในไฟล์ตัวเองแล้ว cast เอา ให้ผลเสียจำกัดอยู่แค่ fixture นี้

type NotesExports = {
  NotesStore: DurableObjectNamespace<NotesStore>;
  NotesAccount: (opts: { props: AccountProps }) => Fetcher<GatekeeperUser>;
  NotesVerifier: (opts: { props: AccountProps }) => Fetcher<GatekeeperUserVerifier>;
  NotesGatekeeper: (
    opts: { props: BindingProps },
  ) => DurableObjectClass<Gatekeeper<NotebookSession>>;
};

function exportsOf(ctx: { exports: unknown }): NotesExports {
  return ctx.exports as NotesExports;
}

// ---------------------------------------------------------------------------
// "บริการภายนอก" จำลอง — ความจริงที่ commit แล้วอยู่ที่นี่ที่เดียว

export class NotesStore extends DurableObject<Cloudflare.Env> {
  commit(notebook: string, text: string): void {
    const key = `notes:${notebook}`;
    const notes = this.ctx.storage.kv.get<string[]>(key) ?? [];
    this.ctx.storage.kv.put(key, [...notes, text]);
  }

  read(notebook: string): string[] {
    return this.ctx.storage.kv.get<string[]>(`notes:${notebook}`) ?? [];
  }

  /** ใช้ตอน revertAction: ลบโน้ตที่เพิ่งใส่ไป */
  uncommit(notebook: string, text: string): void {
    const key = `notes:${notebook}`;
    const notes = this.ctx.storage.kv.get<string[]>(key) ?? [];
    const at = notes.lastIndexOf(text);
    if (at >= 0) this.ctx.storage.kv.put(key, [...notes.slice(0, at), ...notes.slice(at + 1)]);
  }
}

function store(ctx: { exports: unknown }): DurableObjectStub<NotesStore> {
  return exportsOf(ctx).NotesStore.getByName("store");
}

// ---------------------------------------------------------------------------
// Vendor / Account — auto-provision เพื่อไม่ต้องมี OAuth

type AccountProps = { label: string };
type BindingProps = AccountProps & { resourceUrl: string };

export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Notes",
      url: `https://${VENDOR_HOST}`,
      logo: AVATAR,
      tagline: "A fake notebook service for studying the approval queue.",
      autoProvisionsAccount: true,
    };
  }

  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    const label = `notes-${crypto.randomUUID().slice(0, 8)}@${VENDOR_HOST}`;
    return exportsOf(this.ctx).NotesAccount({ props: { label } });
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async connectAccount(_cb: Fetcher<GatekeeperConnectCallback>): Promise<{ url: string }> {
    throw new Error("Notes auto-provisions accounts; there is no connect flow.");
  }
}

export class NotesAccount
    extends WorkerEntrypoint<Cloudflare.Env, AccountProps> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    return {
      displayName: this.ctx.props.label.split("@")[0],
      uniqueName: this.ctx.props.label,
      avatar: AVATAR,
    };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<NotebookSession>>;
    resource: SupportedResource;
  }> {
    const parsed = new URL(url);
    if (parsed.host !== VENDOR_HOST || !parsed.pathname.startsWith("/notebooks/")) {
      throw new Error(`Not a notes resource URL: ${url}`);
    }
    return {
      class: exportsOf(this.ctx).NotesGatekeeper({
        props: { label: this.ctx.props.label, resourceUrl: url },
      }),
      resource: SUPPORTED_RESOURCES[0],
    };
  }

  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return exportsOf(this.ctx).NotesVerifier({ props: this.ctx.props });
  }

  async ensureResources(_patterns: string[]): Promise<{ url?: string }> { return {}; }
  async getAuthenticatedEmail(): Promise<string | null> { return null; }
  async revoke(): Promise<void> {}

  startResourceConfigurator(_pattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("No configurator; bind a URL directly.");
  }
  reconnect(): Promise<{ url: string }> {
    throw new Error("No credentials to reconnect.");
  }
}

export class NotesVerifier
    extends WorkerEntrypoint<Cloudflare.Env, AccountProps> implements GatekeeperUserVerifier {
  async identify(): Promise<string> { return this.ctx.props.label; }
}

// ---------------------------------------------------------------------------
// Session — สิ่งที่ agent/gadget เรียกได้จริง

export interface NotebookSession extends RpcTarget {
  list(): Promise<string[]>;
  add(text: string): Promise<{ queuedAs: number }>;
}

class NotebookSessionImpl extends RpcTarget implements NotebookSession {
  #gk: NotesGatekeeper;
  #queue: RpcStub<ApprovalQueue>;

  constructor(gk: NotesGatekeeper, queue: RpcStub<ApprovalQueue>) {
    super();
    this.#gk = gk;
    this.#queue = queue;
  }

  /**
   * อ่านโน้ต = observation
   *
   * ตาม doc ของ authorizeObservation(): เรียก "หลัง" ดึงข้อมูลมาแล้วได้ ตราบใดที่ยังไม่ได้ส่งคืนให้
   * ผู้เรียก เพื่อให้ description บอกได้ว่าอ่านอะไรไปจริง ๆ
   */
  async list(): Promise<string[]> {
    const notes = await this.#gk.readWithPending();
    await this.#queue.authorizeObservation({
      title: `Read ${this.#gk.notebookName()}`,
      description: `Read ${notes.length} note(s) from the notebook.`,
    });
    return notes;
  }

  /**
   * เขียนโน้ต = action
   *
   * คืนค่าทันทีหลัง submitAction() — ไม่รอการอนุมัติ นี่คือหัวใจ: agent ทำงานต่อได้เลย
   * และเพราะเรา overlay pending ตอนอ่าน list() ครั้งถัดไปจะเห็นโน้ตนี้แล้ว จึงไม่ตั้ง awaitDecision
   */
  async add(text: string): Promise<{ queuedAs: number }> {
    const id = this.#gk.stagePending(text);
    await this.#queue.submitAction(id, {
      title: `Add a note to ${this.#gk.notebookName()}`,
      description: `Append the following note:\n\n> ${text}`,
      implementsRevert: true,
      autoApprovable: true,
      actionKind: ACTION_KIND,
    });
    return { queuedAs: id };
  }
}

// ---------------------------------------------------------------------------
// Gatekeeper — หนึ่งตัวต่อหนึ่ง resource ที่ผูกไว้ (รันเป็น facet ใต้ Overseer ของ workspace)

export class NotesGatekeeper
    extends DurableObject<Cloudflare.Env, BindingProps> implements Gatekeeper<NotebookSession> {

  notebookName(): string {
    return decodeURIComponent(new URL(this.ctx.props.resourceUrl).pathname.split("/").pop()!);
  }

  /** ความจริงที่ commit แล้ว + pending ที่ยังไม่อนุมัติ ซ้อนกัน = โลกที่ agent มองเห็น */
  async readWithPending(): Promise<string[]> {
    const committed = await store(this.ctx).read(this.notebookName());
    const pending = this.#pendingTexts();
    return [...committed, ...pending];
  }

  #pendingTexts(): string[] {
    const ids = this.ctx.storage.kv.get<number[]>("pending") ?? [];
    return ids.map(id => this.ctx.storage.kv.get<string>(`action:${id}`)!).filter(t => t != null);
  }

  /** จอง action id แล้วเก็บเนื้อหาไว้รออนุมัติ */
  stagePending(text: string): number {
    const id = (this.ctx.storage.kv.get<number>("counter") ?? 0) + 1;
    this.ctx.storage.kv.put("counter", id);
    this.ctx.storage.kv.put(`action:${id}`, text);
    this.ctx.storage.kv.put("pending", [...(this.ctx.storage.kv.get<number[]>("pending") ?? []), id]);
    return id;
  }

  #unstage(id: number): string | undefined {
    const text = this.ctx.storage.kv.get<string>(`action:${id}`);
    const pending = this.ctx.storage.kv.get<number[]>("pending") ?? [];
    this.ctx.storage.kv.put("pending", pending.filter(p => p !== id));
    return text;
  }

  async describe(): Promise<ResourceDescription> {
    return {
      url: this.ctx.props.resourceUrl,
      title: `Notebook ${this.notebookName()}`,
      snippet: `A notebook of plain-text notes.`,
      suggestedBindingName: "NOTEBOOK",
      tsType: "Notebook",
    };
  }

  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }

  /** ผู้ใช้เปิด auto-approve ของชนิดนี้ได้ (ยังต้องมี autoApprovable ต่อ action อีกชั้น) */
  async getAutoApprovableActions(): Promise<ActionKind[]> { return [ACTION_KIND]; }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<NotebookSession> {
    return new NotebookSessionImpl(this, approvalQueue.dup());
  }

  /**
   * observer verification: ใครก็ดูได้ (แนว "low-stakes" เหมือน spotify)
   *
   * โน้ตปลอมพวกนี้ไม่ใช่ข้อมูลที่ information-flow model มีไว้ปกป้อง จึงไม่ต้องตรวจผู้สังเกตการณ์
   */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}

  /** ผู้ใช้กดอนุมัติ -> ถึงตอนนี้ค่อยแตะ "บริการภายนอก" จริง ๆ */
  async applyAction(action: number): Promise<void> {
    const text = this.#unstage(action);
    if (text === undefined) throw new Error(`No pending action ${action}`);
    await store(this.ctx).commit(this.notebookName(), text);
  }

  /** ผู้ใช้กดปฏิเสธ -> ทิ้ง pending ทำให้ overlay คำนวณใหม่โดยไม่มีมัน */
  async rejectAction(action: number): Promise<void> {
    this.#unstage(action);
    this.ctx.storage.kv.delete(`action:${action}`);
  }

  async revertAction(action: number): Promise<void> {
    const text = this.ctx.storage.kv.get<string>(`action:${action}`);
    if (text === undefined) throw new Error(`Unknown action ${action}`);
    await store(this.ctx).uncommit(this.notebookName(), text);
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("Not Found", { status: 404 });
  },
};
