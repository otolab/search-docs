"""Private generation state for the isolated Linux supervisor experiment."""
import errno
from contextlib import nullcontext
import json
import os
import re
import secrets
import stat
from pathlib import Path

from embedding_control_lock import ensure_managed_state_directory, managed_state_lock
from embedding_linux_pidfd import PinnedProcess, TargetUnavailable, _listener_inodes

_GENERATION = re.compile(r'^[0-9a-f]{32}$')
_MAX_STATE_BYTES = 16 * 1024


class StateSafetyError(RuntimeError):
    """State cannot be safely published, interpreted, or reclaimed."""


class GenerationInUse(StateSafetyError):
    """At least one process recorded by a generation is still alive."""


def _fault_enabled(fault_injector, name: str) -> bool:
    if fault_injector is None:
        return False
    enabled = getattr(fault_injector, 'enabled', None)
    return bool(enabled(name)) if enabled is not None else False


def _fault_checkpoint(fault_injector, name: str) -> None:
    if fault_injector is None:
        return
    checkpoint = getattr(fault_injector, 'checkpoint', None)
    if checkpoint is not None:
        checkpoint(name)


def generation_id() -> str:
    return secrets.token_hex(16)


def generation_filename(port: int, generation: str) -> str:
    if (
        not isinstance(port, int)
        or isinstance(port, bool)
        or not 0 < port < 65536
        or not isinstance(generation, str)
        or not _GENERATION.fullmatch(generation)
    ):
        raise ValueError('invalid port or generation')
    return f'port-{port}-{generation}.json'


def _read_process_state_starttime(pid: int):
    """Read proc state and starttime, preserving comm fields with spaces."""
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        raise ValueError('invalid PID')
    try:
        contents = Path(f'/proc/{pid}/stat').read_text(encoding='ascii')
        close = contents.rfind(')')
        if close < 0:
            raise ValueError('invalid proc stat record')
        fields = contents[close + 1:].split()
        # The tail starts at field 3 (state), so starttime (field 22) is index 19.
        state = fields[0]
        starttime = int(fields[19])
        if len(state) != 1 or starttime < 0:
            raise ValueError('invalid proc starttime')
        return state, starttime
    except (OSError, ValueError, IndexError) as exc:
        raise StateSafetyError(f'cannot read starttime for PID {pid}') from exc


def read_process_starttime(pid: int) -> int:
    """Read Linux /proc starttime (field 22), preserving comm fields with spaces."""
    return _read_process_state_starttime(pid)[1]


def current_pid_namespace_inode() -> int:
    """Ensure pidfd and procfs identify this process in the same PID namespace."""
    try:
        with PinnedProcess(os.getpid()) as process:
            process.verify_procfs_pid()
        return os.stat('/proc/self/ns/pid').st_ino
    except (OSError, TargetUnavailable) as exc:
        raise StateSafetyError('cannot verify the current PID namespace') from exc


def current_network_namespace_inode() -> int:
    """Return the network namespace used by this process's /proc/net view."""
    try:
        return os.stat('/proc/self/ns/net').st_ino
    except OSError as exc:
        raise StateSafetyError('cannot identify the current network namespace') from exc


def process_network_namespace_inode(pid: int) -> int:
    """Return a process's current network namespace, refusing unreadable identities."""
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        raise StateSafetyError('network namespace PID is invalid')
    try:
        return os.stat(f'/proc/{pid}/ns/net').st_ino
    except OSError as exc:
        raise StateSafetyError(f'cannot identify the network namespace for PID {pid}') from exc


def process_identity_alive(pid: int, starttime: int, namespace_inode: int) -> bool:
    """Return whether the exact recorded process is live; uncertainty is an error."""
    if namespace_inode != current_pid_namespace_inode():
        raise StateSafetyError('state belongs to a different PID namespace')
    try:
        process = PinnedProcess(pid)
    except TargetUnavailable as exc:
        cause = exc.__cause__
        if isinstance(cause, OSError) and cause.errno == errno.ESRCH:
            return False
        if isinstance(cause, OSError) and cause.errno == errno.EINVAL:
            try:
                state, current_starttime = _read_process_state_starttime(pid)
            except StateSafetyError:
                # An absent PID cannot still be the recorded generation. If
                # procfs exists but is unreadable or malformed, keep failing
                # closed instead of treating uncertainty as a dead process.
                try:
                    os.stat(f'/proc/{pid}')
                except FileNotFoundError:
                    return False
                except OSError as stat_error:
                    raise StateSafetyError(
                        f'cannot determine whether recorded PID {pid} is a zombie'
                    ) from stat_error
                raise
            if current_starttime != starttime:
                return False
            if state in ('Z', 'X'):
                # Zombies cannot execute or receive signals. Their PID remains
                # allocated until reaped, so the starttime check cannot race
                # with reuse while this proc entry exists.
                return False
        raise StateSafetyError(f'cannot pin recorded PID {pid}') from exc

    try:
        if process.exited():
            return False
        process.verify_procfs_pid()
        if process.exited():
            return False
        current_starttime = read_process_starttime(pid)
        return current_starttime == starttime and not process.exited()
    except TargetUnavailable as exc:
        raise StateSafetyError(f'cannot verify recorded PID {pid}') from exc
    finally:
        process.close()


def process_group_alive(process_group_id: int) -> bool:
    """Conservatively detect descendants that remain in the managed session."""
    if (
        not isinstance(process_group_id, int)
        or isinstance(process_group_id, bool)
        or process_group_id <= 0
    ):
        raise StateSafetyError('process group identity is invalid')
    try:
        os.killpg(process_group_id, 0)
        return True
    except OSError as exc:
        if exc.errno == errno.ESRCH:
            return False
        if exc.errno == errno.EPERM:
            return True
        raise StateSafetyError(
            f'cannot determine whether process group {process_group_id} is still alive'
        ) from exc


def _open_state_directory(directory: Path) -> int:
    ensure_managed_state_directory(directory)
    flags = os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0)
    if not hasattr(os, 'O_DIRECTORY') or not hasattr(os, 'O_NOFOLLOW'):
        raise StateSafetyError('secure directory access is unavailable')
    try:
        fd = os.open(directory, flags)
        info = os.fstat(fd)
        if (
            not stat.S_ISDIR(info.st_mode)
            or info.st_uid != os.geteuid()
            or info.st_mode & 0o077
        ):
            os.close(fd)
            raise StateSafetyError('state directory is not owner-only')
        return fd
    except OSError as exc:
        raise StateSafetyError('cannot open state directory safely') from exc


def _validate_record(record: object, port: int, generation: str) -> dict:
    if not isinstance(record, dict):
        raise StateSafetyError('state is not a JSON object')
    if (
        record.get('version') != 3
        or record.get('generation') != generation
        or record.get('port') != port
        or not isinstance(record.get('secret'), str)
        or not re.fullmatch(r'[0-9a-f]{64}', record['secret'])
        or not isinstance(record.get('pidNamespaceInode'), int)
        or isinstance(record.get('pidNamespaceInode'), bool)
        or not isinstance(record.get('networkNamespaceInode'), int)
        or isinstance(record.get('networkNamespaceInode'), bool)
        or record.get('networkNamespaceInode') <= 0
    ):
        raise StateSafetyError('state identity or secret is invalid')
    for key in ('supervisor', 'child'):
        identity = record.get(key)
        if (
            not isinstance(identity, dict)
            or not isinstance(identity.get('pid'), int)
            or isinstance(identity.get('pid'), bool)
            or identity['pid'] <= 0
            or not isinstance(identity.get('starttime'), int)
            or isinstance(identity.get('starttime'), bool)
            or identity['starttime'] < 0
        ):
            raise StateSafetyError(f'{key} identity is invalid')
    process_group_id = record.get('processGroupId')
    if (
        not isinstance(process_group_id, int)
        or isinstance(process_group_id, bool)
        or process_group_id != record['child']['pid']
    ):
        raise StateSafetyError('process group identity is invalid')
    address = record.get('socketAddress')
    if not isinstance(address, str) or not address.startswith('\0'):
        raise StateSafetyError('control socket address is invalid')
    return record


def _read_state_at(directory_fd: int, name: str, port: int, generation: str) -> tuple[dict, os.stat_result]:
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    try:
        fd = os.open(name, flags, dir_fd=directory_fd)
    except OSError as exc:
        raise StateSafetyError(f'cannot open state file {name}') from exc
    try:
        info = os.fstat(fd)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.geteuid()
            or info.st_mode & 0o077
            or info.st_nlink not in (1, 2)
            or info.st_size > _MAX_STATE_BYTES
        ):
            raise StateSafetyError(f'state file {name} is not a private regular file')
        content = bytearray()
        while len(content) <= _MAX_STATE_BYTES:
            chunk = os.read(fd, min(4096, _MAX_STATE_BYTES + 1 - len(content)))
            if not chunk:
                break
            content.extend(chunk)
        if len(content) > _MAX_STATE_BYTES:
            raise StateSafetyError(f'state file {name} is too large')
        try:
            record = json.loads(content.decode('utf-8'))
        except (UnicodeError, ValueError) as exc:
            raise StateSafetyError(f'state file {name} is invalid JSON') from exc
        return _validate_record(record, port, generation), info
    finally:
        os.close(fd)


def current_generation_matches(directory: Path, expected: dict) -> bool:
    """Check that the exact published generation is still present and valid."""
    port = expected.get('port') if isinstance(expected, dict) else None
    generation = expected.get('generation') if isinstance(expected, dict) else None
    if not isinstance(port, int) or isinstance(port, bool) or not isinstance(generation, str):
        raise StateSafetyError('expected generation is missing its identity')
    name = generation_filename(port, generation)
    directory_fd = _open_state_directory(Path(directory))
    try:
        record, _info = _read_state_at(directory_fd, name, port, generation)
        return record == expected
    finally:
        os.close(directory_fd)


def publish_generation(directory: Path, record: dict, fault_injector=None) -> str:
    """Atomically expose one complete generation without replacing any record."""
    port = record.get('port') if isinstance(record, dict) else None
    generation = record.get('generation') if isinstance(record, dict) else None
    if not isinstance(port, int) or isinstance(port, bool) or not isinstance(generation, str):
        raise StateSafetyError('generation state is missing its port or generation')
    name = generation_filename(port, generation)
    _validate_record(record, port, generation)
    payload = (json.dumps(record, sort_keys=True, separators=(',', ':')) + '\n').encode('utf-8')
    if len(payload) > _MAX_STATE_BYTES:
        raise StateSafetyError('generation state is too large')
    temporary = f'{name}.tmp'
    directory_fd = _open_state_directory(directory)
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0)
        try:
            fd = os.open(temporary, flags, 0o600, dir_fd=directory_fd)
        except OSError as exc:
            raise StateSafetyError(f'cannot create generation state {temporary}') from exc
        try:
            offset = 0
            while offset < len(payload):
                if offset == 0 and _fault_enabled(fault_injector, 'state-partial-write'):
                    offset += os.write(fd, payload[: max(1, len(payload) // 2)])
                    raise OSError('injected generation publication failure at partial-write')
                offset += os.write(fd, payload[offset:])
            _fault_checkpoint(fault_injector, 'state-temp-fsync')
            os.fsync(fd)
            temporary_info = os.fstat(fd)
        finally:
            os.close(fd)
        try:
            # link() publishes atomically and fails if a generation name already exists.
            _fault_checkpoint(fault_injector, 'state-link')
            os.link(
                temporary, name,
                src_dir_fd=directory_fd,
                dst_dir_fd=directory_fd,
                follow_symlinks=False,
            )
            os.unlink(temporary, dir_fd=directory_fd)
            _fault_checkpoint(fault_injector, 'state-directory-fsync')
            os.fsync(directory_fd)
        except OSError as exc:
            try:
                current = os.stat(temporary, dir_fd=directory_fd, follow_symlinks=False)
                if current.st_dev == temporary_info.st_dev and current.st_ino == temporary_info.st_ino:
                    os.unlink(temporary, dir_fd=directory_fd)
                    os.fsync(directory_fd)
            except FileNotFoundError:
                pass
            raise StateSafetyError(f'cannot atomically publish generation {generation}') from exc
        return name
    finally:
        os.close(directory_fd)


def _generation_groups(entries: list[str]) -> dict[tuple[int, str], set[str]]:
    groups: dict[tuple[int, str], set[str]] = {}
    for name in entries:
        legacy = re.fullmatch(r'port-(\d+)\.json', name)
        if legacy:
            raise StateSafetyError(
                f'legacy fixed state {name} cannot be recovered automatically; inspect it manually'
            )
        match = re.fullmatch(r'port-(\d+)-([0-9a-f]{32})\.json(\.tmp)?', name)
        if name.startswith('port-') and not match:
            raise StateSafetyError(f'unrecognized prototype state {name}; leaving it untouched')
        if not match:
            continue
        port = int(match.group(1))
        if not 0 < port < 65536:
            raise StateSafetyError(f'invalid port in state name {name}')
        key = (port, match.group(2))
        groups.setdefault(key, set()).add(name)
    return groups


def recover_stale_generations_locked(
    directory: Path, allow_live_port: int | None = None,
) -> list[str]:
    """Reclaim stale generations while the caller holds the directory lock."""
    directory_fd = _open_state_directory(directory)
    try:
        groups = _generation_groups(os.listdir(directory_fd))
        loaded = []
        live = []
        for (port, generation), names in groups.items():
            records = []
            for name in sorted(names):
                record, info = _read_state_at(directory_fd, name, port, generation)
                records.append((name, record, info))
            if len(records) == 2:
                first, second = records
                if (
                    first[1] != second[1]
                    or first[2].st_ino != second[2].st_ino
                    or first[2].st_dev != second[2].st_dev
                ):
                    raise StateSafetyError(f'generation {generation} has conflicting state files')
            record = records[0][1]
            if record['pidNamespaceInode'] != current_pid_namespace_inode():
                raise StateSafetyError(f'generation {generation} belongs to another PID namespace')
            if record['networkNamespaceInode'] != current_network_namespace_inode():
                raise StateSafetyError(
                    f'generation {generation} belongs to another network namespace'
                )
            supervisor = record['supervisor']
            child = record['child']
            supervisor_alive = process_identity_alive(
                supervisor['pid'], supervisor['starttime'], record['pidNamespaceInode']
            )
            child_alive = process_identity_alive(
                child['pid'], child['starttime'], record['pidNamespaceInode']
            )
            descendants_alive = process_group_alive(record['processGroupId'])
            if supervisor_alive or child_alive or descendants_alive:
                live.append((port, generation))
            else:
                try:
                    remaining_listeners = _listener_inodes(port)
                except TargetUnavailable as exc:
                    raise StateSafetyError(
                        f'cannot verify whether generation {generation} still has a listener'
                    ) from exc
                if remaining_listeners:
                    raise GenerationInUse(
                        f'port {port} still has a LISTEN socket after the recorded processes exited'
                    )
                loaded.append((generation, names))
        blocking = [
            generation for port, generation in live
            if allow_live_port is None or port == allow_live_port
        ]
        if blocking:
            raise GenerationInUse(
                'live or not-yet-reaped prototype generation(s): ' + ', '.join(blocking)
            )
        removed = []
        for generation, names in loaded:
            for name in names:
                os.unlink(name, dir_fd=directory_fd)
            removed.append(generation)
        if removed:
            os.fsync(directory_fd)
        return removed
    finally:
        os.close(directory_fd)


def recover_stale_generations(directory: Path) -> list[str]:
    """Remove generations only after both recorded process identities are absent."""
    with managed_state_lock(directory):
        return recover_stale_generations_locked(directory)


def remove_current_generation(directory: Path, expected: dict, lock_held: bool = False) -> bool:
    """Supervisor-owned cleanup; never remove a replacement or another generation."""
    port = expected['port']
    generation = expected['generation']
    name = generation_filename(port, generation)
    temporary = f'{name}.tmp'
    lock_context = nullcontext() if lock_held else managed_state_lock(directory)
    with lock_context:
        directory_fd = _open_state_directory(directory)
        try:
            try:
                if current_network_namespace_inode() != expected['networkNamespaceInode']:
                    return False
            except (KeyError, StateSafetyError):
                return False
            names = [candidate for candidate in (name, temporary) if candidate in os.listdir(directory_fd)]
            if not names:
                return False
            records = [_read_state_at(directory_fd, candidate, port, generation) for candidate in names]
            if any(record != expected for record, _info in records):
                return False
            current = {
                'pid': os.getpid(),
                'starttime': read_process_starttime(os.getpid()),
            }
            if expected.get('supervisor') != current:
                return False
            child = expected['child']
            if process_identity_alive(
                child['pid'], child['starttime'], expected['pidNamespaceInode']
            ):
                return False
            if process_group_alive(expected['processGroupId']):
                return False
            try:
                if _listener_inodes(port):
                    return False
            except TargetUnavailable:
                return False
            if len(records) == 2 and (
                records[0][1].st_ino != records[1][1].st_ino
                or records[0][1].st_dev != records[1][1].st_dev
            ):
                return False
            for candidate in names:
                os.unlink(candidate, dir_fd=directory_fd)
            os.fsync(directory_fd)
            return True
        finally:
            os.close(directory_fd)
