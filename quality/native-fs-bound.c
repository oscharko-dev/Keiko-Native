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
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define MAX_BOUND_ENTRIES 32

typedef struct {
  int fd;
  char type;
  mode_t mode;
  const char *path;
  struct stat before;
} bound_entry_t;

static uint64_t time_ns(const struct stat *value, int changed) {
#ifdef __APPLE__
  struct timespec time = changed ? value->st_ctimespec : value->st_mtimespec;
#else
  struct timespec time = changed ? value->st_ctim : value->st_mtim;
#endif
  return (uint64_t)time.tv_sec * 1000000000ULL + (uint64_t)time.tv_nsec;
}

static uint64_t parse_value(char **cursor, int final) {
  if (!**cursor) fail("bound-metadata");
  char *end = NULL;
  errno = 0;
  uint64_t value = strtoull(*cursor, &end, 10);
  if (errno || end == *cursor || (final ? *end != 0 : *end != ':'))
    fail("bound-metadata");
  *cursor = final ? end : end + 1;
  return value;
}

static int matches_record(const bound_entry_t *entry,
                          const struct stat *value) {
  return (uint64_t)value->st_dev == (uint64_t)entry->before.st_dev &&
         (uint64_t)value->st_ino == (uint64_t)entry->before.st_ino &&
         value->st_mode == entry->before.st_mode &&
         value->st_size == entry->before.st_size &&
         time_ns(value, 0) == time_ns(&entry->before, 0) &&
         time_ns(value, 1) == time_ns(&entry->before, 1);
}

static int canonical_path(const char *path, char type) {
  if (!strcmp(path, ".")) return type == 'D';
  if (!path[0] || path[0] == '/' || strlen(path) >= PATH_MAX) return 0;
  char copy[PATH_MAX];
  memcpy(copy, path, strlen(path) + 1);
  char *save = NULL;
  for (char *part = strtok_r(copy, "/", &save); part;
       part = strtok_r(NULL, "/", &save))
    if (!valid_component(part)) return 0;
  return path[strlen(path) - 1] != '/' && strstr(path, "//") == NULL;
}

static void parse_entries(int argc, char **argv, bound_entry_t *entries,
                          size_t count) {
  if (count == 0 || count > MAX_BOUND_ENTRIES || argc != 5 + (int)(count * 4))
    fail("bound-count");
  for (size_t i = 0; i < count; i++) {
    char *type = argv[5 + i * 4];
    char *mode_text = argv[6 + i * 4];
    char *path = argv[7 + i * 4];
    char *metadata = argv[8 + i * 4];
    char *mode_end = NULL;
    long mode = strtol(mode_text, &mode_end, 8);
    if ((strcmp(type, "D") && strcmp(type, "F")) ||
        !canonical_path(path, *type) || !mode_text[0] || *mode_end ||
        mode < 0 || mode > 0777)
      fail("bound-entry");
    if ((*type == 'D' && mode != (!strcmp(path, ".") ? 0700 : 0755)) ||
        (*type == 'F' && mode != 0600 && mode != 0644 && mode != 0755))
      fail("bound-mode");
    entries[i] = (bound_entry_t){
        .fd = 3 + (int)i, .type = *type, .mode = (mode_t)mode, .path = path};
    char token[256];
    copy_bounded(token, sizeof(token), metadata, "bound-metadata");
    char *cursor = token;
    entries[i].before.st_dev = (dev_t)parse_value(&cursor, 0);
    entries[i].before.st_ino = (ino_t)parse_value(&cursor, 0);
    entries[i].before.st_mode = (mode_t)parse_value(&cursor, 0);
    entries[i].before.st_size = (off_t)parse_value(&cursor, 0);
    uint64_t mtime = parse_value(&cursor, 0);
    uint64_t ctime = parse_value(&cursor, 1);
#ifdef __APPLE__
    entries[i].before.st_mtimespec.tv_sec = (time_t)(mtime / 1000000000ULL);
    entries[i].before.st_mtimespec.tv_nsec = (long)(mtime % 1000000000ULL);
    entries[i].before.st_ctimespec.tv_sec = (time_t)(ctime / 1000000000ULL);
    entries[i].before.st_ctimespec.tv_nsec = (long)(ctime % 1000000000ULL);
#else
    entries[i].before.st_mtim.tv_sec = (time_t)(mtime / 1000000000ULL);
    entries[i].before.st_mtim.tv_nsec = (long)(mtime % 1000000000ULL);
    entries[i].before.st_ctim.tv_sec = (time_t)(ctime / 1000000000ULL);
    entries[i].before.st_ctim.tv_nsec = (long)(ctime % 1000000000ULL);
#endif
    struct stat current;
    if (fstat(entries[i].fd, &current) ||
        !matches_record(&entries[i], &current) ||
        (current.st_mode & 0777) != entries[i].mode ||
        (*type == 'D' ? !S_ISDIR(current.st_mode) : !S_ISREG(current.st_mode)))
      fail("bound-fd");
    for (size_t prior = 0; prior < i; prior++)
      if (!strcmp(entries[prior].path, path) ||
          (entries[prior].before.st_dev == current.st_dev &&
           entries[prior].before.st_ino == current.st_ino))
        fail("bound-duplicate");
  }
  if (entries[0].type != 'D' || strcmp(entries[0].path, "."))
    fail("bound-root");
}

static ssize_t find_entry(bound_entry_t *entries, size_t count,
                          const char *path) {
  for (size_t i = 0; i < count; i++)
    if (!strcmp(entries[i].path, path)) return (ssize_t)i;
  return -1;
}

static DIR *try_directory_stream(int descriptor) {
  int scan = dup(descriptor);
  if (scan < 0) return NULL;
  DIR *directory = fdopendir(scan);
  if (!directory) close(scan);
  return directory;
}

static int validate_inventory(bound_entry_t *entries, size_t count) {
  unsigned char seen[MAX_BOUND_ENTRIES] = {1};
  for (size_t i = 0; i < count; i++) {
    struct stat current;
    if (fstat(entries[i].fd, &current) ||
        !matches_record(&entries[i], &current))
      return 0;
    if (entries[i].type != 'D') continue;
    DIR *directory = try_directory_stream(entries[i].fd);
    if (!directory) return 0;
    rewinddir(directory);
    struct dirent *item;
    while ((item = readdir(directory))) {
      if (!strcmp(item->d_name, ".") || !strcmp(item->d_name, "..")) continue;
      char path[PATH_MAX];
      if (!valid_component(item->d_name) ||
          snprintf(path, sizeof(path), "%s%s%s",
                   !strcmp(entries[i].path, ".") ? "" : entries[i].path,
                   !strcmp(entries[i].path, ".") ? "" : "/",
                   item->d_name) >= (int)sizeof(path)) {
        closedir(directory);
        return 0;
      }
      ssize_t index = find_entry(entries, count, path);
      struct stat named, descriptor;
      if (index < 0 || ++seen[index] != 1 ||
          fstatat(entries[i].fd, item->d_name, &named, AT_SYMLINK_NOFOLLOW) ||
          fstat(entries[index].fd, &descriptor) ||
          !matches_record(&entries[index], &descriptor) ||
          !same_stat(&named, &descriptor)) {
        closedir(directory);
        return 0;
      }
    }
    closedir(directory);
    if (fstat(entries[i].fd, &current) ||
        !matches_record(&entries[i], &current))
      return 0;
  }
  for (size_t i = 0; i < count; i++)
    if (seen[i] != 1) return 0;
  return 1;
}

static void create_directory(int stage, const bound_entry_t *entry) {
  chain_t chain = {0};
  char leaf[NAME_MAX + 1];
  int parent = open_parent(stage, entry->path, 1, &chain, leaf);
  if (mkdirat(parent, leaf, entry->mode) && errno != EEXIST)
    fail("bound-mkdir");
  int directory = openat(parent, leaf, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  if (directory < 0 || fchmod(directory, entry->mode)) fail("bound-directory");
  struct stat descriptor, named;
  if (fstat(directory, &descriptor) ||
      fstatat(parent, leaf, &named, AT_SYMLINK_NOFOLLOW) ||
      !same_stat(&descriptor, &named))
    fail("bound-directory-rebound");
  close(directory);
  close_chain(&chain, 0);
}

static void copy_file(int stage, const bound_entry_t *entry) {
  chain_t chain = {0};
  char leaf[NAME_MAX + 1];
  int parent = open_parent(stage, entry->path, 1, &chain, leaf);
  int output = openat(parent, leaf, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW,
                      entry->mode);
  if (output < 0 || lseek(entry->fd, 0, SEEK_SET) < 0) fail("bound-copy-open");
  char buffer[65536];
  ssize_t size;
  while ((size = read(entry->fd, buffer, sizeof(buffer))) > 0) {
    ssize_t offset = 0;
    while (offset < size) {
      ssize_t written = write(output, buffer + offset, (size_t)(size - offset));
      if (written <= 0) fail("bound-copy-write");
      offset += written;
    }
  }
  if (size < 0 || fchmod(output, entry->mode) || fsync(output))
    fail("bound-copy");
  struct stat descriptor, named;
  if (fstat(output, &descriptor) ||
      fstatat(parent, leaf, &named, AT_SYMLINK_NOFOLLOW) ||
      !same_stat(&descriptor, &named))
    fail("bound-copy-rebound");
  close(output);
  close_chain(&chain, 0);
}

static size_t path_depth(const char *path) {
  size_t depth = 1;
  for (const char *cursor = path; *cursor; cursor++)
    if (*cursor == '/') depth++;
  return depth;
}

static void sync_staged_directories(int stage, bound_entry_t *entries,
                                    size_t count) {
  for (size_t depth = MAX_DEPTH; depth > 0; depth--)
    for (size_t i = 1; i < count; i++) {
      if (entries[i].type != 'D' || path_depth(entries[i].path) != depth)
        continue;
      chain_t chain = {0};
      char leaf[NAME_MAX + 1];
      int parent = open_parent(stage, entries[i].path, 0, &chain, leaf);
      int directory = openat(parent, leaf, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
      struct stat descriptor, named;
      if (directory < 0 || fstat(directory, &descriptor) ||
          fstatat(parent, leaf, &named, AT_SYMLINK_NOFOLLOW) ||
          !same_stat(&descriptor, &named))
        fail("bound-directory-rebound");
      if (sync_directory(directory, "bound-directory-sync"))
        fail("bound-directory-sync");
      close(directory);
      close_chain(&chain, 0);
    }
}

int run_publish_bound(int argc, char **argv) {
  char *count_end = NULL;
  long parsed = argc > 4 ? strtol(argv[4], &count_end, 10) : 0;
  if (!count_end || *count_end || parsed <= 0 || parsed > MAX_BOUND_ENTRIES)
    fail("bound-count");
  size_t count = (size_t)parsed;
  bound_entry_t entries[MAX_BOUND_ENTRIES] = {0};
  parse_entries(argc, argv, entries, count);
  if (!validate_inventory(entries, count)) fail("bound-inventory");

  chain_t destination_chain = {0}, publication_chain = {0};
  int destination_root = open_absolute(argv[2], 1, &destination_chain);
  refresh_chain(&destination_chain);
  char leaf[NAME_MAX + 1];
  int parent =
      open_parent(destination_root, argv[3], 1, &publication_chain, leaf);
  refresh_chain(&publication_chain);
  char staging[NAME_MAX + 1];
  if (snprintf(staging, sizeof(staging), ".keiko-stage-%ld", (long)getpid()) >=
          (int)sizeof(staging) ||
      mkdirat(parent, staging, 0700))
    fail("stage-create");
  int stage = openat(parent, staging, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  if (stage < 0) fail("stage-open");
  arm_stage_cleanup(parent, staging, stage);
  if (sync_directory(parent, "stage-parent-sync")) fail("stage-parent-sync");
  for (size_t i = 1; i < count; i++)
    if (entries[i].type == 'D') create_directory(stage, &entries[i]);
  for (size_t i = 0; i < count; i++)
    if (entries[i].type == 'F') copy_file(stage, &entries[i]);
  sync_staged_directories(stage, entries, count);
  if (test_failure_at("bound-inventory-drift") ||
      !validate_inventory(entries, count)) {
    close(stage);
    fail("bound-inventory-drift");
  }
  publish_staged(parent, &publication_chain, leaf, staging, stage);
  refresh_chain_leaf(&destination_chain);
  close_chain(&destination_chain, 1);
  return 0;
}
