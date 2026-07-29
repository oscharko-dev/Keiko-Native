export const LIFECYCLE_PROVIDER_BUDGETS = Object.freeze({
  normal: 136,
  recovery: 150,
});

export class LifecycleProviderError extends Error {
  constructor(code) {
    super(code);
    this.name = "LifecycleProviderError";
    this.code = code;
  }
}

const statusCode = (error) => error?.status ?? error?.statusCode;

export function classifyProviderFailure(error) {
  if (error instanceof LifecycleProviderError) return error.code;
  if (error?.name === "AbortError" || error?.code === "ETIMEDOUT")
    return "provider-timeout";
  const status = statusCode(error);
  if (status === 429 || error?.rateLimited === true)
    return "provider-rate-limited";
  if (status === 409) return "provider-conflict";
  if ([403, 404, 422].includes(status)) return "provider-rejected";
  return "provider-unavailable";
}

export function createLifecycleProviderBudget(mode = "normal") {
  const limit = LIFECYCLE_PROVIDER_BUDGETS[mode];
  if (limit === undefined) throw new TypeError("unknown lifecycle budget mode");
  let used = 0;
  return Object.freeze({
    mode,
    limit,
    get used() {
      return used;
    },
    get remaining() {
      return limit - used;
    },
    consume(count = 1) {
      if (!Number.isSafeInteger(count) || count <= 0)
        throw new TypeError("request count must be a positive safe integer");
      if (used + count > limit)
        throw new LifecycleProviderError("provider-rate-limited");
      used += count;
      return used;
    },
  });
}

export function lifecycleIssueConcurrencyGroup(issueNumber) {
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0)
    throw new TypeError("issue number must be a positive safe integer");
  return `issue-lifecycle-${issueNumber}`;
}

export function lifecycleProviderConcurrencyGroup() {
  return "issue-lifecycle-provider-budget";
}

export function lifecycleSerializationContract(issueNumber) {
  return Object.freeze({
    acquisitionOrder: Object.freeze([
      lifecycleIssueConcurrencyGroup(issueNumber),
      lifecycleProviderConcurrencyGroup(),
    ]),
    cancelInProgress: false,
    queue: "max",
  });
}

export async function callLifecycleProvider(budget, operation) {
  budget.consume();
  try {
    return await operation();
  } catch (error) {
    throw new LifecycleProviderError(classifyProviderFailure(error));
  }
}
