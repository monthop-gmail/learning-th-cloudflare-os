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

  // --- ACL ของ "บริการภายนอก" — เก็บรวมไว้ที่นี่เหมือน TestControl ใน fixture เดิม ---

  /**
   * ตั้งสิทธิ์ของสมุดเล่มหนึ่ง
   *
   * `allowlist` = ใครสังเกตการณ์สมุดเล่มนี้ได้ (ว่าง = ยังไม่เปิดใช้ ACL, ผ่านหมด)
   * `secretReaders` = ในจำนวนนั้น ใครอ่านโน้ตชั้นความลับได้อีกชั้นหนึ่ง
   */
  setAcl(notebook: string, allowlist: string[], secretReaders: string[]): void {
    this.ctx.storage.kv.put(`acl:${notebook}`, { allowlist, secretReaders });
  }

  getAcl(notebook: string): { allowlist: string[]; secretReaders: string[] } {
    return this.ctx.storage.kv.get<{ allowlist: string[]; secretReaders: string[] }>(
      `acl:${notebook}`) ?? { allowlist: [], secretReaders: [] };
  }

  readSecret(notebook: string): string {
    return this.ctx.storage.kv.get<string>(`secret:${notebook}`) ?? `(สมุด ${notebook} ยังไม่มีโน้ตลับ)`;
  }

  setSecret(notebook: string, text: string): void {
    this.ctx.storage.kv.put(`secret:${notebook}`, text);
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

/**
 * `GatekeeperUserVerifier` ไม่มีเมธอดของตัวเองเลย
 *
 * ธรรมเนียมคือ gatekeeper เพิ่มเมธอดนอกมาตรฐานเข้าไปเองแล้วเชื่อคำตอบ เพราะ overseer ส่ง verifier
 * กลับไปให้เฉพาะ vendor ที่เป็นคนสร้างมันเท่านั้น (ดู doc ของ GatekeeperUserVerifier)
 */
export interface NotesVerifierApi extends GatekeeperUserVerifier {
  identify(): Promise<string>;
}

export class NotesVerifier
    extends WorkerEntrypoint<Cloudflare.Env, AccountProps> implements NotesVerifierApi {
  async identify(): Promise<string> { return this.ctx.props.label; }
}

// ---------------------------------------------------------------------------
// Session — สิ่งที่ agent/gadget เรียกได้จริง

export interface NotebookSession extends RpcTarget {
  list(): Promise<string[]>;
  add(text: string): Promise<{ queuedAs: number }>;
  readRestricted(): Promise<string>;
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
   * อ่านโน้ตชั้นความลับ = observation ที่ observer บางคนห้ามเห็น (forward exclusion)
   *
   * ตาม docs/observers.md §"Step 5": gatekeeper ตั้ง `excludeObservers` เป็น observer id
   * ที่ห้ามเห็นข้อมูลก้อนนี้ แล้ว overseer จะ **throw บล็อกการอ่านทั้งดุ้น** ถ้าคนนั้นยังมีสิทธิ์
   * เข้าถึง gadget อยู่ (เพราะ v1 ยังซ่อนรายเธรดไม่ได้) — จะปล่อยผ่านก็ต่อเมื่อคนนั้นหลุดสิทธิ์ไปแล้ว
   *
   * นี่คือคู่ตรงข้ามของ addObserver(): addObserver คุมคนที่มาทีหลังข้อมูล
   * ส่วน excludeObservers คุมข้อมูลที่มาทีหลังคน
   */
  async readRestricted(): Promise<string> {
    const secret = await this.#gk.readSecret();
    await this.#queue.authorizeObservation({
      title: `Read the restricted note in ${this.#gk.notebookName()}`,
      description: "Read a note that only the notebook's own members may see.",
      excludeObservers: await this.#gk.observersWithoutSecretAccess(),
    });
    return secret;
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

  /** โน้ตชั้นความลับของสมุดเล่มนี้ */
  async readSecret(): Promise<string> {
    return await store(this.ctx).readSecret(this.notebookName());
  }

  /**
   * observer id ที่ "ห้ามเห็น" โน้ตชั้นความลับ
   *
   * ใช้ ACL primitive ตัวเดียวกับ addObserver() ตามที่ docs/observers.md §9.1 แนะนำสำหรับกลยุทธ์ C
   */
  async observersWithoutSecretAccess(): Promise<string[]> {
    const { secretReaders } = await store(this.ctx).getAcl(this.notebookName());
    const excluded: string[] = [];
    for (const [key, label] of this.ctx.storage.kv.list<string>({ prefix: "observer:" })) {
      if (!secretReaders.includes(label)) excluded.push(key.slice("observer:".length));
    }
    return excluded;
  }

  /**
   * observer verification แบบ **กลยุทธ์ B (ACL check)** ตาม docs/observers.md §9.1
   *
   * ถาม verifier ว่าพูดแทนบัญชีไหน แล้วเทียบกับ ACL ของสมุดเล่มนี้ — ไม่ผ่านก็ throw
   * ซึ่งเป็นวิธีเดียวที่ gatekeeper ใช้บอกว่า "คนนี้ห้ามเห็นสิ่งที่ gadget อ่านไปแล้ว"
   *
   * allowlist ว่าง = ยังไม่ตั้ง ACL = ให้ผ่านหมด (เจ้าของสมุดต้องเปิดใช้เอง)
   */
  async addObserver(id: string, user: Fetcher<NotesVerifierApi>): Promise<void> {
    const label = await user.identify();
    const { allowlist } = await store(this.ctx).getAcl(this.notebookName());
    if (allowlist.length > 0 && !allowlist.includes(label)) {
      throw new Error(`${label} does not have access to notebook ${this.notebookName()}.`);
    }
    this.ctx.storage.kv.put(`observer:${id}`, label);
  }

  /** ต้อง idempotent ตามสัญญาใน docs/observers.md §"Step 7" */
  async removeObserver(id: string): Promise<void> {
    this.ctx.storage.kv.delete(`observer:${id}`);
  }

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

// ---------------------------------------------------------------------------
// Control surface
//
// HTTP ธรรมดาบน fetch() ของ worker เอง เทสต์เรียกผ่าน harness.fetchWorker("gatekeeper-notes", ...)
// ไม่ต้อง gate ด้วย env เพราะ worker ตัวนี้ไม่มีวัน deploy จริง
//
// ตรวจ body แทนที่จะเชื่อ ไม่ใช่เพื่อความปลอดภัย แต่เพื่อ failure mode: ถ้าพิมพ์ชื่อ field ผิด
// แล้วปล่อยผ่าน ACL จะไปตั้งให้สมุดชื่อ `undefined` แล้วเทสต์จะตายอีกหลายขั้นถัดไป
// โดยไม่บอกสาเหตุจริง

/** 400 ที่บอกว่า field ไหนผิด เพื่อให้คำสั่ง control ที่พิมพ์ผิดพังตรงจุดที่มันผิด */
function badRequest(problem: string): Response {
  return new Response(`Bad control request: ${problem}`, { status: 400 });
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(v => typeof v === "string");
}

export default {
  async fetch(req: Request, _env: Cloudflare.Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== "POST") return new Response("Not Found", { status: 404 });

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return badRequest("the body is not JSON");
    }
    if (typeof body !== "object" || body === null) {
      return badRequest("the body is not a JSON object");
    }
    const { notebook, allowlist, secretReaders, secret } = body as Record<string, unknown>;
    if (typeof notebook !== "string" || notebook.length === 0) {
      return badRequest("`notebook` must be a non-empty string");
    }

    // ตั้ง ACL ของสมุดหนึ่งเล่ม
    // Body: {"notebook":"...", "allowlist":["a@x"], "secretReaders":["a@x"]}
    if (url.pathname === "/control/acl") {
      if (!isStringArray(allowlist)) return badRequest("`allowlist` must be an array of strings");
      if (!isStringArray(secretReaders)) {
        return badRequest("`secretReaders` must be an array of strings");
      }
      await store(ctx).setAcl(notebook, allowlist, secretReaders);
      return new Response(null, { status: 204 });
    }

    // ใส่เนื้อโน้ตชั้นความลับ
    // Body: {"notebook":"...", "secret":"..."}
    if (url.pathname === "/control/secret") {
      if (typeof secret !== "string") return badRequest("`secret` must be a string");
      await store(ctx).setSecret(notebook, secret);
      return new Response(null, { status: 204 });
    }

    return new Response("Not Found", { status: 404 });
  },
};
