# Changelog

## [Unreleased]

## [0.2.0] - 2026-11-05

- ✨ `wait-for-npm` checks npm every 5 minutes, for up to 345 minutes. It used
  to back off from 10 to 30 minutes between checks and give up after 325, so
  the GitHub release could land up to 30 minutes after the package was
  approved; now it lands within 5.

## [0.1.0] - 2026-11-03

- ✨ First release: the `bump`, `stamp`, `wait-for-npm`, and `notes` commands,
  taken from the release scripts of PhotoStructure's npm packages.

[0.2.0]: https://github.com/photostructure/changelog-release-action/releases/tag/v0.2.0
[0.1.0]: https://github.com/photostructure/changelog-release-action/releases/tag/v0.1.0
