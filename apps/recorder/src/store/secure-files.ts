import { closeSync, constants as fsConstants, fchmodSync, fstatSync, fsyncSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { dlopen, FFIType, ptr, read, type Pointer } from "bun:ffi";

interface NativeSymbols {
  openat: (directoryFd: number, path: Pointer, flags: number, mode: number) => number;
  mkdirat: (directoryFd: number, path: Pointer, mode: number) => number;
  renameat: (oldDirectoryFd: number, oldPath: Pointer, newDirectoryFd: number, newPath: Pointer) => number;
  unlinkat: (directoryFd: number, path: Pointer, flags: number) => number;
}

const nativeDefinitions = {
  openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  mkdirat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  renameat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  unlinkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
} as const;

const native = process.platform === "darwin"
  ? dlopen("/usr/lib/libSystem.B.dylib", {
    ...nativeDefinitions,
    __error: { args: [], returns: FFIType.ptr },
  })
  : process.platform === "linux"
    ? dlopen("libc.so.6", {
      ...nativeDefinitions,
      __errno_location: { args: [], returns: FFIType.ptr },
    })
    : null;

if (native === null) throw new Error(`secure snapshot storage is unsupported on ${process.platform}`);

const syscalls = native.symbols as unknown as NativeSymbols;
const readErrno = process.platform === "darwin"
  ? (native.symbols as unknown as { __error: () => Pointer }).__error
  : (native.symbols as unknown as { __errno_location: () => Pointer }).__errno_location;
const DIRECTORY_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0);
const FILE_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const AT_REMOVEDIR = 0;

function nativeError(operation: string): NodeJS.ErrnoException {
  const errno = read.i32(readErrno());
  const names = osConstants.errno as unknown as Record<string, number>;
  const code = Object.entries(names).find(([, value]) => value === errno)?.[0];
  const error = new Error(`${operation} failed${code === undefined ? ` with errno ${errno}` : ` with ${code}`}`) as NodeJS.ErrnoException;
  if (code !== undefined) error.code = code;
  error.errno = errno;
  return error;
}

function pathPointer(path: string): Pointer {
  if (path.length === 0 || path.includes("\0")) throw new TypeError("secure file path must be a non-empty string without NUL");
  return ptr(Buffer.from(`${path}\0`, "utf8"));
}

function componentPointer(component: string): Pointer {
  if (component.length === 0 || component === "." || component === ".." || component.includes("/") || component.includes("\0")) {
    throw new TypeError("secure file component must be a single non-special path component");
  }
  return pathPointer(component);
}

function checkResult(operation: string, result: number): void {
  if (result < 0) throw nativeError(operation);
}

export interface OpenedSecureFile {
  fd: number;
  parentFd: number;
  parentOwned: boolean;
  name: string;
}

export interface OpenedSecureParent {
  parentFd: number;
  parentOwned: boolean;
  name: string;
}

export function openDirectory(path: string): number {
  return openSync(path, DIRECTORY_FLAGS);
}

export function openDirectoryAt(parentFd: number, name: string, create: boolean): number {
  const namePointer = componentPointer(name);
  let fd = syscalls.openat(parentFd, namePointer, DIRECTORY_FLAGS, 0);
  if (fd >= 0) return fd;
  if (!create) throw nativeError("openat directory");

  const mkdirPointer = componentPointer(name);
  syscalls.mkdirat(parentFd, mkdirPointer, 0o700);
  const retryPointer = componentPointer(name);
  fd = syscalls.openat(parentFd, retryPointer, DIRECTORY_FLAGS, 0);
  checkResult("openat directory", fd);
  return fd;
}

function pathComponents(relativePath: string): string[] {
  if (relativePath.length === 0) return [];
  const components = relativePath.split("/");
  for (const component of components) componentPointer(component);
  return components;
}

export function openDirectoryPath(rootFd: number, relativePath: string, create: boolean): number {
  let currentFd = rootFd;
  let currentOwned = false;
  try {
    for (const component of pathComponents(relativePath)) {
      const nextFd = openDirectoryAt(currentFd, component, create);
      if (currentOwned) closeFd(currentFd);
      currentFd = nextFd;
      currentOwned = true;
    }
    return currentFd;
  } catch (error) {
    if (currentOwned) closeFd(currentFd);
    throw error;
  }
}

export function openFileAt(parentFd: number, name: string, flags: number, mode = 0o600): number {
  const result = syscalls.openat(parentFd, componentPointer(name), flags | FILE_NOFOLLOW, mode);
  checkResult("openat file", result);
  if ((flags & fsConstants.O_CREAT) !== 0 && (flags & fsConstants.O_EXCL) !== 0) fchmodSync(result, mode);
  return result;
}

export function openParentPath(rootFd: number, relativePath: string): OpenedSecureParent {
  const components = pathComponents(relativePath);
  const name = components.pop();
  if (name === undefined) throw new TypeError("secure file path must name a file");

  let parentFd = rootFd;
  let parentOwned = false;
  try {
    for (const component of components) {
      const nextFd = openDirectoryAt(parentFd, component, false);
      if (parentOwned) closeFd(parentFd);
      parentFd = nextFd;
      parentOwned = true;
    }
    return { parentFd, parentOwned, name };
  } catch (error) {
    if (parentOwned) closeFd(parentFd);
    throw error;
  }
}

export function closeParentPath(parent: OpenedSecureParent): void {
  if (parent.parentOwned) closeFd(parent.parentFd);
}

export function openFilePath(rootFd: number, relativePath: string, flags: number): OpenedSecureFile {
  const parent = openParentPath(rootFd, relativePath);
  try {
    return { ...parent, fd: openFileAt(parent.parentFd, parent.name, flags) };
  } catch (error) {
    closeParentPath(parent);
    throw error;
  }
}

export function closeOpenedFile(file: OpenedSecureFile): void {
  closeFd(file.fd);
  closeParentPath(file);
}

export function closeFd(fd: number): void {
  closeSync(fd);
}

export function readOpenedFile(file: OpenedSecureFile, maxBytes: number): { content: string; size: number } | null {
  try {
    const information = fstatSync(file.fd);
    if (!information.isFile() || information.size > maxBytes) return null;
    const bytes = readFileSync(file.fd);
    if (bytes.byteLength > maxBytes) return null;
    return { content: bytes.toString("utf8"), size: bytes.byteLength };
  } catch {
    return null;
  }
}

export function writeFileAt(parentFd: number, temporaryName: string, content: string): void {
  const fileFd = openFileAt(parentFd, temporaryName, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  try {
    writeFileSync(fileFd, content, { encoding: "utf8" });
    fsyncSync(fileFd);
  } finally {
    closeFd(fileFd);
  }
}

export function renameAt(parentFd: number, oldName: string, newName: string): void {
  const result = syscalls.renameat(parentFd, componentPointer(oldName), parentFd, componentPointer(newName));
  checkResult("renameat", result);
}

export function unlinkAt(parentFd: number, name: string): void {
  const result = syscalls.unlinkat(parentFd, componentPointer(name), AT_REMOVEDIR);
  checkResult("unlinkat", result);
}
