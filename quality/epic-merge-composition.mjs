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
  let ports;
  try {
    const github = createEpicMergeGitHubBoundary({ request });
    ports = createInertEpicMergeAdapter({ clock, github, store });
  } catch (error) {
    store.close();
    throw error;
  }
  return Object.freeze({
    close: store.close,
    reconcile: (input) => reconcileEpicMergeOperation(input, ports),
    run: (input) => runGuardedEpicMerge(input, ports),
  });
}
