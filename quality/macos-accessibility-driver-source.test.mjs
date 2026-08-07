import assert from "node:assert/strict";
import test from "node:test";

import {
  authenticateCurrentEvaluationCheckout,
  authenticateEvaluationCheckout,
  authenticateRuntimeInputState,
  digestFramedSources,
  evaluationRepositoryRoot,
  evaluationRuntimeInputPaths,
  gitReadEnvironment,
  inspectCurrentRuntimeInputs,
  physicalEvaluationSourceDigest,
  physicalEvaluationSourceNames,
  postEvaluationPathPolicy,
} from "./macos-accessibility-driver-source.mjs";

test("source digest frames file identity and bytes without concatenation ambiguity", () => {
  const left = digestFramedSources([
    { name: "a", bytes: Buffer.from("bc") },
    { name: "d", bytes: Buffer.from("") },
  ]);
  const changedName = digestFramedSources([
    { name: "ab", bytes: Buffer.from("c") },
    { name: "d", bytes: Buffer.from("") },
  ]);
  const changedBoundary = digestFramedSources([
    { name: "a", bytes: Buffer.from("b") },
    { name: "c", bytes: Buffer.from("d") },
  ]);

  assert.match(left, /^[0-9a-f]{64}$/u);
  assert.notEqual(left, changedName);
  assert.notEqual(left, changedBoundary);
});

test("source digest binds every decision-critical evaluator source", async () => {
  assert.deepEqual(physicalEvaluationSourceNames, [
    "evaluate-macos-accessibility-driver.mjs",
    "macos-accessibility-driver-evaluation.mjs",
    "macos-accessibility-driver-harness.mjs",
    "macos-accessibility-driver-source.mjs",
    "macos-accessibility-foundation-attestation.mjs",
    "run-macos-accessibility-driver-evaluation.mjs",
  ]);
  assert.match(await physicalEvaluationSourceDigest(), /^[0-9a-f]{64}$/u);
});

test("source digest rejects malformed entries", () => {
  assert.throws(
    () => digestFramedSources([{ name: "", bytes: Buffer.from("source") }]),
    /evaluation-source-entry-invalid/u,
  );
  assert.throws(
    () => digestFramedSources([{ name: "source", bytes: "not-bytes" }]),
    /evaluation-source-entry-invalid/u,
  );
});

test("checkout authentication allows only versioned retained evidence paths after the source head", () => {
  const evaluationHead = "a".repeat(40);
  const currentHead = "b".repeat(40);
  assert.equal(postEvaluationPathPolicy.schemaVersion, 1);
  assert.deepEqual(
    authenticateEvaluationCheckout({
      ancestor: true,
      changes: [
        {
          blobType: "blob",
          newMode: "100644",
          oldMode: "000000",
          path: "docs/evaluation/macos-accessibility-driver-evidence.json",
          status: "A",
        },
      ],
      currentHead,
      evaluationHead,
      workingTreeClean: true,
    }),
    { authenticated: true, reasonCode: null },
  );

  for (const mutation of [
    { ancestor: false },
    { workingTreeClean: false },
    {
      changes: [
        {
          blobType: "blob",
          newMode: "100644",
          oldMode: "100644",
          path: "quality/macos-accessibility-driver-harness.mjs",
          status: "M",
        },
      ],
    },
    {
      changes: [
        {
          blobType: "blob",
          newMode: "000000",
          oldMode: "100644",
          path: "docs/evaluation/macos-accessibility-driver-evidence.json",
          status: "D",
        },
      ],
    },
    {
      changes: [
        {
          blobType: "tree",
          newMode: "040000",
          oldMode: "000000",
          path: "docs/evaluation/macos-accessibility-driver-evidence.json",
          status: "A",
        },
      ],
    },
    {
      changes: [
        {
          blobType: "blob",
          newMode: "100755",
          oldMode: "100644",
          path: "docs/evaluation/macos-accessibility-driver-evidence.json",
          status: "M",
        },
      ],
    },
  ]) {
    assert.equal(
      authenticateEvaluationCheckout({
        ancestor: true,
        changes: [],
        currentHead,
        evaluationHead,
        workingTreeClean: true,
        ...mutation,
      }).authenticated,
      false,
    );
  }
});

test("checkout authentication accepts squash delivery through the immutable source digest", () => {
  assert.deepEqual(
    authenticateEvaluationCheckout({
      ancestor: false,
      changes: [],
      currentHead: "b".repeat(40),
      evaluationHead: "a".repeat(40),
      sourceDigestAuthenticated: true,
      workingTreeClean: true,
    }),
    { authenticated: true, reasonCode: null },
  );
  assert.deepEqual(
    authenticateEvaluationCheckout({
      ancestor: false,
      changes: [],
      currentHead: "b".repeat(40),
      evaluationHead: "a".repeat(40),
      sourceDigestAuthenticated: false,
      workingTreeClean: true,
    }),
    { authenticated: false, reasonCode: "evaluation-head-not-ancestor" },
  );
});

function gitResult(stdout = "", exitCode = 0) {
  return {
    exitCode,
    signal: null,
    stderrEmpty: true,
    stdout: Buffer.from(stdout, "utf8"),
    timedOut: false,
  };
}

test("current checkout authentication binds clean bytes, fixed root, and full object identities", () => {
  const evaluationHead = "a".repeat(40);
  const currentHead = "b".repeat(40);
  const blob = "c".repeat(40);
  const calls = [];
  const run = (args, repositoryRoot) => {
    calls.push({ args, repositoryRoot });
    if (args[0] === "status") return gitResult();
    if (args[0] === "rev-parse") return gitResult(`${currentHead}\n`);
    if (args[0] === "merge-base") return gitResult();
    if (args[0] === "diff")
      return gitResult(
        `:000000 100644 ${"0".repeat(40)} ${blob} A\0docs/evaluation/macos-accessibility-driver-evidence.json\0`,
      );
    if (args[0] === "cat-file") return gitResult("blob\n");
    throw new Error("unexpected-git-command");
  };
  assert.deepEqual(
    authenticateCurrentEvaluationCheckout(evaluationHead, {
      inspectInputs: () => ({
        authenticated: true,
        reasonCode: null,
      }),
      run,
    }),
    { authenticated: true, reasonCode: null },
  );
  assert.ok(
    calls.every(
      ({ repositoryRoot }) => repositoryRoot === evaluationRepositoryRoot,
    ),
  );
  assert.ok(
    calls.find(({ args }) => args[0] === "diff").args.includes("--abbrev=40"),
  );

  assert.deepEqual(
    authenticateCurrentEvaluationCheckout(evaluationHead, {
      inspectInputs: () => ({ authenticated: true, reasonCode: null }),
      run: (args) => {
        if (args[0] === "status") return gitResult();
        if (args[0] === "rev-parse") return gitResult(`${currentHead}\n`);
        if (args[0] === "merge-base") return gitResult("", 1);
        if (args[0] === "diff") return gitResult();
        throw new Error("squash-authentication-read-past-diff");
      },
      sourceDigestAuthenticated: true,
    }),
    { authenticated: true, reasonCode: null },
  );

  let foreignRootInvoked = false;
  assert.deepEqual(
    authenticateCurrentEvaluationCheckout(evaluationHead, {
      repositoryRoot: "/private/tmp/foreign-repository",
      run: () => {
        foreignRootInvoked = true;
        return gitResult();
      },
    }),
    {
      authenticated: false,
      reasonCode: "evaluation-checkout-input-invalid",
    },
  );
  assert.equal(foreignRootInvoked, false);

  assert.deepEqual(
    authenticateCurrentEvaluationCheckout(evaluationHead, {
      inspectInputs: () => ({
        authenticated: true,
        reasonCode: null,
      }),
      run: (args) =>
        args[0] === "status"
          ? gitResult(
              " M docs/evaluation/macos-accessibility-driver-evidence.json\0",
            )
          : (() => {
              throw new Error("dirty-checkout-read-past-status");
            })(),
    }),
    {
      authenticated: false,
      reasonCode: "evaluation-working-tree-dirty",
    },
  );

  assert.deepEqual(
    authenticateCurrentEvaluationCheckout(evaluationHead, {
      inspectInputs: () => ({
        authenticated: true,
        reasonCode: null,
      }),
      run: (args) => {
        if (args[0] === "status") return gitResult();
        if (args[0] === "rev-parse") return gitResult(`${currentHead}\n`);
        if (args[0] === "merge-base") return gitResult();
        if (args[0] === "diff")
          return gitResult(
            `:000000 100644 0000000 ccccccc A\0docs/evaluation/macos-accessibility-driver-evidence.json\0`,
          );
        throw new Error("abbreviated-object-read-past-diff");
      },
    }),
    {
      authenticated: false,
      reasonCode: "evaluation-checkout-diff-invalid",
    },
  );
});

test("runtime input authentication rejects hidden index and byte substitutions", () => {
  const path = "docs/evaluation/macos-accessibility-driver-evidence.json";
  const object = "d".repeat(40);
  const valid = {
    indexFlags: [`H ${path}`],
    inputs: [
      {
        headMode: "100644",
        headObject: object,
        indexMode: "100644",
        indexObject: object,
        indexStage: "0",
        path,
        worktreeMode: "100644",
        worktreeObject: object,
        worktreeType: "file",
      },
    ],
    requiredPaths: [path],
  };
  assert.deepEqual(authenticateRuntimeInputState(valid), {
    authenticated: true,
    reasonCode: null,
  });
  for (const mutation of [
    { indexFlags: [`h ${path}`] },
    { indexFlags: [`S ${path}`] },
    { inputs: [{ ...valid.inputs[0], indexObject: "e".repeat(40) }] },
    { inputs: [{ ...valid.inputs[0], worktreeObject: "e".repeat(40) }] },
    { inputs: [{ ...valid.inputs[0], worktreeType: "symbolic-link" }] },
    { inputs: [{ ...valid.inputs[0], worktreeMode: "100755" }] },
    { inputs: [] },
  ]) {
    assert.equal(
      authenticateRuntimeInputState({ ...valid, ...mutation }).authenticated,
      false,
    );
  }
});

test("production runtime inspection binds the exact canonical path inventory and raw Git records", () => {
  assert.deepEqual(evaluationRuntimeInputPaths, [
    "quality/evaluate-macos-accessibility-driver.mjs",
    "quality/macos-accessibility-driver-evaluation.mjs",
    "quality/macos-accessibility-driver-harness.mjs",
    "quality/macos-accessibility-driver-source.mjs",
    "quality/macos-accessibility-foundation-attestation.mjs",
    "quality/run-macos-accessibility-driver-evaluation.mjs",
    "docs/evaluation/macos-accessibility-driver-capture-allowed.json",
    "docs/evaluation/macos-accessibility-driver-capture-denied.json",
    "docs/evaluation/macos-accessibility-driver-capture-recovered.json",
    "docs/evaluation/macos-accessibility-driver-capture-revoked.json",
    "docs/evaluation/macos-accessibility-driver-evidence.json",
    "docs/evaluation/macos-accessibility-driver-foundation-acceptance.json",
    "docs/evaluation/macos-accessibility-driver-foundation-package-manifest.json",
    "docs/evaluation/macos-accessibility-driver-prepared.json",
    "native/package-policy.json",
  ]);
  const object = "d".repeat(40);
  const inspect = ({
    flags = evaluationRuntimeInputPaths.map((path) => `H ${path}`),
    indexObject = object,
    missingPath = null,
    worktreeObject = object,
    worktreeMode = 0o100644,
    worktreeRegular = true,
  } = {}) =>
    inspectCurrentRuntimeInputs(
      (args) => {
        const path = args.at(-1);
        if (args[0] === "ls-files" && args[1] === "-v")
          return gitResult(`${flags.join("\0")}\0`);
        if (args[0] === "ls-tree")
          return gitResult(
            path === missingPath ? "" : `100644 blob ${object}\t${path}\0`,
          );
        if (args[0] === "ls-files" && args[1] === "-s")
          return gitResult(`100644 ${indexObject} 0\t${path}\0`);
        if (args[0] === "hash-object") {
          assert.ok(args.includes("--no-filters"));
          return gitResult(`${worktreeObject}\n`);
        }
        throw new Error("unexpected-runtime-inspection-command");
      },
      evaluationRepositoryRoot,
      () => ({
        isFile: () => worktreeRegular,
        mode: worktreeMode,
      }),
    );

  assert.deepEqual(inspect(), {
    authenticated: true,
    reasonCode: null,
  });
  for (const mutation of [
    {
      flags: evaluationRuntimeInputPaths.map(
        (path, index) => `${index === 0 ? "h" : "H"} ${path}`,
      ),
    },
    { indexObject: "e".repeat(40) },
    { missingPath: evaluationRuntimeInputPaths[0] },
    { worktreeObject: "e".repeat(40) },
    { worktreeMode: 0o100755 },
    { worktreeRegular: false },
  ])
    assert.equal(inspect(mutation).authenticated, false);
});

test("git read environment rejects every inherited Git control", () => {
  const environment = gitReadEnvironment({
    GIT_CONFIG_PARAMETERS: "'core.fsmonitor'='true'",
    GIT_DIR: "/private/tmp/foreign.git",
    GIT_INDEX_FILE: "/private/tmp/foreign.index",
    GIT_OBJECT_DIRECTORY: "/private/tmp/foreign-objects",
    PATH: "/usr/bin:/bin",
  });
  assert.equal(environment.PATH, "/usr/bin:/bin");
  assert.deepEqual(
    Object.keys(environment)
      .filter((name) => name.startsWith("GIT_"))
      .toSorted(),
    [
      "GIT_ATTR_NOSYSTEM",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_CONFIG_SYSTEM",
      "GIT_NO_REPLACE_OBJECTS",
      "GIT_OPTIONAL_LOCKS",
    ],
  );
});
