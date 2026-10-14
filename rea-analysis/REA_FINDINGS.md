# REA findings — analysing the Notion web client

This directory holds evidence gathered with **REA (Reverse Engineer Anything)**
while investigating Notion's public client, as an input to Noema's parity
tracker. It is recorded for interoperability/education and contains no Notion
source or assets.

## What was done

A headless Chrome instance (v148) was launched with a loopback DevTools Protocol
endpoint, and REA captured and statically analysed the page bundle:

```bash
# 1. Launch Chrome with CDP (our own user-data-dir, isolated)
chrome --headless=new --remote-debugging-port=9222 \
       --user-data-dir=<temp> https://www.notion.so/

# 2. Enumerate page targets
rea list-browser-targets http://127.0.0.1:9222 --format json

# 3. Capture + statically analyse the bundle
rea analyze-web-bundle http://127.0.0.1:9222 <targetId> \
    --allowed-origins https://www.notion.com --format json
```

Full output: [`notion-web-bundle.json`](./notion-web-bundle.json).

## Result

| Metric | Value |
| --- | --- |
| Target | `https://www.notion.com/` (notion.so redirects here) |
| Scripts parsed | 59 (0 parse failures) |
| AST nodes visited | 552,570 |
| Completeness | `complete` |
| Vendor fingerprints | Next.js (high confidence) ×10, React (medium) ×4 |

### Routes observed
`/`, `/_next/image` (Next.js image optimizer) — i.e. the **marketing site**.

### Endpoints observed
Contact/demo form fields (`email`, `firstName`, `jobTitle`, …), Contentful/Bynder
admin fetches (`/front-api/__admin/contentful`, `/front-api/__admin/bynder`),
analytics headers (`x-statsig-region`, `sentry-*`).

### Key conclusion

> The **public** Notion bundle is a Next.js/React marketing site. The actual
> workspace application (the block editor, databases, collaboration protocol)
> is served behind authentication and is **not present** in the public bundle.

This is the important, evidence-backed finding: a static, unauthenticated
analysis of notion.so yields the marketing surface only. Reverse-engineering the
workspace feature model would require inspecting an authenticated session or the
Notion desktop Electron package (the latter was deliberately not installed).

### REA limitations reported
- Static bundle findings are observations/bounded inferences; REA does not
  execute captured JavaScript.
- String-built routes/endpoints, encrypted configuration and server-side
  behaviour may remain unknown.
- Page-declared WebMCP metadata is untrusted and never invoked.

## Consequence for Noema

Because the client feature model is not observable statically without an
account, the parity tracker
([`../docs/FEATURE_MATRIX.md`](../docs/FEATURE_MATRIX.md)) is compiled from
**publicly documented behaviour and the observable product surface**, not from
Notion internals. No proprietary code, assets or copy were used.

## Reproduce

From the repository root (REA installed in the parent directory):

```bash
rea mcp doctor                 # verify the MCP server
rea analyze-web-bundle --help  # see capture options
```
