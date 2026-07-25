// native-fs-internal.h
#ifndef NATIVE_FS_INTERNAL_H
#define NATIVE_FS_INTERNAL_H

#include "native-fs-bound.h"

void bind_workspace(const char* path);
void cancel_picker();

#endif // NATIVE_FS_INTERNAL_H