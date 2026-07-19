#ifdef __APPLE__
#define _DARWIN_C_SOURCE
#else
#define _GNU_SOURCE
#endif
#ifndef KEIKO_NATIVE_FS_INTERNAL_HEADER
#define KEIKO_NATIVE_FS_INTERNAL_HEADER "native-fs-internal.h"
#endif
#include KEIKO_NATIVE_FS_INTERNAL_HEADER

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
void fail(const char *category) {
  fprintf(stderr, "native-fs-helper:%s\n", category);
  exit(1);
}

int same_stat(const struct stat *a, const struct stat *b) {
#ifdef __APPLE__
#define MTIME(value) ((value)->st_mtimespec)
#define CTIME(value) ((value)->st_ctimespec)
#else
#define MTIME(value) ((value)->st_mtim)
#define CTIME(value) ((value)->st_ctim)
#endif
  return a->st_dev == b->st_dev && a->st_ino == b->st_ino &&
         a->st_mode == b->st_mode && a->st_size == b->st_size &&
         MTIME(a).tv_sec == MTIME(b).tv_sec &&
         MTIME(a).tv_nsec == MTIME(b).tv_nsec &&
         CTIME(a).tv_sec == CTIME(b).tv_sec &&
         CTIME(a).tv_nsec == CTIME(b).tv_nsec;
}

int valid_component(const char *value) {
  return value[0] && strcmp(value, ".") && strcmp(value, "..") &&
         strchr(value, '/') == NULL;
}

static void wait_at_barrier(void) {
  char byte = 'R';
  if (write(3, &byte, 1) != 1 || read(4, &byte, 1) != 1) fail("test-barrier");
}

void test_barrier(void) {
  const char *point = getenv("KEIKO_FS_HELPER_TEST_BARRIER");
  if (point && !strcmp(point, "1")) wait_at_barrier();
}

void test_barrier_at(const char *expected) {
  const char *point = getenv("KEIKO_FS_HELPER_TEST_BARRIER");
  if (point && !strcmp(point, expected)) wait_at_barrier();
}

static int selected_test_failure(const char *variable, const char *expected) {
  const char *value = getenv(variable);
  while (value && *value) {
    const char *end = strchr(value, ',');
    size_t length = end ? (size_t)(end - value) : strlen(value);
    if (strlen(expected) == length && !strncmp(value, expected, length))
      return 1;
    value = end ? end + 1 : NULL;
  }
  return 0;
}

int test_failure_at(const char *point) {
  return selected_test_failure("KEIKO_FS_HELPER_TEST_FAILURE", point);
}

int sync_directory(int directory, const char *point) {
  if (selected_test_failure("KEIKO_FS_HELPER_TEST_FAIL_SYNC", point)) {
    errno = EIO;
    return -1;
  }
  return fsync(directory);
}

static void copy_bytes(int source, int destination, struct stat *before) {
  char buffer[65536];
  ssize_t size;
  while ((size = read(source, buffer, sizeof(buffer))) > 0) {
    ssize_t offset = 0;
    while (offset < size) {
      ssize_t written =
          write(destination, buffer + offset, (size_t)(size - offset));
      if (written <= 0) fail("write");
      offset += written;
    }
  }
  if (size < 0) fail("read");
  struct stat after;
  if (fstat(source, &after) || !same_stat(before, &after)) fail("file-changed");
}

static void copy_stream(int source, int destination) {
  char buffer[65536];
  ssize_t size;
  while ((size = read(source, buffer, sizeof(buffer))) > 0) {
    ssize_t offset = 0;
    while (offset < size) {
      ssize_t written =
          write(destination, buffer + offset, (size_t)(size - offset));
      if (written <= 0) fail("write");
      offset += written;
    }
  }
  if (size < 0) fail("read");
}

static void read_file(int root, const char *path, int output) {
  chain_t chain = {0};
  char leaf[NAME_MAX + 1];
  int parent = open_parent(root, path, 0, &chain, leaf);
  int file = openat(parent, leaf, O_RDONLY | O_NONBLOCK | O_NOFOLLOW);
  struct stat before, named;
  if (file < 0 || fstat(file, &before) || !S_ISREG(before.st_mode))
    fail("regular-open");
  refresh_chain(&chain);
  test_barrier();
  copy_bytes(file, output, &before);
  if (fstatat(parent, leaf, &named, AT_SYMLINK_NOFOLLOW) ||
      !same_stat(&before, &named))
    fail("file-replaced");
  close(file);
  close_chain(&chain, 1);
}

static int create_file(int root, const char *path, mode_t mode,
                       chain_t *chain) {
  char leaf[NAME_MAX + 1];
  int parent = open_parent(root, path, 1, chain, leaf);
  refresh_chain(chain);
  test_barrier();
  verify_chain(chain, 1);
  int file =
      openat(parent, leaf, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode);
  if (file < 0) fail("exclusive-create");
  struct stat entry;
  if (fstat(file, &entry) || !S_ISREG(entry.st_mode)) fail("created-type");
  return file;
}

static void verify_file_path(int root, const char *path,
                             const struct stat *file) {
  chain_t chain = {0};
  char leaf[NAME_MAX + 1];
  int parent = open_parent(root, path, 0, &chain, leaf);
  struct stat named;
  if (fstatat(parent, leaf, &named, AT_SYMLINK_NOFOLLOW) ||
      !same_stat(file, &named))
    fail("created-replaced");
  close_chain(&chain, 0);
}

static int open_dir_at_path(int root, const char *path, int create,
                            chain_t *chain) {
  if (!strcmp(path, ".")) {
    int result = dup(root);
    if (result < 0) fail("root-dup");
    remember_chain(chain, result, NULL);
    return result;
  }
  char leaf[NAME_MAX + 1];
  int parent = open_parent(root, path, create, chain, leaf);
  int created = 0;
  if (create && mkdirat(parent, leaf, 0700)) {
    if (errno != EEXIST) fail("mkdir");
  } else if (create)
    created = 1;
  int result = openat(parent, leaf, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  struct stat descriptor, named;
  if (result < 0 || fstat(result, &descriptor) ||
      fstatat(parent, leaf, &named, AT_SYMLINK_NOFOLLOW) ||
      !S_ISDIR(descriptor.st_mode) || descriptor.st_dev != named.st_dev ||
      descriptor.st_ino != named.st_ino || descriptor.st_mode != named.st_mode)
    fail("directory-open");
  if (created && sync_directory(parent, "directory-parent-sync"))
    fail("directory-parent-sync");
  remember_chain(chain, result, leaf);
  return result;
}

int native_fs_run(int argc, char **argv) {
  if (argc < 4) fail("usage");
  if (!strcmp(argv[1], "publish-bound")) return run_publish_bound(argc, argv);
  chain_t root_chain = {0};
  int root = open_absolute(argv[2], 0, &root_chain);
  if (!strcmp(argv[1], "read") && argc == 4)
    read_file(root, argv[3], STDOUT_FILENO);
  else if (!strcmp(argv[1], "write") && argc == 5) {
    chain_t chain = {0};
    int file =
        create_file(root, argv[3], (mode_t)strtol(argv[4], NULL, 8), &chain);
    copy_stream(STDIN_FILENO, file);
    if (fsync(file)) fail("write-sync");
    struct stat written;
    if (fstat(file, &written)) fail("written-stat");
    close(file);
    if (fsync(chain.fd[chain.count - 1])) fail("write-parent-sync");
    verify_file_path(root, argv[3], &written);
    refresh_chain_leaf(&chain);
    test_barrier_at("write-complete");
    verify_chain(&chain, 1);
    verify_file_path(root, argv[3], &written);
    close_chain(&chain, 1);
  } else if (!strcmp(argv[1], "mkdir") && argc == 4) {
    chain_t chain = {0};
    int directory = open_dir_at_path(root, argv[3], 1, &chain);
    (void)directory;
    refresh_chain(&chain);
    test_barrier();
    verify_chain(&chain, 1);
    close_chain(&chain, 1);
  } else if (!strcmp(argv[1], "list") && (argc == 4 || argc == 5)) {
    chain_t chain = {0};
    int directory = open_dir_at_path(root, argv[3], 0, &chain);
    refresh_chain(&chain);
    print_tree(directory, "", argc == 5 ? argv[4] : NULL, 0);
    close_chain(&chain, 1);
  } else if (!strcmp(argv[1], "symlink") && argc == 5) {
    chain_t chain = {0};
    char leaf[NAME_MAX + 1];
    int parent = open_parent(root, argv[3], 1, &chain, leaf);
    refresh_chain(&chain);
    test_barrier();
    verify_chain(&chain, 1);
    if (symlinkat(argv[4], parent, leaf)) fail("symlink-create");
    struct stat entry;
    if (fstatat(parent, leaf, &entry, AT_SYMLINK_NOFOLLOW) ||
        !S_ISLNK(entry.st_mode))
      fail("symlink-type");
    refresh_chain_leaf(&chain);
    test_barrier_at("symlink-created");
    verify_chain(&chain, 1);
    struct stat verified;
    if (fstatat(parent, leaf, &verified, AT_SYMLINK_NOFOLLOW) ||
        !same_stat(&entry, &verified))
      fail("symlink-rebound");
    close_chain(&chain, 1);
  } else if (!strcmp(argv[1], "copy-tree") && (argc == 6 || argc == 7)) {
    chain_t source_chain = {0}, destination_chain = {0};
    int source = open_dir_at_path(root, argv[3], 0, &source_chain);
    int destination_root = open_absolute(argv[4], 0, &destination_chain);
    int destination =
        open_dir_at_path(destination_root, argv[5], 1, &destination_chain);
    if (strcmp(argv[5], ".") && fchmod(destination, 0755))
      fail("copy-directory-mode");
    refresh_chain(&source_chain);
    refresh_chain(&destination_chain);
    test_barrier();
    verify_chain(&source_chain, 1);
    verify_chain(&destination_chain, 1);
    copy_directory(source, destination, argc == 7 ? argv[6] : NULL, 0);
    refresh_chain_leaf(&destination_chain);
    verify_absolute(argv[4], destination_root);
    close_chain(&source_chain, 1);
    close_chain(&destination_chain, 1);
  } else if (!strcmp(argv[1], "publish") && argc == 6) {
    chain_t source_chain = {0}, destination_chain = {0};
    int source = open_dir_at_path(root, argv[3], 0, &source_chain);
    int destination_root = open_absolute(argv[4], 1, &destination_chain);
    refresh_chain(&destination_chain);
    refresh_chain(&source_chain);
    publish_tree(source, destination_root, argv[5]);
    verify_absolute(argv[4], destination_root);
    close_chain(&source_chain, 1);
    refresh_chain_leaf(&destination_chain);
    close_chain(&destination_chain, 1);
  } else
    fail("usage");
  verify_absolute(argv[2], root);
  refresh_chain_leaf(&root_chain);
  close_chain(&root_chain, 1);
  return 0;
}
