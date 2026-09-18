import { translateFile, defaultOutputPath, isSupportedExtension, extractTranslationText } from '@genoffice/translation-core'
import { existsSync } from 'node:fs'

const input = '/tmp/pdf-test/test.pdf'
console.log('input:', input, existsSync(input) ? 'OK' : 'MISSING')
console.log('supported:', isSupportedExtension('.pdf'))
console.log('default output:', defaultOutputPath(input, 'zh-CN'))
const txt = await extractTranslationText(input)
console.log('extracted chars:', txt.length)
console.log('preview:', txt.slice(0, 200).replace(/\n/g, ' '))
