---
layout: home
title: GenOffice
hero:
  name: GenOffice
  text: Open-source AI Office Suite
  tagline: Docs, Sheets, Slides, PDF, Markdown, HTML — embeddable, scriptable, yours.
  actions:
    - theme: brand
      text: Quick Start
      link: /guide/getting-started
    - theme: alt
      text: REST API
      link: /api/rest-api
    - theme: alt
      text: SDK Reference
      link: /api/sdk-typescript
features:
  - title: Six editors, one engine
    details: Docs, Sheets, Slides, PDF, Markdown and HTML all share the same IPC, AI, and recents stack. No Electron required — the web-server bundle ships as a single Node process.
  - title: Embeddable
    details: Drop a `<iframe>` into any web page with one line of HTML. Or import `@genoffice/web-sdk` for typed events and commands.
  - title: AI-native
    details: 12 LLM providers, 10 official Skills, agent loop, KB / TM. Bring your own provider or Skill — plugins are plain npm packages.
  - title: Open formats
    details: .docx, .xlsx, .pptx, .pdf, .md, .html round-trip through open engines we maintain. `.genkb` / `.gentm` for sharing KB and translation memory.
  - title: Apache-2.0
    details: The whole core is Apache-2.0. Commercial SLA and Pro features are layered on top, never the other way around.
  - title: Stable SDK
    details: REST API v1, postMessage v1 envelope, and the JS SDK all carry a backward-compatibility commitment — no breaking changes inside a v1.x release.
---
