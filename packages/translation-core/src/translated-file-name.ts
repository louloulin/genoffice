/**
 * 翻译副本的文件名派生规则。
 *
 * **为什么放在 translation-core 而不是各自的应用里**：docs / sheets / slides 三个
 * 编辑器都要在「应用翻译」之后把产物落到云盘，规则一旦各写一份，第三种格式就会
 * 悄悄给出另一个名字，用户在云盘里按名字找翻译稿时只能靠翻。
 *
 * **与服务端的关系**：Dataflare `DriveOfficeSessionService.deriveTranslatedName` 是
 * 权威实现（文件名合法性由 `DriveNames.requireValid` 把关），这里是它的同构镜像，
 * 作用只有一个：**在真正保存之前把文件名显示给用户看**。两侧必须一致，否则用户
 * 看到的名字和落盘的名字对不上。服务端保留了「传空则自行派生」的兜底，客户端永远
 * 显式传名，所以这条兜底不参与正常流程。
 */

/** 与 `CrmDriveItem.NAME_MAX_LENGTH` 对齐。 */
export const DRIVE_NAME_MAX_LENGTH = 255

/** 服务端 `DEFAULT_SAVE_FILE_NAME`：原名缺失时的退化名。 */
const FALLBACK_NAME = 'untitled'

/** 单语翻译副本的名后缀，与服务端 `TRANSLATED_NAME_SUFFIX` 一致。 */
export const TRANSLATED_NAME_SUFFIX = 'translated'

/** 双语副本的名后缀，与服务端 `BILINGUAL_NAME_SUFFIX` 一致。 */
export const BILINGUAL_NAME_SUFFIX = 'bilingual'

export type TranslatedNameSuffix =
  | typeof TRANSLATED_NAME_SUFFIX
  | typeof BILINGUAL_NAME_SUFFIX
  | (string & {})

/**
 * `报价单.docx` + `translated` → `报价单.translated.docx`。
 *
 * 扩展名**原样保留**：计划要求「保原格式」，换个扩展名会让云盘下载与知识库解析
 * 对不上号。
 *
 * 超长时截的是**基名**而不是整体：后缀与扩展名才是这份文件「是什么」的信息，
 * 整体截会把 `.docx` 截掉。截基名时取**尾部**（与服务端 `takeLast` 一致）——
 * 文件名里真正区分同名文件的信息通常在末尾（`合同v2.final.docx`）。
 */
export function deriveTranslatedName(
  original: string | null | undefined,
  suffix: TranslatedNameSuffix,
): string {
  const name = original && original.trim() ? original : FALLBACK_NAME
  const dot = name.lastIndexOf('.')
  // 句点在前一位（`.gitignore`）或落在末尾时，整个名字都是基名。
  const hasExt = dot > 0 && dot < name.length - 1
  const base = hasExt ? name.slice(0, dot) : name
  const ext = hasExt ? name.slice(dot) : ''
  const tail = `.${suffix}${ext}`
  const room = DRIVE_NAME_MAX_LENGTH - tail.length
  if (room <= 0) {
    // 后缀本身就把长度吃完了：宁可名字退化，也不能产生一个服务端会拒绝的文件名。
    return FALLBACK_NAME
  }
  const trimmedBase = base.length > room ? base.slice(base.length - room) : base
  return `${trimmedBase}${tail}`
}

/**
 * 按应用模式挑后缀：双语走 `bilingual`，其余走 `translated`。
 *
 * 单独抽出来是因为「模式 → 后缀」这个判断在三个应用里都会各写一次，而它是用户
 * 唯一能看见的差异（文件名）。两处判断不一致 = 同一次翻译在不同格式下产出不同
 * 命名的文件。
 */
export function translatedNameSuffixFor(
  applyMode: 'replace' | 'bilingual' | undefined,
): TranslatedNameSuffix {
  return applyMode === 'bilingual' ? BILINGUAL_NAME_SUFFIX : TRANSLATED_NAME_SUFFIX
}
