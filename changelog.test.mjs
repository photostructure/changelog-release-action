import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  ReleaseError,
  npmView,
  readUnreleased,
  releaseNotes,
  stamp,
  waitForNpm,
} from "./changelog.mjs";

const RELEASED =
  "## [1.2.3] - 2026-01-02\n\n- Old fix.\n\n[1.2.3]: https://example.com/v1.2.3\n";

function bumpOf(text) {
  return readUnreleased(text.split("\n")).bump;
}

describe("readUnreleased", () => {
  for (const bump of ["patch", "minor", "major"]) {
    test(`reads ${bump}`, () => {
      assert.equal(
        bumpOf(
          `# Changelog\n\n## [Unreleased (${bump})]\n\n- New.\n\n${RELEASED}`,
        ),
        bump,
      );
    });
  }

  const failures = [
    [
      "no Unreleased heading",
      RELEASED,
      'has no "## [Unreleased (patch|minor|major)]" heading',
      undefined,
    ],
    [
      "a heading without a bump",
      `## [Unreleased]\n\n- New.\n\n${RELEASED}`,
      // The annotation shows only the message, so these three carry the fix.
      'does not name a version bump. Change line 1 to "## [Unreleased (patch)]", "## [Unreleased (minor)]", or "## [Unreleased (major)]".',
      1,
    ],
    [
      "an unknown bump",
      `## [Unreleased (huge)]\n\n- New.\n\n${RELEASED}`,
      '"huge" on line 1 of CHANGELOG.md is not a version bump. Use patch, minor, or major.',
      1,
    ],
    [
      "a misspelled heading",
      `## Unreleased (minor)\n\n- New.\n\n${RELEASED}`,
      'is not a valid Unreleased heading. Write it as "## [Unreleased (patch)]", "## [Unreleased (minor)]", or "## [Unreleased (major)]".',
      1,
    ],
    [
      "an empty section",
      `## [Unreleased (minor)]\n\n\n${RELEASED}`,
      "section of CHANGELOG.md is empty",
      1,
    ],
    [
      "two Unreleased headings",
      "## [Unreleased (minor)]\n\n- A.\n\n## [Unreleased (patch)]\n\n- B.\n",
      "more than one Unreleased heading",
      5,
    ],
  ];
  for (const [name, text, message, line] of failures) {
    test(`explains ${name}`, () => {
      assert.throws(
        () => bumpOf(text),
        (error) => {
          assert.ok(error instanceof ReleaseError);
          assert.ok(error.message.includes(message), error.message);
          assert.equal(error.file, "CHANGELOG.md");
          assert.equal(error.line, line);
          assert.ok(
            error.details.includes("  ## [Unreleased (minor)]"),
            "shows an example heading",
          );
          return true;
        },
      );
    });
  }
});

describe("stamp", () => {
  test("renames the section and adds a link definition", () => {
    assert.equal(
      stamp(
        `# Changelog\n\n## [Unreleased (minor)]\n\n- New.\n\n${RELEASED}`,
        "1.3.0",
        "2026-11-02",
        "https://example.com/v1.3.0",
      ),
      "# Changelog\n\n## [Unreleased]\n\n## [1.3.0] - 2026-11-02\n\n- New.\n\n" +
        "## [1.2.3] - 2026-01-02\n\n- Old fix.\n\n" +
        "[1.3.0]: https://example.com/v1.3.0\n[1.2.3]: https://example.com/v1.2.3\n",
    );
  });

  test("appends the link definition when there are none", () => {
    assert.equal(
      stamp(
        "## [Unreleased (patch)]\n\n- Fix.\n",
        "0.0.1",
        "2026-11-02",
        "https://example.com/0.0.1",
      ),
      "## [Unreleased]\n\n## [0.0.1] - 2026-11-02\n\n- Fix.\n\n[0.0.1]: https://example.com/0.0.1\n",
    );
  });

  test("refuses a version that is already in the file", () => {
    assert.throws(
      () =>
        stamp(
          `## [Unreleased (patch)]\n\n- Fix.\n\n${RELEASED}`,
          "1.2.3",
          "2026-11-02",
          "https://example.com/v1.2.3",
        ),
      (error) => {
        assert.ok(error instanceof ReleaseError);
        assert.equal(
          error.message,
          "CHANGELOG.md already has a ## [1.2.3] heading on line 5. Remove or rename it, then start the release again.",
        );
        assert.equal(error.file, "CHANGELOG.md");
        assert.equal(error.line, 5);
        return true;
      },
    );
  });

  test("refuses an Unreleased heading without a bump", () => {
    assert.throws(
      () =>
        stamp(
          `## [Unreleased]\n\n- New.\n\n${RELEASED}`,
          "1.3.0",
          "2026-11-02",
          "https://example.com/v1.3.0",
        ),
      /does not name a version bump/,
    );
  });
});

describe("releaseNotes", () => {
  const changelog =
    "# Changelog\n\n## [Unreleased]\n\n## [1.2.30] - 2026-03-01\n\n- Later.\n\n" +
    "## [1.2.3] - 2026-01-02\n\n### Fixes\n\n- Old fix.\n\n## [1.2.2] - 2025-12-01\n\n- Older.\n";

  test("returns the version's section, subsections included", () => {
    assert.equal(
      releaseNotes(changelog, "1.2.3"),
      "\n### Fixes\n\n- Old fix.\n",
    );
  });

  test("reads the last section to the end of the file", () => {
    assert.equal(releaseNotes(changelog, "1.2.2"), "\n- Older.\n");
  });

  for (const [name, version] of [
    ["a missing version", "9.9.9"],
    ["an empty section", "1.2.4"],
  ]) {
    test(`explains ${name}`, () => {
      const text =
        "## [1.2.4] - 2026-04-01\n\n## [1.2.3] - 2026-01-02\n\n- Fix.\n";
      assert.throws(
        () => releaseNotes(text, version),
        (error) => {
          assert.ok(error instanceof ReleaseError);
          // The annotation shows only the message, so it carries the fix.
          assert.equal(
            error.message,
            `CHANGELOG.md has no notes under ## [${version}]. Create the release by hand with "gh release create <tag> --verify-tag --generate-notes".`,
          );
          assert.match(
            error.details.join("\n"),
            /^The release workflow writes that section/,
          );
          return true;
        },
      );
    });
  }
});

describe("waitForNpm", () => {
  // `sleep` advances the clock that `now` reads, and `viewedAt` records the
  // minute of each `npm view` after `start`. `view` answers from `results`,
  // then E404. The clock starts at a real epoch time so a deadline that leaves
  // out the start time fails.
  function fakes(results) {
    const start = Date.UTC(2026, 10, 4);
    let ms = start;
    const viewed = [];
    const viewedAt = [];
    return {
      viewed,
      viewedAt,
      now: () => ms,
      sleep: async (wait) => {
        ms += wait;
      },
      view: async (spec) => {
        viewed.push(spec);
        viewedAt.push((ms - start) / 60_000);
        return results.shift() ?? NOT_YET;
      },
    };
  }
  const NOT_YET = { ok: false, stderr: "npm error code E404\n" };

  test("returns once npm serves the version", async () => {
    const f = fakes([NOT_YET, NOT_YET, { ok: true, stderr: "" }]);
    await waitForNpm("pkg@1.2.3", f);
    assert.deepEqual(f.viewedAt, [5, 10, 15]);
    assert.deepEqual(f.viewed, ["pkg@1.2.3", "pkg@1.2.3", "pkg@1.2.3"]);
  });

  test("fails at once on an error other than E404", async () => {
    const f = fakes([NOT_YET, { ok: false, stderr: "npm error code E500\n" }]);
    await assert.rejects(waitForNpm("pkg@1.2.3", f), (error) => {
      assert.ok(error instanceof ReleaseError);
      // The annotation shows only the message, so the message carries the fix.
      assert.equal(
        error.message,
        "npm view pkg@1.2.3 failed. Fix the cause, such as an npm outage, then re-run this job.",
      );
      assert.deepEqual(error.details, ["npm error code E500"]);
      return true;
    });
    assert.equal(f.viewed.length, 2);
  });

  test("checks every 5 minutes until the 345 minutes README.md documents, then tells the maintainer to approve and re-run", async () => {
    const f = fakes([]);
    await assert.rejects(waitForNpm("pkg@1.2.3", f), (error) => {
      assert.ok(error instanceof ReleaseError);
      assert.equal(
        error.message,
        "npm does not serve pkg@1.2.3. Approve the staged package on npmjs.com, then re-run this job.",
      );
      return true;
    });
    assert.deepEqual(
      f.viewedAt,
      Array.from({ length: 69 }, (_, i) => 5 * (i + 1)),
    );
  });
});

describe("npmView", () => {
  let bin;
  const path = process.env.PATH;

  // A stand-in npm that records its arguments, prints $FAKE_STDERR, and exits
  // with $FAKE_STATUS.
  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), "changelog-release-action-npm-"));
    writeFileSync(
      join(bin, "npm"),
      '#!/bin/sh\necho "$@" > "$(dirname "$0")/args"\nprintf "%s" "$FAKE_STDERR" >&2\nexit "$FAKE_STATUS"\n',
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}${delimiter}${path}`;
  });
  afterEach(() => {
    process.env.PATH = path;
    delete process.env.FAKE_STDERR;
    delete process.env.FAKE_STATUS;
    rmSync(bin, { recursive: true, force: true });
  });

  test("asks the registry for the exact version", async () => {
    process.env.FAKE_STATUS = "0";
    assert.deepEqual(await npmView("@scope/pkg@1.2.3"), {
      ok: true,
      stderr: "",
    });
    assert.equal(
      readFileSync(join(bin, "args"), "utf8"),
      "view @scope/pkg@1.2.3 version --prefer-online\n",
    );
  });

  test("reports a failure with npm's stderr", async () => {
    process.env.FAKE_STATUS = "1";
    process.env.FAKE_STDERR = "npm error code E404\n";
    assert.deepEqual(await npmView("pkg@1.2.3"), {
      ok: false,
      stderr: "npm error code E404\n",
    });
  });
});
