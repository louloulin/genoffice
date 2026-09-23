/**
 * VitePress config for the GenOffice documentation site.
 *
 * Sections:
 *   - Guide       — installation, quick starts, deployment, security
 *   - API         — REST API, SDK, postMessage, IPC, provider plugins, agent & skills
 *   - Skills      — official + community skills
 *   - About       — architecture, roadmap, governance, FAQ
 *
 * Sidebars are hand-curated (typedoc generates into `api/_generated/` and is
 * referenced via VitePress's `auto-collapses` sidebar for that folder).
 */

import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'GenOffice',
  description: 'AI-native office suite — docs, sheets, slides, pdf, markdown, html. Open SDK, REST API v1, embeddable iframe.',

  lang: 'en-US',
  lastUpdated: true,

  head: [
    ['meta', { name: 'theme-color', content: '#0ea5e9' }],
    ['meta', { name: 'description', content: 'AI-native office suite — docs, sheets, slides, pdf, markdown, html. Open SDK, REST API v1, embeddable iframe.' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'GenOffice — Open-source AI Office Suite' }],
    ['meta', { property: 'og:description', content: 'Apache-2.0, embeddable, scriptable, yours.' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
  ],

  // Bilingual nav (Chinese is added in addition to the default English).
  locales: {
    root: { label: 'English', lang: 'en-US' },
    zh: { label: '简体中文', lang: 'zh-CN' },
  },

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started', activeMatch: '/guide/' },
      { text: 'API', link: '/api/rest-api', activeMatch: '/api/' },
      { text: 'Skills', link: '/skills/official', activeMatch: '/skills/' },
      { text: 'About', link: '/about/architecture', activeMatch: '/about/' },
      { text: 'v1.0-beta', link: '/about/roadmap' },
    ],

    sidebar: {
      '/guide/': [
        { text: 'Getting Started', items: [
          { text: 'Installation', link: '/guide/installation' },
          { text: 'Quick Start — Web', link: '/guide/quick-start-web' },
          { text: 'Quick Start — Embed', link: '/guide/quick-start-embed' },
          { text: 'Quick Start — SDK', link: '/guide/quick-start-sdk' },
          { text: 'SDK Multi-instance', link: '/guide/sdk-multi-instance' },
          { text: 'Getting Started', link: '/guide/getting-started' },
        ] },
        { text: 'Deployment', items: [
          { text: 'Docker', link: '/guide/deployment-docker' },
          { text: 'Kubernetes', link: '/guide/deployment-kubernetes' },
        ] },
        { text: 'Operations', items: [
          { text: 'Security Best Practices', link: '/guide/security-best-practices' },
        ] },
      ],

      '/api/': [
        { text: 'Public API', items: [
          { text: 'REST API v1', link: '/api/rest-api' },
          { text: 'JavaScript SDK', link: '/api/sdk-typescript' },
          { text: 'postMessage Protocol', link: '/api/postmessage-protocol' },
          { text: 'Marketplace', link: '/api/marketplace' },
          { text: 'Generated API Reference', link: '/api/_generated/README' },
        ] },
        { text: 'Extensibility', items: [
          { text: 'Provider Plugins', link: '/api/provider-plugins' },
          { text: 'Provider Capabilities', link: '/api/provider-capabilities' },
          { text: 'AI & Skills Protocol', link: '/api/ai-skills-protocol' },
          { text: 'Agent Protocol v1', link: '/api/agent-protocol' },
          { text: 'KB / TM Format', link: '/api/kb-tm-format' },
        ] },
        { text: 'Packages', items: [
          { text: '@genoffice/agent-runtime', link: '/api/agent-runtime' },
          { text: '@genoffice/agent-session', link: '/api/agent-session' },
        ] },
        { text: 'Reference', items: [
          { text: 'IPC Channels (514)', link: '/api/ipc-channels' },
          { text: 'IPC Channels (auto)', link: '/api/ipc-channels-auto' },
        ] },
      ],

      '/skills/': [
        { text: 'Skills', items: [
          { text: 'Marketplace', link: '/skills/marketplace' },
          { text: 'Official Skills', link: '/skills/official' },
          { text: 'doc-format', link: '/skills/official/doc-format' },
          { text: 'json-validate', link: '/skills/official/json-validate' },
          { text: 'markdown-format', link: '/skills/official/markdown-format' },
          { text: 'sheet-formula', link: '/skills/official/sheet-formula' },
          { text: 'slides-outline', link: '/skills/official/slides-outline' },
          { text: 'text-diff', link: '/skills/official/text-diff' },
          { text: 'text-summarize', link: '/skills/official/text-summarize' },
          { text: 'text-translate', link: '/skills/official/text-translate' },
          { text: 'text-translate-pairs', link: '/skills/official/text-translate-pairs' },
          { text: 'yaml-to-json', link: '/skills/official/yaml-to-json' },
          { text: 'yaml-validate', link: '/skills/official/yaml-validate' },
          { text: 'Community Skills', link: '/skills/community' },
          { text: 'Authoring Guide', link: '/skills/authoring' },
        ] },
      ],

      '/about/': [
        { text: 'About', items: [
          { text: 'Architecture', link: '/about/architecture' },
          { text: 'Roadmap', link: '/about/roadmap' },
          { text: 'Governance', link: '/about/governance' },
          { text: 'RFC Process', link: '/rfcs/README' },
          { text: 'FAQ', link: '/about/faq' },
        ] },
      ],

      '/changelog/': [
        { text: 'Changelog', items: [
          { text: 'Releases', link: '/changelog/' },
        ] },
      ],
    },

    // zh-CN localized sidebar — maps to /zh/* VitePress locale routes.
    sidebarZH: {
      '/zh/guide/': [
        { text: '快速上手', items: [
          { text: '安装', link: '/zh/guide/installation' },
          { text: '快速上手 — Web', link: '/zh/guide/quick-start-web' },
          { text: '快速上手 — 嵌入', link: '/zh/guide/quick-start-embed' },
          { text: '快速上手 — SDK', link: '/zh/guide/quick-start-sdk' },
          { text: 'SDK 多实例', link: '/zh/guide/sdk-multi-instance' },
          { text: '快速开始', link: '/zh/guide/getting-started' },
        ] },
        { text: '部署', items: [
          { text: 'Docker', link: '/zh/guide/deployment-docker' },
          { text: 'Kubernetes', link: '/zh/guide/deployment-kubernetes' },
        ] },
        { text: '运维', items: [
          { text: '安全最佳实践', link: '/zh/guide/security-best-practices' },
        ] },
      ],
      '/zh/api/': [
        { text: '公开 API', items: [
          { text: 'REST API v1', link: '/zh/api/rest-api' },
          { text: 'JavaScript SDK', link: '/zh/api/sdk-typescript' },
          { text: 'postMessage 协议', link: '/zh/api/postmessage-protocol' },
          { text: '市场', link: '/zh/api/marketplace' },
        ] },
        { text: '扩展性', items: [
          { text: 'Provider 插件', link: '/zh/api/provider-plugins' },
          { text: 'Provider 能力矩阵', link: '/zh/api/provider-capabilities' },
          { text: 'AI & Skills 协议', link: '/zh/api/ai-skills-protocol' },
          { text: 'Agent 协议 v1', link: '/zh/api/agent-protocol' },
          { text: 'KB / TM 格式', link: '/zh/api/kb-tm-format' },
        ] },
        { text: '包', items: [
          { text: '@genoffice/agent-runtime', link: '/zh/api/agent-runtime' },
          { text: '@genoffice/agent-session', link: '/zh/api/agent-session' },
        ] },
        { text: '参考', items: [
          { text: 'IPC 通道 (514)', link: '/zh/api/ipc-channels' },
        ] },
      ],
      '/zh/skills/': [
        { text: 'Skills', items: [
          { text: '市场', link: '/zh/skills/marketplace' },
          { text: '官方 Skills', link: '/zh/skills/official' },
          { text: 'doc-format', link: '/zh/skills/official/doc-format' },
          { text: 'json-validate', link: '/zh/skills/official/json-validate' },
          { text: 'markdown-format', link: '/zh/skills/official/markdown-format' },
          { text: 'sheet-formula', link: '/zh/skills/official/sheet-formula' },
          { text: 'slides-outline', link: '/zh/skills/official/slides-outline' },
          { text: 'text-diff', link: '/zh/skills/official/text-diff' },
          { text: 'text-summarize', link: '/zh/skills/official/text-summarize' },
          { text: 'text-translate', link: '/zh/skills/official/text-translate' },
          { text: 'text-translate-pairs', link: '/zh/skills/official/text-translate-pairs' },
          { text: 'yaml-to-json', link: '/zh/skills/official/yaml-to-json' },
          { text: 'yaml-validate', link: '/zh/skills/official/yaml-validate' },
          { text: '社区 Skills', link: '/zh/skills/community' },
          { text: '编写指南', link: '/zh/skills/authoring' },
        ] },
      ],
      '/zh/about/': [
        { text: '关于', items: [
          { text: '架构', link: '/zh/about/architecture' },
          { text: '路线图', link: '/zh/about/roadmap' },
          { text: '治理', link: '/zh/about/governance' },
          { text: '常见问题', link: '/zh/about/faq' },
        ] },
      ],

      '/zh/changelog/': [
        { text: '更新日志', items: [
          { text: '版本历史', link: '/zh/changelog/' },
        ] },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/genspark-ai/genoffice' },
    ],

    footer: {
      message: 'Apache-2.0 · Open SDK · REST API v1 · Embeddable',
      copyright: `Copyright © 2024-present GenOffice contributors`,
    },

    search: {
      provider: 'local',
    },

    outline: { level: [2, 3], label: 'On this page' },

    docFooter: { prev: 'Previous', next: 'Next' },

    editLink: {
      pattern: 'https://github.com/genspark-ai/genoffice/edit/main/docs/:path',
      text: 'Edit on GitHub',
    },
  },

  // Markdown options — disable broken-link checker (we ship external
  // GitHub URLs that may not exist before the public release).
  markdown: {
    lineNumbers: false,
    theme: { light: 'github-light', dark: 'github-dark' },
  },

  // VitePress sitemap + dead-link detection live in CI (docs.yml).
  cleanUrls: true,
})
