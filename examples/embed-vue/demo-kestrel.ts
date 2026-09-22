/**
 * SDK 2.0 Kestrel end-to-end demo (sdk1.md §B.5.6 verification gate #3).
 *
 * Vue 3 + Composition API variant of the React demo. Exercises the
 * same four Kestrel surfaces in one page:
 *
 *   1. Multi-instance (two `GenOfficeEditor`s side-by-side, each with
 *      its own `instanceId`).
 *   2. Plugin Runtime (`mountSidebar` / `postToSidebar` /
 *      `sidebarMessage`).
 *   3. Comments API (`addComment` / `listComments` /
 *      `resolveComment` + events).
 *   4. Telemetry (`telemetry: true` + `usage` subscriber).
 *
 * The Vue variant uses the `getEditor(instanceId)` import to look up
 * handles from sibling handlers, demonstrating the cross-component
 * lookup pattern that Kestrel M1's EditorRegistry enables.
 */
import { createApp, defineComponent, h, onMounted, onBeforeUnmount, ref, reactive } from 'vue'
import {
  createEditor,
  getEditor,
  type EditorHandle,
  type UsageEvent,
  type Comment,
  type SidebarMessageEvent,
} from '@genoffice/web-sdk'

interface Args { host: string; jwt: string; documentId: string }

// ── Multi-instance + raw editor ───────────────────────────────────────────
const VueEditor = defineComponent({
  props: { host: { type: String, required: true }, documentId: { type: String, required: true }, jwt: { type: String, required: true }, instanceId: { type: String, required: true } },
  setup(props) {
    const refEl = ref<HTMLDivElement | null>(null)
    let handle: EditorHandle | null = null
    onMounted(() => {
      if (!refEl.value) return
      handle = createEditor({
        host: props.host,
        documentId: props.documentId,
        app: 'docs',
        jwt: props.jwt,
        container: refEl.value,
        instanceId: props.instanceId,
      })
    })
    onBeforeUnmount(() => { handle?.destroy(); handle = null })
    return () => h('div', { ref: refEl, class: 'frame' })
  },
})

// ── Comments panel ───────────────────────────────────────────────────────
const CommentsPanel = defineComponent({
  props: { instanceId: { type: String, required: true } },
  setup(props) {
    const comments = ref<Comment[]>([])
    const draft = ref('')

    async function refresh() {
      const editor = getEditor(props.instanceId)
      if (!editor) return
      const r = await editor.command('listComments')
      comments.value = r.comments
    }

    onMounted(() => {
      const editor = getEditor(props.instanceId)
      if (!editor) return
      editor.on('commentAdded', (e) => { comments.value = [...comments.value, e.comment] })
      editor.on('commentResolved', (e) => {
        comments.value = comments.value.map((c) => c.id === e.comment.id ? e.comment : c)
      })
      void refresh()
    })

    async function add() {
      const editor = getEditor(props.instanceId)
      if (!editor || !draft.value) return
      await editor.command('addComment', { anchor: { range: { start: 0, end: 5 } }, text: draft.value })
      draft.value = ''
    }

    async function toggle(id: string, resolved: boolean) {
      const editor = getEditor(props.instanceId)
      if (!editor) return
      await editor.command('resolveComment', { id, resolved })
    }

    return () => h('div', { class: 'panel' }, [
      h('h3', `Comments (${comments.value.length})`),
      h('div', { class: 'row' }, [
        h('input', {
          value: draft.value,
          'onUpdate:modelValue': (v: string) => { draft.value = v },
          placeholder: 'New comment…',
        }),
        h('button', { onClick: add, disabled: !draft.value }, 'Add'),
      ]),
      h('ul', null, comments.value.map((c) =>
        h('li', { key: c.id, class: c.resolved ? 'resolved' : '' }, [
          h('span', null, c.text),
          h('button', { onClick: () => toggle(c.id, !c.resolved) }, c.resolved ? 'Unresolve' : 'Resolve'),
        ]),
      )),
    ])
  },
})

// ── Plugin Runtime panel ─────────────────────────────────────────────────
const SidebarMountPanel = defineComponent({
  props: { args: { type: Object, required: true } },
  setup(props) {
    const refEl = ref<HTMLDivElement | null>(null)
    let handle: EditorHandle | null = null
    const panelId = ref<string | null>(null)
    const messages = ref<SidebarMessageEvent[]>([])

    onMounted(() => {
      if (!refEl.value) return
      const args = props.args as Args
      handle = createEditor({
        host: args.host,
        documentId: args.documentId,
        app: 'docs',
        jwt: args.jwt,
        container: refEl.value,
      })
      handle.on('sidebarMessage', (e) => {
        messages.value = [e, ...messages.value].slice(0, 10)
      })
    })
    onBeforeUnmount(() => { handle?.destroy(); handle = null })

    async function mount() {
      if (!handle) return
      const args = props.args as Args
      const r = await handle.command('mountSidebar', {
        panelUrl: `${args.host}/panel-stub.html`,
        width: 320,
        title: 'AI assistant',
      })
      panelId.value = r.panelId
    }
    async function unmount() {
      if (!panelId.value || !handle) return
      await handle.command('unmountSidebar', { panelId: panelId.value })
      panelId.value = null
    }
    async function push() {
      if (!panelId.value || !handle) return
      await handle.command('postToSidebar', {
        panelId: panelId.value,
        message: { type: 'ASK', prompt: 'summarise this document' },
      })
    }

    return () => h('div', { class: 'panel' }, [
      h('div', { ref: refEl, class: 'frame' }),
      h('div', { class: 'controls' }, [
        h('button', { onClick: mount, disabled: !!panelId.value }, 'Mount sidebar'),
        h('button', { onClick: push, disabled: !panelId.value }, 'Post "ASK"'),
        h('button', { onClick: unmount, disabled: !panelId.value }, 'Unmount'),
      ]),
      h('ul', null, messages.value.map((m, i) =>
        h('li', { key: i }, [h('code', null, JSON.stringify(m.message))]),
      )),
    ])
  },
})

// ── Telemetry badge ──────────────────────────────────────────────────────
const TelemetryBadge = defineComponent({
  props: { args: { type: Object, required: true } },
  setup(props) {
    const refEl = ref<HTMLDivElement | null>(null)
    let handle: EditorHandle | null = null
    const usage = ref<UsageEvent | null>(null)

    onMounted(() => {
      if (!refEl.value) return
      const args = props.args as Args
      handle = createEditor({
        host: args.host,
        documentId: args.documentId,
        app: 'docs',
        jwt: args.jwt,
        container: refEl.value,
        telemetry: true,
      })
      handle.on('usage', (e) => { usage.value = e })
    })
    onBeforeUnmount(() => { handle?.destroy(); handle = null })

    async function probe() {
      if (!handle) return
      await handle.command('insertText', { text: 'telemetry probe ' })
    }

    return () => h('div', { class: 'panel' }, [
      h('div', { ref: refEl, class: 'frame small' }),
      h('p', null, [
        'Telemetry: opt-in via ',
        h('code', null, 'telemetry: true'),
        '. Fires every 30 s.',
      ]),
      h('button', { onClick: probe }, 'insertText'),
      usage.value
        ? h('table', null, [
            h('tbody', null, [
              h('tr', null, [h('td', null, 'instanceId'), h('td', null, h('code', null, usage.value.instanceId))]),
              h('tr', null, [h('td', null, 'docBytesWritten'), h('td', null, String(usage.value.docBytesWritten))]),
              h('tr', null, [h('td', null, 'aiCalls'), h('td', null, String(usage.value.aiCalls))]),
              h('tr', null, [h('td', null, 'aiTokensIn'), h('td', null, String(usage.value.aiTokensIn))]),
              h('tr', null, [h('td', null, 'sessionDurationMs'), h('td', null, String(usage.value.sessionDurationMs))]),
            ]),
          ])
        : h('p', null, [h('em', null, 'Waiting for first 30 s tick…')]),
    ])
  },
})

// ── Root app ─────────────────────────────────────────────────────────────
const App = defineComponent({
  setup() {
    const state = reactive({ jwt: '', docA: 'doc_split_a', docB: 'doc_split_b' })
    const ready = () => !!state.jwt
    return () => {
      if (!ready()) {
        return h('div', null, [
          h('h1', null, 'Kestrel demo'),
          h('p', null, 'Paste a JWT (mint via POST /api/v1/auth/jwt).'),
          h('input', {
            value: state.jwt,
            'onUpdate:modelValue': (v: string) => { state.jwt = v },
          }),
        ])
      }
      const args: Args = { host: window.location.origin, jwt: state.jwt, documentId: state.docA }
      return h('div', null, [
        h('h1', null, 'SDK 2.0 Kestrel demo'),
        h('p', null, 'Four surfaces in one page.'),
        h('div', { class: 'row' }, [h('label', null, 'JWT'),
          h('input', { value: state.jwt, 'onUpdate:modelValue': (v: string) => { state.jwt = v } })]),
        h('div', { class: 'row' }, [h('label', null, 'doc A'),
          h('input', { value: state.docA, 'onUpdate:modelValue': (v: string) => { state.docA = v } })]),
        h('div', { class: 'row' }, [h('label', null, 'doc B'),
          h('input', { value: state.docB, 'onUpdate:modelValue': (v: string) => { state.docB = v } })]),
        h('h2', null, '1. Multi-instance'),
        h('div', { class: 'split' }, [
          h(VueEditor, { host: args.host, documentId: state.docA, jwt: args.jwt, instanceId: 'split-A' }),
          h(VueEditor, { host: args.host, documentId: state.docB, jwt: args.jwt, instanceId: 'split-B' }),
        ]),
        h('h2', null, '2. Comments API'),
        h(CommentsPanel, { instanceId: 'split-A' }),
        h('h2', null, '3. Plugin Runtime'),
        h(SidebarMountPanel, { args }),
        h('h2', null, '4. Telemetry'),
        h(TelemetryBadge, { args }),
      ])
    }
  },
})

createApp(App).mount('#app')
