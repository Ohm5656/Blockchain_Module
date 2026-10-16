// Node core import makes accidental browser bundling fail without a Node polyfill.
import { versions } from "node:process";

if (typeof window !== "undefined" || !versions.node) {
  throw new Error("Fuji signing module is server-only; import it only in a Node backend.");
}
