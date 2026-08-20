import { createRecorderServer, type RecorderServer } from "./http/server";

export interface RecorderCliOptions {
  dataDir?: string;
  port?: number;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new RangeError("--port must be an integer between 0 and 65535");
  return port;
}

export function parseRecorderCliArgs(args: string[]): RecorderCliOptions {
  const options: RecorderCliOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--data-dir" || argument?.startsWith("--data-dir=")) {
      const value = argument === "--data-dir" ? args[index + 1] : argument.slice("--data-dir=".length);
      if (value === undefined || value.length === 0 || value.startsWith("--")) throw new Error("--data-dir requires a value");
      options.dataDir = value;
      if (argument === "--data-dir") index += 1;
      continue;
    }
    if (argument === "--port" || argument?.startsWith("--port=")) {
      const value = argument === "--port" ? args[index + 1] : argument.slice("--port=".length);
      if (value === undefined || value.length === 0 || value.startsWith("--")) throw new Error("--port requires a value");
      options.port = parsePort(value);
      if (argument === "--port") index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

export async function startRecorder(options: RecorderCliOptions = {}): Promise<RecorderServer> {
  return createRecorderServer(options);
}

export async function runRecorderProcess(args = process.argv.slice(2)): Promise<RecorderServer> {
  const app = await startRecorder(parseRecorderCliArgs(args));
  console.log(`Recorder listening at ${app.server.url}`);
  console.log(`Recorder token: ${app.config.tokenPath}`);
  const stop = async () => {
    await app.stop();
    process.exitCode = 0;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return app;
}

if (import.meta.main) {
  runRecorderProcess().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
