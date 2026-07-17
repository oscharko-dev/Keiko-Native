export const LIFECYCLE_STATES = Object.freeze([
  "status: new",
  "status: triaged",
  "status: ready",
  "status: in progress",
  "status: pr open",
  "status: ready for human review",
  "status: blocked",
  "status: waiting for user",
  "status: done",
]);

const lifecycleStateSet = new Set(LIFECYCLE_STATES);
const activeRequestSources = LIFECYCLE_STATES.slice(0, 8);
const planningActorRoles = new Set(["planner", "maintainer"]);
const deliveryActorRoles = new Set(["implementer", "maintainer"]);

function freezeEdgeMap(entries) {
  return Object.freeze(
    Object.fromEntries(
      entries.map(([source, targets]) => [source, Object.freeze(targets)]),
    ),
  );
}

export const ALLOWED_LIFECYCLE_EDGES = freezeEdgeMap([
  [
    "status: new",
    ["status: triaged", "status: blocked", "status: waiting for user"],
  ],
  [
    "status: triaged",
    [
      "status: ready",
      "status: blocked",
      "status: waiting for user",
      "status: new",
    ],
  ],
  [
    "status: ready",
    [
      "status: in progress",
      "status: blocked",
      "status: waiting for user",
      "status: new",
    ],
  ],
  [
    "status: in progress",
    [
      "status: ready",
      "status: pr open",
      "status: blocked",
      "status: waiting for user",
      "status: new",
    ],
  ],
  [
    "status: pr open",
    [
      "status: ready",
      "status: in progress",
      "status: ready for human review",
      "status: blocked",
      "status: waiting for user",
      "status: new",
    ],
  ],
  [
    "status: ready for human review",
    [
      "status: pr open",
      "status: in progress",
      "status: blocked",
      "status: waiting for user",
      "status: new",
      "status: done",
    ],
  ],
  [
    "status: blocked",
    [
      "status: waiting for user",
      "status: new",
      "status: triaged",
      "status: ready",
      "status: in progress",
      "status: pr open",
    ],
  ],
  [
    "status: waiting for user",
    [
      "status: blocked",
      "status: new",
      "status: triaged",
      "status: ready",
      "status: in progress",
      "status: pr open",
    ],
  ],
  ["status: done", ["status: new"]],
]);

function pair(source, target) {
  return Object.freeze({ source, target });
}

export const PERMITTED_LABEL_REQUESTS = Object.freeze([
  pair("status: new", "status: triaged"),
  pair("status: triaged", "status: ready"),
  ...activeRequestSources
    .filter((source) => source !== "status: blocked")
    .map((source) => pair(source, "status: blocked")),
  ...activeRequestSources
    .filter((source) => source !== "status: waiting for user")
    .map((source) => pair(source, "status: waiting for user")),
]);

const permittedRequestKeys = new Set(
  PERMITTED_LABEL_REQUESTS.map(({ source, target }) => `${source}->${target}`),
);

function labelName(label) {
  if (typeof label === "string") return label;
  return typeof label?.name === "string" ? label.name : undefined;
}

function statusLabels(labels) {
  if (!Array.isArray(labels))
    return { failures: ["Label names are unavailable."], states: [] };
  const names = labels.map(labelName);
  const failures = names.includes(undefined)
    ? ["A label name is unavailable."]
    : [];
  const states = names.filter((name) => name?.startsWith("status: "));
  const unknown = [
    ...new Set(states.filter((name) => !lifecycleStateSet.has(name))),
  ];
  if (unknown.length > 0)
    failures.push(`Unknown lifecycle status labels: ${unknown.join(", ")}.`);
  const duplicates = states.filter(
    (name, index) => states.indexOf(name) !== index,
  );
  if (duplicates.length > 0)
    failures.push(
      `Duplicate lifecycle status labels: ${[...new Set(duplicates)].join(", ")}.`,
    );
  return {
    failures,
    states: states.filter((state) => lifecycleStateSet.has(state)),
  };
}

function success(extra = {}) {
  return { failures: [], ok: true, ...extra };
}

function failure(failures, extra = {}) {
  return { failures, ok: false, ...extra };
}

export function validateProviderStatusLabels(labelNames) {
  const observed = statusLabels(labelNames);
  const observedSet = new Set(observed.states);
  const missing = LIFECYCLE_STATES.filter((state) => !observedSet.has(state));
  const unexpected = Array.isArray(labelNames)
    ? [
        ...new Set(
          labelNames
            .map(labelName)
            .filter((name) => name?.startsWith("status: "))
            .filter((name) => !lifecycleStateSet.has(name)),
        ),
      ]
    : [];
  const failures = [...observed.failures];
  if (missing.length > 0)
    failures.push(`Missing lifecycle status labels: ${missing.join(", ")}.`);
  if (unexpected.length > 0)
    failures.push(
      `Unexpected lifecycle status labels: ${unexpected.join(", ")}.`,
    );
  return { failures, missing, ok: failures.length === 0, unexpected };
}

export function isAllowedLifecycleEdge(source, target) {
  return ALLOWED_LIFECYCLE_EDGES[source]?.includes(target) === true;
}

function validIdentity(value) {
  return typeof value === "string" && value.trim() !== "";
}

function hasReason(value) {
  return typeof value === "string" && value.trim() !== "";
}

function roleAllowed(target, actorRole) {
  if (target === "status: triaged" || target === "status: ready")
    return planningActorRoles.has(actorRole);
  return deliveryActorRoles.has(actorRole);
}

function reasonFailures(input) {
  if (
    input.requestedTarget === "status: blocked" &&
    !hasReason(input.blockingCondition)
  )
    return ["Blocked requests require a validated blocking condition."];
  if (
    input.requestedTarget === "status: waiting for user" &&
    !hasReason(input.humanInput)
  )
    return ["Waiting requests require the missing human input."];
  return [];
}

export function validateTransitionRequest(input) {
  const failures = [];
  if (!lifecycleStateSet.has(input?.currentState))
    failures.push("The current lifecycle state is not canonical.");
  if (!lifecycleStateSet.has(input?.requestedSource))
    failures.push("The requested source lifecycle state is not canonical.");
  if (!lifecycleStateSet.has(input?.requestedTarget))
    failures.push("The requested target lifecycle state is not canonical.");
  if (!validIdentity(input?.eventIdentity))
    failures.push("The transition request identity is missing.");
  if (input?.currentState !== input?.requestedSource)
    failures.push("The requested source does not match current state.");
  if (failures.length > 0) return failure(failures);

  const requestKey = `${input.requestedSource}->${input.requestedTarget}`;
  if (!permittedRequestKeys.has(requestKey))
    return failure(["The source and requested-target pair is not permitted."]);
  if (!roleAllowed(input.requestedTarget, input.actorRole))
    return failure(["The actor role is not authorized for this request."]);

  const reasonResult = reasonFailures(input);
  return reasonResult.length > 0 ? failure(reasonResult) : success();
}

function validateDesiredState(desiredState) {
  return lifecycleStateSet.has(desiredState)
    ? []
    : ["The desired lifecycle state is not canonical."];
}

export function planStatusLabelReconciliation(currentLabels, desiredState) {
  const observed = statusLabels(currentLabels);
  const failures = [
    ...observed.failures,
    ...validateDesiredState(desiredState),
  ];
  if (failures.length > 0) return failure(failures, { apply: [], remove: [] });
  const remove = observed.states.filter((state) => state !== desiredState);
  const apply = observed.states.includes(desiredState) ? [] : [desiredState];
  return success({ apply, remove });
}

export function verifyStatusLabelReadback({
  actualIssueIdentity,
  desiredState,
  expectedIssueIdentity,
  labels,
}) {
  const observed = statusLabels(labels);
  const failures = [
    ...observed.failures,
    ...validateDesiredState(desiredState),
  ];
  if (actualIssueIdentity !== expectedIssueIdentity)
    failures.push("The issue identity changed during reconciliation.");
  if (observed.states.length !== 1)
    failures.push("Lifecycle read-back must contain exactly one status label.");
  if (observed.states[0] !== desiredState)
    failures.push("Lifecycle read-back does not equal the desired state.");
  return failures.length > 0
    ? failure([...new Set(failures)])
    : success({ state: desiredState });
}
