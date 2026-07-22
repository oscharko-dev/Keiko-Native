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
#include <string.h>
#include <unistd.h>

static int same_parent(const struct stat *left, const struct stat *right) {
#ifdef __APPLE__
#define CHANGED(value) ((value)->st_ctimespec)
#else
#define CHANGED(value) ((value)->st_ctim)
#endif
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino &&
         left->st_mode == right->st_mode &&
         CHANGED(left).tv_sec == CHANGED(right).tv_sec &&
         CHANGED(left).tv_nsec == CHANGED(right).tv_nsec;
}

static int same_object(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino &&
         left->st_mode == right->st_mode;
}

void remember_chain(chain_t *chain, int fd, const char *name) {
  if (chain->count >= MAX_DEPTH) fail("depth-or-stat");
  size_t index = chain->count;
  if (fstat(fd, &chain->before[index])) fail("depth-or-stat");
  copy_bounded(chain->name[index], sizeof(chain->name[index]), name ? name : "",
               "component-too-long");
  chain->fd[index] = fd;
  chain->count = index + 1;
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
  while (chain->count)
    close(chain->fd[--chain->count]);
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

static int create_component(int parent, const char *name) {
  if (!mkdirat(parent, name, 0700)) return 1;
  if (errno != EEXIST) fail("mkdir");
  return 0;
}

static int open_component(int parent, const char *name,
                          const char *open_category,
                          const char *entry_category) {
  int result = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  struct stat descriptor, named;
  if (result < 0) fail(open_category);
  if (fstat(result, &descriptor) ||
      fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW) ||
      !S_ISDIR(descriptor.st_mode) || !same_object(&descriptor, &named))
    fail(entry_category);
  return result;
}

int open_absolute(const char *path, int create, chain_t *chain) {
  if (path[0] != '/') fail("root-not-absolute");
  int current = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  if (current < 0) fail("root-open");
  remember_chain(chain, current, NULL);
  char copy[PATH_MAX];
  copy_bounded(copy, sizeof(copy), path, "path-too-long");
  char *save = NULL;
  for (char *part = strtok_r(copy, "/", &save); part;
       part = strtok_r(NULL, "/", &save)) {
    if (!valid_component(part)) fail("invalid-component");
    int created = create ? create_component(current, part) : 0;
    int next =
        open_component(current, part, "directory-open", "directory-entry");
    if (created && sync_directory(current, "absolute-parent-sync"))
      fail("absolute-parent-sync");
    current = next;
    remember_chain(chain, current, part);
  }
  chain->metadata_start = chain->count - 1;
  return current;
}

void verify_absolute(const char *path, int expected) {
  chain_t chain = {0};
  int reopened = open_absolute(path, 0, &chain);
  struct stat before, after;
  if (fstat(expected, &before) || fstat(reopened, &after) ||
      !same_object(&before, &after))
    fail("root-changed");
  close_chain(&chain, 0);
}

int open_parent(int root, const char *path, int create, chain_t *chain,
                char leaf[NAME_MAX + 1]) {
  if (!path[0] || path[0] == '/') fail("invalid-relative-path");
  char copy[PATH_MAX];
  copy_bounded(copy, sizeof(copy), path, "path-too-long");
  char *last = strrchr(copy, '/');
  const char *name = copy;
  char *parents = NULL;
  if (last) {
    *last = 0;
    parents = copy;
    name = last + 1;
  }
  if (!valid_component(name)) fail("invalid-leaf");
  copy_bounded(leaf, NAME_MAX + 1, name, "invalid-leaf");
  int current = dup(root);
  if (current < 0) fail("root-dup");
  remember_chain(chain, current, NULL);
  if (!parents) return current;
  char *save = NULL;
  for (char *part = strtok_r(parents, "/", &save); part;
       part = strtok_r(NULL, "/", &save)) {
    if (!valid_component(part)) fail("invalid-component");
    int created = create ? create_component(current, part) : 0;
    int next = open_component(current, part, "parent-open", "parent-entry");
    if (created && sync_directory(current, "relative-parent-sync"))
      fail("relative-parent-sync");
    current = next;
    remember_chain(chain, current, part);
  }
  return current;
}
