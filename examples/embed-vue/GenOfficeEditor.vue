<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { createEditor, type EditorHandle, type EditorApp, type EditorTheme, type EditorLang, type EditorToolbar, type SavedEvent, type DirtyChangedEvent, type ErrorEvent } from '@genoffice/web-sdk'

const props = defineProps<{
  host: string
  documentId: string
  app: EditorApp
  jwt: string
  theme?: EditorTheme
  lang?: EditorLang
  toolbar?: EditorToolbar
}>()

const emit = defineEmits<{
  ready: []
  saved: [e: SavedEvent]
  dirtyChanged: [e: DirtyChangedEvent]
  error: [e: ErrorEvent]
  closed: []
}>()

const containerRef = ref<HTMLDivElement | null>(null)
let editor: EditorHandle | null = null

onMounted(() => {
  if (!containerRef.value) return
  editor = createEditor({
    host: props.host,
    documentId: props.documentId,
    app: props.app,
    jwt: props.jwt,
    theme: props.theme,
    lang: props.lang,
    toolbar: props.toolbar,
    container: containerRef.value,
    onReady: () => emit('ready'),
    onError: (e) => emit('error', e),
  })
  editor.on('saved', (e) => emit('saved', e))
  editor.on('dirtyChanged', (e) => emit('dirtyChanged', e))
  editor.on('closed', () => emit('closed'))
})

onBeforeUnmount(() => {
  editor?.destroy()
  editor = null
})
</script>

<template>
  <div ref="containerRef" class="genoffice-editor" />
</template>

<style scoped>
.genoffice-editor {
  width: 100%;
  height: 100%;
}
</style>
