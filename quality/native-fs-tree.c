#ifdef __APPLE__
#define _DARWIN_C_SOURCE
#else
#define _GNU_SOURCE
#endif
#ifndef KEIKO_NATIVE_FS_INTERNAL_HEADER
#define KEIKO_NATIVE_FS_INTERNAL_HEADER "native-fs-internal.h"
#endif
#include KEIKO_NATIVE_FS_INTERNAL_HEADER

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#ifndef __APPLE__
#include <linux/fs.h>
#include <sys/syscall.h>
#endif

static int swap_entries(int parent, const char *left, const char *right) {
#ifdef __APPLE__
  return renameatx_np(parent, left, parent, right, RENAME_SWAP);
#else
  return (int)syscall(SYS_renameat2, parent, left, parent, right,
                      RENAME_EXCHANGE);
#endif
}

static void copy_regular(int source_parent, const char *name, int dest_parent) {
  int source =
      openat(source_parent, name, O_RDONLY | O_NONBLOCK | O_NOFOLLOW);
  struct stat before;
  if (source < 0 || fstat(source, &before) || !S_ISREG(before.st_mode))
    fail("copy-source");
  mode_t destination_mode = (before.st_mode & 0111) ? 0755 : 0644;
  int dest = openat(dest_parent, name,
                    O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, destination_mode);
  if (dest < 0) fail("copy-create");
  char buffer[65536];
  ssize_t size;
  while ((size = read(source, buffer, sizeof(buffer))) > 0) {
    ssize_t offset = 0;
    while (offset < size) {
      ssize_t written = write(dest, buffer + offset, (size_t)(size - offset));
      if (written <= 0) fail("copy-write");
      offset += written;
    }
  }
  struct stat after;
  if (size < 0 || fstat(source, &after) || !same_stat(&before, &after))
    fail("copy-source-changed");
  if (fsync(dest)) fail("copy-sync");
  close(source);
  close(dest);
}

void copy_directory(int source, int destination, const char *exclude,
                    int depth) {
  if (depth >= MAX_DEPTH) fail("depth");
  struct stat directory_before, directory_after;
  if (fstat(source, &directory_before)) fail("directory-stat");
  DIR *directory = fdopendir(dup(source));
  if (!directory) fail("directory-read");
  struct dirent *entry;
  while ((entry = readdir(directory))) {
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    if (!valid_component(entry->d_name)) fail("directory-name");
    struct stat before, after;
    if (fstatat(source, entry->d_name, &before, AT_SYMLINK_NOFOLLOW))
      fail("entry-stat");
    if (depth == 0 && exclude && !strcmp(entry->d_name, exclude)) {
      if (!S_ISDIR(before.st_mode)) fail("excluded-type");
      continue;
    }
    if (S_ISREG(before.st_mode)) copy_regular(source, entry->d_name, destination);
    else if (S_ISDIR(before.st_mode)) {
      if (mkdirat(destination, entry->d_name, 0755)) fail("copy-mkdir");
      int child_source = openat(source, entry->d_name,
                                O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
      int child_dest = openat(destination, entry->d_name,
                              O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
      if (child_source < 0 || child_dest < 0) fail("copy-directory-open");
      copy_directory(child_source, child_dest, NULL, depth + 1);
      close(child_source);
      close(child_dest);
    } else fail("unsupported-entry");
    if (fstatat(source, entry->d_name, &after, AT_SYMLINK_NOFOLLOW) ||
        !same_stat(&before, &after)) fail("entry-changed");
  }
  closedir(directory);
  if (fstat(source, &directory_after) ||
      !same_stat(&directory_before, &directory_after))
    fail("directory-changed");
}

static void remove_entry(int parent, const char *name) {
  struct stat entry;
  if (fstatat(parent, name, &entry, AT_SYMLINK_NOFOLLOW)) {
    if (errno == ENOENT) return;
    fail("remove-stat");
  }
  if (S_ISDIR(entry.st_mode)) {
    int child = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    DIR *directory = child < 0 ? NULL : fdopendir(dup(child));
    if (!directory) fail("remove-open");
    struct dirent *nested;
    while ((nested = readdir(directory)))
      if (strcmp(nested->d_name, ".") && strcmp(nested->d_name, ".."))
        remove_entry(child, nested->d_name);
    closedir(directory);
    close(child);
    if (unlinkat(parent, name, AT_REMOVEDIR)) fail("remove-directory");
  } else {
    if (unlinkat(parent, name, 0)) fail("remove-file");
  }
}

void print_tree(int root, const char *prefix, const char *exclude, int depth) {
  struct stat directory_before, directory_after;
  if (fstat(root, &directory_before)) fail("list-directory-stat");
  DIR *directory = fdopendir(dup(root));
  if (!directory) fail("list-open");
  struct dirent *entry;
  while ((entry = readdir(directory))) {
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    if (depth == 0 && exclude && !strcmp(entry->d_name, exclude)) continue;
    struct stat metadata;
    if (fstatat(root, entry->d_name, &metadata, AT_SYMLINK_NOFOLLOW))
      fail("list-stat");
    char path[PATH_MAX];
    if (snprintf(path, sizeof(path), "%s%s%s", prefix, prefix[0] ? "/" : "",
                 entry->d_name) >= (int)sizeof(path)) fail("path-too-long");
    if (S_ISREG(metadata.st_mode))
      printf("F\t%04o\t%s\n", (unsigned)(metadata.st_mode & 0777), path);
    else if (S_ISDIR(metadata.st_mode)) {
      printf("D\t%04o\t%s\n", (unsigned)(metadata.st_mode & 0777), path);
      int child = openat(root, entry->d_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
      if (child < 0) fail("list-directory");
      print_tree(child, path, NULL, depth + 1);
      close(child);
    } else fail("unsupported-entry");
  }
  closedir(directory);
  if (fstat(root, &directory_after) ||
      !same_stat(&directory_before, &directory_after))
    fail("list-directory-changed");
}

void publish_tree(int source, int destination_root, const char *path) {
  chain_t chain = {0};
  char leaf[NAME_MAX + 1];
  int parent = open_parent(destination_root, path, 1, &chain, leaf);
  char staging[NAME_MAX + 1];
  if (snprintf(staging, sizeof(staging), ".keiko-stage-%ld", (long)getpid()) >=
      (int)sizeof(staging)) fail("stage-name");
  if (mkdirat(parent, staging, 0700)) fail("stage-create");
  int stage = openat(parent, staging, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  if (stage < 0) fail("stage-open");
  copy_directory(source, stage, NULL, 0);
  if (fsync(stage)) fail("stage-sync");
  close(stage);
  struct stat existing;
  if (!fstatat(parent, leaf, &existing, AT_SYMLINK_NOFOLLOW)) {
    if (!S_ISDIR(existing.st_mode)) {
      remove_entry(parent, staging);
      fail("publish-destination-type");
    }
    if (swap_entries(parent, staging, leaf)) {
      remove_entry(parent, staging);
      fail("publish-swap");
    }
    remove_entry(parent, staging);
  } else if (errno != ENOENT || renameat(parent, staging, parent, leaf)) {
    remove_entry(parent, staging);
    fail("publish-rename");
  }
  if (fsync(parent)) fail("publish-sync");
  close_chain(&chain, 0);
}
