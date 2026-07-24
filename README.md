# Ballerina Playground

Ballerina playground is a web-based tool for trying out language features, hosted at https://play.ballerina.io/, with the native Ballerina interpreter source at https://github.com/ballerina-nutcracker/ballerina.

## Getting started

### Prerequisites

- Go 1.26 or later
- Bun 1.3.10 or later

### Clone repository

Clone with submodules:

```bash
git clone --recurse-submodules https://github.com/ballerina-nutcracker/playground
```

If you already cloned without submodules:

```bash
git submodule update --init --recursive
```

### Install dependencies

From the repository root:

```bash
bun install
```

### Code structure

- `apps/web/`: Web frontend that loads `ballerina.wasm` and provides the editor/runner UI.
- `packages/wasm/`: Go module that builds `ballerina.wasm` for the browser runtime.
- `packages/wasm/ballerina/`: Ballerina interpreter git submodule used by the WASM runtime.
- `scripts/`: Supporting scripts used for development and maintenance tasks.

### Development

Run the playground in development mode from the repository root:

```bash
bun run dev
```
