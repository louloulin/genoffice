#!/usr/bin/env node
/**
 * sync-changelog.mjs
 *
 * Mirrors the root CHANGELOG.md into the VitePress docs site at:
 *   - docs/changelog/index.md (English, verbatim)
 *   - docs/zh/changelog/index.md (Chinese — translated via simple
 *     `zh` header swap; full translation lives in the file itself
 *     and is updated by hand because the audience is Chinese-first)
 *
 * Why not auto-translate? The CN copy is curated for tone and is
 * maintained by hand, so we only sync the EN side and copy the ZH
 * counterpart if it's missing.
 */
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "CHANGELOG.md");
const EN_DST = path.join(ROOT, "docs/changelog/index.md");
const ZH_DST = path.join(ROOT, "docs/zh/changelog/index.md");

const FRONT_MATTER = (title) =>
  `---\ntitle: ${title}\n---\n\n`;

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function main() {
  const src = fs.readFileSync(SRC, "utf8");
  ensureDir(EN_DST);
  fs.writeFileSync(EN_DST, FRONT_MATTER("Changelog") + src + "\n");
  console.log(`synced → ${path.relative(ROOT, EN_DST)}`);

  // For the ZH side, only create the file if missing. We deliberately
  // do not machine-translate because the audience is Chinese-first and
  // the copy is curated by hand (per the page header).
  if (!fs.existsSync(ZH_DST)) {
    ensureDir(ZH_DST);
    fs.writeFileSync(
      ZH_DST,
      FRONT_MATTER("更新日志") +
        "# 更新日志\n\n> 请手动维护本文件（中文受众，机器翻译不友好）。\n\n" +
        src +
        "\n",
    );
    console.log(`seeded → ${path.relative(ROOT, ZH_DST)}`);
  } else {
    console.log(`kept   → ${path.relative(ROOT, ZH_DST)} (exists, manual)`);
  }
}

main();
