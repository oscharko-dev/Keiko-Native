import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const testFilesystem = {
  chmod(root, path, mode) {
    chmodSync(join(root, path), mode);
  },
  copyTree(sourceRoot, sourcePath, destinationRoot, destinationPath) {
    const destination = join(destinationRoot, destinationPath);
    mkdirSync(join(destination, ".."), { recursive: true });
    cpSync(join(sourceRoot, sourcePath), destination, { recursive: true });
  },
  list(root, path = ".") {
    const start = join(root, path);
    const entries = [];
    function visit(directory, prefix) {
      for (const name of readdirSync(directory).toSorted()) {
        const absolute = join(directory, name);
        const status = lstatSync(absolute);
        const relativePath = prefix ? `${prefix}/${name}` : name;
        if (status.isDirectory()) {
          entries.push({
            mode: (status.mode & 0o777).toString(8).padStart(4, "0"),
            path: relativePath,
            type: "D",
          });
          visit(absolute, relativePath);
        } else if (status.isFile())
          entries.push({
            mode: (status.mode & 0o777).toString(8).padStart(4, "0"),
            path: relativePath,
            type: "F",
          });
      }
    }
    visit(start, "");
    return entries;
  },
  mkdir(root, path) {
    mkdirSync(join(root, path), { recursive: true });
  },
  publish(sourceRoot, sourcePath, destinationRoot, destinationPath) {
    const destination = join(destinationRoot, destinationPath);
    rmSync(destination, { force: true, recursive: true });
    cpSync(join(sourceRoot, sourcePath), destination, { recursive: true });
  },
  read(root, path) {
    return readFileSync(join(root, path));
  },
  remove(root, path) {
    rmSync(join(root, path), { force: true, recursive: true });
  },
  touch(root, path, sourceEpoch) {
    const timestamp = new Date(sourceEpoch * 1000);
    utimesSync(join(root, path), timestamp, timestamp);
  },
  write(root, path, bytes) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), bytes);
  },
};
