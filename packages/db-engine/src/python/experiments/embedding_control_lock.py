"""Locks shared with the supported Linux CLI for the isolated supervisor experiment."""

import json
import os
import secrets
import stat
from contextlib import contextmanager
from pathlib import Path


def _verify_directory_chain(directory: Path, expected_owner: int, private_final: bool = False) -> None:
    """Reject symlinked or replaceable ancestors of managed state."""
    directory = Path(os.path.abspath(directory))
    chain = [*reversed(directory.parents), directory]
    for index, component in enumerate(chain):
        info = component.lstat()
        is_final = index == len(chain) - 1
        if not stat.S_ISDIR(info.st_mode):
            raise PermissionError(f'managed path component {component} is not a real directory')
        allowed_owners = (expected_owner,) if is_final else (0, expected_owner)
        if info.st_uid not in allowed_owners:
            raise PermissionError(f'managed path component {component} has an unexpected owner')
        writable = info.st_mode & 0o022
        sticky_root = info.st_uid == 0 and info.st_mode & stat.S_ISVTX
        if writable and not sticky_root:
            raise PermissionError(f'managed path component {component} is writable by other users')
        if is_final and private_final and info.st_mode & 0o077:
            raise PermissionError(f'managed state directory {component} is not owner-only')


def ensure_managed_state_directory(directory: Path) -> None:
    """Create or validate a private state directory without repairing it."""
    directory = Path(directory)
    try:
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    except FileExistsError:
        pass
    _verify_directory_chain(directory, os.geteuid(), private_final=True)


@contextmanager
def embedding_lifecycle_lock():
    """Exclude prototype state publication from supported CLI lifecycle operations.

    The lock is an atomic directory because Node and Python can both create and
    remove it without native dependencies. A process crash intentionally leaves
    the directory behind; callers must inspect it and remove it manually. It is
    never reclaimed from a PID alone.
    """
    search_docs = Path.home() / '.search-docs'
    try:
        search_docs.mkdir(mode=0o700, parents=True, exist_ok=True)
    except OSError as exc:
        raise RuntimeError('cannot create the embedding state parent directory') from exc
    try:
        _verify_directory_chain(search_docs, os.geteuid())
    except OSError as exc:
        raise RuntimeError(
            'embedding state parent and its ancestors must be real, non-replaceable directories'
        ) from exc

    lock_directory = search_docs / 'embedding-management.lock'
    try:
        lock_directory.mkdir(mode=0o700)
    except FileExistsError as exc:
        raise RuntimeError(
            f'embedding management lock {lock_directory} already exists; '
            'another operation may be active; inspect it and remove it manually only after '
            'confirming no embedding operation is active'
        ) from exc
    except OSError as exc:
        raise RuntimeError('cannot acquire the embedding management lock') from exc

    token = secrets.token_hex(24)
    lock_identity = lock_directory.lstat()
    owner_path = lock_directory / 'owner.json'
    owner = {
        'token': token,
        'pid': os.getpid(),
    }
    owner_fd = None
    try:
        owner_fd = os.open(
            owner_path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0),
            0o600,
        )
        payload = (json.dumps(owner, sort_keys=True) + '\n').encode('utf-8')
        offset = 0
        while offset < len(payload):
            offset += os.write(owner_fd, payload[offset:])
        os.fsync(owner_fd)
        os.close(owner_fd)
        owner_fd = None
        yield
    finally:
        if owner_fd is not None:
            os.close(owner_fd)
        try:
            current_directory = lock_directory.lstat()
            current_owner = json.loads(owner_path.read_text(encoding='utf-8'))
            if (
                current_directory.st_dev == lock_identity.st_dev
                and current_directory.st_ino == lock_identity.st_ino
                and current_owner.get('token') == token
            ):
                owner_path.unlink()
                lock_directory.rmdir()
        except FileNotFoundError:
            pass


@contextmanager
def managed_state_lock(directory: Path):
    """Lock an existing owner-only directory, or fail closed."""
    if os.name != 'posix':
        raise RuntimeError('managed state locking is not supported on this platform')
    import fcntl

    ensure_managed_state_directory(directory)
    flags = os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0)
    if not hasattr(os, 'O_NOFOLLOW') or not hasattr(os, 'O_DIRECTORY'):
        raise RuntimeError('secure directory access is unavailable')
    directory_fd = os.open(directory, flags)
    try:
        directory_stat = os.fstat(directory_fd)
        if not stat.S_ISDIR(directory_stat.st_mode) or directory_stat.st_uid != os.geteuid() or directory_stat.st_mode & 0o077:
            raise PermissionError('managed state directory must be owner-only')
        fd = os.open('state.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=directory_fd)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077 or info.st_nlink != 1:
                raise PermissionError('managed state lock must be an owner-only regular file')
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            try:
                yield
            finally:
                fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)
    finally:
        os.close(directory_fd)
