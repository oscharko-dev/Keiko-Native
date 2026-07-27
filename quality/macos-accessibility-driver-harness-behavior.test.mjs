import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  checkpointBehaviorContract,
  classifyCandidateSubprocessOutcome,
  createEvaluationArtifacts,
} from "./macos-accessibility-driver-harness.mjs";

const expectedCheckpoints = [
  "workspace-select",
  "workspace-cancel",
  "workspace-permission-deny",
  "task-submit",
  "streaming",
  "normal-completion",
  "run-cancellation",
  "crash-recovery",
  "terminal-summary",
  "keyboard-focus",
  "voiceover-semantics",
  "appearance-contrast",
  "reduce-motion-applicability",
  "scaling",
  "unicode-ime",
  "quit-zero-descendants",
];

test("representative checkpoint contract keeps 16 behavioral semantics", () => {
  assert.deepEqual(
    Object.keys(checkpointBehaviorContract),
    expectedCheckpoints,
  );
  assert.deepEqual(
    checkpointBehaviorContract["workspace-permission-deny"].observations,
    ["workspace:permission-denied"],
  );
  assert.deepEqual(checkpointBehaviorContract["task-submit"].observations, [
    "task:submitted-after-late-state",
  ]);
  assert.deepEqual(
    checkpointBehaviorContract["run-cancellation"].observations,
    ["run:cancelled-late-result-discarded"],
  );
  assert.deepEqual(checkpointBehaviorContract["crash-recovery"].observations, [
    "runtime:crashed",
    "runtime:recovered",
  ]);
  assert.deepEqual(
    checkpointBehaviorContract["appearance-contrast"].observations,
    ["appearance:light", "appearance:dark", "appearance:increase-contrast"],
  );
  assert.deepEqual(
    checkpointBehaviorContract["reduce-motion-applicability"].observations,
    ["motion:reduced", "motion:full"],
  );
});

test("generated candidates observe behavioral states rather than identifier echo", async () => {
  const root = await mkdtemp(join(tmpdir(), "keiko-behavior-contract-"));
  try {
    const artifacts = await createEvaluationArtifacts(root);
    const [surface, axuielement, systemEvents] = await Promise.all([
      readFile(artifacts.surfaceSource, "utf8"),
      readFile(artifacts.axuielementSource, "utf8"),
      readFile(artifacts.systemEventsSource, "utf8"),
    ]);

    assert.doesNotMatch(surface, /journeyState\.stringValue = identifier/u);
    assert.match(surface, /completeLateTaskState/u);
    assert.match(surface, /completeCancellationRace/u);
    assert.match(surface, /completeRuntimeRecovery/u);
    assert.equal(surface.match(/self\.window\.title =/gu)?.length, 1);
    assert.match(
      surface,
      /self\.window\.accessibilityHelp =\s+\[@"Keiko Accessibility Evaluation state:" stringByAppendingString:state\];/u,
    );
    for (const expected of [
      "workspace:permission-denied",
      "task:submitted-after-late-state",
      "run:cancelled-late-result-discarded",
      "runtime:recovered",
      "appearance:increase-contrast",
      "motion:reduced",
    ]) {
      assert.match(axuielement, new RegExp(expected, "u"));
      assert.match(systemEvents, new RegExp(expected, "u"));
    }
    assert.match(
      surface,
      /isEqualToString:@"crash-recovery"\]\) \{\s+\[self setSemanticState:@"runtime:crashed"\];\s+\[self performSelector:@selector\(completeRuntimeRecovery\)\s+withObject:nil\s+afterDelay:0\.75\];/u,
    );
    const axActionBlock = axuielement.match(
      /\} else if \(IsActionCheckpoint\(identifier\)\) \{(?<body>[\s\S]*?)\n    \} else \{/u,
    )?.groups?.body;
    assert.equal(axActionBlock?.match(/AXUIElementPerformAction/g)?.length, 2);
    assert.match(
      axActionBlock,
      /^\s+if \(IsSinglePressTransition\(identifier\)\) \{\s+action = AXUIElementPerformAction\(element, kAXPressAction\);\s+\}\s+for \(NSString \*expectedState in expectedObservations\) \{\s+if \(!IsSinglePressTransition\(identifier\)\) \{\s+action = AXUIElementPerformAction\(element, kAXPressAction\);/u,
    );
    const systemEventsActionBlock = systemEvents.match(
      /else if actionIdentifiers contains identifierValue then(?<body>[\s\S]*?)\n      else\n        return my closed\("failed", "checkpoint-action-failed", 0\)/u,
    )?.groups?.body;
    assert.equal(
      systemEventsActionBlock?.match(
        /perform action "AXPress" of targetElement/g,
      )?.length,
      2,
    );
    assert.match(
      systemEventsActionBlock,
      /if singlePressIdentifiers contains identifierValue then\s+perform action "AXPress" of targetElement\s+end if\s+repeat with expectedState in expectedStates\s+if singlePressIdentifiers does not contain identifierValue then\s+perform action "AXPress" of targetElement/u,
    );
    assert.doesNotMatch(
      systemEventsActionBlock,
      /set journeyStateElement to item 1 of journeyStateElements/u,
    );
    assert.doesNotMatch(
      systemEventsActionBlock,
      /entire contents of item 1 of \(value of attribute "AXWindows" of targetProcess\)/u,
    );
    assert.match(
      systemEventsActionBlock,
      /set expectedWindowHelp to "Keiko Accessibility Evaluation state:" & \(contents of expectedState\)\s+set deadlineDate to \(current date\) \+ 2\s+repeat\s+try\s+set refreshedWindows to value of attribute "AXWindows" of targetProcess\s+if \(count of refreshedWindows\) is 1 and \(value of attribute "AXHelp" of item 1 of refreshedWindows\) is expectedWindowHelp then[\s\S]*?end try\s+if \(current date\) is greater than or equal to deadlineDate then exit repeat\s+delay 0\.02\s+end repeat\s+if stateObserved is false then\s+return my closed\("failed", "checkpoint-observation-failed", 0\)/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("candidate subprocess results fail closed on process-level anomalies", () => {
  const passed = {
    exitCode: 0,
    signal: null,
    stderrEmpty: true,
    stdout:
      '{"status":"passed","reasonCode":null,"prompted":false,"checkpointPasses":1,"hostile":"must-not-propagate"}',
    timedOut: false,
  };
  assert.deepEqual(classifyCandidateSubprocessOutcome(passed), {
    checkpointPasses: 1,
    prompted: false,
    reasonCode: null,
    status: "passed",
  });

  for (const hostile of [
    { ...passed, exitCode: 9 },
    { ...passed, exitCode: null, signal: "SIGKILL" },
    { ...passed, stderrEmpty: false },
  ]) {
    assert.deepEqual(classifyCandidateSubprocessOutcome(hostile), {
      checkpointPasses: 0,
      prompted: false,
      reasonCode: "candidate-process-failed",
      status: "failed",
    });
  }

  assert.deepEqual(
    classifyCandidateSubprocessOutcome({ ...passed, timedOut: true }),
    {
      checkpointPasses: 0,
      prompted: false,
      reasonCode: "bounded-wait-expired",
      status: "failed",
    },
  );

  assert.deepEqual(
    classifyCandidateSubprocessOutcome({
      ...passed,
      stdout:
        '{"status":"permission-denied","reasonCode":"accessibility-permission-denied","prompted":false,"checkpointPasses":0}',
    }),
    {
      checkpointPasses: 0,
      prompted: false,
      reasonCode: "accessibility-permission-denied",
      status: "permission-denied",
    },
  );
  assert.deepEqual(
    classifyCandidateSubprocessOutcome({
      ...passed,
      stdout:
        '{"status":"failed","reasonCode":"checkpoint-observation-failed","prompted":false,"checkpointPasses":0}',
    }),
    {
      checkpointPasses: 0,
      prompted: false,
      reasonCode: "checkpoint-observation-failed",
      status: "failed",
    },
  );

  for (const stdout of [
    "{",
    '{"status":"passed","reasonCode":null,"prompted":false,"checkpointPasses":0}',
    '{"status":"passed","reasonCode":"checkpoint-observation-failed","prompted":false,"checkpointPasses":1}',
    '{"status":"permission-denied","reasonCode":"accessibility-permission-denied","prompted":false,"checkpointPasses":1}',
    '{"status":"permission-denied","reasonCode":"checkpoint-observation-failed","prompted":false,"checkpointPasses":0}',
    '{"status":"failed","reasonCode":null,"prompted":false,"checkpointPasses":0}',
    '{"status":"failed","reasonCode":"checkpoint-observation-failed","prompted":false,"checkpointPasses":1}',
    '{"status":"unknown","reasonCode":null,"prompted":false,"checkpointPasses":1}',
  ]) {
    assert.deepEqual(
      classifyCandidateSubprocessOutcome({ ...passed, stdout }),
      {
        checkpointPasses: 0,
        prompted: false,
        reasonCode: "candidate-output-invalid",
        status: "failed",
      },
    );
  }
});
