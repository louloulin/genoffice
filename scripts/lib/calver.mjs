// CalVer 版本的解析 / 校验 / 自增。
//
// dataflarework 与 genoffice 两个仓库共用同一套制式与实现，复制而非抽包：两个仓库
// 各有独立的 CI 与发布通道，抽公共包会让「改一次版本逻辑要同时动两个仓库的依赖树」，
// 门槛反而更高。改动时两边都要改 —— verify-version-wiring.mjs 各自校验自己的那份。
//
// 格式：YYYY.M.D 或 YYYY.M.D.N
//   - YYYY.M.D   ：当天第一次发布
//   - YYYY.M.D.N ：同一天第 N 次发布（N ≥ 2）
//
// 为什么用 CalVer 而不是 SemVer：
//   本项目是内部系统，发布节奏跟着「这批需求上不上线」走，不跟对外 API 兼容性承诺走。
//   SemVer 的 major/minor 每次都要人判断「这算不算破坏性变更」，判错的后果是线上跑着一个
//   号看不出新旧；CalVer 下「号变大了 = 又发了一次」永远成立，且不需要判断。

const PATTERN = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:\.(\d{1,3}))?$/

/**
 * @param {string} raw
 * @returns {{year:number, month:number, day:number, seq:number, raw:string}|null}
 */
export function parseVersion(raw) {
  if (typeof raw !== 'string') return null
  const m = PATTERN.exec(raw.trim())
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return { year, month, day, seq: m[4] === undefined ? 1 : Number(m[4]), raw: raw.trim() }
}

export function isValidVersion(raw) {
  return parseVersion(raw) !== null
}

/** 归一化成 YYYY.MM.DD（seq=1）或 YYYY.MM.DD.N。
 *
 *  月/日补零到两位：`10.5` 与 `10.05` 会被 sort 当成两个不同版本（字典序 / 数值序都不一致），
 *  补零让「同一个日子只有一个写法」成为格式的硬约束。 */
export function formatVersion({ year, month, day, seq }) {
  const pad = (n) => String(n).padStart(2, '0')
  const base = `${year}.${pad(month)}.${pad(day)}`
  return seq > 1 ? `${base}.${seq}` : base
}

/**
 * 算出下一个版本号。
 *
 * 规则：
 *   - 换了自然日（当天 > 记录日，或记录日在未来——时钟回拨）→ 回到 YYYY.M.D；
 *   - 同一天 → seq + 1。
 *
 * 「记录日在未来」也归零到当天：本地时钟被调早、或从别人的机器拉了旧 VERSION 过来时，
 * 继续自增会得到比记录值还小的号，而 bump 脚本拒绝版本号倒退（会失败而不是静默发一个旧号）。
 */
export function nextVersion(current, now = new Date()) {
  const today = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() }
  const parsed = parseVersion(current)
  if (!parsed) return formatVersion({ ...today, seq: 1 })

  const isSameDay =
    parsed.year === today.year && parsed.month === today.month && parsed.day === today.day
  if (isSameDay) return formatVersion({ ...parsed, seq: parsed.seq + 1 })
  return formatVersion({ ...today, seq: 1 })
}

/** 排序比较：a 比 b 新返回正数。无法解析的段按 -1 处理（排在所有合法版本之前）。 */
export function compareVersions(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa && !pb) return 0
  if (!pa) return -1
  if (!pb) return 1
  return (
    pa.year - pb.year || pa.month - pb.month || pa.day - pb.day || pa.seq - pb.seq
  )
}
