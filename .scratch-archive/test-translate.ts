import { translateOne, sharedMemory, KnowledgeBase } from '@genoffice/translation-core'
import { chatForProvider, defaultAiSettings } from '@genoffice/ai-provider'

async function main() {
  const settings = {
    provider: 'custom',
    providers: {
      custom: { apiKey: 'ollama', model: 'guoxuter/ov_intent_analysis_sft:v7_q8', baseUrl: 'http://127.0.0.1:11434/v1' }
    }
  }
  console.log('=== direct chatForProvider test ===')
  const r = await chatForProvider(
    settings.provider as any,
    settings.providers.custom,
    'You are a translator. Reply with ONLY the translated text, no quotes or commentary.',
    'Translate to Chinese: Hello world, how are you today?'
  )
  console.log(JSON.stringify(r, null, 2))

  console.log('\n=== translateOne test ===')
  const kb = new KnowledgeBase()
  await kb.load()
  const res = await translateOne(
    { instruction: 'Hello world, how are you today?', sourceLang: 'en', targetLang: 'zh-CN', memoryEnabled: false },
    { provider: settings.provider as any, config: settings.providers.custom, memory: null, knowledgeBase: kb }
  )
  console.log(JSON.stringify(res, null, 2))
}
main().catch(e => { console.error('FAIL:', e.message ?? e); process.exit(1) })
