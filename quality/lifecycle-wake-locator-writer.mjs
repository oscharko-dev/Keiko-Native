import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  LIFECYCLE_WAKE_REPOSITORY,
  lifecycleWakeLocatorBytes,
} from "./lifecycle-wake.mjs";

const positive = (value) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || String(parsed) !== value)
    throw new TypeError("locator integer must be canonical and positive");
  return parsed;
};

export async function writeLifecycleWakeLocator({
  environment = process.env,
  outputDirectory = ".keiko-lifecycle-wake-locator",
} = {}) {
  const pullRequest =
    environment.KEIKO_WAKE_PULL_REQUEST_NUMBER === ""
      ? null
      : positive(environment.KEIKO_WAKE_PULL_REQUEST_NUMBER);
  const locator = {
    repository: LIFECYCLE_WAKE_REPOSITORY,
    issue_number: positive(environment.KEIKO_WAKE_ISSUE_NUMBER),
    pull_request_number: pullRequest,
    source_workflow_path: environment.KEIKO_WAKE_SOURCE_WORKFLOW_PATH,
    source_run_id: positive(environment.GITHUB_RUN_ID),
    source_run_attempt: positive(environment.GITHUB_RUN_ATTEMPT),
    source_protected_dev_sha: environment.GITHUB_WORKFLOW_SHA,
  };
  const bytes = lifecycleWakeLocatorBytes(locator);
  if (bytes.length > 512) throw new RangeError("locator exceeds 512 bytes");
  await mkdir(outputDirectory, { recursive: false });
  const path = `${outputDirectory}/locator.bin`;
  await writeFile(path, bytes, { flag: "wx" });
  return Object.freeze({ bytes, locator: Object.freeze(locator), path });
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
)
  await writeLifecycleWakeLocator();
