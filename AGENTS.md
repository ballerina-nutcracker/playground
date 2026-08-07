# AGENTS.md

[Ballerina Playground](https://play.ballerina.io/) is a web-based tool for trying out Ballerina. This repository implements it: the web frontend loads `ballerina.wasm` and provides the editor and runner UI, built from the [Ballerina](https://github.com/ballerina-nutcracker/ballerina) sources (see the submodule under `packages/wasm/`).

## Repository structure

Workspaces are declared in the root `package.json` as `apps/*` and `packages/*`.

| Path            | Package            | Role                                                |
| --------------- | ------------------ | --------------------------------------------------- |
| `apps/web`      | `@playground/web`  | Frontend: Vite + React; consumes the WASM artifact. |
| `packages/wasm` | `@playground/wasm` | Builds `ballerina.wasm` with Go.                    |

Nested `package.json` files under paths like `packages/wasm/ballerina/.../testdata/` belong to upstream fixtures, not to this Bun workspace.

## Commands

Use **Bun** for installs and scripts. Do **not** use npm, pnpm, or yarn.

Run a script in one workspace package with `--filter`, for example:

- `bun run --filter @playground/web dev`

Useful root scripts:

- `bun dev` / `bun build` — Turbo across workspaces
- `bun format` — Biome format (write)
- `bun lint` / `bun lint:fix` — Biome check (and auto-fix)

## Web application

Guidance for `apps/web` and related frontend work:

- **shadcn UI primitives** live under `apps/web/src/components/ui/`. **Do not edit files in that directory** unless it is clearly necessary (for example, a defect that cannot be fixed by composing or wrapping components elsewhere). Prefer new or adjusted code outside `ui/`.

## Task completion

Before considering work **complete**, `bun format` and `bun lint` must succeed at the repository root.
