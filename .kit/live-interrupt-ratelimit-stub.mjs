#!/usr/bin/env node
// A local stand-in for the Anthropic API that refuses every request with a
// rate limit, so a real `claude -p` child pointed at it through
// ANTHROPIC_BASE_URL parks in the harness's rate-limit retry wait and spends
// nothing. Used by .kit/live-interrupt-ratelimit-test.sh.
//
// Every request, whatever its method or path, is answered 429 with a reset
// RESET_S seconds away, carried in each header family the harness reads for a
// rate limit: retry-after, the anthropic-ratelimit-{requests,tokens,
// input-tokens,output-tokens}-reset timestamps, and the unified-limit
// status and reset pair. The body is the API's own error shape. Each request
// is appended to the request log as one JSON line holding its arrival time,
// method, path and decoded body, so a caller can read what the child sent.
//
// Usage: node live-interrupt-ratelimit-stub.mjs <port-file> <request-log> [reset-seconds]
// Listens on 127.0.0.1 on a port the OS picks, and writes that port to
// <port-file> once listening, which is the caller's readiness signal.
import http from 'node:http';
import fs from 'node:fs';
import zlib from 'node:zlib';

const [portFile, requestLog, resetArg] = process.argv.slice(2);
if (!portFile || !requestLog) {
  process.stderr.write('usage: live-interrupt-ratelimit-stub.mjs <port-file> <request-log> [reset-seconds]\n');
  process.exit(2);
}
const RESET_S = Number(resetArg) > 0 ? Math.floor(Number(resetArg)) : 14400;

// The harness can compress a request body. A body in an encoding this stub
// cannot decode is kept as base64, so the log still records that it arrived.
function decodeBody(raw, encoding) {
  try {
    switch ((encoding || '').toLowerCase()) {
      case '': case 'identity': return raw.toString('utf8');
      case 'gzip': return zlib.gunzipSync(raw).toString('utf8');
      case 'deflate': return zlib.inflateSync(raw).toString('utf8');
      case 'br': return zlib.brotliDecompressSync(raw).toString('utf8');
      case 'zstd': return zlib.zstdDecompressSync(raw).toString('utf8');
      default: return 'base64:' + raw.toString('base64');
    }
  } catch (e) {
    return 'undecodable:' + raw.toString('base64');
  }
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const now = Date.now();
    const body = decodeBody(Buffer.concat(chunks), req.headers['content-encoding']);
    fs.appendFileSync(requestLog, JSON.stringify({ at: now, method: req.method, url: req.url, body }) + '\n');
    const resetMs = now + RESET_S * 1000;
    const resetIso = new Date(resetMs).toISOString();
    res.writeHead(429, {
      'content-type': 'application/json',
      'retry-after': String(RESET_S),
      'x-should-retry': 'true',
      'request-id': 'req_stub_' + now,
      'anthropic-ratelimit-requests-limit': '50',
      'anthropic-ratelimit-requests-remaining': '0',
      'anthropic-ratelimit-requests-reset': resetIso,
      'anthropic-ratelimit-tokens-limit': '40000',
      'anthropic-ratelimit-tokens-remaining': '0',
      'anthropic-ratelimit-tokens-reset': resetIso,
      'anthropic-ratelimit-input-tokens-limit': '40000',
      'anthropic-ratelimit-input-tokens-remaining': '0',
      'anthropic-ratelimit-input-tokens-reset': resetIso,
      'anthropic-ratelimit-output-tokens-limit': '8000',
      'anthropic-ratelimit-output-tokens-remaining': '0',
      'anthropic-ratelimit-output-tokens-reset': resetIso,
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-reset': String(Math.floor(resetMs / 1000)),
    });
    res.end(JSON.stringify({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'This request would exceed the rate limit for your organization. Please try again later.' },
    }));
  });
});

server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(portFile, String(server.address().port));
});
