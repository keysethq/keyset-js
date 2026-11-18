# keyset-js

The TypeScript SDK and the command line for [Keyset](https://keyset.dev), the booking platform for small
accommodation businesses.

| Package | What it is | npm |
|---|---|---|
| [`@keyset/sdk`](./packages/sdk) | Typed client for the Keyset booking API: search, quote, check out, read the outcome, manage bookings with a server key. Zero dependencies. | `npm install @keyset/sdk` |
| [`@keyset/cli`](./packages/cli) | The `keyset` command: sign in, forward webhook events to your machine, create sample events, read the API. | `npm install -g @keyset/cli` |

Start with the [documentation](https://keyset.dev) and the package READMEs. Both packages are MIT licensed.

## This repository is a mirror

Keyset's source lives in a private repository. This repository holds only the two packages above, assembled from it for
every release, and npm releases are built here with provenance, so you can see what a published tarball was made from.
That has two consequences. Issues are welcome, and a pull request is welcome as a description of what you would
change; it cannot be merged here, because the next mirror run would overwrite the merge. Security reports go to the
address in [SECURITY.md](./SECURITY.md), not into an issue.

## Working on it

```sh
bun install --frozen-lockfile
bun run build
bun run typecheck
bun run test
bun run sdk:pack   # pack, install into a project outside this tree and run it
bun run cli:pack
```
