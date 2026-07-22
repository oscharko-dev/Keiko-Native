import { enforceExactToolchain } from "./toolchain.mjs";

try {
  enforceExactToolchain();
  console.log("toolchain: passed node=24.18.0 npm=11.16.0");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
