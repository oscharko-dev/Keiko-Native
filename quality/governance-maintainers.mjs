export const GOVERNANCE_MAINTAINERS = Object.freeze([
  Object.freeze({ id: 159039192, login: "Niko4417", type: "User" }),
  Object.freeze({ id: 59687448, login: "oscharko", type: "User" }),
]);

const byId = new Map(GOVERNANCE_MAINTAINERS.map((entry) => [entry.id, entry]));
const byLogin = new Map(
  GOVERNANCE_MAINTAINERS.map((entry) => [entry.login.toLowerCase(), entry]),
);

export function governanceMaintainerById(id) {
  return Number.isSafeInteger(id) ? byId.get(id) : undefined;
}

export function governanceMaintainerByLogin(login) {
  return typeof login === "string"
    ? byLogin.get(login.toLowerCase())
    : undefined;
}

export function isGovernanceMaintainerActor(actor) {
  const expected = governanceMaintainerById(actor?.id);
  return (
    expected !== undefined &&
    actor?.type === expected.type &&
    actor?.login === expected.login
  );
}
