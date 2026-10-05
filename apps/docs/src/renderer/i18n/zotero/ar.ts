import type { zh } from './zh'

/** Zotero integration strings (References tab). Split out of strings-zotero.ts for per-locale dynamic loading. */
export const ar = {
  zoteroCitation: 'اقتباس Zotero',
  zoteroCitationTip: 'أضف اقتباسًا باستخدام Zotero؛ ضع المؤشر داخل اقتباس لتعديله',
  zoteroBibliography: 'مراجع Zotero',
  zoteroBibliographyTip: 'أضف قائمة المراجع أو عدّلها باستخدام Zotero',
  zoteroRefresh: 'تحديث',
  zoteroRefreshTip: 'تحديث جميع اقتباسات ومراجع Zotero',
  zoteroDocumentSettings: 'إعدادات المستند',
  zoteroDocumentSettingsTip: 'إعدادات مستند Zotero',
  zoteroDocumentPreferences: 'تفضيلات المستند',
  zoteroRemoveCodes: 'إزالة رموز الحقول',
  zoteroConnectionError: 'تعذر الاتصال بـ Zotero. شغّل Zotero واتركه مفتوحًا.',
  zoteroOperationError: 'فشلت عملية Zotero.',
  zoteroNoteFieldsUnsupported:
    'يحتوي هذا المستند على استشهادات Zotero في الحواشي السفلية أو الختامية، ولا يستطيع GenOffice تحديثها بعد. تم تعطيل أوامر Zotero هنا للحفاظ على قائمة المراجع سليمة.',
  zoteroGroup: 'Zotero',
} satisfies Record<keyof typeof zh, string>
