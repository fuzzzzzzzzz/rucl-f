import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { relative, resolve, sep } from 'node:path'
import v8 from '@vitest/coverage-v8'
import { V8CoverageProvider } from '@vitest/coverage-v8/dist/provider.js'

const cloudRoot = fileURLToPath(new URL('../cloudfunctions/', import.meta.url))

// Cloud functions are loaded by Node require(), not Vite's module runner.
// Use their executed bytes when remapping native V8 offsets. Never change hits,
// thresholds, exclusions, or the normal TypeScript source-map handling.
export class NativeCloudV8CoverageProvider extends V8CoverageProvider {
  async getSources(url, transform, functions = []) {
    const filename = fileURLToPath(url)
    const path = relative(cloudRoot, filename)
    if (
      !path.startsWith(`..${sep}`) &&
      !path.startsWith('..') &&
      resolve(cloudRoot, path) === filename &&
      path.endsWith('.js') &&
      !path.split(sep).includes('node_modules')
    ) {
      return { code: await readFile(filename, 'utf8') }
    }
    return super.getSources(url, transform, functions)
  }
}

export default {
  ...v8,
  getProvider: () => new NativeCloudV8CoverageProvider(),
}
