#define _GNU_SOURCE

#include <errno.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdio.h>
#include <signal.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/ptrace.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

#if defined(__x86_64__)
#define TAOMNI_AUDIT_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define TAOMNI_AUDIT_ARCH AUDIT_ARCH_AARCH64
#else
#define TAOMNI_AUDIT_ARCH 0
#endif

static int install_capture_filter(void) {
    struct sock_filter instructions[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS,
                 (unsigned int)offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, TAOMNI_AUDIT_ARCH, 1, 0),
        BPF_STMT(BPF_RET | BPF_K,
                 SECCOMP_RET_ERRNO | (ENOSYS & SECCOMP_RET_DATA)),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS,
                 (unsigned int)offsetof(struct seccomp_data, nr)),
#if defined(__x86_64__)
        BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, __X32_SYSCALL_BIT, 0, 1),
        BPF_STMT(BPF_RET | BPF_K,
                 SECCOMP_RET_ERRNO | (ENOSYS & SECCOMP_RET_DATA)),
#endif
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_connect, 2, 0),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_socket, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_TRACE),
    };
    struct sock_fprog program = {
        .len = (unsigned short)(sizeof(instructions) / sizeof(instructions[0])),
        .filter = instructions,
    };

    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
        return -1;
    }
    return prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program);
}

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "Taomni SocksCap launcher: missing target executable\n");
        return 125;
    }

    if (ptrace(PTRACE_TRACEME, 0, NULL, NULL) != 0) {
        fprintf(stderr, "Taomni SocksCap launcher: ptrace is unavailable: %s\n",
                strerror(errno));
        return 126;
    }
    if (raise(SIGSTOP) != 0) {
        fprintf(stderr, "Taomni SocksCap launcher: cannot enter trace stop: %s\n",
                strerror(errno));
        return 126;
    }
    if (install_capture_filter() != 0) {
        fprintf(stderr, "Taomni SocksCap launcher: seccomp is unavailable: %s\n",
                strerror(errno));
        return 126;
    }

    if (strcmp(argv[1], "--preflight") == 0) {
        errno = 0;
        long result = syscall(__NR_connect, -1, NULL, 0);
        return result == -1 && errno == EBADF ? 0 : 126;
    }

    execv(argv[1], &argv[1]);
    fprintf(stderr, "Taomni SocksCap launcher: exec %s failed: %s\n", argv[1],
            strerror(errno));
    return 127;
}
