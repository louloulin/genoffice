import type { zh } from './zh'

/** Zotero integration strings (References tab). Split out of strings-zotero.ts for per-locale dynamic loading. */
export const th = {
  zoteroCitation: 'การอ้างอิง Zotero',
  zoteroCitationTip: 'เพิ่มการอ้างอิงด้วย Zotero วางเคอร์เซอร์ในการอ้างอิงเพื่อแก้ไข',
  zoteroBibliography: 'บรรณานุกรม Zotero',
  zoteroBibliographyTip: 'เพิ่มหรือแก้ไขบรรณานุกรมด้วย Zotero',
  zoteroRefresh: 'รีเฟรช',
  zoteroRefreshTip: 'รีเฟรชการอ้างอิงและบรรณานุกรม Zotero ทั้งหมด',
  zoteroDocumentSettings: 'การตั้งค่าเอกสาร',
  zoteroDocumentSettingsTip: 'การตั้งค่าเอกสาร Zotero',
  zoteroDocumentPreferences: 'การกำหนดลักษณะเอกสาร',
  zoteroRemoveCodes: 'ลบรหัสเขตข้อมูล',
  zoteroConnectionError: 'ไม่สามารถเชื่อมต่อกับ Zotero ได้ โปรดเปิด Zotero ทิ้งไว้',
  zoteroOperationError: 'การดำเนินการ Zotero ล้มเหลว',
  zoteroNoteFieldsUnsupported:
    'เอกสารนี้มีการอ้างอิง Zotero ในเชิงอรรถหรืออ้างอิงท้ายเรื่อง ซึ่ง GenOffice ยังอัปเดตไม่ได้ คำสั่ง Zotero จึงถูกปิดไว้เพื่อรักษาบรรณานุกรมให้ครบถ้วน',
  zoteroGroup: 'Zotero',
} satisfies Record<keyof typeof zh, string>
