#!/usr/bin/env bash
#
# วางไฟล์ประกอบการเรียนลงใน clone ของ cloudflare/cloudflare-os
#
#   ./install.sh /path/to/cloudflare-os
#
# ไฟล์ทั้งหมดใน overlay/ จะถูกคัดลอกทับตามโครงเดิม ไม่แตะไฟล์อื่นของ upstream เลย
# ถอนออกได้ด้วย ./install.sh --uninstall /path/to/cloudflare-os

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OVERLAY="$HERE/overlay"

UNINSTALL=0
if [[ "${1:-}" == "--uninstall" ]]; then
  UNINSTALL=1
  shift
fi

TARGET="${1:-}"
if [[ -z "$TARGET" ]]; then
  echo "ใช้: $0 [--uninstall] /path/to/cloudflare-os" >&2
  exit 1
fi

if [[ ! -f "$TARGET/pnpm-workspace.yaml" || ! -d "$TARGET/packages/integration-tests" ]]; then
  echo "ผิดพลาด: '$TARGET' ไม่เหมือน clone ของ cloudflare-os" >&2
  echo "         (หาไม่เจอทั้ง pnpm-workspace.yaml และ packages/integration-tests)" >&2
  exit 1
fi

# รายการไฟล์ที่จะวาง คำนวณจาก overlay/ เสมอ จะได้ไม่มีทางหลุด
mapfile -t FILES < <(cd "$OVERLAY" && find . -type f | sed 's|^\./||' | sort)

if [[ "$UNINSTALL" == "1" ]]; then
  for f in "${FILES[@]}"; do
    if [[ -f "$TARGET/$f" ]]; then
      rm "$TARGET/$f"
      echo "  ลบ  $f"
    fi
  done
  # เก็บกวาดโฟลเดอร์ว่างของ fixture
  rmdir -p "$TARGET/packages/integration-tests/fixtures/gatekeeper-notes/src" 2>/dev/null || true
  echo "ถอนเรียบร้อย"
  exit 0
fi

for f in "${FILES[@]}"; do
  mkdir -p "$TARGET/$(dirname "$f")"
  cp "$OVERLAY/$f" "$TARGET/$f"
  echo "  วาง $f"
done

cat <<'EOF'

ติดตั้งเรียบร้อย ต่อไป:

  cd <cloudflare-os>
  corepack enable pnpm
  pnpm install
  pnpm run-local          # เปิด http://localhost:8787

แล้วเริ่มบทที่ 1:

  node packages/integration-tests/learn-01-explore-api.mjs

บทที่ 4 (ไม่ต้องมี pnpm run-local รันอยู่):

  pnpm --filter @gadgets/integration-tests exec vitest run __tests__/notes-approval.test.ts
EOF
