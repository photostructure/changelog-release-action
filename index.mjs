// Entry point: runs the `command` input. See README.md.
import console from "node:console";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import {
  ReleaseError,
  npmView,
  readUnreleased,
  releaseNotes,
  stamp,
  waitForNpm,
} from "./changelog.mjs";

const env = process.env;
const CHANGELOG = "CHANGELOG.md";

function input(name) {
  return (env[`INPUT_${name.toUpperCase()}`] ?? "").trim();
}

function requiredInput(name, command) {
  const value = input(name);
  if (value === "") {
    throw new ReleaseError(`The ${command} command needs the "${name}" input.`);
  }
  return value;
}

function setOutput(name, value) {
  appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

// Reads `path` at the workflow commit. The publish job has no checkout.
async function fetchAtWorkflowCommit(path) {
  const url = `${env.GITHUB_API_URL}/repos/${env.GITHUB_REPOSITORY}/contents/${path}?ref=${env.GITHUB_SHA}`;
  let response;
  let body;
  try {
    response = await fetch(url, {
      headers: {
        accept: "application/vnd.github.raw",
        authorization: `Bearer ${input("token")}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    body = await response.text();
  } catch (error) {
    // These reject only when the connection fails before the whole response
    // arrives, such as a DNS failure or a reset; the reason is in `cause`.
    throw new ReleaseError(
      `Could not reach GitHub for ${path} at ${env.GITHUB_SHA}. Re-run this job.`,
      { details: [`GET ${url}`, String(error.cause ?? error)] },
    );
  }
  if (response.ok) return body;
  const details = [`GET ${url}`, body];
  const wait = rateLimitWait(response, body);
  if (wait != null) {
    throw new ReleaseError(
      `GitHub rate-limited the request for ${path} at ${env.GITHUB_SHA}. ${wait}, then re-run this job.`,
      { details },
    );
  }
  // The job runs the workflow file at the tag, so a re-run cannot pick up a
  // permissions fix; only a server error is worth re-running.
  const fix =
    response.status >= 500
      ? "Re-run this job."
      : 'Check the job\'s "contents" permission. The job runs the workflow file at the tag, so a permission fix ships with the next release; create this release by hand once npm serves the package (see "When it fails" in the action\'s README).';
  throw new ReleaseError(
    `GitHub returned ${response.status} for ${path} at ${env.GITHUB_SHA}. ${fix}`,
    { details },
  );
}

// Returns how long to wait when `response` is one of GitHub's rate-limit
// errors, which arrive as 403 or 429. A secondary limit may come with no
// headers, as a 403 whose body names it:
// https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api#rate-limit-errors
function rateLimitWait(response, body) {
  if (response.status !== 403 && response.status !== 429) return undefined;
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter != null) return `Wait ${retryAfter} seconds`;
  if (response.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
    return `Wait until ${new Date(reset).toISOString()}`;
  }
  if (response.status === 429 || /secondary rate limit/i.test(body)) {
    return "Wait a minute";
  }
  return undefined;
}

function versionOf(tag) {
  return tag.replace(/^v/, "");
}

const commands = {
  bump() {
    const lines = readFileSync(CHANGELOG, "utf8").split("\n");
    setOutput("bump", readUnreleased(lines).bump);
  },

  stamp() {
    const tag = requiredInput("tag", "stamp");
    const date = new Date().toISOString().slice(0, 10);
    const url = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/releases/tag/${tag}`;
    const text = readFileSync(CHANGELOG, "utf8");
    writeFileSync(CHANGELOG, stamp(text, versionOf(tag), date, url));
  },

  async "wait-for-npm"() {
    const tag = requiredInput("tag", "wait-for-npm");
    const { name } = JSON.parse(await fetchAtWorkflowCommit("package.json"));
    await waitForNpm(`${name}@${versionOf(tag)}`, { view: npmView, sleep });
  },

  async notes() {
    const tag = requiredInput("tag", "notes");
    const text = await fetchAtWorkflowCommit(CHANGELOG);
    const file = join(env.RUNNER_TEMP, "release-notes.md");
    writeFileSync(file, releaseNotes(text, versionOf(tag)));
    setOutput("notes-file", file);
  },
};

const command = input("command");
try {
  if (!Object.hasOwn(commands, command)) {
    throw new ReleaseError(`Unknown command "${command}".`, {
      details: [
        `The command input must be one of: ${Object.keys(commands).join(", ")}.`,
      ],
    });
  }
  await commands[command]();
} catch (error) {
  if (!(error instanceof ReleaseError)) throw error;
  const where = [
    error.file == null ? null : `file=${error.file}`,
    error.line == null ? null : `line=${error.line}`,
  ].filter((part) => part != null);
  console.error(
    `::error${where.length === 0 ? "" : ` ${where.join(",")}`}::${error.message}`,
  );
  console.error([error.message, "", ...error.details].join("\n"));
  process.exitCode = 1;
}
