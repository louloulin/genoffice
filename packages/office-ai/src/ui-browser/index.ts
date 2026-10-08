/**
 * Browser entry of the office-ai UI tier — `import { mountEditor } from '@genoffice/office-ai/ui'`.
 *
 * The Node side (`@genoffice/office-ai/host`) starts or attaches the HTTP face
 * that serves the renderer bundles and answers IPC; this module is what a page
 * loads to put one of those editors on screen. It bundles to a browser ESM file
 * and deliberately depends on nothing but the DOM, so it can be loaded from a
 * plain `<script type="module">` with no bundler on the consumer's side.
 */
export { mountEditor, buildEmbedUrl, ENVELOPE_VERSION } from './mount'
export { isEnvelope } from './envelope'
export type {
  MountedEditor,
  MountEditorOptions,
  MountApp,
  MountMode,
  MountTheme,
  MountLang,
  MountToolbar,
} from './mount'
export type { Envelope } from './envelope'
