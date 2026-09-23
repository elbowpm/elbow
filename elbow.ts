#!/usr/bin/env bun
// elbow: names and versions for Bend hub packages.
// The hub stores packages by content hash; elbow maps name@version to that
// hash through the elbow registry and writes the hash into the import lines.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const REGISTRY = process.env.ELBOW_REGISTRY ?? "https://elbow.paymahn.workers.dev";
const BEND = (process.env.BEND ?? "bend").split(" ");
const NAME = /^[a-z][a-z0-9-]*$/;
const VERSION = /^\d+\.\d+\.\d+$/;
// Same grammar as the Bend loader: header lines only, a hub path is 0x<hash>/<entry>.
const HEADER = /^\s*(#.*|import(\s.*)?)?$/;
const IMPORT_LINE = /^(\s*import\s+)(\S+)(\s+as\s+([A-Za-z_]\w*).*)$/;

type Release = { name: string; version: string; hash: string; entry: string };
type Manifest = { project: { bend: string }; dependencies: Record<string, string> };
type Package = { hash: string; files: { path: string; sha256: string }[]; dependencies: string[] };
type Lock = { format: 1; bend: string; dependencies: Record<string, Release & { range: string }>; packages: Package[] };
const LOCK = "elbow.lock";
const HUB = process.env.BEND_HUB ?? "https://hub.bend-lang.com";
const sha = (data: string) => crypto.createHash("sha256").update(data).digest("hex");
const MANIFEST = "elbow.toml";

function manifest(): Manifest {
  if (!fs.existsSync(MANIFEST)) {
    const version = spawnSync(BEND[0], [...BEND.slice(1), "version"], { encoding: "utf8" })
      .stdout?.trim().match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? die("cannot determine Bend version");
    return { project: { bend: version }, dependencies: {} };
  }
  const value = Bun.TOML.parse(fs.readFileSync(MANIFEST, "utf8")) as Partial<Manifest>;
  if (!value.project || !VERSION.test(value.project.bend) || !value.dependencies ||
      Object.entries(value.dependencies).some(([name, range]) =>
        !NAME.test(name) || typeof range !== "string" || !range.trim())) die("invalid elbow.toml");
  return value as Manifest;
}

function saveManifest(value: Manifest): void {
  if (!fs.existsSync(MANIFEST)) {
    fs.writeFileSync(MANIFEST, `[project]\nbend = ${JSON.stringify(value.project.bend)}\n\n[dependencies]\n` +
      Object.entries(value.dependencies).sort(([a], [b]) => a.localeCompare(b))
        .map(([name, range]) => `${JSON.stringify(name)} = ${JSON.stringify(range)}\n`).join(""));
    return;
  }
  const lines = fs.readFileSync(MANIFEST, "utf8").split("\n");
  const start = lines.findIndex((line) => line.trim() === "[dependencies]");
  if (start < 0) die("missing [dependencies] in elbow.toml");
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  const seen = new Set<string>();
  for (let i = start + 1; i < end; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const match = line.match(/^(\s*(?:"([^"]+)"|([a-z][a-z0-9-]*))\s*=\s*)("(?:\\.|[^"])*"|'[^']*')(\s*(?:#.*)?)$/);
    if (!match) die("unsupported dependency line in elbow.toml: " + line);
    const name = match[2] ?? match[3];
    seen.add(name);
    lines[i] = match[1] + JSON.stringify(value.dependencies[name]) + match[5];
  }
  lines.splice(end, 0, ...Object.entries(value.dependencies).filter(([name]) => !seen.has(name))
    .sort(([a], [b]) => a.localeCompare(b)).map(([name, range]) => `${JSON.stringify(name)} = ${JSON.stringify(range)}`));
  fs.writeFileSync(MANIFEST, lines.join("\n"));
}
function checkBend(version: string): void {
  const found = spawnSync(BEND[0], [...BEND.slice(1), "version"], { encoding: "utf8" })
    .stdout?.trim().match(/\b\d+\.\d+\.\d+\b/)?.[0];
  if (found !== version) die(`Bend ${version} required (found ${found ?? "none"})`);
}

function imports(source: string): { hash: string; entry: string }[] {
  const found: { hash: string; entry: string }[] = [];
  for (const line of source.split("\n")) {
    if (!HEADER.test(line)) break;
    const raw = line.match(IMPORT_LINE)?.[2];
    const m = raw && path.posix.normalize(raw).match(/^(0x[0-9a-f]{32,64})\/(.+\.bend)$/);
    if (m) found.push({ hash: m[1], entry: m[2] });
  }
  return found;
}

async function packageGraph(roots: string[], verifyForeignFiles = true): Promise<Package[]> {
  const graph = new Map<string, Package>();
  async function visit(hash: string): Promise<void> {
    if (graph.has(hash)) return;
    if (!/^0x[0-9a-f]{32,64}$/.test(hash)) die("invalid package hash: " + hash);
    const response = await fetch(`${HUB}/${hash}/manifest`);
    if (!response.ok) die("cannot fetch " + hash + " manifest");
    const manifest = await response.text();
    if (!sha(manifest).startsWith(hash.slice(2))) die("invalid manifest hash: " + hash);
    const files = manifest.trim().split("\n").map((line) => {
      const m = line.match(/^([0-9a-f]{64}) ([^ ]+)$/);
      if (!m || m[2].startsWith("/") || m[2].split("/").some((part) => !part || part === "." || part === ".."))
        die("unsafe manifest path: " + line);
      return { path: m[2], sha256: m[1] };
    });
    const dependencies = new Set<string>();
    graph.set(hash, { hash, files, dependencies: [] });
    for (const file of files) {
      if (!verifyForeignFiles && !file.path.endsWith(".bend")) continue;
      const response = await fetch(`${HUB}/${hash}/${file.path}`);
      if (!response.ok) die(`cannot fetch ${hash}/${file.path}`);
      const body = Buffer.from(await response.arrayBuffer());
      if (sha(body) !== file.sha256) die(`invalid file hash: ${hash}/${file.path}`);
      if (file.path.endsWith(".bend")) {
        for (const item of imports(body.toString("utf8"))) dependencies.add(item.hash);
      }
    }
    graph.get(hash)!.dependencies = [...dependencies].sort();
    for (const dep of dependencies) await visit(dep);
  }
  for (const root of roots) await visit(root);
  return [...graph.values()].sort((a, b) => a.hash.localeCompare(b.hash));
}

function warnForeign(packages: Package[]): void {
  for (const pkg of packages) {
    const files = pkg.files.filter((file) => /\.(?:c|js)$/.test(file.path)).map((file) => JSON.stringify(file.path));
    if (files.length) console.warn(`warning: ${pkg.hash} contains foreign code (${files.join(", ")}); it can run host code and Bend proofs do not cover it. Inspect before running.`);
  }
}

async function lock(): Promise<void> {
  if (!fs.existsSync(MANIFEST)) die("no elbow.toml; add a package first");
  const project = manifest();
  checkBend(project.project.bend);
  const direct = bendFiles().flatMap((file) => imports(fs.readFileSync(file, "utf8")));
  const dependencies: Lock["dependencies"] = {};
  for (const [name, range] of Object.entries(project.dependencies).sort()) {
    const imported = direct.filter(({ hash }) => index.some((r) => r.name === name && r.hash === hash));
    if (imported.length === 0) die(`${name} is declared but not imported`);
    const selected = index.find((r) => r.name === name && r.hash === imported[0].hash &&
      Bun.semver.satisfies(r.version, range));
    if (!selected || imported.some(({ hash }) => hash !== selected.hash)) die(`${name} imports disagree with ${range}`);
    dependencies[name] = { ...selected, range };
  }
  for (const item of direct) {
    if (!Object.values(dependencies).some((r) => r.hash === item.hash && r.entry === item.entry))
      die(`unmanaged import: ${item.hash}/${item.entry}`);
  }
  const packages = await packageGraph(Object.values(dependencies).map((r) => r.hash));
  warnForeign(packages);
  fs.writeFileSync(LOCK, JSON.stringify({ format: 1, bend: project.project.bend, dependencies, packages }, null, 2) + "\n");
  console.log(`locked ${packages.length} packages`);
}
async function install(args: string[]): Promise<void> {
  if (args.length !== 1 || args[0] !== "--locked") die("usage: elbow install --locked");
  if (!fs.existsSync(MANIFEST) || !fs.existsSync(LOCK)) die("elbow.toml and elbow.lock are required");
  const project = manifest();
  const data = JSON.parse(fs.readFileSync(LOCK, "utf8")) as Lock;
  if (data.format !== 1 || data.bend !== project.project.bend || !data.dependencies || !Array.isArray(data.packages))
    die("invalid or stale elbow.lock");
  checkBend(data.bend);
  if (Object.keys(project.dependencies).sort().join() !== Object.keys(data.dependencies).sort().join())
    die("manifest and lock dependencies differ");
  for (const [name, range] of Object.entries(project.dependencies)) {
    const dep = data.dependencies[name];
    if (dep?.name !== name || dep.range !== range || !Bun.semver.satisfies(dep.version, range) ||
      !/^0x[0-9a-f]{32,64}$/.test(dep.hash) || !dep.entry.endsWith(".bend"))
      die(`${name} has a stale lock entry`);
  }
  const sources = bendFiles().map((file) => ({ file, imports: imports(fs.readFileSync(file, "utf8")) }));
  const direct = sources.flatMap(({ imports }) => imports);
  for (const dep of Object.values(data.dependencies)) {
    if (!direct.some((i) => i.hash === dep.hash && i.entry === dep.entry)) die(`${dep.name} is not imported`);
  }
  for (const item of direct) {
    if (!Object.values(data.dependencies).some((d) => d.hash === item.hash && d.entry === item.entry))
      die(`unlocked import: ${item.hash}/${item.entry}`);
  }
  const packages = new Map(data.packages.map((p) => [p.hash, p]));
  if (packages.size !== data.packages.length) die("duplicate package in lock");
  const reachable = new Set<string>();
  function visit(hash: string): void {
    if (reachable.has(hash)) return;
    const pkg = packages.get(hash);
    if (!pkg || !/^0x[0-9a-f]{32,64}$/.test(hash) || !Array.isArray(pkg.files) ||
      !Array.isArray(pkg.dependencies)) die("incomplete package graph: " + hash);
    reachable.add(hash);
    for (const dep of pkg.dependencies) visit(dep);
  }
  for (const dep of Object.values(data.dependencies)) visit(dep.hash);
  if (reachable.size !== packages.size) die("unreachable package in lock");
  const lib = path.resolve(process.env.BEND_LIB ?? path.join(os.homedir(), ".bend", "lib"));
  for (const pkg of data.packages) {
    const lines: string[] = [];
    const imported = new Set<string>();
    const actual = new Set<string>();
    for (const file of pkg.files) {
      if (!file || typeof file.path !== "string" || !/^[0-9a-f]{64}$/.test(file.sha256) ||
        file.path.startsWith("/") || file.path.split("/").some((s) => !s || s === "." || s === "..") ||
        actual.has(file.path)) die(`unsafe lock path in ${pkg.hash}`);
      actual.add(file.path);
      lines.push(`${file.sha256} ${file.path}\n`);
    }
    if (!lines.length || !sha(lines.join("")).startsWith(pkg.hash.slice(2))) die(`invalid package manifest: ${pkg.hash}`);
    for (const file of pkg.files) {
      const dest = path.join(lib, pkg.hash, file.path);
      let body: Buffer;
      if (fs.existsSync(dest)) body = fs.readFileSync(dest);
      else {
        const response = await fetch(`${HUB}/${pkg.hash}/${file.path}`).catch(() => undefined);
        if (!response?.ok) die(`cannot fetch ${pkg.hash}/${file.path}`);
        body = Buffer.from(await response.arrayBuffer());
      }
      if (sha(body) !== file.sha256) die(`corrupt package file: ${pkg.hash}/${file.path}`);
      if (!fs.existsSync(dest)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, body);
      }
      if (file.path.endsWith(".bend")) {
        for (const item of imports(body.toString("utf8"))) {
          imported.add(item.hash);
          if (!pkg.dependencies.includes(item.hash) || !packages.get(item.hash)?.files.some((f) => f.path === item.entry))
            die(`unlocked transitive import: ${item.hash}/${item.entry}`);
        }
      }
    }
    if (imported.size !== pkg.dependencies.length || pkg.dependencies.some((d) => !imported.has(d)))
      die(`stale transitive graph: ${pkg.hash}`);
  }
  warnForeign(data.packages);
  for (const { file, imports: used } of sources) {
    if (used.length && !check(file)) die(`Bend check failed: ${file}`);
  }
  console.log(`installed ${packages.size} locked packages`);
}




const HELP = `elbow: names and versions for Bend hub packages.

usage:
  elbow add <name>[@range]... [file] [--as Alias] add imports, manifest, lock (file: main.bend)
  elbow update [name...]                         update within manifest ranges
  elbow lock                                     record exact dependency graph from source imports
  elbow install --locked                         verify and fetch locked packages (no registry)
  elbow list                                     show imported packages and newer versions
  elbow publish <file.bend> <name>@<x.y.z>       publish to the hub, then register the name

env: ELBOW_REGISTRY (${REGISTRY}), ELBOW_TOKEN (fine-grained GitHub token for publish), BEND`;

function die(msg: string): never {
  throw new Error(msg);
}

let index: Release[] = [];

// ponytail: fetches the whole index per run; fetch per name when it grows
async function load(): Promise<void> {
  const res = await fetch(REGISTRY + "/index").catch(() => undefined);
  if (!res?.ok) die("cannot reach the registry " + REGISTRY);
  index = (await res.text()).split("\n").filter(Boolean).map((l) => {
    const [name, version, hash, entry] = l.split(" ");
    return { name, version, hash, entry };
  });
}

function releases(): Release[] {
  return index;
}

function pick(all: Release[], name: string, range = "*"): Release {
  const ok = all.filter((r) => r.name === name && Bun.semver.satisfies(r.version, range));
  if (ok.length === 0) die(`no release of ${name} matches ${range}`);
  return ok.reduce((a, b) => (Bun.semver.order(a.version, b.version) >= 0 ? a : b));
}

function bendFiles(): string[] {
  return (fs.readdirSync(".", { recursive: true }) as string[]).filter((p) =>
    p.endsWith(".bend") && !p.split(path.sep).some((s) => s.startsWith(".") || s === "node_modules"));
}

// Calls fn on each hub import in the header; fn returns a new release to pin, or nothing.
function rewrite(file: string, fn: (hash: string, alias: string) => Release | undefined): boolean {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  let changed = false;
  for (let i = 0; i < lines.length && HEADER.test(lines[i]); i++) {
    const m = lines[i].match(IMPORT_LINE);
    const parsed = m?.[2] && path.posix.normalize(m[2]).match(/^(0x[0-9a-f]{32,64})\/(.+\.bend)$/);
    const r = parsed && fn(parsed[1], m![4]);
    if (m && parsed && r && r.hash !== parsed[1]) {
      lines[i] = m[1] + r.hash + "/" + r.entry + m[3];
      changed = true;
    }
  }
  if (changed) fs.writeFileSync(file, lines.join("\n"));
  return changed;
}

function check(file: string): boolean {
  return spawnSync(BEND[0], [...BEND.slice(1), file, "--check-only"], { stdio: "inherit" }).status === 0;
}

async function add(args: string[]): Promise<void> {
  const at = args.indexOf("--as");
  const alias = at >= 0 ? args.splice(at, 2)[1] : undefined;
  const file = args.find((a) => a.endsWith(".bend")) ?? "main.bend";
  const specs = args.filter((a) => !a.endsWith(".bend"));
  if (specs.length === 0) die("add needs a package name");
  if (alias && specs.length > 1) die("--as takes one package");
  if (!bendFiles().includes(path.normalize(file))) die(`target must be a project .bend file: ${file}`);
  const all = releases();
  const byHash = new Map(all.map((r) => [r.hash, r]));
  const project = manifest();
  if (!fs.existsSync(MANIFEST)) {
    for (const source of bendFiles()) {
      for (const item of imports(fs.readFileSync(source, "utf8"))) {
        const old = byHash.get(item.hash);
        if (!old) die(`cannot adopt unknown import: ${item.hash}`);
        project.dependencies[old.name] = old.version;
      }
    }
  }
  const changed = new Set<string>([file]);
  for (const spec of specs) {
    const [name, range = "*"] = spec.split("@");
    const r = pick(all, name, range);
    let found = false;
    for (const source of bendFiles()) {
      if (rewrite(source, (hash) => {
        if (byHash.get(hash)?.name !== name) return;
        found = true;
        return r;
      })) changed.add(source);
    }
    if (!found) {
      const as = alias ?? name.split("-").filter(Boolean).map((s) => s[0].toUpperCase() + s.slice(1)).join("");
      if (!/^[A-Za-z_]\w*$/.test(as)) die("bad alias: " + as);
      const lines = fs.readFileSync(file, "utf8").split("\n");
      let last = -1;
      for (let i = 0; i < lines.length && HEADER.test(lines[i]); i++) {
        if (/^\s*import\s/.test(lines[i])) last = i;
      }
      lines.splice(last + 1, 0, `import ${r.hash}/${r.entry} as ${as}`);
      fs.writeFileSync(file, lines.join("\n"));
    }
    project.dependencies[name] = range === "*" ? "^" + r.version : range;
    console.log(`${file}: ${name}@${r.version}`);
  }
  saveManifest(project);
  for (const source of changed) if (!check(source)) die(`Bend check failed: ${source}`);
  await lock();
}

async function update(names: string[]): Promise<void> {
  if (!fs.existsSync(MANIFEST) || !fs.existsSync(LOCK)) die("add and lock the project first");
  const project = manifest();
  for (const name of names) if (!project.dependencies[name]) die(`undeclared package: ${name}`);
  const byHash = new Map(releases().map((r) => [r.hash, r]));
  const changed = bendFiles().filter((file) => rewrite(file, (hash) => {
    const cur = byHash.get(hash);
    if (!cur || !project.dependencies[cur.name] || (names.length && !names.includes(cur.name))) return;
    const next = pick(releases(), cur.name, project.dependencies[cur.name]);
    if (next.hash !== hash) console.log(`${file}: ${cur.name} ${cur.version} -> ${next.version}`);
    return next;
  }));
  for (const file of changed) if (!check(file)) die(`Bend check failed after update: ${file}`);
  await lock();
  if (!changed.length) console.log("up to date");
}

async function list(): Promise<void> {
  const all = releases();
  const byHash = new Map(all.map((r) => [r.hash, r]));
  const hashes = new Set<string>();
  for (const file of bendFiles()) {
    rewrite(file, (hash, alias) => {
      const r = byHash.get(hash);
      hashes.add(hash);
      const latest = r && pick(all, r.name).version;
      console.log(`${file}: ${alias} ` + (!r ? `${hash} (not in index)`
        : `${r.name}@${r.version}` + (latest !== r.version ? ` (latest ${latest})` : "")));
      return undefined;
    });
  }
  if (hashes.size) {
    try {
      warnForeign(await packageGraph([...hashes], false));
    } catch (error) {
      console.warn("warning: foreign-code status unknown: " + JSON.stringify(String(error)));
    }
  }
}

async function publish(args: string[]): Promise<void> {
  const [file, spec = ""] = args;
  const [name, version] = spec.split("@");
  if (!file || !fs.existsSync(file)) die("publish needs an existing .bend file");
  if (!NAME.test(name ?? "") || !VERSION.test(version ?? "")) die("publish needs <name>@<x.y.z>, name as " + NAME);
  if (releases().some((r) => r.name === name && r.version === version)) die(`${name}@${version} is already published`);
  const token = process.env.ELBOW_TOKEN;
  if (!token) die("publish needs ELBOW_TOKEN (fine-grained GitHub token)");
  const out = spawnSync(BEND[0], [...BEND.slice(1), file, "--publish"],
    { stdio: ["inherit", "pipe", "inherit"], encoding: "utf8" });
  if (out.status !== 0) die("bend --publish failed");
  const m = out.stdout.match(/^import (0x[0-9a-f]+)\/(\S+) as /m);
  if (!m) die("unexpected bend output:\n" + out.stdout);
  try {
    warnForeign(await packageGraph([m[1]], false));
  } catch (error) {
    console.warn("warning: foreign-code status unknown: " + JSON.stringify(String(error)));
  }
  const res = await fetch(REGISTRY + "/publish", {
    method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ name, version, hash: m[1], entry: m[2] }),
  });
  const msg = (await res.text()).trim();
  if (!res.ok) die(`registry refused ${name}@${version}: ${msg}`);
  console.log(msg);
}

const [cmd, ...rest] = process.argv.slice(2);
const cmds: Record<string, (a: string[]) => void | Promise<void>> = { add, update, list: () => list(), lock, install, publish };
if (!cmd || !cmds[cmd]) {
  console.log(HELP);
  process.exit(cmd && cmd !== "help" && cmd !== "--help" ? 1 : 0);
}
const transactional = cmd === "add" || cmd === "update";
const originals = new Map<string, Buffer | undefined>();
if (transactional) {
  for (const file of [...bendFiles(), MANIFEST, LOCK])
    originals.set(file, fs.existsSync(file) ? fs.readFileSync(file) : undefined);
}
try {
  if (cmd !== "install") await load();
  await cmds[cmd](rest);
} catch (error) {
  for (const [file, original] of originals) {
    if (original === undefined) {
      if (fs.existsSync(file)) fs.rmSync(file);
    } else fs.writeFileSync(file, original);
  }
  console.error("elbow: " + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}
