# @keyset/cli

The `keyset` command line: sign in from the browser, forward Keyset's signed webhook events to a local
endpoint while you build, create sample events, resend past ones and read the API. Node 24 or newer, no dependencies
beyond Node itself. Licence: MIT. Documentation: [keyset.dev](https://keyset.dev/cli/).

## Install

```bash
npm install -g @keyset/cli
keyset --help
```

Or run it once with `npx @keyset/cli --help`. From the Keyset repository: `bun --filter @keyset/cli run build`, then
`node packages/cli/dist/main.js`.

## Stability

The CLI is versioned 0.x. A minor release may change a command, a flag or its output, and the [changelog](./CHANGELOG.md)
says so each time. The API it talks to follows the stability rule on [keyset.dev](https://keyset.dev/stability/).

## Sign in

```bash
keyset login
```

The CLI prints a code and opens the Keyset page that Keyset names in its answer, `/cli?code=…` on the app (or prints the address with `--no-browser`). Sign in,
check the code is the one in your terminal, pick the Property and confirm. Keyset makes a read-only key named after
your machine, valid for 90 days, and the CLI keeps it in `${XDG_CONFIG_HOME:-~/.config}/keyset/config.json` (0600).
Without `--api` the CLI signs in to production, `https://api.keyset.cloud`; `--api` names another deployment.

`keyset status` shows where you are signed in; `keyset logout` deletes the stored file. The key stays valid until it
is revoked in Einstellungen › Entwickler, where CLI keys are listed like any other.

## Listen

```bash
keyset listen --forward-to http://localhost:3000/webhooks
keyset listen --forward-to http://localhost:3000/webhooks --events reservation.confirmed,reservation.cancelled
```

`listen` starts after the newest event, checks for new ones every two seconds and posts each to your address with the
body and headers of a real delivery (`webhook-id`, `webhook-timestamp`, `webhook-signature`, Standard Webhooks). It
prints its signing secret on start; configure your receiver with it. The secret is made at the first login and kept
when you sign in again, so you configure it once. A failed local answer is printed and not retried. Live keys may
listen; their events carry `livemode: true` only against production.

## Trigger

```bash
keyset trigger reservation.confirmed
```

Asks Keyset for one sample event of any of the eight public types. Only test keys may do this; the CLI refuses a live
key before sending anything. A sample is built from the Property's latest booking or block, or from a made-up one on
its first apartment, so the references it names may not exist. It shows up in `keyset listen` within a few seconds and
is delivered to the Property's subscribed webhook endpoints too.

## Events, reading the API, completion

```bash
keyset events list --type payment.received --limit 5
keyset events resend evt_… --forward-to http://localhost:3000/webhooks
keyset get events -d type=payment.received -d limit=5
keyset get reservations/<id>
keyset listen --print-json | jq .type
keyset listen --forward-to https://localhost:3443/webhooks --skip-verify -H "X-Debug: 1"
source <(keyset completion bash)
```

`events list` shows the newest events of the last thirty days; `events resend` posts one of them to your address again,
signed like `listen`. `get` reads any `/v1/` path with the stored key (a path without a leading slash is under the
signed-in Property) and prints the JSON. `--print-json` writes each event's body as one line on stdout and every message
to stderr. `-H` adds a header to each forwarded post; it cannot replace the signature headers or the content type.
`--skip-verify` accepts a self-signed certificate, and only for an address on this machine.

## CI

```bash
export KEYSET_API_KEY=sk_test_ks1_…  KEYSET_PROPERTY_ID=…  KEYSET_API=https://api-staging.keyset.cloud
export KEYSET_WEBHOOK_SECRET=whsec_…   # optional; otherwise listen makes one per run and prints it
keyset listen --forward-to http://localhost:3000/webhooks
```

With `KEYSET_API_KEY` set, the stored login is not used. Make the key in Einstellungen › Entwickler and keep it in the
CI's secret store; there is no `--api-key` argument, because arguments show in `ps` and the shell history.

## Tests

```bash
bun --filter @keyset/cli run test
```
