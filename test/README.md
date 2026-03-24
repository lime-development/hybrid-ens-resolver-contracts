# Tests

Tests are Mocha specs under `test/**/*.test.js`, configured in [`.mocharc.json`](../.mocharc.json). Hardhat is loaded via the test files.

## Current suite

| File | Description |
|------|-------------|
| `HybridResolver.test.js` | Resolver unit tests on the Hardhat network (deployment, CCIP flow, `setAddr`, signers, URLs, interfaces). |

## Commands (from repo root)

```bash
npm test
npm run test:unit      # excludes tests whose title matches "Integration"
npm run test:integration   # only tests whose title matches "Integration"
```

There is no `Integration.test.js` in this repository yet. When you add end-to-end tests against a live gateway (title them with `Integration` in the `describe`/`it` string), `npm run test:integration` will pick them up.
