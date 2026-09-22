import { register } from "node:module"
import { pathToFileURL } from "node:url"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
process.stderr.write("[register-loaders] starting\n")
const here = dirname(fileURLToPath(import.meta.url))
const loaderUrl = resolve(here, "raw-md-loader.mjs")
process.stderr.write("[register-loaders] registering " + loaderUrl + "\n")
register(loaderUrl, pathToFileURL(here))
process.stderr.write("[register-loaders] done\n")
