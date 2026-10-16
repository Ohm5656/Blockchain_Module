import { FujiError } from "../fuji/errors.js";

export function reportFailure(error: unknown): void {
  // Never dump a raw RPC error, private key, or signed transaction.
  console.error(error instanceof FujiError
    ? `[${error.code}] ${error.message}`
    : "Unexpected Fuji command failure. Check server configuration; raw diagnostics are suppressed to protect secrets.");
  process.exitCode = 1;
}
