#ifndef KEIKO_NATIVE_FS_INTERNAL_H
#define KEIKO_NATIVE_FS_INTERNAL_H

#ifndef KEIKO_NATIVE_FS_HELPER_HEADER
#define KEIKO_NATIVE_FS_HELPER_HEADER "native-fs-helper.h"
#endif
#include KEIKO_NATIVE_FS_HELPER_HEADER

#include <limits.h>
#include <stddef.h>
#include <sys/stat.h>

#define MAX_DEPTH 64

typedef struct {
  int fd[MAX_DEPTH];
  char name[MAX_DEPTH][NAME_MAX + 1];
  struct stat before[MAX_DEPTH];
  size_t count;
  size_t metadata_start;
} chain_t;

_Noreturn void fail(const char *category);
void copy_bounded(char *destination, size_t capacity, const char *source,
                  const char *category);
int same_stat(const struct stat *a, const struct stat *b);
int valid_component(const char *value);
void close_chain(chain_t *chain, int verify);
void refresh_chain(chain_t *chain);
void refresh_chain_leaf(chain_t *chain);
void remember_chain(chain_t *chain, int fd, const char *name);
void verify_chain(chain_t *chain, int metadata);
void verify_absolute(const char *path, int expected);
void test_barrier(void);
void test_barrier_at(const char *point);
int test_failure_at(const char *point);
int sync_directory(int directory, const char *point);
int open_parent(int root, const char *path, int create, chain_t *chain,
                char leaf[NAME_MAX + 1]);
int open_absolute(const char *path, int create, chain_t *chain);
void copy_directory(int source, int destination, const char *exclude,
                    int depth);
void print_tree(int root, const char *prefix, const char *exclude, int depth);
void publish_staged(int parent, chain_t *chain, const char *leaf,
                    const char *staging, int stage);
void remove_entry(int parent, const char *name);
int try_remove_entry(int parent, const char *name);
void arm_stage_cleanup(int parent, const char *name, int stage);
void disarm_stage_cleanup(void);
void publish_tree(int source, int destination_root, const char *path);
int run_publish_bound(int argc, char **argv);

#endif
