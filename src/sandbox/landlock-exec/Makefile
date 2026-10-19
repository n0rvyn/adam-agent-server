# landlock-exec Makefile
# Compiles the landlock-exec C binary (Landlock LSM wrapper).
# Only builds on Linux. macOS dev machines skip this automatically.

# Target output
TARGET = landlock-exec

# Source
SRC = main.c

# Compiler and flags
CC ?= gcc
CFLAGS ?= -std=c11 -Wall -Wextra -O2 -pipe

# Only build on Linux (skip on macOS, BSD, etc.)
UNAME_S := $(shell uname -s)
ifeq ($(UNAME_S),Linux)
TARGET_DIR := .
BUILD_GOALS := $(TARGET)
else
TARGET_DIR := .
BUILD_GOALS :=
endif

.PHONY: all clean

all: $(BUILD_GOALS)

$(TARGET): $(SRC)
	$(CC) $(CFLAGS) -o $@ $(SRC)

clean:
	rm -f $(TARGET)
