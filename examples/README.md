# GenOffice Examples

Worked examples for integrating GenOffice into a host application. Each
folder is a standalone npm project — copy it as a starting point or follow
its README for the canonical integration pattern.

## Layout

| Folder | Pattern | What it shows |
|---|---|---|
| `embed-basic/` | Plain HTML + `<script>` UMD | Smallest possible iframe Embed, with and without the SDK. |
| `embed-react/` | React 18 + Vite | Reusable `<GenOfficeEditor>` component with typed props. |
| `embed-vue/` | Vue 3 + Vite | Reusable `<GenOfficeEditor>` SFC with typed events. |
| `custom-provider/` | Standalone npm package | Building a third-party `AiProviderPlugin` and shipping it via the marketplace. |
| `custom-skill/` | Standalone npm package | Building a third-party `SkillPackage` and shipping it via the marketplace. |

## Common setup

Every example assumes a local GenOffice web-server on `http://localhost:18082`:

```sh
# In the monorepo root
pnpm --filter @genoffice/web-server dev    # serves the editor + REST API

# In another terminal
curl -X POST http://localhost:18082/api/v1/auth/jwt \
  -H 'Content-Type: application/json' \
  -d '{"sub":"demo-user"}'
```

The token printed by that curl is what every example's "JWT" field wants.

## Installing an example

```sh
cd examples/embed-react      # or any of the others
pnpm install
pnpm dev                      # opens a dev server on the example's port
```

For `custom-provider/` and `custom-skill/` (which are npm-publishable
packages, not runnable apps):

```sh
cd examples/custom-provider
pnpm install
pnpm run build                # → dist/{index.js,index.mjs,index.cjs,index.d.ts}
```

Then drop the package into your web-server's `genoffice.providers.json` or
`genoffice.skills.json` and restart the server — the marketplace loader
picks it up at boot.
