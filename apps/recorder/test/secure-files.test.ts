import { closeSync, constants as fsConstants, fstatSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { closeFd, openDirectory, openDirectoryAt, openFileAt } from "../src/store/secure-files";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("writes through a pinned directory after its path is replaced by a symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-review-secure-files-"));
  const outside = await mkdtemp(join(tmpdir(), "ai-review-secure-files-outside-"));
  temporaryDirectories.push(root, outside);
  const owner = join(root, "owner");
  await mkdir(owner);

  const rootFd = openDirectory(root);
  const ownerFd = openDirectoryAt(rootFd, "owner", false);
  await rename(owner, join(root, "owner-moved"));
  await symlink(outside, owner, "dir");

  const fileFd = openFileAt(
    ownerFd,
    "snapshot",
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  writeFileSync(fileFd, "inside", { encoding: "utf8" });
  expect(fstatSync(fileFd).mode & 0o777).toBe(0o600);
  closeFd(fileFd);
  closeFd(ownerFd);
  closeFd(rootFd);

  expect(readFileSync(join(root, "owner-moved", "snapshot"), "utf8")).toBe("inside");
  await expect(readFile(join(outside, "snapshot"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});
