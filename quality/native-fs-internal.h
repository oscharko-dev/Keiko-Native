#ifndef KEIKO_NATIVE_FS_INTERNAL_H
#define KEIKO_NATIVE_FS_INTERNAL_H

#include <stddef.h>
#include <limits.h>
#include <sys/stat.h>

#define MAX_DEPTH 64

typedef struct {
  int fd[MAX_DEPTH];
  struct stat before[MAX_DEPTH];
  size_t count;
} chain_t;

void fail(const char *category);
int same_stat(const struct stat *a, const struct stat *b);
int valid_component(const char *value);
void close_chain(chain_t *chain, int verify);
void refresh_chain(chain_t *chain);
int open_parent(int root, const char *path, int create, chain_t *chain,
                char leaf[NAME_MAX + 1]);
void copy_directory(int source, int destination, const char *exclude,
                    int depth);
void print_tree(int root, const char *prefix, const char *exclude, int depth);
void publish_tree(int source, int destination_root, const char *path);

#endif
