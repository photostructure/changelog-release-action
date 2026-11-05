// Reads and rewrites a Keep a Changelog CHANGELOG.md, and waits for npm to
// serve a release. index.mjs reads the inputs, calls the GitHub API, and
// writes the files and outputs.
import { execFile } from "node:child_process";

export const BUMPS = ["patch", "minor", "major"];

// Minutes to sleep before each `npm view`, so the GitHub release follows npm
// approval by at most this long. The job holds its runner for the whole wait,
// so checking less often saves nothing.
const NPM_CHECK_MINUTES = 5;

// Minutes after which `waitForNpm` starts no new sleep. The last sleep can end
// up to 5 minutes later, so the wait ends by about minute 350, which leaves at
// least 10 of GitHub's 360-minute job limit for the job's other steps.
const NPM_WAIT_LIMIT_MINUTES = 345;

const HEADINGS =
  '"## [Unreleased (patch)]", "## [Unreleased (minor)]", or "## [Unreleased (major)]"';

const EXAMPLE = [
  "Example:",
  "",
  "  ## [Unreleased (minor)]",
  "",
  "  - ✨ Added the `foo` option.",
  "",
  "Commit the change to the default branch, then start the release again.",
];

// A failure the maintainer fixes by hand. index.mjs prints it as an
// annotation on `file` and `line`, when given, followed by the details.
export class ReleaseError extends Error {
  constructor(summary, { details = [], file, line } = {}) {
    super(summary);
    this.details = details;
    this.file = file;
    this.line = line;
  }
}

function headingFail(line, summary, details = []) {
  throw new ReleaseError(summary, {
    details: details.length === 0 ? EXAMPLE : [...details, "", ...EXAMPLE],
    file: "CHANGELOG.md",
    line,
  });
}

// Returns the 0-based line index and bump of the one
// `## [Unreleased (patch|minor|major)]` heading, which must have notes.
export function readUnreleased(lines) {
  const candidates = [];
  lines.forEach((text, i) => {
    if (/^#+ .*unreleased/i.test(text)) candidates.push(i);
  });
  if (candidates.length === 0) {
    headingFail(
      undefined,
      'CHANGELOG.md has no "## [Unreleased (patch|minor|major)]" heading.',
      [
        "Add that heading above the newest release and list this release's",
        "changes under it.",
      ],
    );
  }
  if (candidates.length > 1) {
    headingFail(
      candidates[1] + 1,
      "CHANGELOG.md has more than one Unreleased heading.",
      [
        `Lines ${candidates.map((i) => i + 1).join(", ")} all look like Unreleased`,
        "headings. Merge their notes under one heading.",
      ],
    );
  }
  const index = candidates[0];
  const heading = lines[index];
  const prefix = "## [Unreleased (";
  let bump;
  if (heading.startsWith(prefix) && heading.endsWith(")]")) {
    bump = heading.slice(prefix.length, -2);
  } else if (heading !== "## [Unreleased]") {
    headingFail(
      index + 1,
      `Line ${index + 1} of CHANGELOG.md is not a valid Unreleased heading. Write it as ${HEADINGS}.`,
      [`It reads "${heading}".`],
    );
  }
  if (bump == null) {
    headingFail(
      index + 1,
      `The Unreleased heading in CHANGELOG.md does not name a version bump. Change line ${index + 1} to ${HEADINGS}.`,
    );
  }
  if (!BUMPS.includes(bump)) {
    headingFail(
      index + 1,
      `"${bump}" on line ${index + 1} of CHANGELOG.md is not a version bump. Use patch, minor, or major.`,
    );
  }
  let end = index + 1;
  while (end < lines.length && !lines[end].startsWith("## ")) end++;
  if (!lines.slice(index + 1, end).some((text) => /\S/.test(text))) {
    headingFail(index + 1, "The Unreleased section of CHANGELOG.md is empty.", [
      `List this release's changes under line ${index + 1}. They become the GitHub`,
      "release notes.",
    ]);
  }
  return { index, bump };
}

// Renames the Unreleased heading to `## [<version>] - <date>`, adds an empty
// `## [Unreleased]` above it, and adds a `[<version>]: <url>` definition.
export function stamp(text, version, date, url) {
  const lines = text.split("\n");
  const existing = lines.findIndex((line) =>
    line.startsWith(`## [${version}]`),
  );
  if (existing !== -1) {
    throw new ReleaseError(
      `CHANGELOG.md already has a ## [${version}] heading on line ${existing + 1}. Remove or rename it, then start the release again.`,
      { file: "CHANGELOG.md", line: existing + 1 },
    );
  }
  const { index } = readUnreleased(lines);
  lines.splice(index, 1, "## [Unreleased]", "", `## [${version}] - ${date}`);
  const def = `[${version}]: ${url}`;
  // Definitions follow heading order, so the first one is the newest
  // version's, and the new one goes just above it.
  const firstDef = lines.findIndex(
    (line) => /^\[\d/.test(line) && line.includes("]: "),
  );
  if (firstDef === -1) {
    while (lines.at(-1) === "") lines.pop();
    lines.push("", def, "");
  } else {
    lines.splice(firstDef, 0, def);
  }
  return lines.join("\n");
}

// Returns the lines under `## [<version>] - `, up to the next `## ` heading.
export function releaseNotes(text, version) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) =>
    line.startsWith(`## [${version}] - `),
  );
  let notes = [];
  if (start !== -1) {
    let end = start + 1;
    while (end < lines.length && !lines[end].startsWith("## ")) end++;
    notes = lines.slice(start + 1, end);
  }
  if (!notes.some((line) => /\S/.test(line))) {
    // The annotation shows only the message, so the message carries the fix.
    throw new ReleaseError(
      `CHANGELOG.md has no notes under ## [${version}]. Create the release by hand with "gh release create <tag> --verify-tag --generate-notes".`,
      {
        details: [
          "The release workflow writes that section into the release commit, so",
          "this tag was not made by it. Adding notes now cannot change the tag.",
        ],
      },
    );
  }
  return notes.join("\n");
}

// Sleeps, then asks npm for `spec`, until npm serves it. `view` resolves to
// { ok, stderr }; `sleep` takes milliseconds; `now` returns epoch milliseconds.
export async function waitForNpm(spec, { view, sleep, now }) {
  const deadline = now() + NPM_WAIT_LIMIT_MINUTES * 60_000;
  while (now() < deadline) {
    await sleep(NPM_CHECK_MINUTES * 60_000);
    const { ok, stderr } = await view(spec);
    if (ok) return;
    // The annotation shows only the message, so the message carries the fix.
    if (!stderr.includes("E404")) {
      throw new ReleaseError(
        `npm view ${spec} failed. Fix the cause, such as an npm outage, then re-run this job.`,
        { details: stderr.trimEnd().split("\n") },
      );
    }
  }
  throw new ReleaseError(
    `npm does not serve ${spec}. Approve the staged package on npmjs.com, then re-run this job.`,
  );
}

// Runs `npm view <spec> version`, which exits non-zero with E404 in its
// stderr until npm serves `spec`.
export function npmView(spec) {
  return new Promise((resolve) => {
    execFile(
      "npm",
      ["view", spec, "version", "--prefer-online"],
      (error, _stdout, stderr) => resolve({ ok: error == null, stderr }),
    );
  });
}
