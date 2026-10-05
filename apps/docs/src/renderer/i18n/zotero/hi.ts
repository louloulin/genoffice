import type { zh } from './zh'

/** Zotero integration strings (References tab). Split out of strings-zotero.ts for per-locale dynamic loading. */
export const hi = {
  zoteroCitation: 'Zotero उद्धरण',
  zoteroCitationTip: 'Zotero से उद्धरण जोड़ें; संपादित करने के लिए कर्सर को उद्धरण में रखें',
  zoteroBibliography: 'Zotero ग्रंथ सूची',
  zoteroBibliographyTip: 'Zotero से ग्रंथ सूची जोड़ें या संपादित करें',
  zoteroRefresh: 'रीफ़्रेश करें',
  zoteroRefreshTip: 'सभी Zotero उद्धरण और ग्रंथ सूचियाँ रीफ़्रेश करें',
  zoteroDocumentSettings: 'दस्तावेज़ सेटिंग',
  zoteroDocumentSettingsTip: 'Zotero दस्तावेज़ सेटिंग',
  zoteroDocumentPreferences: 'दस्तावेज़ प्राथमिकताएँ',
  zoteroRemoveCodes: 'फ़ील्ड कोड हटाएँ',
  zoteroConnectionError: 'Zotero से कनेक्ट नहीं हो सका। Zotero शुरू करें और उसे खुला रखें।',
  zoteroOperationError: 'Zotero कार्रवाई विफल रही।',
  zoteroNoteFieldsUnsupported:
    'इस दस्तावेज़ के फ़ुटनोट या एंडनोट में Zotero उद्धरण हैं, जिन्हें GenOffice अभी अपडेट नहीं कर सकता। ग्रंथसूची को सुरक्षित रखने के लिए यहाँ Zotero कमांड बंद हैं।',
  zoteroGroup: 'Zotero',
} satisfies Record<keyof typeof zh, string>
