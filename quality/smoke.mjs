import { validateRepository } from "./contract.mjs";

const result = await validateRepository(process.cwd());
if (result.failureCount > 0) throw new Error("Quality contract smoke failed.");
process.stdout.write("Keiko Native quality bootstrap is operational.\n");
