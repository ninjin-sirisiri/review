import { runAdapter } from "../../common/src/adapter-contract";

export { mapHostEvent, runAdapter } from "../../common/src/adapter-contract";
export { RecorderBridge } from "../../common/src/bridge";

if (import.meta.main) {
  await runAdapter("codex", process.stdin, process.stdout);
}
