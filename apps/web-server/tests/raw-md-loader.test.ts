import { describe, expect, it } from 'vitest'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

/**
 * The raw-md loader is a Node ESM hook that translates `?raw` markdown
 * imports (used by `@genoffice/pptx-ops/src/op-docs.ts` and friends) into
 * `export default <text>;` modules. tsx 4.x runs its own ESM resolver,
 * so we drive the test in a fresh Node subprocess with the loader
 * registered and assert the imported value round-trips the file's text.
 */

const here = fileURLToPath(import.meta.url)
const testsDir = dirname(here)
const webServerRoot = resolve(testsDir, '..')
const loaderPath = resolve(webServerRoot, 'scripts', 'raw-md-loader.mjs')
const registerPath = resolve(webServerRoot, 'scripts', 'register-loaders.mjs')
const scriptsDir = pathToFileURL(resolve(webServerRoot, 'scripts')).href

const registerSnippet = `import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register(${JSON.stringify(loaderPath)}, ${JSON.stringify(scriptsDir)});`

function runWithLoader(programPath: string): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(
      process.execPath,
      ['--import', `data:text/javascript,${encodeURIComponent(registerSnippet)}`, programPath],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ).toString()
    return { stdout, stderr: '', status: 0 }
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number }
    return {
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? '',
      status: e.status ?? 1,
    }
  }
}

function tmpFixture(content: string): { file: string; dir: string } {
  const dir = mkdtempSync(`${tmpdir()}/genoffice-raw-loader-`)
  const file = resolve(dir, 'note.md')
  writeFileSync(file, content, 'utf8')
  return { file, dir }
}

describe('raw-md-loader (apps/web-server/scripts/raw-md-loader.mjs)', () => {
  it('translates `?raw` markdown import into a string export (subprocess)', () => {
    const { file, dir } = tmpFixture('hello\n# world\n')
    // Spawn a child node that imports `<file>?raw` and echoes the default
    // export. The loader must turn the import into a string module so the
    // child never throws ERR_UNKNOWN_FILE_EXTENSION.
    const childProgram = `
      import content from ${JSON.stringify(file + '?raw')}
      process.stdout.write('__RAW_VALUE__' + JSON.stringify(content))
    `
    const childPath = resolve(dir, 'child.mjs')
    writeFileSync(childPath, childProgram, 'utf8')
    const { stdout, stderr, status } = runWithLoader(childPath)
    rmSync(dir, { recursive: true, force: true })
    expect(status).toBe(0)
    expect(stderr).not.toContain('ERR_UNKNOWN_FILE_EXTENSION')
    expect(stdout).toContain('__RAW_VALUE__')
    const json = stdout.split('__RAW_VALUE__')[1] ?? ''
    expect(JSON.parse(json)).toBe('hello\n# world\n')
  })

  it('leaves plain `.md` imports alone (Node still rejects)', () => {
    const { file, dir } = tmpFixture('hello')
    const { stderr, status } = runWithLoader(file)
    rmSync(dir, { recursive: true, force: true })
    expect(stderr).toContain('ERR_UNKNOWN_FILE_EXTENSION')
    expect(status).not.toBe(0)
  })

  it('registers successfully when imported as the `register-loaders` entry', () => {
    const driverPath = resolve(testsDir, '__fixtures__', 'raw-md-loader-register-driver.mjs')
    const driverUrl = pathToFileURL(driverPath).href
    let out = ''
    try {
      out = execFileSync(
        process.execPath,
        [
          '--import',
          `data:text/javascript,${encodeURIComponent(`import(${JSON.stringify(pathToFileURL(registerPath).href)})`)}`,
          driverUrl,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      ).toString()
    } catch (err) {
      const e = err as { stdout?: Buffer | string; stderr?: Buffer | string }
      out = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '')
    }
    expect(out).toContain('[register-loaders] done')
  })
})
