import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
export const factoryFixtureRoot = "/srv/bellteam/bots/bot-62c62f61/repos/dotagents-gpt-job-observer-20261025";
export function fixtureExchange(directory: string, expiry: string, phase: string, control: unknown, frame: Uint8Array | null = null): unknown {
  const child = spawnSync("/usr/bin/python3", [join(factoryFixtureRoot, "tests/update/core_observer_fixture.py"), "ordinary", phase, directory, expiry, JSON.stringify(control)],
    { input: frame ?? new Uint8Array(), encoding: "utf8", timeout: 2500, maxBuffer: 16384, stdio: ["pipe", "pipe", "pipe", "pipe"] });
  writeFileSync(join(directory, `${phase}.stderr`), child.stderr ?? "", { mode: 0o600 });
  assert.equal(child.error, undefined); assert.equal(child.status, 0); assert.equal(child.stdout, "");
  const reply = child.output[3]; assert.equal(typeof reply, "string");
  assert.ok(Buffer.byteLength(reply as string) <= 16384);
  writeFileSync(join(directory, `${phase}.reply.json`), reply as string, { mode: 0o600 });
  return JSON.parse(reply as string);
}
