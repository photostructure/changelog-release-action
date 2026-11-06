# Changelog

## [Unreleased (minor)]

- ✨ The Unreleased heading can name an exact version, such as
  `## [Unreleased (13.61.0)]`, in place of `patch`, `minor`, or `major`. `bump`
  sets its output to that version, which `npm version` takes unchanged. A
  workflow that checks the `bump` output against `patch|minor|major` must also
  accept `X.Y.Z`. `stamp` fails when the tag is for a different version than
  the heading names.

## [0.2.0] - 2026-11-05

- 🐞 Renamed the action from "Changelog Release" to "Changelog Bump and
  Release", because GitHub Marketplace rejects a name another action already
  uses. Workflows refer to the action by its repository, so they need no change.
- ✨ `wait-for-npm` checks npm every 5 minutes, for up to 345 minutes. It used
  to back off from 10 to 30 minutes between checks and give up after 325, so
  the GitHub release could land up to 30 minutes after the package was
  approved; now it lands within 5.

## [0.1.0] - 2026-11-03

- ✨ First release: the `bump`, `stamp`, `wait-for-npm`, and `notes` commands,
  taken from the release scripts of PhotoStructure's npm packages.

[0.2.0]: https://github.com/photostructure/changelog-release-action/releases/tag/v0.2.0
[0.1.0]: https://github.com/photostructure/changelog-release-action/releases/tag/v0.1.0
