#ifndef KEIKO_NATIVE_FS_INTERNAL_H
#define KEIKO_NATIVE_FS_INTERNAL_H

#ifndef KEIKO_NATIVE_FS_HELPER_HEADER
#define KEIKO_NATIVE_FS_HELPER_HEADER "native-fs-helper.h"
#endif
#include KEIKO_NATIVE_FS_HELPER_HEADER

#include <stddef.h>
#include <limits.h>
#include <sys/stat.h>

#define MAX_DEPTH 64

typedef struct {
  int fd[MAX_DEPTH];
  char name[MAX_DEPTH][NAME_MAX + 1];
  struct stat before[MAX_DEPTH];
  size_t count;
  size_t metadata_start;
} chain_t;

void fail(const char *category);
int same_stat(const struct stat *a, const struct stat *b);
int valid_component(const char *value);
void close_chain(chain_t *chain, int verify);
void refresh_chain(chain_t *chain);
void refresh_chain_leaf(chain_t *chain);
void verify_chain(chain_t *chain, int metadata);
void test_barrier(void);
void test_barrier_at(const char *point);
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
void publish_tree(int source, int destination_root, const char *path);
int run_publish_bound(int argc, char **argv);

#endif
