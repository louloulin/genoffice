# `@genoffice/provider-my-provider` — third-party provider template

Worked example of shipping an `AiProviderPlugin` as an npm package. Drop
the built `dist/` into `genoffice.providers.json` and the web-server picks
it up at boot.

## Build

```sh
pnpm install
pnpm run build       # → dist/{index.js,index.mjs,index.cjs,index.d.ts}
```

## Install

Add to your web-server's `genoffice.providers.json`:

```json
{
  "providers": [
    { "name": "@genoffice/provider-my-provider", "version": "^0.1.0" }
  ]
}
```

On boot the marketplace loader dynamically imports the package, registers
the default export into `getDefaultProviderRegistry()`, and from that point
`chatForProvider('my-provider', ...)` / `streamForProvider('my-provider', ...)`
route through your implementation.

## What's inside

`src/index.ts` implements `AiProviderPlugin` with:

- `chat(request, { apiKey, model })` — one-shot completion.
- `streamChat(request, { apiKey, model })` — streaming completion, async generator.
- `validate({ apiKey })` — optional key-shape check.
- `id`, `label`, `models`, `defaultModel`, `keyPlaceholder` — UI metadata.

Replace the `fetch(...)` calls with calls to your real provider.

## Test

The package is plain TypeScript — copy `src/index.ts`, install
`@genoffice/ai-provider` as a `peerDependency`, and write a vitest suite
that mocks `fetch` and asserts on the plugin's outbound request shape.

A reference implementation (Anthropic) lives at
`packages/provider-anthropic/src/index.ts` in the main monorepo.
