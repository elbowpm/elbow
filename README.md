# Elbow

Names and versions for [Bend](https://bend-lang.com/) hub packages. Elbow writes hub hashes into Bend imports and records the exact package graph in `elbow.lock`. Bend still runs the program; Elbow does not install `node_modules`.

## Install

Elbow is a standalone binary for macOS and Linux (including WSL), x64 or arm64. It runs programs with [Bend 2.0.25](https://bend-lang.com/install.sh), so install Bend first. Then install Elbow:

```sh
curl -fsSL https://elbow.paymahn.workers.dev/install.sh | sh
```

The script downloads the binary for your platform from the latest [GitHub release](https://github.com/elbowpm/elbow/releases), checks its SHA-256, and puts it in `~/.local/bin`. The script is also published with each release, so you can read it before you run it.

In automation, pin a version instead:

```sh
version=0.2.0 target=linux-x64 # or linux-arm64, darwin-arm64, darwin-x64
name="elbow-${version}-${target}"
curl -fsSLO "https://github.com/elbowpm/elbow/releases/download/v${version}/${name}.tar.gz"
curl -fsSLO "https://github.com/elbowpm/elbow/releases/download/v${version}/${name}.tar.gz.sha256"
shasum -a 256 -c "${name}.tar.gz.sha256" # or sha256sum -c
tar -xzf "${name}.tar.gz"
mkdir -p "$HOME/.local/bin" && mv "${name}/bin/elbow" "$HOME/.local/bin/elbow"
```

Elbow uses the public registry at `https://elbow.paymahn.workers.dev` unless `ELBOW_REGISTRY` is set. [Browse its packages](https://elbow.paymahn.workers.dev/) to see names, versions, and hub hashes.

## Use

In a Bend project with this `main.bend`:

```bend
import Base

def main() -> U32:
  Encoding.nibble(10)
```

Run:

```sh
elbow add encoding@0.1.0  # adds the hash import, elbow.toml, and elbow.lock
bend main.bend             # prints 97
elbow list
elbow update               # only within ranges in elbow.toml
elbow lock                 # refresh the lock after editing imports
elbow install --locked     # verify exact hashes and cached bytes
```

Elbow adds `import 0x9d23342b3ff0307de441520a624274dc/encoding.bend as Encoding`. This manifest and lock are from that example:

```toml
# elbow.toml
[project]
bend = "2.0.25"

[dependencies]
"encoding" = "0.1.0"
```

```json
{
  "format": 1,
  "bend": "2.0.25",
  "dependencies": {
    "encoding": {
      "name": "encoding",
      "version": "0.1.0",
      "hash": "0x9d23342b3ff0307de441520a624274dc",
      "entry": "encoding.bend",
      "range": "0.1.0"
    }
  },
  "packages": [{
    "hash": "0x9d23342b3ff0307de441520a624274dc",
    "files": [{
      "path": "encoding.bend",
      "sha256": "f679249755ca77db50fcd3b81c59481058d62d5b9e0eab3d9606519e4f88223d"
    }],
    "dependencies": []
  }]
}
```
Commit both files and the updated `.bend` imports. `install --locked` can run without the registry or hub when the Bend cache already contains the verified bytes. A registry outage does not change a hash-pinned Bend program.

## Publish

Create a [fine-grained GitHub personal access token](https://github.com/settings/personal-access-tokens/new) for your account with **no repository access and no additional permissions**, and set a short expiration. The registry asks GitHub `GET /user` for the numeric account ID; GitHub [documents that endpoint as requiring no fine-grained token permissions](https://docs.github.com/en/rest/users/users#get-the-authenticated-user). It does not retain your token. Do not use a broad `gh auth token`: Elbow requires `ELBOW_TOKEN` explicitly. Keep it out of shell history and project files.

```sh
read -r -s ELBOW_TOKEN && export ELBOW_TOKEN # enter token without echoing it
elbow publish path/to/package.bend my-package@1.0.0
unset ELBOW_TOKEN
```

Publishing uploads the Bend package to the hub, then registers its immutable name/version/hash. The first GitHub account ID to publish a name owns it. Publishing requires network access; installing does **not** require a token. `add`, `list`, `install --locked`, and `publish` warn when a verified hub manifest contains `.c` or `.js` files (including transitive packages). Inspect those files before running the package: foreign effects execute host code and Bend proofs do not cover them.

## Develop

Development needs [Bun 1.4.2](https://bun.sh/docs/installation). `bun elbow.ts help` prints the available commands, and `bun build --compile elbow.ts --outfile elbow` builds the standalone binary. CI builds that binary, then exercises it against the deployed registry and a real hub package. The registry Worker, D1 schema, and deployment workflow are maintained separately in a private repository.
