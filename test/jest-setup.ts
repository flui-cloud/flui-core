import * as http from 'node:http';
import * as https from 'node:https';

/**
 * No connection pooling inside the test process.
 *
 * Node 19 turned `http.globalAgent.keepAlive` on by default, and supertest
 * opens a fresh ephemeral port for **every request** — `serverAddress()` calls
 * `app.listen(0)` when the server has no address, and `end()` calls
 * `server.close()` once the response is in (supertest 7.1.4,
 * `lib/test.js:63` and `:134`). The pooled socket outlives the port it was
 * keyed on.
 *
 * Both halves were measured on this machine:
 *   - after `server.close()`, a socket was still in `globalAgent.freeSockets`
 *     in 40 of 40 iterations;
 *   - when the same port is then handed to a new server, the pooled socket is
 *     picked up and the request dies (`ECONNRESET`/`socket hang up`, or a
 *     truncated response, which is what `Parse Error: Expected HTTP/` is);
 *     with `keepAlive: false` the identical sequence answers 200.
 *
 * The ephemeral port coming back is what makes it rare — 0 times in 40 on an
 * idle machine, and far likelier under a full run where many workers are
 * churning ports. It is the only mechanism found that produces that error in
 * these suites, and the flake it is aimed at
 * (`auth/controllers/api-keys.controller.spec.ts`, roughly one run in three)
 * was NOT reproduced here — 3 full runs and 8 focused runs, 0 occurrences — so
 * this is a mechanism removed, not a repair demonstrated.
 */
// Cast because `keepAlive` is an `AgentOptions` field that @types/node does
// not re-declare on `Agent`, though the runtime reads it on every request.
const noPooling = (agent: http.Agent): void => {
  (agent as unknown as { keepAlive: boolean }).keepAlive = false;
  agent.destroy();
};
noPooling(http.globalAgent);
noPooling(https.globalAgent);
