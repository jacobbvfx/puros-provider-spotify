// Reads `cargo metadata` JSON on stdin and prints the crates linked into the
// release helper with their declared licenses, for the packaged notice file.
import process from 'node:process'

let input = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) input += chunk
const metadata = JSON.parse(input)
const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]))
const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]))
const linked = new Set()
const pending = [metadata.resolve.root]
while (pending.length > 0) {
  const id = pending.pop()
  if (linked.has(id)) continue
  linked.add(id)
  for (const dep of nodes.get(id)?.deps ?? []) {
    // Build scripts and proc-macros run on the build machine, not in the binary.
    if (dep.dep_kinds.some((kind) => kind.kind === null)) pending.push(dep.pkg)
  }
}
const lines = [...linked]
  .map((id) => packages.get(id))
  .filter((pkg) => pkg && pkg.id !== metadata.resolve.root)
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
  .map((pkg) => `${pkg.name} ${pkg.version} — ${pkg.license ?? 'see crate'}${pkg.repository ? ` — ${pkg.repository}` : ''}`)
process.stdout.write([
  'Puros Spotify helper — third-party Rust crates',
  'librespot is an unofficial Spotify client library (MIT); see https://github.com/librespot-org/librespot.',
  '',
  ...lines,
  '',
].join('\n'))
