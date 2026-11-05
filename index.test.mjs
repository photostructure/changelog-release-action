// Runs index.mjs the way the Actions runner does: inputs in INPUT_* variables,
// outputs appended to $GITHUB_OUTPUT, and the GitHub API at $GITHUB_API_URL.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  test,
} from "node:test";

const INDEX = join(import.meta.dirname, "index.mjs");
const CHANGELOG =
  "# Changelog\n\n## [Unreleased (minor)]\n\n- New.\n\n## [1.2.3] - 2026-01-02\n\n- Old fix.\n";

let dir;
let server;
let apiUrl;
const requests = [];
const files = {};

before(async () => {
  server = createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    const match = /^\/repos\/owner\/repo\/contents\/([^?]+)\?ref=abc123$/.exec(
      req.url,
    );
    // A `files` entry that is not a string is an error response to return
    // for that file: { status, headers, body }, where headers and body are optional.
    const body = match && files[match[1]];
    if (body != null && typeof body !== "string") {
      res.writeHead(body.status, body.headers).end(body.body ?? "Error");
    } else {
      res.writeHead(body == null ? 404 : 200).end(body ?? "Not Found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "changelog-release-action-"));
  writeFileSync(join(dir, "output"), "");
  requests.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(inputs, api = apiUrl) {
  const env = {
    PATH: process.env.PATH,
    GITHUB_API_URL: api,
    GITHUB_OUTPUT: join(dir, "output"),
    GITHUB_REPOSITORY: "owner/repo",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_SHA: "abc123",
    RUNNER_TEMP: dir,
  };
  for (const [name, value] of Object.entries(inputs))
    env[`INPUT_${name.toUpperCase()}`] = value;
  // Async spawn: the test's HTTP server must keep answering while index.mjs runs.
  const child = spawn(process.execPath, [INDEX], { cwd: dir, env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return new Promise((resolve) =>
    child.on("close", (status) =>
      resolve({
        status,
        stdout,
        stderr,
        output: readFileSync(join(dir, "output"), "utf8"),
      }),
    ),
  );
}

describe("bump", () => {
  test("sets the bump output", async () => {
    writeFileSync(join(dir, "CHANGELOG.md"), CHANGELOG);
    const r = await run({ command: "bump" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.output, "bump=minor\n");
  });

  test("annotates CHANGELOG.md and explains the fix", async () => {
    writeFileSync(join(dir, "CHANGELOG.md"), "## [Unreleased]\n\n- New.\n");
    const r = await run({ command: "bump" });
    assert.equal(r.status, 1);
    assert.equal(r.output, "");
    assert.match(
      r.stderr,
      /^::error file=CHANGELOG\.md,line=1::The Unreleased heading/,
    );
    assert.match(
      r.stderr,
      /^::error file=CHANGELOG\.md,line=1::.*Change line 1 to "## \[Unreleased \(patch\)\]"/,
    );
    assert.match(r.stderr, /\nExample:\n/);
  });
});

describe("stamp", () => {
  test("stamps today's UTC date and the tag's release URL", async () => {
    writeFileSync(join(dir, "CHANGELOG.md"), CHANGELOG);
    const today = new Date().toISOString().slice(0, 10);
    const r = await run({ command: "stamp", tag: "v1.3.0" });
    assert.equal(r.status, 0, r.stderr);
    const text = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
    assert.ok(
      text.includes(`## [Unreleased]\n\n## [1.3.0] - ${today}\n\n- New.`),
      text,
    );
    assert.ok(
      text.endsWith(
        "\n[1.3.0]: https://github.com/owner/repo/releases/tag/v1.3.0\n",
      ),
      text,
    );
  });

  test("needs the tag input", async () => {
    writeFileSync(join(dir, "CHANGELOG.md"), CHANGELOG);
    const r = await run({ command: "stamp" });
    assert.equal(r.status, 1);
    assert.match(
      r.stderr,
      /^::error::The stamp command needs the "tag" input\./,
    );
  });
});

describe("notes", () => {
  test("writes the tag's section from the workflow commit", async () => {
    files["CHANGELOG.md"] =
      "## [Unreleased]\n\n## [1.3.0] - 2026-11-02\n\n- New.\n\n## [1.2.3] - 2026-01-02\n";
    const r = await run({ command: "notes", tag: "v1.3.0", token: "secret" });
    assert.equal(r.status, 0, r.stderr);
    const file = join(dir, "release-notes.md");
    assert.equal(r.output, `notes-file=${file}\n`);
    assert.equal(readFileSync(file, "utf8"), "\n- New.\n");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].headers.authorization, "Bearer secret");
    assert.equal(requests[0].headers.accept, "application/vnd.github.raw");
  });

  test("fails when the API does not return the file", async () => {
    delete files["CHANGELOG.md"];
    const r = await run({ command: "notes", tag: "v1.3.0" });
    assert.equal(r.status, 1);
    assert.match(
      r.stderr,
      /^::error::GitHub returned 404 for CHANGELOG\.md at abc123\. Check the job's "contents" permission\. The job runs the workflow file at the tag, so a permission fix ships with the next release; create this release by hand once npm serves the package \(see "When it fails" in the action's README\)\.\n/,
    );
    assert.match(
      r.stderr,
      /GET http:\/\/127\.0\.0\.1:\d+\/repos\/owner\/repo\/contents\/CHANGELOG\.md\?ref=abc123\nNot Found/,
    );
  });

  test("says to re-run after a server error", async () => {
    files["CHANGELOG.md"] = { status: 502 };
    const r = await run({ command: "notes", tag: "v1.3.0" });
    assert.equal(r.status, 1);
    assert.match(
      r.stderr,
      /^::error::GitHub returned 502 for CHANGELOG\.md at abc123\. Re-run this job\.\n/,
    );
    delete files["CHANGELOG.md"];
  });

  // GitHub's rate-limit responses, from
  // https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api#rate-limit-errors
  const rateLimits = [
    [
      "a primary rate limit (403)",
      403,
      { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1793750400" },
      // date -u -d @1793750400 +%FT%TZ prints 2026-11-04T00:00:00Z.
      "Wait until 2026-11-04T00:00:00.000Z, then re-run this job.",
      undefined,
    ],
    [
      "a secondary rate limit (429)",
      429,
      { "retry-after": "60" },
      "Wait 60 seconds, then re-run this job.",
      undefined,
    ],
    [
      "a secondary rate limit (403, no headers)",
      403,
      { "x-ratelimit-remaining": "42" },
      "Wait a minute, then re-run this job.",
      JSON.stringify({
        message:
          "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
      }),
    ],
  ];
  for (const [name, status, headers, advice, body] of rateLimits) {
    test(`says to wait and re-run after ${name}`, async () => {
      files["CHANGELOG.md"] = { status, headers, body };
      const r = await run({ command: "notes", tag: "v1.3.0" });
      assert.equal(r.status, 1);
      assert.ok(
        r.stderr.startsWith(
          `::error::GitHub rate-limited the request for CHANGELOG.md at abc123. ${advice}\n`,
        ),
        r.stderr,
      );
      delete files["CHANGELOG.md"];
    });
  }

  test("keeps the permission advice for a 403 that is not a rate limit", async () => {
    files["CHANGELOG.md"] = {
      status: 403,
      headers: { "x-ratelimit-remaining": "42" },
      body: JSON.stringify({
        message: "Resource not accessible by integration",
      }),
    };
    const r = await run({ command: "notes", tag: "v1.3.0" });
    assert.equal(r.status, 1);
    assert.match(
      r.stderr,
      /^::error::GitHub returned 403 for CHANGELOG\.md at abc123\. Check the job's "contents" permission\./,
    );
    delete files["CHANGELOG.md"];
  });

  test("says to re-run when GitHub cannot be reached", async () => {
    // A port that was just freed has no listener, so fetch rejects with
    // ECONNREFUSED. (fetch refuses some low ports, such as 1, outright.)
    const closed = createServer();
    await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const { port } = closed.address();
    await new Promise((resolve) => closed.close(resolve));
    const r = await run(
      { command: "notes", tag: "v1.3.0" },
      `http://127.0.0.1:${port}`,
    );
    assert.equal(r.status, 1);
    assert.match(
      r.stderr,
      /^::error::Could not reach GitHub for CHANGELOG\.md at abc123\. Re-run this job\.\n/,
    );
    assert.match(r.stderr, /ECONNREFUSED/);
  });
});

// A successful run sleeps 5 minutes before its first `npm view`, so these
// cover only what happens before that. changelog.test.mjs covers the loop and
// npmView.
describe("wait-for-npm", () => {
  test("needs the tag input", async () => {
    const r = await run({ command: "wait-for-npm" });
    assert.equal(r.status, 1);
    assert.match(
      r.stderr,
      /^::error::The wait-for-npm command needs the "tag" input\./,
    );
    assert.equal(requests.length, 0);
  });

  test("reads package.json from the workflow commit", async () => {
    delete files["package.json"];
    const r = await run({ command: "wait-for-npm", tag: "v1.3.0" });
    assert.equal(r.status, 1);
    assert.match(
      r.stderr,
      /^::error::GitHub returned 404 for package\.json at abc123\./,
    );
  });
});

test("rejects an unknown command", async () => {
  const r = await run({ command: "publish" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^::error::Unknown command "publish"\./);
  assert.match(r.stderr, /one of: bump, stamp, wait-for-npm, notes\./);
});
