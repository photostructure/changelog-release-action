# changelog-release-action

A GitHub Action that drives PhotoStructure's npm release workflows from
`CHANGELOG.md`:

1. The maintainer writes the release notes under
   `## [Unreleased (patch|minor|major)]`, or `## [Unreleased (X.Y.Z)]` when the
   release must have a particular version. The heading names the version bump,
   so starting a release asks no questions.
2. The release job bumps the version, then renames that heading to
   `## [X.Y.Z] - YYYY-MM-DD` in the signed release commit.
3. The publish job stages the package on npm, then keeps running: it checks
   npm every 5 minutes, for up to 5 hours 45 minutes, for the new version.
4. The maintainer reviews the staged package and approves it with 2FA. At its
   next check, the publish job finds the version on npm and creates the
   GitHub release, with that section above GitHub's generated notes.

GitHub emails watchers the release body when the release is published, and
later edits send no new email. That is why the GitHub release waits for npm,
so the email announces a package that installs, and why it carries the
CHANGELOG notes from the start.

## CHANGELOG.md format

The file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), with
the bump in the Unreleased heading:

```markdown
# Changelog

## [Unreleased (minor)]

- ✨ Added the `foo` option.

## [1.2.3] - 2026-01-02

- 🐞 Fixed the bar.

[1.2.3]: https://github.com/owner/repo/releases/tag/v1.2.3
```

- Exactly one heading may mention "Unreleased", in any case or heading level.
  Near misses such as `## Unreleased (minor)` fail with the exact fix rather
  than "no heading".
- The bump is `patch`, `minor`, `major`, or an exact `X.Y.Z` version without
  leading zeros, such as `## [Unreleased (13.61.0)]`. `npm version` takes
  either form, so a caller can pass the `bump` output to it unchanged. A
  caller that checks the output against `patch|minor|major` must also accept
  `X.Y.Z`. `stamp` fails when the heading names a version other than the
  tag's. A bare `## [Unreleased]` names no bump. Between releases that is the
  right state; releasing from it fails.
- The section needs at least one non-blank line before the next `## ` heading.
- Link definitions (`[1.2.3]: <url>`) are newest first. `stamp` adds the new
  one above the first existing one, or at the end of the file if there are
  none.

## Commands

Set the `command` input to one of these.

| Command        | Reads                                    | Does                                                                                                                                        | Inputs |
| -------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `bump`         | `./CHANGELOG.md` (needs a checkout)      | Sets the `bump` output to `patch`, `minor`, `major`, or the heading's `X.Y.Z` version.                                                      | none   |
| `stamp`        | `./CHANGELOG.md` (needs a checkout)      | Renames the Unreleased heading to `## [<version>] - <today, UTC>`, adds an empty `## [Unreleased]` above it, and adds `[<version>]: <url>`. | `tag`  |
| `wait-for-npm` | `package.json` at `$GITHUB_SHA`, via API | Runs `npm view <name>@<version>` at once, then every 5 minutes for up to 345 minutes, until npm serves it.                                  | `tag`  |
| `notes`        | `CHANGELOG.md` at `$GITHUB_SHA`, via API | Writes the lines under `## [<version>] - ` to `$RUNNER_TEMP/release-notes.md` and sets the `notes-file` output to that path.                | `tag`  |

- `tag` is the release tag. A leading `v` is dropped to get the version, so
  `v1.2.3` and `1.2.3` both mean version 1.2.3.
- `stamp` links the version to
  `$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/releases/tag/<tag>`.
- `wait-for-npm` and `notes` read files through the GitHub API with the
  `token` input (default `${{ github.token }}`), so the publish job needs no
  checkout.
- The action runs on the runner's own Node.js 24 (`using: node24`) and has no
  dependencies, so callers need no `setup-node` step. `wait-for-npm` runs the
  runner image's `npm`.

## Usage

Pin the action by commit SHA, as with every third-party action. The tag in the
comment is for people reading the workflow.

In the workflow that creates the release commit:

```yaml
jobs:
  changelog:
    runs-on: ubuntu-24.04
    outputs:
      bump: ${{ steps.bump.outputs.bump }}
    steps:
      - uses: actions/checkout@<sha> # v7.0.1
        with:
          persist-credentials: false
      - id: bump
        uses: photostructure/changelog-release-action@<sha> # v0.3.1
        with:
          command: bump

  release:
    runs-on: ubuntu-24.04
    needs: changelog
    steps:
      # ... checkout, then a step with id "version" that runs
      #   npm version "${{ needs.changelog.outputs.bump }}" --no-git-tag-version --ignore-scripts
      # and writes tag=v<new version> to $GITHUB_OUTPUT ...
      - uses: photostructure/changelog-release-action@<sha> # v0.3.1
        with:
          command: stamp
          tag: ${{ steps.version.outputs.tag }}
      # ... git add package.json package-lock.json CHANGELOG.md, commit, tag, push
```

`--no-git-tag-version` matters: plain `npm version` commits and tags before
`stamp` runs, so the tag would carry the Unreleased heading and the later
`git tag` would fail.

In the tag-bound publish workflow, after the staging job:

```yaml
github-release:
  runs-on: ubuntu-24.04
  needs: stage
  permissions:
    contents: write
  steps:
    - uses: photostructure/changelog-release-action@<sha> # v0.3.1
      with:
        command: wait-for-npm
        tag: ${{ github.ref_name }}
    - id: notes
      uses: photostructure/changelog-release-action@<sha> # v0.3.1
      with:
        command: notes
        tag: ${{ github.ref_name }}
    - env:
        GH_TOKEN: ${{ github.token }}
        NOTES: ${{ steps.notes.outputs.notes-file }}
        TAG: ${{ github.ref_name }}
      run: |
        # ... the caller's own tag checks: the annotated tag still points at
        # $GITHUB_SHA, and the tag and commit signatures are still verified ...
        gh release create "$TAG" --repo "$GITHUB_REPOSITORY" --verify-tag \
          --notes-file "$NOTES" --generate-notes
```

The action does not check the tag. Tag checks and the `gh release create`
flags (such as `--prerelease`) stay in each caller, because callers differ
there. Run the tag checks after `wait-for-npm`: the tag can move during the
wait, and `notes` reads CHANGELOG.md at `$GITHUB_SHA`, not at the tag.
`--verify-tag` only checks that the tag exists on GitHub.

A repository without a CHANGELOG.md can use `wait-for-npm` alone and keep
`--generate-notes` by itself.

## When it fails

Every failure the maintainer can fix prints a GitHub annotation that says what
to change, on the CHANGELOG.md line when there is one. The job log has the
details below it.

- `bump` or `stamp` failed: fix the Unreleased heading, its notes, a
  duplicate version heading, or a release job that tags a version other than
  the heading names, as the message says. Commit to the default branch, and
  start the release again. Nothing was tagged or published.
- `wait-for-npm` or `notes` could not read a file: GitHub's response is in
  the log. For a 5xx status, or "Could not reach GitHub" (no response at
  all), re-run the job. For a rate limit, wait as long as the message says,
  then re-run the job. Otherwise check the job's `contents` permission. The
  job runs the workflow file at the tag, so the fix ships with the next
  release. To finish this one by hand:
  1. Approve the staged package, then wait until
     `npm view <name>@<version> version --prefer-online` prints the version,
     so the watcher email announces a package that installs.
  2. Confirm what the caller's tag checks confirm: the tag still points at the
     release commit, and its signature is verified.
  3. Save the tag's `## [<version>] - ` section of CHANGELOG.md to a file and
     run
     `gh release create <tag> --verify-tag --notes-file <file> --generate-notes`.
- `wait-for-npm` gave up after 345 minutes: approve the staged package on
  npmjs.com, then re-run the failed job. The tag and the staged package stay
  as they are; no new release is needed.
- `wait-for-npm` failed with an npm error other than E404: the job log has
  npm's output. Fix the cause, such as an npm outage, and re-run the job.
- `notes` found no section: the tag was not made by the release workflow.
  Create the release by hand with
  `gh release create <tag> --verify-tag --generate-notes`.

## Developing

```sh
npm test
```

`changelog.mjs` holds the CHANGELOG parsing, the npm wait loop, and the
`npm view` call, which `changelog.test.mjs` tests, the last against a
stand-in `npm` on `PATH`. `index.mjs` reads the inputs, calls the GitHub API,
and writes the files and outputs. `index.test.mjs` runs it the way the runner
does, against a local stand-in for the GitHub API. Its `wait-for-npm` tests
end at or before the first `npm view`, because every later check comes after
a 5-minute sleep.

## Releasing this action

1. From the repository root, stamp `CHANGELOG.md` with this action's own
   `stamp` command:
   ```sh
   INPUT_COMMAND=stamp INPUT_TAG=vX.Y.Z GITHUB_SERVER_URL=https://github.com \
     GITHUB_REPOSITORY=photostructure/changelog-release-action node index.mjs
   ```
2. Change the `# vA.B.C` comments in the Usage examples above to `# vX.Y.Z`.
3. Commit both as `chore(release): X.Y.Z`, push `main`, then push a signed
   annotated tag `vX.Y.Z` on that commit. Callers pin the tagged commit, so a
   fix found after tagging goes in the next release, not under the tagged
   version's heading.
4. Create the GitHub release for the tag with the `## [X.Y.Z]` section as its
   notes.
5. Update callers to the tagged commit's SHA, from
   `git rev-parse vX.Y.Z^{commit}`. Plain `git rev-parse vX.Y.Z` prints the
   annotated tag object's SHA, which is a different value.
