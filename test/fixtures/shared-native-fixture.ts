import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sha256, type CurrentProduct } from "../../src/update-ledger-contract.js";
import type { CommonJournalNative } from "../../src/update-ledger-native-journal.js";
import type { ReadLease } from "../../src/update-ledger-provider-ports.js";
import { nativeJournalFixture } from "./ledger-native-state.js";

export interface NativeLease { mode: "EX" | "SH"; resources: readonly string[]; signal: AbortSignal; generation?: string; helperPid: number; leaseId: string;
  lockInodes: unknown; filesystem: unknown; assertCurrent(): Promise<void>; }
interface NativeOptions { purpose?: "deployment" | "journal"; parentLease?: unknown; signal?: AbortSignal; onEvent?(event: unknown): void; }
export interface NativeAdapter {
  prepare(resources: readonly string[]): Promise<unknown>;
  withLease<T>(resources: readonly string[], mode: "EX" | "SH", deadline: number, work: (lease: NativeLease) => Promise<T>, options?: NativeOptions): Promise<T>;
  withWriteLease<T>(resources: readonly string[], deadline: number, work: (lease: NativeLease) => Promise<T>): Promise<T>;
  withReadLease<T>(resources: readonly string[], expected: string, deadline: number, work: (lease: NativeLease) => Promise<T>): Promise<T>;
  store: { load(identity: unknown): Promise<unknown>; replace(record: unknown, cas: { expectedGeneration: string | null }): Promise<unknown> };
}
export const fixedNativePath = process.env.GPT_LEDGER_NATIVE_SOURCE;
export const generation = "33333333-3333-4333-8333-333333333333";
export const identity = { product_id: "gpt-connector-rabbit", host_id: "rabbit", owner: { system: "bellteam", id: "bot-7696018a" } };
let create: ((input: { fixtureRoot: string; identity: unknown }) => NativeAdapter) | null = null;
if (fixedNativePath) {
  assert.equal(sha256(await readFile(fixedNativePath)), "64bd2db2522bb5d4cdcc0da0ed0b76890e214f2bbd758181b1cea3643962623e");
  assert.equal(sha256(await readFile(join(dirname(fixedNativePath), "native/linux_helper.py"))), "932e4e88fcafc8c6a53f9c2fa6d56279e8b65f87fc1e840f6a4730520f7c2ff6");
  create = (await import(pathToFileURL(fixedNativePath).href)).createLinuxFixtureNative;
}
export function adapterFor(root: string): NativeAdapter { assert.ok(create, "fixed native source required"); return create({ fixtureRoot: root, identity }); }
export function journalNative(adapter: NativeAdapter, observations: Record<string, unknown>[]): CommonJournalNative {
  return { withLease: (resources, mode, deadline, work, options) => adapter.withLease(resources, mode, deadline, async lease => {
    assert.equal(lease.mode, "EX"); observations.push({ kind: "journal-EX", helperPid: lease.helperPid, leaseId: lease.leaseId, resources: lease.resources, filesystem: lease.filesystem, lockInodes: lease.lockInodes });
    return work(lease as NativeLease & { mode: "EX" });
  }, options) };
}
export function observedReadLease(lease: NativeLease): NativeLease & ReadLease {
  assert.equal(lease.mode, "SH"); assert.equal(lease.generation, generation);
  return lease as NativeLease & { mode: "SH"; generation: string };
}
export async function fixture(name: string) {
  const base = resolve("../../artifacts/2026-10-25-update-ledger-native/fixtures"); await mkdir(base, { recursive: true, mode: 0o700 });
  const root = join(base, randomUUID()); await mkdir(root, { mode: 0o700 }); await mkdir(join(root, "resources"), { mode: 0o700 });
  const prefix = join(root, "resources/deployment"), journal = join(root, "resources/journal"), packageRoot = join(prefix, "package");
  for (const path of [prefix, journal, packageRoot]) await mkdir(path, { mode: 0o700 });
  const manifest = '{"name":"gpt-connector","version":"0.16.3","type":"module"}\n', entry = '// synthetic fixture artifact, no executable client\n';
  await writeFile(join(packageRoot, "package.json"), manifest, { mode: 0o600 }); await writeFile(join(packageRoot, "entry.js"), entry, { mode: 0o600 });
  const manifestHash = sha256(manifest), treeHash = sha256(entry), sourceHash = sha256("synthetic-source-original");
  await writeFile(join(root, "fixture-name.json"), JSON.stringify({ name, scope: "Linux private UUID fixture; synthetic health/trust; no host/http" }) + "\n", { mode: 0o600 });
  const data = nativeJournalFixture(packageRoot, manifestHash), adapter = adapterFor(root), prepared = await adapter.prepare([prefix, journal]);
  return { root, prefix, journal, packageRoot, manifestHash, treeHash, sourceHash, data, adapter, prepared };
}
export async function existingFixture(root: string) {
  const prefix = join(root, "resources/deployment"), journal = join(root, "resources/journal"), packageRoot = join(prefix, "package");
  const manifestHash = sha256(await readFile(join(packageRoot, "package.json")));
  return { root, prefix, journal, packageRoot, data: nativeJournalFixture(packageRoot, manifestHash), adapter: adapterFor(root) };
}
export interface RemoteWitness { body: string; product: CurrentProduct; }
