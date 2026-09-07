/**
 * enterprise/preview — File preview helper.
 */

import { existsSync, readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { registerHandle } from '../common/registry.js'

export function registerPreviewHandlers(): void {
  registerHandle('preview:get', async (_event: unknown, args: unknown) => {
    const { filePath, width, height, format } = args as {
      filePath: string
      width?: number
      height?: number
      format?: 'thumbnail' | 'full'
    }

    if (!existsSync(filePath as string)) {
      return null
    }

    const ext = extname(filePath as string).toLowerCase()
    const bytes = readFileSync(filePath as string)

    if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext)) {
      return {
        type: 'image',
        base64: bytes.toString('base64'),
        mimeType: `image/${ext.slice(1)}`,
        width: width || 800,
        height: height || 600,
      }
    } else if (ext === '.pdf') {
      return {
        type: 'pdf',
        base64: bytes.toString('base64'),
        pageCount: 1,
      }
    } else if (['.txt', '.md', '.json', '.xml', '.html', '.css', '.js', '.ts'].includes(ext)) {
      return {
        type: 'text',
        content: bytes.toString('utf-8').slice(0, 10000),
        truncated: bytes.length > 10000,
      }
    }

    return {
      type: 'unsupported',
      extension: ext,
      message: `不支持预览 ${ext} 文件`,
    }
  })
}
