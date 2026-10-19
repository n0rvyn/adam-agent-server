/**
 * landlock-exec — a minimal C wrapper binary that applies Landlock LSM restrictions
 * before executing the target command.
 *
 * Usage: landlock-exec [--ro /path1] [--rw /path2] -- command arg1 arg2
 *
 * Creates a Landlock ruleset with:
 *   - LANDLOCK_ACCESS_FS_READ_FILE | READ_DIR | EXECUTE for all paths
 *   - WRITE_FILE | REMOVE_FILE | REMOVE_DIR | MAKE_DIR | TRUNCATE for --rw paths
 * Calls prctl(PR_SET_NO_NEW_PRIVS, 1) then landlock_restrict_self().
 * Gracefully degrades if Landlock is unavailable (old kernel).
 *
 * Build: make landlock-exec (only builds on Linux)
 * Note: Compile with -std=c11 -lseccomp on Linux.
 * Requires Linux kernel 5.13+ (Landlock LSM).
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/prctl.h>
#include <linux/landlock.h>

#ifndef LANDLOCK_ACCESS_FS_MASK
#define LANDLOCK_ACCESS_FS_MASK 0x1fff
#endif

#ifndef LANDLOCK_CREATE_RULESET_VERSION
#define LANDLOCK_CREATE_RULESET_VERSION (1)
#endif

#ifndef LANDLOCK_ACCESS_FS_EXECUTE
#define LANDLOCK_ACCESS_FS_EXECUTE (1ULL << 2)
#endif

#ifndef LANDLOCK_ACCESS_FS_WRITE_FILE
#define LANDLOCK_ACCESS_FS_WRITE_FILE (1ULL << 6)
#endif

#ifndef LANDLOCK_ACCESS_FS_REMOVE_FILE
#define LANDLOCK_ACCESS_FS_REMOVE_FILE (1ULL << 9)
#endif

#ifndef LANDLOCK_ACCESS_FS_REMOVE_DIR
#define LANDLOCK_ACCESS_FS_REMOVE_DIR (1ULL << 10)
#endif

#ifndef LANDLOCK_ACCESS_FS_MAKE_DIR
#define LANDLOCK_ACCESS_FS_MAKE_DIR (1ULL << 11)
#endif

#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_MAX_RULES  (1ULL << 12)
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 12)
#endif

#define MAX_PATHS 64

static const char *g_ro_paths[MAX_PATHS];
static const char *g_rw_paths[MAX_PATHS];
static int g_ro_count = 0;
static int g_rw_count = 0;

/*
 * Print usage and exit.
 */
static void usage(const char *prog) {
    fprintf(stderr, "Usage: %s [--ro /path] [--rw /path] -- command [args...]\n", prog);
    fprintf(stderr, "  --ro /path   Read-only access to path\n");
    fprintf(stderr, "  --rw /path   Read-write access to path\n");
    exit(1);
}

/*
 * Parse --ro and --rw arguments before the "--" separator.
 */
static void parse_args(int argc, char *argv[]) {
    int i = 1;
    while (i < argc && strcmp(argv[i], "--") != 0) {
        if (strcmp(argv[i], "--ro") == 0) {
            if (i + 1 >= argc || argv[i + 1][0] == '-') usage(argv[0]);
            if (g_ro_count < MAX_PATHS) g_ro_paths[g_ro_count++] = argv[++i];
        } else if (strcmp(argv[i], "--rw") == 0) {
            if (i + 1 >= argc || argv[i + 1][0] == '-') usage(argv[0]);
            if (g_rw_count < MAX_PATHS) g_rw_paths[g_rw_count++] = argv[++i];
        } else if (strcmp(argv[i], "--check") == 0) {
            /* Probe Landlock kernel support without executing anything. */
            int fd = syscall(SYS_landlock_create_ruleset, NULL, 0,
                            LANDLOCK_CREATE_RULESET_VERSION);
            if (fd >= 0) {
                close(fd);
                printf("landlock: available\n");
                exit(0);
            } else {
                printf("landlock: unavailable\n");
                exit(1);
            }
        } else {
            usage(argv[0]);
        }
        i++;
    }
}

/*
 * Create a Landlock ruleset with all registered paths.
 * Returns a ruleset file descriptor, or -1 on failure.
 */
static int create_landlock_ruleset(void) {
    struct landlock_ruleset_attr attr = {
        .handled_access_fs = LANDLOCK_ACCESS_FS_MASK,
    };

    int ruleset_fd = syscall(SYS_landlock_create_ruleset, &attr, sizeof(attr),
                              LANDLOCK_CREATE_RULESET_VERSION);
    if (ruleset_fd < 0) {
        perror("landlock_create_ruleset");
        return -1;
    }

    /*
     * Rules for RO paths: allow read + execute, but not write.
     * We model this by denying write on ro paths. Actually, since Landlock is
     * a deny-list, we just omit write permissions for ro paths.
     * So: for ro paths we add READ + EXECUTE only.
     */
    unsigned long ro_access = LANDLOCK_ACCESS_FS_READ_FILE |
                               LANDLOCK_ACCESS_FS_READ_DIR   |
                               LANDLOCK_ACCESS_FS_EXECUTE;

    /* For now, all paths get read+exec. */
    for (int i = 0; i < g_ro_count; i++) {
        struct landlock_path_beneath_attr pattr = {
            .parent_fd = -1,  /* placeholder */
            .allowed_access = ro_access,
        };
        pattr.parent_fd = open(g_ro_paths[i], O_PATH | O_CLOEXEC);
        if (pattr.parent_fd < 0) {
            perror("open (ro path)");
            continue;
        }
        int ret = syscall(SYS_landlock_add_rule, ruleset_fd,
                          LANDLOCK_RULE_PATH_BENEATH, &pattr, 0);
        close(pattr.parent_fd);
        if (ret < 0) perror("landlock_add_rule (ro)");
    }

    /*
     * Rules for RW paths: read + execute + write permissions.
     */
    unsigned long rw_access = ro_access |
                              LANDLOCK_ACCESS_FS_WRITE_FILE |
                              LANDLOCK_ACCESS_FS_REMOVE_FILE |
                              LANDLOCK_ACCESS_FS_REMOVE_DIR  |
                              LANDLOCK_ACCESS_FS_MAKE_DIR    |
                              LANDLOCK_ACCESS_FS_TRUNCATE;

    for (int i = 0; i < g_rw_count; i++) {
        struct landlock_path_beneath_attr pattr = {
            .parent_fd = -1,
            .allowed_access = rw_access,
        };
        pattr.parent_fd = open(g_ro_paths[i], O_PATH | O_CLOEXEC);
        if (pattr.parent_fd < 0) {
            /* Try the rw path itself as parent */
            pattr.parent_fd = open(g_rw_paths[i], O_PATH | O_CLOEXEC);
        }
        if (pattr.parent_fd < 0) {
            perror("open (rw path)");
            continue;
        }
        int ret = syscall(SYS_landlock_add_rule, ruleset_fd,
                          LANDLOCK_RULE_PATH_BENEATH, &pattr, 0);
        close(pattr.parent_fd);
        if (ret < 0) perror("landlock_add_rule (rw)");
    }

    return ruleset_fd;
}

int main(int argc, char *argv[]) {
    /* Skip if no paths specified (no-op sandbox) */
    if (argc < 2) usage(argv[0]);

    parse_args(argc, argv);

    /* Find the "--" separator */
    int sep = -1;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--") == 0) { sep = i; break; }
    }
    if (sep < 0 || sep + 1 >= argc) usage(argv[0]);

    /* Create and apply the Landlock ruleset */
    int ruleset_fd = create_landlock_ruleset();
    if (ruleset_fd >= 0) {
        if (syscall(SYS_landlock_restrict_self, ruleset_fd, 0) < 0) {
            perror("landlock_restrict_self");
            close(ruleset_fd);
            /* Fall through — exec without sandbox */
        }
        close(ruleset_fd);
    }

    /* Disable privilege escalation */
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) {
        perror("prctl PR_SET_NO_NEW_PRIVS");
    }

    /* Execute the target command */
    execvp(argv[sep + 1], &argv[sep + 1]);
    perror("execvp");
    _exit(127);
}
