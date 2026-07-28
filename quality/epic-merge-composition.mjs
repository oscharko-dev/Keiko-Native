import { createInertEpicMergeAdapter } from "./epic-merge-adapter.mjs";
import {
  reconcileEpicMergeOperation,
  runGuardedEpicMerge,
} from "./epic-merge-broker.mjs";
import { createEpicMergeGitHubBoundary } from "./epic-merge-github.mjs";
import { createEpicMergeOperationStore } from "./epic-merge-store.mjs";

export function createInertEpicMergeComposition({
  clock,
  databasePath,
  request,
}) {
  const store = createEpicMergeOperationStore(databasePath);
  const github = createEpicMergeGitHubBoundary({ request });
  const ports = createInertEpicMergeAdapter({ clock, github, store });
  return Object.freeze({
    close: store.close,
    reconcile: (input) => reconcileEpicMergeOperation(input, ports),
    run: (input) => runGuardedEpicMerge(input, ports),
  });
}
