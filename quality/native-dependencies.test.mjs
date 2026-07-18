import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  captureDependencySnapshot,
  createTargetVulnerabilityInventory,
  cvss31BaseScore,
  evaluateVulnerabilityResults,
} from "./native-dependencies.mjs";

test("derives an OSV inventory only from the filtered Cargo resolve graph", () => {
  const metadata = {
    packages: [
      cargoPackage("app", "0.1.0", null),
      cargoPackage("safe", "1.2.3"),
      cargoPackage("linux-only", "4.5.6"),
    ],
    resolve: {
      nodes: [
        { dependencies: ["safe-id"], id: "app-id" },
        { dependencies: [], id: "safe-id" },
      ],
    },
  };
  metadata.packages[0].id = "app-id";
  metadata.packages[1].id = "safe-id";
  metadata.packages[2].id = "linux-id";

  assert.deepEqual(createTargetVulnerabilityInventory(metadata), {
    results: [
      {
        packages: [
          {
            package: {
              ecosystem: "crates.io",
              name: "safe",
              version: "1.2.3",
            },
          },
        ],
        source: {
          path: "native/Cargo.lock#aarch64-apple-darwin",
          type: "lockfile",
        },
      },
    ],
  });
});

test("target vulnerability inventory rejects incomplete or unsupported Cargo metadata", () => {
  for (const metadata of [
    {},
    { packages: [], resolve: { nodes: [] } },
    {
      packages: [
        cargoPackage("git-dependency", "1.0.0", "git+https://invalid"),
      ],
      resolve: { nodes: [{ dependencies: [], id: "git-id" }] },
    },
    {
      packages: [cargoPackage("safe", "1.0.0")],
      resolve: { nodes: [{ dependencies: [], id: "missing-id" }] },
    },
  ]) {
    assert.throws(
      () => createTargetVulnerabilityInventory(metadata),
      /Target dependency inventory rejected/u,
    );
  }
});

function cargoPackage(
  name,
  version,
  source = "registry+https://github.com/rust-lang/crates.io-index",
) {
  return { id: `${name}-id`, name, source, version };
}

test("vulnerability policy retains unmaintained signals and enforces moderate", () => {
  assert.deepEqual(evaluateVulnerabilityResults({ results: [] }), {
    blocking: 0,
    informationalUnmaintained: 0,
    low: 0,
  });
  assert.deepEqual(
    evaluateVulnerabilityResults(
      vulnerabilityResults({ informational: "unmaintained", severity: "" }),
    ),
    { blocking: 0, informationalUnmaintained: 1, low: 0 },
  );
  assert.deepEqual(
    evaluateVulnerabilityResults(vulnerabilityResults({ severity: "3.9" })),
    { blocking: 0, informationalUnmaintained: 0, low: 1 },
  );
  assert.throws(
    () =>
      evaluateVulnerabilityResults(vulnerabilityResults({ severity: "4.0" })),
    /Vulnerability policy rejected moderate-or-higher/u,
  );
});

test("vulnerability policy fails closed on malformed, unknown, mixed, or patched signals", () => {
  const mutations = [
    {},
    { results: {} },
    vulnerabilityResults({ severity: "unknown" }),
    vulnerabilityResults({ severity: "" }),
    vulnerabilityResults({ informational: "unsound", severity: "" }),
    vulnerabilityResults({
      fixed: "1.0.1",
      informational: "unmaintained",
      severity: "",
    }),
    vulnerabilityResults({
      informational: "unmaintained",
      mixed: true,
      severity: "",
    }),
  ];
  for (const mutation of mutations)
    assert.throws(
      () => evaluateVulnerabilityResults(mutation),
      /Vulnerability policy rejected/u,
    );
});

test("informational-unmaintained requires exact RustSec identity and introduced-only ranges", () => {
  const mutations = [
    (report) =>
      (finding(report).vulnerabilities[0].affected[0].ranges[0].events = []),
    (report) =>
      (finding(
        report,
      ).vulnerabilities[0].affected[0].ranges[0].events[0].introduced = 0),
    (report) =>
      (finding(
        report,
      ).vulnerabilities[0].affected[0].ranges[0].events[0].introduced = ""),
    (report) =>
      (finding(
        report,
      ).vulnerabilities[0].affected[0].ranges[0].events[0].fixed = "1.0.1"),
    (report) =>
      (finding(
        report,
      ).vulnerabilities[0].affected[0].ranges[0].events[0].last_affected =
        "1.0.0"),
    (report) =>
      (finding(
        report,
      ).vulnerabilities[0].affected[0].ranges[0].events[0].limit = "2.0.0"),
    (report) => (finding(report).groups[0].ids = ["RUSTSEC-2025-9999"]),
    (report) => (finding(report).groups[0].aliases = ["RUSTSEC-2025-9999"]),
    (report) => (finding(report).groups[0].ids = [17]),
    (report) => (finding(report).groups[0].aliases = [17]),
    (report) => (finding(report).groups[0].aliases = ["GHSA-1111-2222-3333"]),
    (report) =>
      (finding(
        report,
      ).vulnerabilities[0].affected[0].database_specific.severity = "low"),
    (report) =>
      (finding(report).vulnerabilities[0].affected[0].database_specific.cvss =
        "0.0"),
    (report) =>
      finding(
        report,
      ).vulnerabilities[0].affected[0].database_specific.categories.push(
        "notice",
      ),
    (report) => (finding(report).vulnerabilities[0].severity = []),
  ];
  for (const mutate of mutations) {
    const report = vulnerabilityResults({
      informational: "unmaintained",
      severity: "",
    });
    mutate(report);
    assert.throws(
      () => evaluateVulnerabilityResults(report),
      /Vulnerability policy rejected/u,
    );
  }
});

test("vulnerability findings reject malformed packages and incoherent group bindings", () => {
  const mutations = [
    (report) => (finding(report).package.name = ""),
    (report) => (finding(report).vulnerabilities[0].affected[0].package = null),
    (report) =>
      (finding(report).vulnerabilities[0].affected[0].package.purl =
        "pkg:cargo/other"),
    (report) =>
      (finding(report).vulnerabilities[0].affected[0].package.purl = 1),
    (report) =>
      finding(report).groups.push(structuredClone(finding(report).groups[0])),
    (report) =>
      finding(report).vulnerabilities.push(
        structuredClone(finding(report).vulnerabilities[0]),
      ),
    (report) => finding(report).groups[0].ids.push("RUSTSEC-2025-9999"),
    (report) =>
      finding(report).groups[0].aliases.push(
        finding(report).groups[0].aliases[0],
      ),
    (report) =>
      finding(report).vulnerabilities.push({
        ...structuredClone(finding(report).vulnerabilities[0]),
        id: "RUSTSEC-2025-9999",
      }),
  ];
  for (const [index, mutate] of mutations.entries()) {
    const report = vulnerabilityResults({ severity: "3.9" });
    mutate(report);
    assert.throws(
      () => evaluateVulnerabilityResults(report),
      /Vulnerability policy rejected/u,
      `binding mutation ${String(index)}`,
    );
  }
});

test("ordinary scored vulnerability identity and severity never degrade malformed data to low", () => {
  const mutations = [
    (report) => (finding(report).vulnerabilities[0].id = "unknown"),
    (report) => (finding(report).groups[0].ids = ["unknown"]),
    (report) => (finding(report).groups[0].aliases = [3]),
    (report) => (finding(report).groups[0].max_severity = 3.9),
    (report) => (finding(report).groups[0].max_severity = "-1"),
    (report) => (finding(report).groups[0].max_severity = "NaN"),
    (report) => (finding(report).vulnerabilities[0].affected = []),
    (report) =>
      (finding(
        report,
      ).vulnerabilities[0].affected[0].database_specific.informational =
        "unmaintained"),
  ];
  for (const mutate of mutations) {
    const report = vulnerabilityResults({ severity: "3.9" });
    mutate(report);
    assert.throws(
      () => evaluateVulnerabilityResults(report),
      /Vulnerability policy rejected/u,
    );
  }
});

test("scored advisories reconcile CVSS and database severity with the group score", () => {
  const critical = "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H";
  for (const mutate of [
    (advisory) => (advisory.severity = [{ score: critical, type: "CVSS_V3" }]),
    (advisory) => (advisory.affected[0].database_specific.cvss = critical),
    (advisory) =>
      (advisory.affected[0].database_specific.categories = ["critical"]),
    (advisory) =>
      (advisory.affected[0].database_specific.severity = "critical"),
  ]) {
    const report = vulnerabilityResults({ severity: "3.9" });
    mutate(finding(report).vulnerabilities[0]);
    assert.throws(
      () => evaluateVulnerabilityResults(report),
      /Vulnerability policy rejected severity-coherence/u,
    );
  }

  for (const [score, vector, blocked] of [
    ["1.5", "CVSS:3.1/AV:P/AC:H/PR:H/UI:R/S:U/C:L/I:N/A:N", false],
    ["5.3", "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N", true],
    ["8.1", "CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:H/A:H", true],
    ["9.8", critical, true],
  ]) {
    const report = vulnerabilityResults({ severity: score });
    finding(report).vulnerabilities[0].severity = [
      { score: vector, type: "CVSS_V3" },
    ];
    if (blocked)
      assert.throws(
        () => evaluateVulnerabilityResults(report),
        /Vulnerability policy rejected moderate-or-higher/u,
      );
    else
      assert.deepEqual(evaluateVulnerabilityResults(report), {
        blocking: 0,
        informationalUnmaintained: 0,
        low: 1,
      });
  }

  for (const [severity, category, blocked] of [
    ["3.9", "low", false],
    ["4.0", "moderate", true],
    ["7.0", "high", true],
    ["9.0", "critical", true],
  ]) {
    const report = vulnerabilityResults({ severity });
    finding(
      report,
    ).vulnerabilities[0].affected[0].database_specific.categories = [category];
    if (blocked)
      assert.throws(
        () => evaluateVulnerabilityResults(report),
        /Vulnerability policy rejected moderate-or-higher/u,
      );
    else
      assert.deepEqual(evaluateVulnerabilityResults(report), {
        blocking: 0,
        informationalUnmaintained: 0,
        low: 1,
      });
  }
});

test("scored advisory severity rejects malformed and unknown representations", () => {
  const critical = "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H";
  const mutations = [
    (advisory) => (advisory.severity = []),
    (advisory) => (advisory.severity = [{ score: critical, type: "CVSS_V4" }]),
    (advisory) => (advisory.severity = [{ score: 9.8, type: "CVSS_V3" }]),
    (advisory) =>
      (advisory.severity = [{ score: `${critical}/AV:N`, type: "CVSS_V3" }]),
    (advisory) =>
      (advisory.severity = [
        {
          score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H",
          type: "CVSS_V3",
        },
      ]),
    (advisory) => (advisory.affected[0].database_specific.cvss = "critical"),
    (advisory) => (advisory.affected[0].database_specific.cvss = 9.8),
    (advisory) => (advisory.affected[0].database_specific.severity = "unknown"),
    (advisory) => (advisory.affected[0].database_specific.categories = [9]),
  ];
  for (const mutate of mutations) {
    const report = vulnerabilityResults({ severity: "3.9" });
    mutate(finding(report).vulnerabilities[0]);
    assert.throws(
      () => evaluateVulnerabilityResults(report),
      /Vulnerability policy rejected/u,
    );
  }
});

test("CVSS 3.1 Scope Changed base scores match the FIRST equation exhaustively", () => {
  let vectors = 0;
  for (const attackVector of ["N", "A", "L", "P"])
    for (const attackComplexity of ["L", "H"])
      for (const privilegesRequired of ["N", "L", "H"])
        for (const userInteraction of ["N", "R"])
          for (const confidentiality of ["N", "L", "H"])
            for (const integrity of ["N", "L", "H"])
              for (const availability of ["N", "L", "H"]) {
                const metrics = {
                  A: availability,
                  AC: attackComplexity,
                  AV: attackVector,
                  C: confidentiality,
                  I: integrity,
                  PR: privilegesRequired,
                  S: "C",
                  UI: userInteraction,
                };
                const vector = cvssVector(metrics);
                assert.equal(
                  cvss31BaseScore(vector),
                  firstCvss31BaseScore(metrics),
                  vector,
                );
                vectors += 1;
              }
  assert.equal(vectors, 1296);
  assert.equal(
    cvss31BaseScore("CVSS:3.1/AV:P/AC:H/PR:L/UI:N/S:C/C:H/I:H/A:L"),
    7,
  );
});

test("database severity normalizes exact canonical OSV and GitHub enum casing", () => {
  for (const [score, severity, blocked] of [
    ["3.9", "LOW", false],
    ["4.0", "MODERATE", true],
    ["4.0", "MEDIUM", true],
    ["7.0", "HIGH", true],
    ["9.0", "CRITICAL", true],
  ]) {
    for (const field of ["severity", "categories"]) {
      const report = vulnerabilityResults({ severity: score });
      const database =
        finding(report).vulnerabilities[0].affected[0].database_specific;
      database[field] = field === "categories" ? [severity] : severity;
      if (blocked)
        assert.throws(
          () => evaluateVulnerabilityResults(report),
          /Vulnerability policy rejected moderate-or-higher/u,
        );
      else
        assert.deepEqual(evaluateVulnerabilityResults(report), {
          blocking: 0,
          informationalUnmaintained: 0,
          low: 1,
        });
    }
  }
  for (const severity of [" MODERATE", "MODERATE ", "MODERATE!", "UNKNOWN"])
    for (const field of ["severity", "categories"]) {
      const report = vulnerabilityResults({ severity: "3.9" });
      const database =
        finding(report).vulnerabilities[0].affected[0].database_specific;
      database[field] = field === "categories" ? [severity] : severity;
      assert.throws(
        () => evaluateVulnerabilityResults(report),
        /Vulnerability policy rejected/u,
      );
    }
});

function cvssVector(metrics) {
  return `CVSS:3.1/AV:${metrics.AV}/AC:${metrics.AC}/PR:${metrics.PR}/UI:${metrics.UI}/S:${metrics.S}/C:${metrics.C}/I:${metrics.I}/A:${metrics.A}`;
}

function firstCvss31BaseScore(metrics) {
  const values = {
    A: { H: 0.56, L: 0.22, N: 0 },
    AC: { H: 0.44, L: 0.77 },
    AV: { A: 0.62, L: 0.55, N: 0.85, P: 0.2 },
    C: { H: 0.56, L: 0.22, N: 0 },
    I: { H: 0.56, L: 0.22, N: 0 },
    PR: { H: 0.5, L: 0.68, N: 0.85 },
    UI: { N: 0.85, R: 0.62 },
  };
  const iss =
    1 -
    (1 - values.C[metrics.C]) *
      (1 - values.I[metrics.I]) *
      (1 - values.A[metrics.A]);
  const impact = 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15);
  if (impact <= 0) return 0;
  const exploitability =
    8.22 *
    values.AV[metrics.AV] *
    values.AC[metrics.AC] *
    values.PR[metrics.PR] *
    values.UI[metrics.UI];
  return (
    Math.ceil(Math.min(1.08 * (impact + exploitability), 10) * 10 - 1e-10) / 10
  );
}

function finding(report) {
  return report.results[0].packages[0];
}

function vulnerabilityResults({
  fixed,
  informational,
  mixed = false,
  severity,
}) {
  const id = "RUSTSEC-2025-0001";
  const affected = (classification) => ({
    database_specific:
      classification === undefined
        ? { categories: [], cvss: null }
        : {
            categories: [],
            cvss: null,
            informational: classification,
            source: `https://github.com/rustsec/advisory-db/blob/osv/crates/${id}.json`,
          },
    package: {
      ecosystem: "crates.io",
      name: "fixture",
      purl: "pkg:cargo/fixture",
    },
    ranges: [
      {
        events: [
          { introduced: "0.0.0-0" },
          ...(fixed === undefined ? [] : [{ fixed }]),
        ],
        type: "SEMVER",
      },
    ],
  });
  return {
    results: [
      {
        packages: [
          {
            groups: [{ aliases: [id], ids: [id], max_severity: severity }],
            package: {
              ecosystem: "crates.io",
              name: "fixture",
              version: "1.0.0",
            },
            vulnerabilities: [
              {
                affected: [
                  affected(informational),
                  ...(mixed ? [affected(undefined)] : []),
                ],
                database_specific: { license: "CC0-1.0" },
                id,
                schema_version: "1.7.3",
              },
            ],
          },
        ],
        source: {
          path: "native/target/osv/native-macos-arm64.osv-scanner.json",
          type: "lockfile",
        },
      },
    ],
  };
}

test("captures a deterministic exact npm-ci dependency inventory", async () => {
  const fixture = await dependencyFixture();
  try {
    const first = await capture(fixture.frontend, join(fixture.root, "first"));
    const second = await capture(
      fixture.frontend,
      join(fixture.root, "second"),
    );
    assert.equal(first.treeSha256, second.treeSha256);
    assert.equal(first.files.length, 3);
    assert.match(first.lockSha256, /^[0-9a-f]{64}$/u);
    assert.match(first.markerSha256, /^[0-9a-f]{64}$/u);
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("rejects dependency symlinks", async () => {
  const fixture = await dependencyFixture();
  try {
    const hostile = join(fixture.modules, "fixture/hostile");
    await symlink("package.json", hostile);
    await assert.rejects(
      capture(fixture.frontend, join(fixture.root, "snapshot")),
      /symbolic-link/u,
    );
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test(
  "rejects dependency special files",
  { skip: process.platform === "win32" },
  async () => {
    const fixture = await dependencyFixture();
    try {
      const hostile = join(fixture.modules, "fixture/hostile");
      const result = spawnSync("mkfifo", [hostile]);
      assert.equal(result.status, 0);
      await assert.rejects(
        capture(fixture.frontend, join(fixture.root, "snapshot")),
        /special-entry/u,
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  },
);

test("rejects lock, marker, identity, inventory, and top-level drift", async () => {
  const mutations = [
    async ({ frontend, lock }) => {
      lock.packages["node_modules/fixture"].version = "2.0.0";
      await writeJson(join(frontend, "package-lock.json"), lock);
    },
    async ({ marker, modules }) => {
      marker.packages["node_modules/fixture"].integrity = "sha512-hostile";
      await writeJson(join(modules, ".package-lock.json"), marker);
    },
    async ({ modules }) => {
      await writeJson(join(modules, "fixture/package.json"), {
        name: "hostile",
        version: "1.0.0",
      });
    },
    async ({ modules }) => {
      await writeFile(join(modules, "fixture/unowned.txt"), "still-owned");
      await mkdir(join(modules, "extra"));
      await writeJson(join(modules, "extra/package.json"), {
        name: "extra",
        version: "1.0.0",
      });
    },
    async ({ modules }) => writeFile(join(modules, "unexpected"), "hostile"),
  ];
  for (const mutate of mutations) {
    const fixture = await dependencyFixture();
    try {
      await mutate(fixture);
      await assert.rejects(
        capture(fixture.frontend, join(fixture.root, "snapshot")),
        /Immutable snapshot rejected|Native traversal rejected/u,
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  }
});

test("requires a valid npm-ci marker and launcher directory", async () => {
  for (const mutation of [
    async ({ modules }) => rm(join(modules, ".package-lock.json")),
    async ({ modules }) => writeFile(join(modules, ".package-lock.json"), "{"),
    async ({ modules }) => {
      await rm(join(modules, ".bin"), { recursive: true });
      await writeFile(join(modules, ".bin"), "hostile");
    },
  ]) {
    const fixture = await dependencyFixture();
    try {
      await mutation(fixture);
      await assert.rejects(
        capture(fixture.frontend, join(fixture.root, "snapshot")),
        /rejected/u,
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  }
});

async function dependencyFixture() {
  const root = await mkdtemp(join(tmpdir(), "keiko-dependencies-"));
  const frontend = join(root, "frontend");
  const modules = join(frontend, "node_modules");
  await mkdir(join(modules, ".bin"), { recursive: true });
  await mkdir(join(modules, "fixture"));
  const entry = {
    version: "1.0.0",
    resolved: "https://registry.invalid/fixture.tgz",
    integrity: "sha512-fixture",
  };
  const lock = {
    lockfileVersion: 3,
    packages: { "": { name: "frontend" }, "node_modules/fixture": entry },
  };
  const marker = {
    lockfileVersion: 3,
    packages: { "node_modules/fixture": entry },
  };
  await writeJson(join(frontend, "package-lock.json"), lock);
  await writeJson(join(modules, ".package-lock.json"), marker);
  await writeJson(join(modules, "fixture/package.json"), {
    name: "fixture",
    version: "1.0.0",
  });
  await writeFile(join(modules, "fixture/index.js"), "export default 1;\n");
  return { frontend, lock, marker, modules, root };
}

async function capture(frontendRoot, snapshotRoot) {
  await mkdir(snapshotRoot);
  return captureDependencySnapshot({
    frontendRoot,
    snapshotRoot,
    async writeFile(path, bytes) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    },
  });
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}
