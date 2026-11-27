"""Stable Linux process reference for a port owner.

The caller holds the reference across owner lookup and all signals.
"""
import errno
import os
import select
import signal
import sys
from typing import Callable, Optional


class TargetUnavailable(RuntimeError):
    """The process or its ownership cannot be established safely."""


def _procfs_pid1_namespace_inode() -> int:
    return os.stat('/proc/1/ns/pid').st_ino


def verify_procfs_pid_namespace() -> int:
    """Prove that /proc presents PIDs from the caller's current PID namespace.

    A procfs mount is tied to the PID namespace active when it was mounted.
    Comparing only fdinfo's numeric ``Pid`` with ``getpid()`` is insufficient:
    the same number can name different processes in two namespaces. PID 1 as
    presented by this procfs instance must belong to the caller's namespace.
    If PID 1 is absent, unreadable, or belongs elsewhere, refuse to interpret
    any procfs PID.
    """
    try:
        current_namespace = os.stat('/proc/self/ns/pid').st_ino
        procfs_namespace = _procfs_pid1_namespace_inode()
    except OSError as exc:
        raise TargetUnavailable('cannot identify the procfs PID namespace') from exc
    if procfs_namespace != current_namespace:
        raise TargetUnavailable('procfs is mounted for a different PID namespace')
    return current_namespace


class PinnedProcess:
    def __init__(self, pid: int):
        if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
            raise ValueError('invalid PID')
        if sys.platform != 'linux' or not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
            raise TargetUnavailable('Linux pidfd is unavailable')
        self.pid = pid
        try:
            self._fd = os.pidfd_open(pid, 0)
        except OSError as exc:
            raise TargetUnavailable('could not pin process') from exc
        self._verified = False

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()

    def close(self):
        if self._fd is not None:
            os.close(self._fd)
            self._fd = None

    def exited(self, timeout_ms: int = 0) -> bool:
        if self._fd is None:
            raise TargetUnavailable('process reference is closed')
        poller = select.poll()
        poller.register(self._fd, select.POLLIN)
        return bool(poller.poll(timeout_ms))

    def verify_procfs_pid(self) -> None:
        """Bind pidfd's target to the PID as interpreted by this procfs mount."""
        try:
            verify_procfs_pid_namespace()
            with open(f'/proc/self/fdinfo/{self._fd}', encoding='ascii') as info:
                values = [line.split()[1] for line in info if line.startswith('Pid:')]
            if len(values) != 1 or int(values[0]) != self.pid or self.exited():
                raise TargetUnavailable('pidfd target does not match procfs PID')
        except (OSError, ValueError, IndexError) as exc:
            raise TargetUnavailable('cannot verify pidfd target in procfs') from exc

    def verify_owner(self, lookup: Callable[[], Optional[int]]) -> None:
        """Verify ownership while the pinned process is alive, or fail closed."""
        self._verified = False
        if self.exited():
            raise TargetUnavailable('pinned process exited before owner lookup')
        try:
            owner = lookup()
        except Exception as exc:
            raise TargetUnavailable('port owner could not be determined') from exc
        if owner != self.pid or self.exited():
            raise TargetUnavailable('port owner changed or pinned process exited')
        self._verified = True

    def send(self, sig: int) -> None:
        if not self._verified or self._fd is None:
            raise TargetUnavailable('process ownership has not been verified')
        try:
            signal.pidfd_send_signal(self._fd, sig)
        except OSError as exc:
            if exc.errno != errno.ESRCH:
                raise TargetUnavailable('could not signal pinned process') from exc


def _listener_inodes(port: int) -> set[str]:
    """Read LISTEN inodes visible in this process's network namespace."""
    inodes = set()
    for table in ('/proc/net/tcp', '/proc/net/tcp6'):
        try:
            with open(table, encoding='ascii') as source:
                next(source)
                for line in source:
                    fields = line.split()
                    if fields[3] == '0A' and int(fields[1].split(':')[1], 16) == port:
                        inodes.add(fields[9])
        except (OSError, ValueError, IndexError, StopIteration) as exc:
            raise TargetUnavailable('cannot read listener table') from exc
    return inodes


def _visible_owners(inodes: set[str]) -> set[int]:
    """Find readable holders; inaccessible same-user processes make the scan uncertain."""
    owners = set()
    try:
        pids = [entry for entry in os.scandir('/proc') if entry.name.isdecimal()]
        for entry in pids:
            try:
                with os.scandir(f'/proc/{entry.name}/fd') as descriptors:
                    for descriptor in descriptors:
                        try:
                            target = os.readlink(descriptor.path)
                        except FileNotFoundError:
                            continue  # A descriptor may close during enumeration.
                        if target.startswith('socket:[') and target[8:-1] in inodes:
                            owners.add(int(entry.name))
            except FileNotFoundError:
                continue  # Process exited during enumeration.
            except PermissionError as exc:
                # Other UIDs normally have unreadable fd directories. They are
                # outside our observable owner set, not evidence about this PID.
                try:
                    with open(f'/proc/{entry.name}/status', encoding='ascii') as status:
                        uids = next(line for line in status if line.startswith('Uid:')).split()[1:]
                        if len(uids) != 4:
                            raise ValueError('invalid Uid field')
                        same_user = os.geteuid() in map(int, uids)
                except FileNotFoundError:
                    continue
                except (OSError, StopIteration, ValueError) as status_error:
                    raise TargetUnavailable('cannot identify inaccessible process') from status_error
                if same_user:
                    raise TargetUnavailable('cannot inspect a same-user process') from exc
    except OSError as exc:
        raise TargetUnavailable('cannot enumerate processes') from exc
    return owners


def observe_port(port: int) -> tuple[frozenset[str], int]:
    """Observe one listener and one visible owner, rejecting ambiguous scans.

    This does not prove visibility of processes hidden by procfs or namespaces,
    nor freeze the listener after the observation.
    """
    if sys.platform != 'linux' or not isinstance(port, int) or isinstance(port, bool) or not 0 < port < 65536:
        raise TargetUnavailable('invalid port or platform')
    before = _listener_inodes(port)
    if len(before) != 1:
        raise TargetUnavailable('expected exactly one visible listener')
    owners = _visible_owners(before)
    if _listener_inodes(port) != before or len(owners) != 1:
        raise TargetUnavailable('listener changed or owner is ambiguous')
    return frozenset(before), next(iter(owners))
