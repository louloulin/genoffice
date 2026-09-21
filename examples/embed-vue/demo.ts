import { createApp, reactive, ref } from 'vue'
import GenOfficeEditor from './GenOfficeEditor.vue'
import type { EditorApp, EditorTheme, EditorToolbar } from '@genoffice/web-sdk'

const state = reactive({
  jwt: '',
  docId: 'doc_demo',
  app: 'docs' as EditorApp,
  theme: 'auto' as EditorTheme,
  toolbar: 'full' as EditorToolbar,
  logs: [] as string[],
})
const log = (s: string) => state.logs.unshift(`${new Date().toISOString().slice(11, 19)}  ${s}`) && (state.logs = state.logs.slice(0, 30))

createApp({
  components: { GenOfficeEditor },
  setup() {
    return { state, log }
  },
  template: `
    <h1>GenOffice Embed — Vue demo</h1>
    <p>Paste a JWT from <code>POST /api/v1/auth/jwt</code>, then mount.</p>
    <div class="row"><label>JWT</label><input v-model="state.jwt" placeholder="eyJ…" /></div>
    <div class="row"><label>Document ID</label><input v-model="state.docId" /></div>
    <div class="row">
      <label>App</label>
      <select v-model="state.app">
        <option value="docs">docs</option><option value="sheets">sheets</option>
        <option value="slides">slides</option><option value="pdf">pdf</option>
        <option value="markdown">markdown</option><option value="html">html</option>
      </select>
    </div>
    <div class="row">
      <label>Theme</label>
      <select v-model="state.theme">
        <option value="auto">auto</option><option value="light">light</option><option value="dark">dark</option>
      </select>
    </div>
    <div class="row">
      <label>Toolbar</label>
      <select v-model="state.toolbar">
        <option value="full">full</option><option value="minimal">minimal</option><option value="none">none</option>
      </select>
    </div>
    <div v-if="state.jwt && state.docId" class="frame-wrap">
      <GenOfficeEditor
        :host="window.location.origin"
        :document-id="state.docId"
        :app="state.app"
        :jwt="state.jwt"
        :theme="state.theme"
        :toolbar="state.toolbar"
        @ready="log('✓ ready (' + state.app + ')')"
        @saved="(e) => log('✓ saved v' + e.version)"
        @dirty-changed="(e) => log('· dirty=' + e.dirty)"
        @error="(e) => log('!! ' + e.code + ': ' + e.message)"
        @closed="log('· closed')"
      />
    </div>
    <div class="log">
      <p v-for="(l, i) in state.logs" :key="i" style="margin:0">{{ l }}</p>
    </div>
  `,
}).mount('#app')
