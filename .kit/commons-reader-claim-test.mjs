#!/usr/bin/env node
// commons-reader-claim-test.mjs: Asserts that the commons store holds a reader claim.
//
// Usage: node .kit/commons-reader-claim-test.mjs <store-file>
// Exits 0 on success, 1 on failure.

import { readFileSync } from "node:fs";
import path from "node:path";

const storeFile = process.argv[2];
if (!storeFile) {
  console.error("Usage: node .kit/commons-reader-claim-test.mjs <store-file>");
  process.exit(1);
}

let store;
try {
  const raw = readFileSync(storeFile, "utf8");
  store = JSON.parse(raw);
} catch (e) {
  console.error(`FAIL: could not read store file: ${e.message}`);
  process.exit(1);
}

// Check for reader claim
const readerClaimKey = "reader:default";
if (store[readerClaimKey]) {
  const record = store[readerClaimKey];
  if (record.holder) {
    console.log(`OK: reader claim exists with holder: ${record.holder}`);
    process.exit(0);
  } else {
    console.error("FAIL: reader claim exists but has no holder");
    process.exit(1);
  }
} else {
  console.error("FAIL: no reader claim in store");
  process.exit(1);
}
