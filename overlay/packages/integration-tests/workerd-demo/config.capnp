using Workerd = import "/workerd/workerd.capnp";

# workerd config เปล่า ๆ — ไม่มี wrangler ไม่มี miniflare ไม่มีบัญชี Cloudflare
#
# รัน: workerd serve --experimental config.capnp
#
# schema เต็มอยู่ที่ node_modules/workerd/workerd.capnp (1,063 บรรทัด เปิดอ่านได้)
# หมายเหตุ: capnp ใช้ `#` เป็นคอมเมนต์เท่านั้น `//` จะพังทันที

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .mainWorker),
    (name = "do-storage", disk = (path = "do-data", writable = true)),
  ],
  sockets = [
    (name = "http", address = "*:8791", http = (), service = "main"),
  ],
);

const mainWorker :Workerd.Worker = (
  modules = [
    (name = "main.js", esModule = embed "main.js"),
  ],
  compatibilityDate = "2026-02-01",
  compatibilityFlags = ["experimental"],

  durableObjectNamespaces = [
    (className = "Counter", uniqueKey = "counter-demo-key", enableSql = true),
  ],

  # เก็บลงดิสก์จริง เพื่อพิสูจน์ว่า state อยู่รอดข้ามการรีสตาร์ต
  durableObjectStorage = (localDisk = "do-storage"),

  bindings = [
    (name = "COUNTER", durableObjectNamespace = "Counter"),

    # หัวใจของ Cloudflare OS: โหลด Worker จากโค้ดที่เพิ่งได้มาตอน runtime
    (name = "LOADER", workerLoader = ()),
  ],
);
