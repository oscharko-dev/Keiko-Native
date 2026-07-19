#ifdef __APPLE__
#define _DARWIN_C_SOURCE
#else
#define _GNU_SOURCE
#endif
#ifndef KEIKO_NATIVE_FS_INTERNAL_HEADER
#define KEIKO_NATIVE_FS_INTERNAL_HEADER "native-fs-internal.h"
#endif
#include KEIKO_NATIVE_FS_INTERNAL_HEADER

#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

typedef struct {
  int armed;
  int parent;
  char name[NAME_MAX + 1];
  struct stat identity;
} stage_cleanup_t;

static stage_cleanup_t cleanup = {.parent = -1};
static int registered;

static int same_identity(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino &&
         left->st_mode == right->st_mode;
}

static void cleanup_owned_stage(void) {
  if (!cleanup.armed) return;
  struct stat named;
  if (!fstatat(cleanup.parent, cleanup.name, &named, AT_SYMLINK_NOFOLLOW) &&
      S_ISDIR(named.st_mode) && same_identity(&cleanup.identity, &named)) {
    (void)try_remove_entry(cleanup.parent, cleanup.name);
    (void)sync_directory(cleanup.parent, "stage-cleanup-sync");
  }
  close(cleanup.parent);
  cleanup = (stage_cleanup_t){.parent = -1};
}

void arm_stage_cleanup(int parent, const char *name, int stage) {
  struct stat descriptor = {0}, named;
  if (cleanup.armed || strlen(name) > NAME_MAX || fstat(stage, &descriptor) ||
      fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW) ||
      !S_ISDIR(descriptor.st_mode) || !same_identity(&descriptor, &named))
    fail("stage-rebound");
  int retained = dup(parent);
  if (retained < 0) fail("stage-cleanup-parent");
  if (!registered) {
    if (atexit(cleanup_owned_stage)) {
      close(retained);
      fail("stage-cleanup-register");
    }
    registered = 1;
  }
  cleanup.armed = 1;
  cleanup.parent = retained;
  cleanup.identity = descriptor;
  strcpy(cleanup.name, name);
}

void disarm_stage_cleanup(void) {
  if (!cleanup.armed) fail("stage-cleanup-state");
  close(cleanup.parent);
  cleanup = (stage_cleanup_t){.parent = -1};
}
