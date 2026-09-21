# Contributing to GenOffice

Thanks for taking the time to contribute! GenOffice is an Apache-2.0
open-source project; contributions of all sizes are welcome.

## Development environment

- Node ≥ 22.12 (see `package.json` → `engines`)
- pnpm ≥ 10 (recommended) or npm ≥ 10
- macOS / Linux (Windows WSL2 also works)

## Quick start

```sh
git clone https://github.com/genspark-ai/genoffice.git
cd genoffice
pnpm install
pnpm run predev      # build stale preloads
pnpm run dev         # start the Electron shell + every editor dev server
```

The dev script runs docs / sheets / slides / pdf / markdown / html in
parallel and wires them through the shell. Pick whichever editor you're
working on; the rest can stay idle.

## Code layout

```
apps/*        # the six editors (docs, sheets, slides, pdf, markdown, html)
              # + shell, web-server, sdk
packages/*    # shared libraries (ai-provider, agent-core, docx-engine, …)
docs/         # VitePress site (public documentation)
examples/     # standalone embed / plugin examples
tools/        # build + maintenance scripts (typedoc, ipc-doc generator, …)
```

Apps never import each other; all cross-app sharing goes through a
package. Packages may import other packages but never apps.

## Commit & PR conventions

- **Conventional Commits** — `feat(sheets): …`, `fix(api): …`,
  `docs(guide): …`, `refactor(core): …`, `test(sdk): …`.
- Commit scope is the app or package name when obvious.
- One PR = one change. Drive-by cleanups belong in their own PR.
- PR title ≤ 72 chars; body uses the `.github/PULL_REQUEST_TEMPLATE.md`
  template.
- Rebase on `main` before requesting review.

## Code style

- TypeScript `strict: true` everywhere.
- ESLint + Prettier (root config).
- File names kebab-case; components PascalCase; functions camelCase.
- Public API must carry JSDoc / TSDoc.
- New public functions must come with a test (coverage target: ≥ 80%).

## Tests

```sh
pnpm test                # run everything (monorepo-wide)
pnpm test -w @genoffice/web-server   # single workspace
pnpm --filter @genoffice/web-server typecheck
```

- Each workspace has its own `vitest.config.ts`; the root harness glues
  them.
- For changes that touch a wire protocol (postMessage envelope, IPC
  channel, REST route), add an end-to-end test in `tests/`.
- Do not skip flaky tests — fix them. If you can't, file an issue and
  link it from the test.

## Adding a new IPC channel

1. Find the relevant capability directory (`apps/web-server/src/<area>`).
2. Register the handler with `registerHandle(channelName, fn)`.
3. Add a `registerHandle(channelName, …)` line + JSDoc.
4. Run `node tools/gen-ipc-docs.mjs` to regenerate the IPC reference.
5. Add an integration test under `apps/web-server/tests/`.

## Adding a new public SDK method

1. Extend the typed surface in `apps/sdk/src/types.ts`.
2. Wire the command envelope in `apps/sdk/src/editor.ts`.
3. Bump `apps/sdk/package.json` version (semver).
4. Add a test in `apps/sdk/test/`.
5. Update `apps/sdk/README.md` event / command table.

## Adding a new provider plugin

See `packages/ai-provider/src/provider-plugin.ts`. The minimum surface is
`{ id, label, models, defaultModel, keyPlaceholder, chat, streamChat }`.
A worked example lives in
`packages/ai-provider/tests/provider-plugin.test.ts`.

## Adding a new Skill

See `packages/agent-skills/src/skill-protocol.ts`. The minimum manifest is
`{ id, version, name, description, triggers, inputs, outputs, execute }`.
Place the file under `packages/agent-skills/src/skills/<id>.ts` and
register it in the registry at boot.

## Release process

1. `pnpm changeset` — describe the change and pick a semver bump.
2. PR merges into `main`.
3. GitHub Actions runs `release.yml`:
   - bumps versions across workspaces,
   - publishes `@genoffice/*` packages to npm (with provenance),
   - builds + pushes the Docker image to ghcr.io,
   - deploys the VitePress site to Pages.
4. A GitHub Discussion is opened in `Announcements` linking the changelog.

## Where to ask

- **Bugs / feature requests**: GitHub Issues.
- **Design questions**: GitHub Discussions, category *Design*.
- **Realtime chat**: Discord (link in README).
- **Security**: see `SECURITY.md` — please do NOT file public issues for
  security bugs.

## Code of conduct

This project follows the Contributor Covenant. See `CODE_OF_CONDUCT.md`.
