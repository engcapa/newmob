#define _GNU_SOURCE

#include <arpa/inet.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>

#define TAOMNI_CONTROL_FD 198
#define TAOMNI_CONFIG_FD 199
#define TAOMNI_CONFIG_MAGIC UINT32_C(0x544d5343)
#define TAOMNI_FLOW_MAGIC UINT32_C(0x544d464c)
#define TAOMNI_PROTOCOL_VERSION UINT16_C(1)
#define TAOMNI_CONFIG_FLAG_IPV6_READY UINT16_C(1)
#define TAOMNI_MAX_TRACKED_FDS 4096

struct taomni_launch_config {
    uint32_t magic;
    uint16_t version;
    uint16_t flags;
    uint16_t relay_port;
    uint16_t reserved;
};

struct taomni_flow_registration {
    uint32_t magic;
    uint16_t version;
    uint16_t family;
    uint32_t pid;
    int32_t fd;
    uint16_t source_port;
    uint16_t destination_port;
    uint8_t source_address[16];
    uint8_t destination_address[16];
};

struct tracked_peer {
    int fd;
    socklen_t length;
    struct sockaddr_storage address;
};

static int (*real_connect_fn)(int, const struct sockaddr *, socklen_t);
static int (*real_getpeername_fn)(int, struct sockaddr *, socklen_t *);
static int (*real_close_fn)(int);
static int (*real_dup_fn)(int);
static int (*real_dup2_fn)(int, int);
static int (*real_dup3_fn)(int, int, int);
static pthread_once_t symbols_once = PTHREAD_ONCE_INIT;
static pthread_mutex_t peers_lock = PTHREAD_MUTEX_INITIALIZER;
static struct tracked_peer peers[TAOMNI_MAX_TRACKED_FDS];
static __thread int inside_hook;

static void load_symbols(void) {
    real_connect_fn = dlsym(RTLD_NEXT, "connect");
    real_getpeername_fn = dlsym(RTLD_NEXT, "getpeername");
    real_close_fn = dlsym(RTLD_NEXT, "close");
    real_dup_fn = dlsym(RTLD_NEXT, "dup");
    real_dup2_fn = dlsym(RTLD_NEXT, "dup2");
    real_dup3_fn = dlsym(RTLD_NEXT, "dup3");
}

static int read_config(struct taomni_launch_config *config) {
    ssize_t count = pread(TAOMNI_CONFIG_FD, config, sizeof(*config), 0);
    if (count == (ssize_t)sizeof(*config) &&
        config->magic == TAOMNI_CONFIG_MAGIC &&
        config->version == TAOMNI_PROTOCOL_VERSION &&
        config->relay_port != 0) {
        return 1;
    }

    const char *port_text = getenv("TAOMNI_SOCKSCAP_RELAY_PORT");
    if (port_text == NULL || *port_text == '\0') {
        return 0;
    }
    char *end = NULL;
    errno = 0;
    long port = strtol(port_text, &end, 10);
    if (errno != 0 || end == port_text || *end != '\0' || port <= 0 || port > 65535) {
        return 0;
    }
    memset(config, 0, sizeof(*config));
    config->magic = TAOMNI_CONFIG_MAGIC;
    config->version = TAOMNI_PROTOCOL_VERSION;
    config->relay_port = (uint16_t)port;
    const char *ipv6_ready = getenv("TAOMNI_SOCKSCAP_IPV6_READY");
    if (ipv6_ready != NULL && strcmp(ipv6_ready, "1") == 0) {
        config->flags |= TAOMNI_CONFIG_FLAG_IPV6_READY;
    }
    return 1;
}

static int is_loopback(const struct sockaddr *address) {
    if (address->sa_family == AF_INET) {
        const struct sockaddr_in *value = (const struct sockaddr_in *)address;
        return (ntohl(value->sin_addr.s_addr) >> 24) == 127;
    }
    if (address->sa_family == AF_INET6) {
        const struct sockaddr_in6 *value = (const struct sockaddr_in6 *)address;
        return IN6_IS_ADDR_LOOPBACK(&value->sin6_addr);
    }
    return 0;
}

static void track_peer(int fd, const struct sockaddr *address, socklen_t length) {
    if (fd < 0 || fd >= TAOMNI_MAX_TRACKED_FDS ||
        length > (socklen_t)sizeof(struct sockaddr_storage)) {
        return;
    }
    pthread_mutex_lock(&peers_lock);
    peers[fd].fd = fd;
    peers[fd].length = length;
    memcpy(&peers[fd].address, address, length);
    pthread_mutex_unlock(&peers_lock);
}

static void forget_peer(int fd) {
    if (fd < 0 || fd >= TAOMNI_MAX_TRACKED_FDS) {
        return;
    }
    pthread_mutex_lock(&peers_lock);
    peers[fd].fd = -1;
    peers[fd].length = 0;
    pthread_mutex_unlock(&peers_lock);
}

static void copy_peer(int old_fd, int new_fd) {
    if (old_fd < 0 || old_fd >= TAOMNI_MAX_TRACKED_FDS ||
        new_fd < 0 || new_fd >= TAOMNI_MAX_TRACKED_FDS) {
        return;
    }
    pthread_mutex_lock(&peers_lock);
    peers[new_fd] = peers[old_fd];
    peers[new_fd].fd = new_fd;
    pthread_mutex_unlock(&peers_lock);
}

static int fill_endpoint(const struct sockaddr *address, uint8_t bytes[16], uint16_t *port) {
    memset(bytes, 0, 16);
    if (address->sa_family == AF_INET) {
        const struct sockaddr_in *value = (const struct sockaddr_in *)address;
        memcpy(bytes, &value->sin_addr, 4);
        *port = ntohs(value->sin_port);
        return AF_INET;
    }
    if (address->sa_family == AF_INET6) {
        const struct sockaddr_in6 *value = (const struct sockaddr_in6 *)address;
        memcpy(bytes, &value->sin6_addr, 16);
        *port = ntohs(value->sin6_port);
        return AF_INET6;
    }
    return 0;
}

static void send_registration(const struct taomni_flow_registration *message) {
    const char *path = getenv("TAOMNI_SOCKSCAP_CONTROL_PATH");
    if (path == NULL || *path == '\0') {
        (void)syscall(SYS_sendto, TAOMNI_CONTROL_FD, message, sizeof(*message),
                      MSG_DONTWAIT | MSG_NOSIGNAL, NULL, 0);
        return;
    }

    size_t path_length = strlen(path);
    struct sockaddr_un destination;
    if (path_length >= sizeof(destination.sun_path)) {
        return;
    }
    memset(&destination, 0, sizeof(destination));
    destination.sun_family = AF_UNIX;
    memcpy(destination.sun_path, path, path_length + 1);

    int control = (int)syscall(SYS_socket, AF_UNIX, SOCK_DGRAM | SOCK_CLOEXEC, 0);
    if (control < 0) {
        return;
    }
    socklen_t destination_length =
        (socklen_t)(offsetof(struct sockaddr_un, sun_path) + path_length + 1);
    (void)syscall(SYS_sendto, control, message, sizeof(*message),
                  MSG_DONTWAIT | MSG_NOSIGNAL,
                  (const struct sockaddr *)&destination, destination_length);
    (void)syscall(SYS_close, control);
}

static void register_flow(int fd, const struct sockaddr *destination) {
    struct sockaddr_storage source;
    socklen_t source_length = sizeof(source);
    if (getsockname(fd, (struct sockaddr *)&source, &source_length) != 0) {
        return;
    }

    struct taomni_flow_registration message;
    memset(&message, 0, sizeof(message));
    message.magic = TAOMNI_FLOW_MAGIC;
    message.version = TAOMNI_PROTOCOL_VERSION;
    message.pid = (uint32_t)getpid();
    message.fd = fd;
    int source_family = fill_endpoint(
        (const struct sockaddr *)&source, message.source_address, &message.source_port);
    int destination_family = fill_endpoint(
        destination, message.destination_address, &message.destination_port);
    if (source_family == 0 || source_family != destination_family) {
        return;
    }
    message.family = (uint16_t)source_family;

    send_registration(&message);
}

__attribute__((visibility("default")))
int connect(int fd, const struct sockaddr *address, socklen_t length) {
    pthread_once(&symbols_once, load_symbols);
    if (real_connect_fn == NULL) {
        errno = ENOSYS;
        return -1;
    }
    if (inside_hook || address == NULL ||
        (address->sa_family != AF_INET && address->sa_family != AF_INET6) ||
        is_loopback(address)) {
        return real_connect_fn(fd, address, length);
    }

    int socket_type = 0;
    socklen_t socket_type_length = sizeof(socket_type);
    if (getsockopt(fd, SOL_SOCKET, SO_TYPE, &socket_type, &socket_type_length) != 0 ||
        socket_type != SOCK_STREAM) {
        return real_connect_fn(fd, address, length);
    }

    struct taomni_launch_config config;
    if (!read_config(&config)) {
        return real_connect_fn(fd, address, length);
    }
    if (address->sa_family == AF_INET6 &&
        (config.flags & TAOMNI_CONFIG_FLAG_IPV6_READY) == 0) {
        errno = ENETUNREACH;
        return -1;
    }

    struct sockaddr_storage original;
    if (length > (socklen_t)sizeof(original)) {
        errno = EINVAL;
        return -1;
    }
    memset(&original, 0, sizeof(original));
    memcpy(&original, address, length);

    struct sockaddr_storage relay;
    socklen_t relay_length;
    memset(&relay, 0, sizeof(relay));
    if (address->sa_family == AF_INET) {
        struct sockaddr_in *value = (struct sockaddr_in *)&relay;
        value->sin_family = AF_INET;
        value->sin_port = htons(config.relay_port);
        value->sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        relay_length = sizeof(*value);
    } else {
        struct sockaddr_in6 *value = (struct sockaddr_in6 *)&relay;
        value->sin6_family = AF_INET6;
        value->sin6_port = htons(config.relay_port);
        value->sin6_addr = in6addr_loopback;
        relay_length = sizeof(*value);
    }

    inside_hook = 1;
    int result = real_connect_fn(fd, (const struct sockaddr *)&relay, relay_length);
    int saved_errno = errno;
    if (result == 0 || saved_errno == EINPROGRESS || saved_errno == EALREADY ||
        saved_errno == EISCONN) {
        track_peer(fd, (const struct sockaddr *)&original, length);
        register_flow(fd, (const struct sockaddr *)&original);
    }
    inside_hook = 0;
    errno = saved_errno;
    return result;
}

__attribute__((visibility("default")))
int getpeername(int fd, struct sockaddr *address, socklen_t *length) {
    pthread_once(&symbols_once, load_symbols);
    if (fd >= 0 && fd < TAOMNI_MAX_TRACKED_FDS && address != NULL && length != NULL) {
        pthread_mutex_lock(&peers_lock);
        if (peers[fd].fd == fd && peers[fd].length != 0) {
            socklen_t copy_length = *length < peers[fd].length ? *length : peers[fd].length;
            memcpy(address, &peers[fd].address, copy_length);
            *length = peers[fd].length;
            pthread_mutex_unlock(&peers_lock);
            return 0;
        }
        pthread_mutex_unlock(&peers_lock);
    }
    if (real_getpeername_fn == NULL) {
        errno = ENOSYS;
        return -1;
    }
    return real_getpeername_fn(fd, address, length);
}

__attribute__((visibility("default")))
int close(int fd) {
    pthread_once(&symbols_once, load_symbols);
    forget_peer(fd);
    if (real_close_fn == NULL) {
        return (int)syscall(SYS_close, fd);
    }
    return real_close_fn(fd);
}

__attribute__((visibility("default")))
int dup(int old_fd) {
    pthread_once(&symbols_once, load_symbols);
    int new_fd = real_dup_fn == NULL ? (int)syscall(SYS_dup, old_fd) : real_dup_fn(old_fd);
    if (new_fd >= 0) {
        copy_peer(old_fd, new_fd);
    }
    return new_fd;
}

__attribute__((visibility("default")))
int dup2(int old_fd, int new_fd) {
    pthread_once(&symbols_once, load_symbols);
    int result = real_dup2_fn == NULL
                     ? (int)syscall(SYS_dup2, old_fd, new_fd)
                     : real_dup2_fn(old_fd, new_fd);
    if (result >= 0) {
        copy_peer(old_fd, result);
    }
    return result;
}

__attribute__((visibility("default")))
int dup3(int old_fd, int new_fd, int flags) {
    pthread_once(&symbols_once, load_symbols);
    int result = real_dup3_fn == NULL
                     ? (int)syscall(SYS_dup3, old_fd, new_fd, flags)
                     : real_dup3_fn(old_fd, new_fd, flags);
    if (result >= 0) {
        copy_peer(old_fd, result);
    }
    return result;
}
