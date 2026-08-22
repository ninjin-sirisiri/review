import { describe, expect, test } from "bun:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRecorderCliArgs } from "../src/index";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const command = join(repoRoot, "bin/ai-review");

describe("parseRecorderCliArgs", () => {
  test("parses space and equals forms", () => {
    expect(parseRecorderCliArgs(["--data-dir", "/tmp/data", "--port=4318", "--ui-root=/tmp/ui"])).toEqual({
      dataDir: "/tmp/data",
      port: 4318,
      uiRoot: "/tmp/ui",
    });
  });

  test("rejects unknown arguments", () => {
    expect(() => parseRecorderCliArgs(["--unknown"])).toThrow("unknown argument: --unknown");
  });
});

describe("ai-review command", () => {
  test("prints help and exits 0", async () => {
    const process = Bun.spawn({
      cmd: [command, "--help"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Usage: ai-review");
    expect(stdout).toContain("--data-dir");
  });

  test("rejects unknown arguments without starting the server", async () => {
    const process = Bun.spawn({
      cmd: [command, "--nope"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("unknown argument: --nope");
  });
});
