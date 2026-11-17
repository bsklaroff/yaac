#!/usr/bin/env node
// The `BROWSER` a test gives `yaac auth update`: "opens" the sign-in URL by
// fetching it, which follows the fake vendor's approve-at-once redirect
// (fake-vendor-oauth.ts) to the CLI's loopback listener, as a browser would.
fetch(process.argv[2]).catch((err) => {
  console.error(`fake browser: ${err.message}`)
  process.exit(1)
})
