// M0 boot smoke: start the loopback UI host from the built bundle, serving
// the docs renderer from the repo checkout (tier-3 asset resolution).
const { startUiHost } = require('../dist/host.cjs')

async function main() {
  const host = await startUiHost({ port: Number(process.env.SMOKE_PORT || 0) })
  console.log(`UI host on ${host.url}`)
  console.log(`channels: ${host.context.registry.handlerCount()}`)
  console.log(`docs page: ${host.url}/docs`)
  process.on('SIGINT', () => {
    void host.close().then(() => process.exit(0))
  })
  setInterval(() => {}, 1 << 30)
}
main().catch((err) => {
  console.error(err)
  process.exit(1)
})