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

static int same_parent(const struct stat *a, const struct stat *b) {
  return a->st_dev == b->st_dev && a->st_ino == b->st_ino &&
         a->st_mode == b->st_mode &&
         CTIME(a).tv_sec == CTIME(b).tv_sec &&
         CTIME(a).tv_nsec == CTIME(b).tv_nsec;
}

int valid_component(const char *value) {
  return value[0] && strcmp(value, ".") && strcmp(value, "..") &&
         strchr(value, '/') == NULL;
}

static int same_object(const struct stat *a, const struct stat *b) {
  return a->st_dev == b->st_dev && a->st_ino == b->st_ino &&
         a->st_mode == b->st_mode;
}

static void remember(chain_t *chain, int fd, const char *name) {
  if (chain->count == MAX_DEPTH || fstat(fd, &chain->before[chain->count]))
    fail("depth-or-stat");
  if (name && strlen(name) > NAME_MAX) fail("component-too-long");
  chain->fd[chain->count++] = fd;
  strcpy(chain->name[chain->count - 1], name ? name : "");
}

void verify_chain(chain_t *chain, int metadata) {
  for (size_t i = 0; i < chain->count; i++) {
    struct stat after, named;
    if (fstat(chain->fd[i], &after) ||
        (metadata && i >= chain->metadata_start &&
         !same_parent(&chain->before[i], &after)))
      fail("parent-changed");
    if (i && chain->name[i][0] &&
        (fstatat(chain->fd[i - 1], chain->name[i], &named,
                 AT_SYMLINK_NOFOLLOW) ||
         !same_object(&after, &named)))
      fail("parent-rebound");
  }
}

void close_chain(chain_t *chain, int verify) {
  if (verify) verify_chain(chain, 1);
  while (chain->count) close(chain->fd[--chain->count]);
}

void refresh_chain(chain_t *chain) {
  for (size_t i = 0; i < chain->count; i++)
    if (fstat(chain->fd[i], &chain->before[i])) fail("parent-stat");
}

void refresh_chain_leaf(chain_t *chain) {
  struct stat after;
  if (!chain->count || fstat(chain->fd[chain->count - 1], &after))
    fail("parent-stat");
  for (size_t i = 0; i < chain->count; i++)
    if (chain->before[i].st_dev == after.st_dev &&
        chain->before[i].st_ino == after.st_ino)
      chain->before[i] = after;
}

int open_absolute(const char *path, int create, chain_t *chain) {
  if (path[0] != '/') fail("root-not-absolute");
  int current = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  if (current < 0) fail("root-open");
  remember(chain, current, NULL);
  char copy[PATH_MAX];
  if (strlen(path) >= sizeof(copy)) fail("path-too-long");
  strcpy(copy, path);
  char *save = NULL;
  for (char *part = strtok_r(copy, "/", &save); part;
       part = strtok_r(NULL, "/", &save)) {
    if (!valid_component(part)) fail("invalid-component");
    if (create && mkdirat(current, part, 0700) && errno != EEXIST)
      fail("mkdir");
    int next = openat(current, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    if (next < 0) fail("directory-open");
    struct stat entry;
    if (fstatat(current, part, &entry, AT_SYMLINK_NOFOLLOW) ||
        !S_ISDIR(entry.st_mode))
      fail("directory-entry");
    current = next;
    remember(chain, current, part);
  }
  chain->metadata_start = chain->count - 1;
  return current;
}

static void verify_absolute(const char *path, int expected) {
  chain_t chain = {0};
  int reopened = open_absolute(path, 0, &chain);
  struct stat before, after;
  if (fstat(expected, &before) || fstat(reopened, &after) ||
      before.st_dev != after.st_dev || before.st_ino != after.st_ino ||
      before.st_mode != after.st_mode)
    fail("root-changed");
  close_chain(&chain, 0);
}

int open_parent(int root, const char *path, int create, chain_t *chain,
                char leaf[NAME_MAX + 1]) {
  if (!path[0] || path[0] == '/') fail("invalid-relative-path");
  char copy[PATH_MAX];
  if (strlen(path) >= sizeof(copy)) fail("path-too-long");
  strcpy(copy, path);
  char *last = strrchr(copy, '/');
  const char *name = copy;
  char *parents = NULL;
  if (last) {
    *last = 0;
    parents = copy;
    name = last + 1;
  }
  if (!valid_component(name) || strlen(name) > NAME_MAX) fail("invalid-leaf");
  strcpy(leaf, name);
  int current = dup(root);
  if (current < 0) fail("root-dup");
  remember(chain, current, NULL);
  if (!parents) return current;
  char *save = NULL;
  for (char *part = strtok_r(parents, "/", &save); part;
       part = strtok_r(NULL, "/", &save)) {
    if (!valid_component(part)) fail("invalid-component");
    if (create && mkdirat(current, part, 0700) && errno != EEXIST)
      fail("mkdir");
    int next = openat(current, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    if (next < 0) fail("parent-open");
    struct stat entry;
    if (fstatat(current, part, &entry, AT_SYMLINK_NOFOLLOW) ||
        !S_ISDIR(entry.st_mode))
      fail("parent-entry");
    current = next;
    remember(chain, current, part);
  }
  return current;
}

static void wait_at_barrier(void) {
  char byte = 'R';
  if (write(3, &byte, 1) != 1 || read(4, &byte, 1) != 1)
    fail("test-barrier");
}

void test_barrier(void) {
  const char *point = getenv("KEIKO_FS_HELPER_TEST_BARRIER");
  if (point && !strcmp(point, "1")) wait_at_barrier();
}

void test_barrier_at(const char *expected) {
  const char *point = getenv("KEIKO_FS_HELPER_TEST_BARRIER");
  if (point && !strcmp(point, expected)) wait_at_barrier();
}

static void copy_bytes(int source, int destination, struct stat *before) {
  char buffer[65536];
  ssize_t size;
  while ((size = read(source, buffer, sizeof(buffer))) > 0) {
    ssize_t offset = 0;
    while (offset < size) {
      ssize_t written = write(destination, buffer + offset, (size_t)(size - offset));
      if (written <= 0) fail("write");
      offset += written;
    }
  }
  if (size < 0) fail("read");
  struct stat after;
  if (fstat(source, &after) || !same_stat(before, &after))
    fail("file-changed");
}

static void copy_stream(int source, int destination) {
  char buffer[65536];
  ssize_t size;
  while ((size = read(source, buffer, sizeof(buffer))) > 0) {
    ssize_t offset = 0;
    while (offset < size) {
      ssize_t written = write(destination, buffer + offset, (size_t)(size - offset));
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

static int create_file(int root, const char *path, mode_t mode, chain_t *chain) {
  char leaf[NAME_MAX + 1];
  int parent = open_parent(root, path, 1, chain, leaf);
  refresh_chain(chain);
  test_barrier();
  verify_chain(chain, 1);
  int file = openat(parent, leaf, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW,
                    mode);
  if (file < 0) fail("exclusive-create");
  struct stat entry;
  if (fstat(file, &entry) || !S_ISREG(entry.st_mode)) fail("created-type");
  return file;
}

static void verify_file_path(int root, const char *path, const struct stat *file) {
  chain_t chain = {0};
  char leaf[NAME_MAX + 1];
  int parent = open_parent(root, path, 0, &chain, leaf);
  struct stat named;
  if (fstatat(parent, leaf, &named, AT_SYMLINK_NOFOLLOW) ||
      !same_stat(file, &named)) fail("created-replaced");
  close_chain(&chain, 0);
}

static int open_dir_at_path(int root, const char *path, int create,
                            chain_t *chain) {
  if (!strcmp(path, ".")) {
    int result = dup(root);
    if (result < 0) fail("root-dup");
    remember(chain, result, NULL);
    return result;
  }
  char leaf[NAME_MAX + 1];
  int parent = open_parent(root, path, create, chain, leaf);
  if (create && mkdirat(parent, leaf, 0700) && errno != EEXIST)
    fail("mkdir");
  int result = openat(parent, leaf, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  if (result < 0) fail("directory-open");
  remember(chain, result, leaf);
  return result;
}

int native_fs_run(int argc, char **argv) {
  if (argc < 4) fail("usage");
  if (!strcmp(argv[1], "publish-bound")) return run_publish_bound(argc, argv);
  chain_t root_chain = {0};
  int root = open_absolute(argv[2], 0, &root_chain);
  if (!strcmp(argv[1], "read") && argc == 4) read_file(root, argv[3], STDOUT_FILENO);
  else if (!strcmp(argv[1], "write") && argc == 5) {
    chain_t chain = {0};
    int file = create_file(root, argv[3], (mode_t)strtol(argv[4], NULL, 8), &chain);
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
        !S_ISLNK(entry.st_mode)) fail("symlink-type");
    refresh_chain_leaf(&chain);
    test_barrier_at("symlink-created");
    verify_chain(&chain, 1);
    struct stat verified;
    if (fstatat(parent, leaf, &verified, AT_SYMLINK_NOFOLLOW) ||
        !same_stat(&entry, &verified)) fail("symlink-rebound");
    close_chain(&chain, 1);
  } else if (!strcmp(argv[1], "copy-tree") && (argc == 6 || argc == 7)) {
    chain_t source_chain = {0}, destination_chain = {0};
    int source = open_dir_at_path(root, argv[3], 0, &source_chain);
    int destination_root = open_absolute(argv[4], 0, &destination_chain);
    int destination = open_dir_at_path(destination_root, argv[5], 1,
                                       &destination_chain);
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
    close_chain(&source_chain, 1); close_chain(&destination_chain, 1);
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
  } else fail("usage");
  verify_absolute(argv[2], root);
  refresh_chain_leaf(&root_chain);
  close_chain(&root_chain, 1);
  return 0;
}
