import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { RepositoryRegistry } from "../src/repositories/registry";
import { RecordStore } from "../src/store/records";

type GitFixture = { root: string; file: string };
const temporaryDirectories: string[] = [];

async function runGit(root: string, args: string[]): Promise<string> {
  const process = Bun.spawn({ cmd: ["git", ...args], cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

async function createFixture(): Promise<GitFixture> {
  const root = await mkdtemp(join(tmpdir(), "ai-review-registry-"));
  temporaryDirectories.push(root);
  await runGit(root, ["init", "--quiet"]);
  await runGit(root, ["config", "user.email", "fixture@example.test"]);
  await runGit(root, ["config", "user.name", "Fixture"]);
  const file = "src/example.ts";
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, file), "export const version = 1;\n", "utf8");
  await runGit(root, ["add", "--", file]);
  await runGit(root, ["commit", "--quiet", "-m", "fixture"]);
  return { root, file };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("RepositoryRegistry", () => {
  test("stores the canonical root and resolves registered targets", async () => {
    const fixture = await createFixture();
    const alias = `${fixture.root}-alias`;
    await symlink(fixture.root, alias, "dir");
    temporaryDirectories.push(alias);
    const store = new RecordStore(new Database(":memory:"));
    const registry = new RepositoryRegistry(store);

    const registered = await registry.register(alias);

    expect(registered.root).toBe(await realpath(fixture.root));
    expect((await registry.get(registered.repository_id))?.root).toBe(await realpath(fixture.root));
    expect(await registry.assertTarget(registered.repository_id, fixture.file)).toBe(await realpath(join(fixture.root, fixture.file)));
    store.close();
  });

  test.each(["../outside.ts", "/etc/passwd", "C:..\\outside.ts", "C:/outside.ts", "\\\\server\\share\\outside.ts"])(
    "rejects target path %s outside the registered root",
    async (path) => {
      const fixture = await createFixture();
      const store = new RecordStore(new Database(":memory:"));
      const registry = new RepositoryRegistry(store);
      const registered = await registry.register(fixture.root);

      await expect(registry.assertTarget(registered.repository_id, path)).rejects.toMatchObject({ code: "PATH_OUTSIDE_ROOT" });
      store.close();
    },
  );

  test("rejects a symlink escape and an unregistered nested repository", async () => {
    const fixture = await createFixture();
    const outside = await mkdtemp(join(tmpdir(), "ai-review-registry-outside-"));
    temporaryDirectories.push(outside);
    await writeFile(join(outside, "secret.ts"), "secret\n", "utf8");
    await symlink(join(outside, "secret.ts"), join(fixture.root, "escape.ts"));

    const nested = join(fixture.root, "nested");
    await mkdir(nested, { recursive: true });
    await runGit(nested, ["init", "--quiet"]);
    await writeFile(join(nested, "module.ts"), "export const nested = true;\n", "utf8");

    const store = new RecordStore(new Database(":memory:"));
    const registry = new RepositoryRegistry(store);
    const registered = await registry.register(fixture.root);

    await expect(registry.assertTarget(registered.repository_id, "escape.ts")).rejects.toMatchObject({ code: "PATH_OUTSIDE_ROOT" });
    await expect(registry.assertTarget(registered.repository_id, "nested/module.ts")).rejects.toMatchObject({ code: "REPOSITORY_NOT_REGISTERED" });
    store.close();
  });
});
