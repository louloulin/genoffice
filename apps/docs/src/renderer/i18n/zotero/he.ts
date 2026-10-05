import type { zh } from './zh'

/** Zotero integration strings (References tab). Split out of strings-zotero.ts for per-locale dynamic loading. */
export const he = {
  zoteroCitation: 'ציטוט Zotero',
  zoteroCitationTip: 'הוספת ציטוט באמצעות Zotero; יש למקם את הסמן בציטוט כדי לערוך אותו',
  zoteroBibliography: 'ביבליוגרפיה של Zotero',
  zoteroBibliographyTip: 'הוספה או עריכה של הביבליוגרפיה באמצעות Zotero',
  zoteroRefresh: 'רענון',
  zoteroRefreshTip: 'רענון כל הציטוטים והביבליוגרפיות של Zotero',
  zoteroDocumentSettings: 'הגדרות מסמך',
  zoteroDocumentSettingsTip: 'הגדרות מסמך Zotero',
  zoteroDocumentPreferences: 'העדפות מסמך',
  zoteroRemoveCodes: 'הסרת קודי שדה',
  zoteroConnectionError: 'לא ניתן להתחבר ל-Zotero. יש להפעיל את Zotero ולהשאיר אותו פתוח.',
  zoteroOperationError: 'פעולת Zotero נכשלה.',
  zoteroNoteFieldsUnsupported:
    'מסמך זה מכיל ציטוטים של Zotero בהערות שוליים או הערות סיום, ש-GenOffice עדיין אינו יכול לעדכן. פקודות Zotero מושבתות כאן כדי לשמור על הביבליוגרפיה שלמה.',
  zoteroGroup: 'Zotero',
} satisfies Record<keyof typeof zh, string>
