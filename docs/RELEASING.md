# Releasing Chitta

Chitta ships to npm as [`@100xprompt/chitta`](https://www.npmjs.com/package/@100xprompt/chitta).
Releases are **tag-driven**: publishing a **GitHub Release** triggers
[`.github/workflows/publish.yml`](../.github/workflows/publish.yml), which runs the test suite and
then `bun publish`. You never publish from a laptop in the normal flow — you cut a tag and a
release, and CI does the rest.

```
bump version → update CHANGELOG → commit → tag vX.Y.Z → push → GitHub Release ─┐
                                                                                │  (workflow)
                                          bun test (gate) → bun publish ────────┘ → npm
```

## Prerequisites (one-time)

- **`NPM_TOKEN` repo secret.** The publish workflow authenticates with an npm **automation** (or
  granular) token that has **publish** rights to the `@100xprompt` scope. Set it at
  **Settings → Secrets and variables → Actions → New repository secret**, name `NPM_TOKEN`. The
  workflow writes it into `~/.npmrc` at run time; without it, `bun publish` fails with a 401/403.
- **Publish access** to the `@100xprompt` npm org, and push + release permission on the repo.
- `publishConfig.access` is already `public` in `package.json` (required for a scoped package).

## Pre-release checklist

Run from a clean checkout of the branch you're releasing. All must be green:

```bash
bun install --frozen-lockfile
bun run ci          # = bun run typecheck && bun run test  (tsc --noEmit + bun test)
```

- [ ] `bun run typecheck` clean (`tsc --noEmit`).
- [ ] `bun test` green (the full suite).
- [ ] `CHANGELOG.md` updated — a new `## [x.y.z] - YYYY-MM-DD` section, existing entries preserved.
- [ ] `version` in `package.json` bumped (SemVer; see below).
- [ ] **Dry run** the package to inspect the tarball (see [Dry run](#dry-run)).

## Cutting a release

1. **Bump the version** in `package.json` (SemVer — `MAJOR.MINOR.PATCH`):

   ```jsonc
   // package.json
   "version": "0.3.0"
   ```

   Pre-1.0, breaking changes bump the **minor** and features/fixes bump the **patch**, per the note
   at the top of the changelog.

2. **Update `CHANGELOG.md`** — rename the `## [Unreleased]` section to `## [x.y.z] - YYYY-MM-DD`
   (today's date), grouped under Added / Changed / Performance / Fixed. Leave a fresh empty
   `## [Unreleased]` on top for the next cycle.

3. **Commit** the version bump + changelog together:

   ```bash
   git add package.json CHANGELOG.md
   git commit -m "release: vX.Y.Z"
   ```

4. **Tag and push** (tag must match the version, prefixed with `v`):

   ```bash
   git tag vX.Y.Z
   git push origin main --tags
   ```

5. **Create the GitHub Release** for that tag — this is what triggers publishing. Either use the
   GitHub UI (Releases → Draft a new release → pick `vX.Y.Z`), or the CLI:

   ```bash
   gh release create vX.Y.Z --title "vX.Y.Z" --notes-file <(sed -n '/## \[X.Y.Z\]/,/## \[/p' CHANGELOG.md)
   # or just: gh release create vX.Y.Z --generate-notes
   ```

6. **CI publishes.** On `release: published`, `publish.yml` checks out the tag, installs with
   `--frozen-lockfile`, **runs `bun test` as a gate**, writes `NPM_TOKEN` into `~/.npmrc`, and runs
   `bun publish --access public`. If tests fail, nothing is published.

7. **Verify** the new version is live:

   ```bash
   npm view @100xprompt/chitta version
   bunx @100xprompt/chitta@X.Y.Z doctor   # smoke-test the published artifact
   ```

## Dry run

Inspect exactly what would be published — **without** pushing anything to npm:

```bash
bun publish --dry-run
```

This prints the tarball contents and the resolved metadata. The published files are governed by the
`files` array in `package.json` (`src`, `dist`, `assets`, `README.md`, `LICENSE`) — confirm nothing
sensitive is included and that `src/` (the source-on-`bunx` entry, `main` → `./src/index.ts`) is
present.

## Notes & fallbacks

- **The publish workflow does not build a binary or typecheck** — it installs, tests, and publishes
  the source package (users run it via `bunx` on Bun, which ships SQLite + the vector index
  in-process, so there's no native build step). Typecheck lives in `ci.yml` and the pre-release
  checklist; keep `main` green so a release is always publishable.
- **Manual publish (break-glass).** If the workflow is unavailable, from a clean, authenticated
  checkout:

  ```bash
  bun install --frozen-lockfile
  bun run ci                    # typecheck + tests must pass first
  bun publish --access public   # requires local npm auth to the @100xprompt scope
  ```

- **Bad publish?** npm forbids re-publishing the same version. Bump to the next patch and release
  again (avoid `npm unpublish`, which is heavily restricted). `npm deprecate` a broken version if
  needed.
