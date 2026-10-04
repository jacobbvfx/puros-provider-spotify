# Spotify provider for Puros

Spotify catalog and library through the Web API, with local playback prepared by librespot (Premium required, Ogg Vorbis source).

This is a provider plugin for Puros, a macOS music player. Puros itself is closed source; providers are built against the public [Provider SDK](https://github.com/purosapp/puros-provider-sdk).

## Install

1. Download `puros-provider-spotify-<version>.zip` from [Releases](../../releases).
2. In Puros open **Settings → Accounts → Install provider…** and choose the ZIP.
3. Review the permissions and warnings, then install. Updates use **Update from file…** on the installed provider.

## Build from source

Requirements:

- macOS with the Xcode command line tools
- Node.js 22.12 or newer
- cmake (`brew install cmake`), used once to build the pinned ffmpeg
- Rust through rustup (`brew install rustup` or https://rustup.rs); `helper/rust-toolchain.toml` pins the toolchain and both macOS targets.

```sh
npm install
npm run typecheck
npm test
npm run package      # builds helpers, writes release/puros-provider-spotify-<version>.zip
```

`npm run build` runs only the helper build steps from `provider.manifest.json`. `npx puros-provider --help` lists every SDK command. The first build compiles ffmpeg from source and caches it in `~/Library/Caches/puros-build`.

## Releases

GitHub Actions builds every push and pull request on macOS and uploads the package as a workflow artifact. Pushing a tag `v<version>` that matches `version` in `provider.manifest.json` publishes a GitHub release with the ZIP and its `.sha256`. When the repository secret `PUROS_PROVIDER_SIGNING_KEY` holds an Ed25519 publisher key (`npx puros-provider keygen --out=<path outside the repo>`), release packages are signed with it; Puros pins that key on first install.

## License

MIT, see [LICENSE](LICENSE). The package bundles a universal `spotify_helper` built on librespot (license inventory in `helper/dist/SPOTIFY-HELPER-LICENSES.txt`) and the SDK's pinned LGPL ffmpeg build.
