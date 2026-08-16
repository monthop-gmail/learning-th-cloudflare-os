// Worker หลักของเดโม — จำลองสิ่งที่ Cloudflare OS ทำกับ Gadget แต่ย่อจนเหลือแก่น
//
// สองอย่างที่พิสูจน์:
//   1. Worker Loader โหลดโค้ดที่ "เพิ่งเขียนตอน runtime" ขึ้นมารันได้
//   2. globalOutbound: null ตัดเน็ตของโค้ดนั้นได้จริง
// บวกกับ Durable Object + SQLite ที่เป็นที่เก็บสถานะของ workspace

import { DurableObject } from "cloudflare:workers";

/** ที่เก็บสถานะ เทียบได้กับ Overseer DO ของจริง */
export class Counter extends DurableObject {
  bump() {
    const n = (this.ctx.storage.kv.get("n") ?? 0) + 1;
    this.ctx.storage.kv.put("n", n);
    return n;
  }
}

// โค้ดของ "gadget" ที่เราสร้างขึ้นสด ๆ ตอน runtime — ในของจริงมาจาก Yjs doc
const GADGET_SOURCE = `
export default {
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/escape") {
      // ลองออกเน็ต — ควรถูกบล็อกเพราะ globalOutbound: null
      try {
        const res = await fetch("https://example.com/");
        return Response.json({ escaped: true, status: res.status });
      } catch (e) {
        return Response.json({ escaped: false, error: String(e) });
      }
    }
    return Response.json({ hello: "ฉันคือโค้ดที่ถูกโหลดตอน runtime" });
  }
};
`;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === "/counter") {
      const stub = env.COUNTER.getByName("demo");
      return Response.json({ count: await stub.bump() });
    }

    // โหลด worker จากสตริง — ชื่อเดียวกันจะถูก reuse (loader ทำหน้าที่เป็น cache ด้วย)
    const worker = env.LOADER.get("gadget-v1", async () => ({
      compatibilityDate: "2026-02-01",
      mainModule: "gadget.js",
      modules: { "gadget.js": GADGET_SOURCE },
      globalOutbound: null,          // ← บรรทัดเดียวที่ตัดเน็ต
    }));

    const target = url.pathname === "/escape"
      ? "http://gadget/escape"
      : "http://gadget/";
    return await worker.getEntrypoint().fetch(target);
  },
};
