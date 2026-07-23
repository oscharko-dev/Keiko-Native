import assert from "node:assert/strict";
import test from "node:test";

import {
  collectRepositoryControlEvidence,
  repositoryControlReadPaths,
} from "./repository-controls-probe.mjs";
import { BROKER_APP_PERMISSIONS } from "./epic-merge-broker-capability.mjs";
import {
  cleanRawProviderEvidence,
  repository,
  repositoryControlMetadata,
} from "./repository-controls-probe.test-fixtures.mjs";

function client(fixtures, calls, source) {
  return async (path) => {
    calls.push(`${source}:${path}`);
    if (!fixtures.has(path)) throw new Error("PRIVATE provider payload");
    return fixtures.get(path);
  };
}

function changedOnSecond(fixtures, changedPath, mutate) {
  let reads = 0;
  return async (path) => {
    const value = fixtures.get(path);
    if (path !== changedPath) return value;
    reads += 1;
    return reads === 2 ? mutate(value) : value;
  };
}

function identityFixtures(appId, slug, permissions, pageTwo = false) {
  const repositories = pageTwo
    ? [
        [
          "/installation/repositories?per_page=100&page=1",
          {
            repositories: Array.from({ length: 100 }, (_, index) => ({
              full_name: `owner/repository-${String(index)}`,
            })),
            total_count: 101,
          },
        ],
        [
          "/installation/repositories?per_page=100&page=2",
          { repositories: [{ full_name: repository }], total_count: 101 },
        ],
      ]
    : [
        [
          "/installation/repositories?per_page=100&page=1",
          {
            repositories: [{ full_name: repository }],
            total_count: 1,
          },
        ],
      ];
  return {
    app: new Map([
      ["/app", { id: appId, slug }],
      [
        `/repos/${repository}/installation`,
        {
          account: { login: "oscharko-dev" },
          app_id: appId,
          app_slug: slug,
          id: appId + 1,
          permissions,
          repository_selection: "selected",
          suspended_at: null,
        },
      ],
    ]),
    installation: new Map(repositories),
  };
}

test("collects only bounded read paths and completes installation pagination", async () => {
  const calls = [];
  const caller = identityFixtures(5252, "keiko-restricted-caller", {
    contents: "write",
    issues: "write",
    metadata: "read",
    pull_requests: "write",
  });
  const broker = identityFixtures(
    4242,
    "keiko-epic-merge-broker",
    BROKER_APP_PERMISSIONS,
    true,
  );
  const raw = cleanRawProviderEvidence();
  const adminValues = {
    actions: raw.actions,
    branch: raw.branch,
    devProtection: raw.devProtection,
    epicProtection: raw.epicProtection,
    epicRuleset: raw.epicRuleset,
    mergeQueue: [{ ...raw.mergeQueue, type: "merge_queue" }],
    nikoPermission: raw.humanPermissions[0],
    oscharkoPermission: raw.humanPermissions[1],
  };
  const admin = new Map(
    Object.entries(repositoryControlReadPaths(repository, 9191)).map(
      ([name, path]) => [path, adminValues[name]],
    ),
  );
  const mergeQueuePath = repositoryControlReadPaths(
    repository,
    9191,
  ).mergeQueue;
  const mergeQueuePageTwoPath = `/repos/${repository}/rules/branches/dev?per_page=100&page=2`;
  admin.set(
    mergeQueuePath,
    Array.from({ length: 100 }, (_, index) => ({
      parameters: {},
      type: `rule-${String(index)}`,
    })),
  );
  admin.set(mergeQueuePageTwoPath, [
    { ...raw.mergeQueue, type: "merge_queue" },
  ]);
  const result = await collectRepositoryControlEvidence(
    {
      admin: client(admin, calls, "admin"),
      brokerApp: client(broker.app, calls, "brokerApp"),
      brokerInstallation: client(
        broker.installation,
        calls,
        "brokerInstallation",
      ),
      callerApp: client(caller.app, calls, "callerApp"),
      callerInstallation: client(
        caller.installation,
        calls,
        "callerInstallation",
      ),
    },
    { ...repositoryControlMetadata(), epicRulesetId: 9191 },
  );
  assert.equal(result.sources.administration, "ok");
  assert.equal(result.sources.broker, "ok");
  assert.ok(
    calls.includes(
      "brokerInstallation:/installation/repositories?per_page=100&page=2",
    ),
  );
  assert.ok(calls.includes(`admin:${mergeQueuePageTwoPath}`));
  for (const source of [
    "admin",
    "brokerApp",
    "brokerInstallation",
    "callerApp",
    "callerInstallation",
  ])
    assert.ok(
      calls.filter((entry) => entry.startsWith(`${source}:`)).length >= 2,
      source,
    );
  const clients = {
    admin: client(admin, [], "admin"),
    brokerApp: client(broker.app, [], "brokerApp"),
    brokerInstallation: client(broker.installation, [], "brokerInstallation"),
    callerApp: client(caller.app, [], "callerApp"),
    callerInstallation: client(caller.installation, [], "callerInstallation"),
  };
  const branchPath = repositoryControlReadPaths(repository, 9191).branch;
  const tornCases = [
    [
      "broker",
      "brokerApp",
      changedOnSecond(broker.app, "/app", (value) => ({
        ...value,
        id: 9999,
      })),
    ],
    [
      "caller",
      "callerApp",
      changedOnSecond(caller.app, "/app", (value) => ({
        ...value,
        id: 9999,
      })),
    ],
    [
      "administration",
      "admin",
      changedOnSecond(admin, branchPath, () => ({
        commit: { sha: "f".repeat(40) },
      })),
    ],
  ];
  let sharedReads = 0;
  const sharedApp = { id: 4242, slug: "keiko-epic-merge-broker" };
  tornCases.push([
    "broker",
    "brokerApp",
    async (path) => {
      if (path !== "/app") return broker.app.get(path);
      sharedReads += 1;
      if (sharedReads === 2) sharedApp.id = 9999;
      return sharedApp;
    },
  ]);
  for (const [source, clientName, changedClient] of tornCases) {
    const torn = await collectRepositoryControlEvidence(
      { ...clients, [clientName]: changedClient },
      { ...repositoryControlMetadata(), epicRulesetId: 9191 },
    );
    assert.equal(torn.sources[source], "changed");
  }
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
});
