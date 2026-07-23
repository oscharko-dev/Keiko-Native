import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { isDirectInvocation, sanitizeDiagnostic } from "./native-process.mjs";
import { parseReleaseJson, readBoundRegularFile } from "./release-io.mjs";
import {
  sanitizedAdministrationProjection,
  sanitizedRepositoryAppIdentity,
  sanitizedRepositoryControlEvidence,
} from "./repository-controls-evidence.mjs";
import { validateRepositoryControls } from "./repository-controls.mjs";

const pageSize = 100;
const pageLimit = 10;
const maximumEvidenceBytes = 1024 * 1024;

export function repositoryControlReadPaths(
  repository,
  epicRulesetId,
  epicProbeBranch = "epic/50-controls-probe",
) {
  const base = `/repos/${repository}`;
  return {
    actions: `${base}/actions/permissions/workflow`,
    branch: `${base}/branches/dev`,
    devProtection: `${base}/branches/dev/protection`,
    epicProtection: `${base}/branches/${encodeURIComponent(epicProbeBranch)}/protection`,
    epicRuleset: `${base}/rulesets/${String(epicRulesetId)}`,
    mergeQueue: `${base}/rules/branches/dev?per_page=100&page=1`,
    nikoPermission: `${base}/collaborators/Niko4417/permission`,
    oscharkoPermission: `${base}/collaborators/oscharko/permission`,
  };
}

async function stableSource(read, project) {
  try {
    const first = await read();
    const firstProjection = structuredClone(project(first));
    const second = await read();
    const reads = [firstProjection, structuredClone(project(second))];
    if (!isDeepStrictEqual(reads[0], reads[1]))
      return { data: {}, reads, status: "changed" };
    return { data: structuredClone(second), reads, status: "ok" };
  } catch {
    return { data: {}, reads: [], status: "unavailable" };
  }
}

async function installationRepositories(request) {
  const repositories = [];
  let total;
  for (let page = 1; page <= pageLimit; page += 1) {
    const response = await request(
      `/installation/repositories?per_page=${String(pageSize)}&page=${String(page)}`,
    );
    if (
      !Number.isSafeInteger(response?.total_count) ||
      response.total_count < 0 ||
      !Array.isArray(response?.repositories) ||
      response.repositories.length > pageSize
    )
      throw new Error("installation_repository_page_invalid");
    if (total === undefined) total = response.total_count;
    if (response.total_count !== total)
      throw new Error("installation_repository_count_changed");
    repositories.push(...response.repositories);
    if (repositories.length >= total) {
      if (repositories.length !== total)
        throw new Error("installation_repository_count_invalid");
      return { repositories, total_count: total };
    }
  }
  throw new Error("installation_repository_pagination_exceeded");
}

async function identityReadback(app, installation, repository) {
  const [appValue, installationValue, repositories] = await Promise.all([
    app("/app"),
    app(`/repos/${repository}/installation`),
    installationRepositories(installation),
  ]);
  return {
    app: appValue,
    installation: installationValue,
    repositories,
  };
}

function mergeQueueRule(value) {
  if (!Array.isArray(value)) return value;
  const matches = value.filter((rule) => rule?.type === "merge_queue");
  if (matches.length !== 1) throw new Error("merge_queue_rule_invalid");
  return matches[0];
}

async function completeRulePages(request, firstPath, firstPage) {
  if (!Array.isArray(firstPage) || firstPage.length > pageSize)
    throw new Error("branch_rule_page_invalid");
  const rules = [...firstPage];
  let prior = firstPage;
  for (
    let page = 2;
    prior.length === pageSize && page <= pageLimit;
    page += 1
  ) {
    const url = new URL(firstPath, "https://api.github.invalid");
    url.searchParams.set("page", String(page));
    const path = `${url.pathname}${url.search}`;
    prior = await request(path);
    if (!Array.isArray(prior) || prior.length > pageSize)
      throw new Error("branch_rule_page_invalid");
    rules.push(...prior);
  }
  if (prior.length === pageSize)
    throw new Error("branch_rule_pagination_exceeded");
  return rules;
}

async function administrationReadback(request, metadata) {
  const paths = repositoryControlReadPaths(
    metadata.repository,
    metadata.epicRulesetId,
    metadata.epicProbeBranch,
  );
  const values = await Promise.all(
    Object.values(paths).map((path) => request(path)),
  );
  const result = Object.fromEntries(
    Object.keys(paths).map((name, index) => [name, values[index]]),
  );
  const rules = await completeRulePages(
    request,
    paths.mergeQueue,
    result.mergeQueue,
  );
  return {
    actions: result.actions,
    branch: result.branch,
    devProtection: result.devProtection,
    epicProtection: result.epicProtection,
    epicRuleset: result.epicRuleset,
    humanPermissions: [result.nikoPermission, result.oscharkoPermission],
    mergeQueue: mergeQueueRule(rules),
  };
}

function sourceStatuses(metadata, administration, broker, caller) {
  return {
    administration: administration.status,
    broker: broker.status,
    caller: caller.status,
    probes: metadata?.sourceStatuses?.probes ?? "unavailable",
  };
}

export async function collectRepositoryControlEvidence(clients, metadata) {
  const [administration, broker, caller] = await Promise.all([
    stableSource(
      () => administrationReadback(clients.admin, metadata),
      sanitizedAdministrationProjection,
    ),
    stableSource(
      () =>
        identityReadback(
          clients.brokerApp,
          clients.brokerInstallation,
          metadata.repository,
        ),
      sanitizedRepositoryAppIdentity,
    ),
    stableSource(
      () =>
        identityReadback(
          clients.callerApp,
          clients.callerInstallation,
          metadata.repository,
        ),
      sanitizedRepositoryAppIdentity,
    ),
  ]);
  return sanitizedRepositoryControlEvidence(
    {
      ...administration.data,
      broker: broker.data,
      caller: caller.data,
    },
    {
      ...metadata,
      configurationReads: {
        administration: administration.reads,
        broker: broker.reads,
        caller: caller.reads,
      },
      sourceStatuses: sourceStatuses(metadata, administration, broker, caller),
    },
  );
}

async function readJson(path) {
  const { bytes } = await readBoundRegularFile(path, maximumEvidenceBytes);
  return parseReleaseJson(bytes);
}

export async function main(
  arguments_ = process.argv.slice(2),
  write = console.log,
) {
  if (arguments_.length !== 1)
    throw new Error("sanitized_evidence_path_required");
  const [evidence, policy] = await Promise.all([
    readJson(arguments_[0]),
    readJson(new URL("./repository-controls-policy.json", import.meta.url)),
  ]);
  const failures = validateRepositoryControls(evidence, policy);
  write(JSON.stringify({ failures, ok: failures.length === 0 }));
  if (failures.length > 0) throw new Error("repository_controls_not_proven");
}

if (isDirectInvocation(process.argv[1], fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(sanitizeDiagnostic(error?.message ?? String(error)));
    process.exitCode = 1;
  });
}
