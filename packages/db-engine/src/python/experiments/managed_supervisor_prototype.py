"""Opt-in Linux supervisor prototype; excluded from supported CLI and npm packages."""
import argparse
import ctypes
import hmac
import json
import os
import signal
import socket
import socketserver
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from embedding_linux_pidfd import (
    PinnedProcess,
    TargetUnavailable,
    _listener_inodes,
    observe_port,
)
from embedding_supervisor_state import (
    StateSafetyError,
    current_network_namespace_inode,
    current_pid_namespace_inode,
    current_generation_matches,
    generation_id,
    process_network_namespace_inode,
    publish_generation,
    read_process_starttime,
    recover_stale_generations_locked,
    remove_current_generation,
)
from embedding_control_lock import embedding_lifecycle_lock, managed_state_lock

_PR_SET_PDEATHSIG = 1
_PR_GET_PDEATHSIG = 2
_CONTROL_MAX_REQUEST_BYTES = 4096
_CONTROL_REQUEST_DEADLINE_SECONDS = 0.15
_CONTROL_REQUEST_QUEUE_SIZE = 3


def _fault_call(fault_injector, method, *args, default=None):
    """Call an optional test-only hook supplied by an isolated harness."""
    if fault_injector is None:
        return default
    callback = getattr(fault_injector, method, None)
    return default if callback is None else callback(*args)


_GATE = r'''
import ctypes, json, os, signal, sys
parent_pid, parent_starttime = int(sys.argv[1]), int(sys.argv[2])
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
    os._exit(125)
if os.getppid() != parent_pid:
    os._exit(125)
try:
    with open(f"/proc/{parent_pid}/stat", encoding="ascii") as source:
        content = source.read()
    fields = content[content.rfind(")") + 1:].split()
    if int(fields[19]) != parent_starttime:
        os._exit(125)
    command = json.loads(sys.stdin.readline())
    if not isinstance(command, list) or not command or not all(isinstance(value, str) for value in command):
        os._exit(125)
    os.execv(command[0], command)
except BaseException:
    os._exit(125)
'''


def _set_parent_death_kill(
    expected_parent_pid, expected_parent_starttime, fault_injector=None,
):
    """Set SIGKILL-on-parent-death and close the fork-to-prctl race."""
    _fault_call(fault_injector, 'checkpoint', 'pdeath-before-prctl')
    libc = ctypes.CDLL(None, use_errno=True)
    result = libc.prctl(_PR_SET_PDEATHSIG, signal.SIGKILL, 0, 0, 0)
    if result != 0:
        os._exit(125)
    _fault_call(fault_injector, 'checkpoint', 'pdeath-after-prctl')
    if os.getppid() != expected_parent_pid:
        os._exit(125)
    try:
        if read_process_starttime(expected_parent_pid) != expected_parent_starttime:
            os._exit(125)
    except StateSafetyError:
        os._exit(125)


def _parent_death_signal():
    signal_number = ctypes.c_int()
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(_PR_GET_PDEATHSIG, ctypes.byref(signal_number), 0, 0, 0) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    return signal_number.value


def _set_parent_death_signal(signal_number):
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(_PR_SET_PDEATHSIG, signal_number, 0, 0, 0) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def _parent_death_guard(
    expected_parent_pid, expected_parent_starttime, fault_injector=None,
):
    """Install parent-death behavior before exec and validate again in the child."""
    _set_parent_death_kill(
        expected_parent_pid, expected_parent_starttime,
        fault_injector=fault_injector,
    )


def _readiness_is_true(port):
    request = urllib.request.Request(f'http://127.0.0.1:{port}/ready')
    try:
        with urllib.request.urlopen(request, timeout=0.5) as response:
            payload = json.loads(response.read(16 * 1024))
            return response.status == 200 and isinstance(payload, dict) and payload.get('ready') is True
    except (OSError, ValueError, urllib.error.URLError):
        return False


def observe_direct_child_listener(pid, port, network_namespace_inode):
    """Match a listener to the direct child in the supervisor's network namespace."""
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        raise TargetUnavailable('invalid direct-child PID')
    if (
        not isinstance(network_namespace_inode, int)
        or isinstance(network_namespace_inode, bool)
        or network_namespace_inode <= 0
    ):
        raise TargetUnavailable('invalid network namespace identity')
    try:
        if (
            current_network_namespace_inode() != network_namespace_inode
            or process_network_namespace_inode(pid) != network_namespace_inode
        ):
            raise TargetUnavailable('direct child belongs to another network namespace')
    except StateSafetyError as error:
        raise TargetUnavailable('cannot verify direct-child network namespace') from error
    before = _listener_inodes(port)
    if len(before) != 1:
        raise TargetUnavailable('expected exactly one visible listener')
    child_listener_inodes = set()
    try:
        with os.scandir(f'/proc/{pid}/fd') as descriptors:
            for descriptor in descriptors:
                try:
                    target = os.readlink(descriptor.path)
                except FileNotFoundError:
                    continue
                if target.startswith('socket:[') and target[8:-1] in before:
                    child_listener_inodes.add(target[8:-1])
    except OSError as error:
        raise TargetUnavailable('cannot inspect the pinned direct child') from error
    try:
        same_namespace = (
            current_network_namespace_inode() == network_namespace_inode
            and process_network_namespace_inode(pid) == network_namespace_inode
        )
    except StateSafetyError as error:
        raise TargetUnavailable('cannot recheck direct-child network namespace') from error
    if (
        _listener_inodes(port) != before
        or child_listener_inodes != before
        or not same_namespace
    ):
        raise TargetUnavailable('pinned direct child does not hold the unique listener')
    return frozenset(before), pid


class Supervisor:
    def __init__(
        self, command, port, state_directory, expected_parent_pid,
        expected_parent_starttime, startup_timeout=180, stop_timeout=5,
        gate_delay=0, state_lock_held=False, fault_injector=None,
    ):
        self.generation = generation_id()
        self.secret = os.urandom(32).hex()
        self.port = port
        self.fault_injector = fault_injector
        self.state_directory = Path(state_directory)
        self.startup_timeout = startup_timeout
        self.stop_timeout = stop_timeout
        self.expected_parent = {
            'pid': expected_parent_pid,
            'starttime': expected_parent_starttime,
        }
        self.pid_namespace_inode = current_pid_namespace_inode()
        self.network_namespace_inode = current_network_namespace_inode()
        self.supervisor_identity = {
            'pid': os.getpid(),
            'starttime': read_process_starttime(os.getpid()),
        }
        supervisor_pid = self.supervisor_identity['pid']
        supervisor_starttime = self.supervisor_identity['starttime']
        self.socket_address = (
            f'\0search-docs-embedding-{os.geteuid()}-{self.generation}'
        )
        self.force_socket_address = self.socket_address + '-force'
        self.state_record = None
        self.state_name = None
        self.reference = None
        self.lock = threading.RLock()
        self.force_transition_lock = threading.Lock()
        self.force_requested = threading.Event()
        self.stopping = False
        self.phase = 'attached'

        # The gate cannot exec the server until this supervisor has pinned its
        # process and starttime. This keeps the LISTEN owner identity stable.
        gate_command = [
            sys.executable, '-c', _GATE,
            str(os.getpid()), str(self.supervisor_identity['starttime']),
        ]
        self.child = subprocess.Popen(
            gate_command,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            preexec_fn=lambda: _parent_death_guard(
                supervisor_pid, supervisor_starttime, self.fault_injector,
            ),
        )
        try:
            self.reference = PinnedProcess(self.child.pid)
            self.reference.verify_procfs_pid()
            if os.getpgid(self.child.pid) != self.child.pid:
                raise TargetUnavailable('server child did not become its process group leader')
            child_starttime = read_process_starttime(self.child.pid)
            self.child_starttime = child_starttime
            self.state_record = {
                'version': 3,
                'generation': self.generation,
                'port': self.port,
                'secret': self.secret,
                'pidNamespaceInode': self.pid_namespace_inode,
                'networkNamespaceInode': self.network_namespace_inode,
                'supervisor': self.supervisor_identity,
                'child': {
                    'pid': self.child.pid,
                    'starttime': self.child_starttime,
                },
                'processGroupId': self.child.pid,
                'socketAddress': self.socket_address,
                'forceSocketAddress': self.force_socket_address,
            }
            # Publish the exact child identity before allowing the gate to exec
            # the server. Product CLI commands can then fail closed throughout
            # startup, and crash recovery has both PIDs to verify.
            self.state_name = publish_generation(
                self.state_directory, self.state_record,
                fault_injector=self.fault_injector,
            )
            if gate_delay:
                time.sleep(gate_delay)
            command_line = command
            if command_line[0].endswith('.py'):
                command_line = [sys.executable, *command_line]
            self.child.stdin.write(
                (json.dumps(command_line) + '\n').encode('utf-8')
            )
            self.child.stdin.close()
            self._wait_for_ready()
            self.reference.verify_owner(self._lookup_same_listener)
        except BaseException:
            self._terminate_child()
            if self.state_record is not None and self.state_name is not None:
                try:
                    remove_current_generation(
                        self.state_directory, self.state_record,
                        lock_held=state_lock_held,
                    )
                except StateSafetyError:
                    # Leave uncertain state in place for explicit recovery.
                    pass
            raise

    def _lookup_same_listener(self):
        if self.reference.exited():
            return None
        try:
            if read_process_starttime(self.child.pid) != self.child_starttime:
                return None
            _inodes, owner = observe_direct_child_listener(
                self.child.pid, self.port, self.network_namespace_inode,
            )
        except (StateSafetyError, TargetUnavailable):
            return None
        return owner if owner == self.child.pid and not self.reference.exited() else None

    def _wait_for_ready(self):
        deadline = time.monotonic() + self.startup_timeout
        while time.monotonic() < deadline:
            if self.reference.exited():
                raise TargetUnavailable('server exited before readiness')
            if _readiness_is_true(self.port):
                self.reference.verify_owner(self._lookup_same_listener)
                return
            time.sleep(0.05)
        raise TargetUnavailable('server did not become ready on the requested port')

    def verify_ready(self):
        if self.reference.exited() or not _readiness_is_true(self.port):
            return False
        try:
            self.reference.verify_owner(self._lookup_same_listener)
            return True
        except TargetUnavailable:
            return False

    def exited(self, timeout_ms=0):
        return self.reference.exited(timeout_ms)

    def send(self, sig):
        with self.lock:
            if not self.exited():
                self.reference.send(sig)

    def _detach_parent_matches(self, peer_pid, peer_uid):
        if peer_pid != self.expected_parent['pid'] or peer_uid != os.geteuid():
            return False
        if os.getppid() != self.expected_parent['pid']:
            return False
        try:
            return read_process_starttime(
                self.expected_parent['pid']
            ) == self.expected_parent['starttime']
        except StateSafetyError:
            return False

    def _detach(self, peer_pid, peer_uid):
        if self.force_requested.is_set():
            return {
                'accepted': False,
                'outcome': (
                    'transferred-unconfirmed'
                    if self.phase in ('transfer-unconfirmed', 'transfer-unknown')
                    else 'not-transferred'
                ),
                'phase': self.phase,
                'generation': self.generation,
                'supervisor': self.supervisor_identity,
                'child': self.state_record['child'],
                'reason': 'force was requested during ownership transfer',
            }
        if self.phase != 'attached' or self.stopping:
            outcome = (
                'unknown'
                if self.phase == 'transfer-unknown'
                else 'transferred-unconfirmed'
                if self.phase == 'transfer-unconfirmed'
                else 'already-transferred'
                if self.phase == 'detached'
                else 'not-transferred'
            )
            return {
                'accepted': False,
                'outcome': outcome,
                'phase': self.phase,
                'generation': self.generation,
                'supervisor': self.supervisor_identity,
                'child': self.state_record['child'],
                'reason': 'ownership is no longer attached',
            }
        if not self._detach_parent_matches(peer_pid, peer_uid):
            return {
                'accepted': False,
                'outcome': 'not-transferred',
                'phase': self.phase,
                'generation': self.generation,
                'supervisor': self.supervisor_identity,
                'child': self.state_record['child'],
                'reason': 'request is not from the live starting CLI',
            }
        guard_cleared = False
        try:
            with managed_state_lock(self.state_directory):
                if not self._detach_parent_matches(peer_pid, peer_uid):
                    return {
                        'accepted': False,
                        'outcome': 'not-transferred',
                        'phase': self.phase,
                        'generation': self.generation,
                        'supervisor': self.supervisor_identity,
                        'child': self.state_record['child'],
                        'reason': 'starting CLI identity changed',
                    }
                if _parent_death_signal() != signal.SIGKILL:
                    return {
                        'accepted': False,
                        'outcome': 'not-transferred',
                        'phase': self.phase,
                        'generation': self.generation,
                        'supervisor': self.supervisor_identity,
                        'child': self.state_record['child'],
                        'reason': 'supervisor parent-death guard is unverified',
                    }
                if not current_generation_matches(self.state_directory, self.state_record):
                    return {
                        'accepted': False,
                        'outcome': 'not-transferred',
                        'phase': self.phase,
                        'generation': self.generation,
                        'supervisor': self.supervisor_identity,
                        'child': self.state_record['child'],
                        'reason': 'published generation state changed',
                    }
                if _fault_call(
                    self.fault_injector, 'enabled', 'detach-readiness-barrier',
                    default=False,
                ):
                    _fault_call(
                        self.fault_injector, 'checkpoint', 'detach-during-readiness',
                    )
                    _fault_call(
                        self.fault_injector, 'mark',
                        'detach-pdeath-during-readiness',
                        str(_parent_death_signal()),
                    )
                if self.force_requested.is_set():
                    return {
                        'accepted': False,
                        'outcome': 'not-transferred',
                        'phase': self.phase,
                        'generation': self.generation,
                        'supervisor': self.supervisor_identity,
                        'child': self.state_record['child'],
                        'reason': 'force was requested before readiness confirmation',
                    }
                if self.reference.exited() or not self.verify_ready():
                    return {
                        'accepted': False,
                        'outcome': 'not-transferred',
                        'phase': self.phase,
                        'generation': self.generation,
                        'supervisor': self.supervisor_identity,
                        'child': self.state_record['child'],
                        'reason': 'pinned server is no longer ready',
                    }
                _fault_call(
                    self.fault_injector, 'checkpoint', 'detach-before-clear',
                )
                if _fault_call(
                    self.fault_injector, 'enabled', 'detach-clear-failure',
                    default=False,
                ):
                    return {
                        'accepted': False,
                        'outcome': 'not-transferred',
                        'phase': self.phase,
                        'generation': self.generation,
                        'supervisor': self.supervisor_identity,
                        'child': self.state_record['child'],
                        'reason': 'injected parent-death guard clear failure',
                    }
                with self.force_transition_lock:
                    if self.force_requested.is_set():
                        return {
                            'accepted': False,
                            'outcome': 'not-transferred',
                            'phase': self.phase,
                            'generation': self.generation,
                            'supervisor': self.supervisor_identity,
                            'child': self.state_record['child'],
                            'reason': 'force was requested before ownership commit',
                        }
                    _set_parent_death_signal(0)
                    guard_cleared = True
                    self.phase = 'transfer-unconfirmed'
                _fault_call(
                    self.fault_injector, 'checkpoint',
                    'detach-after-clear-before-ack',
                )
                _fault_call(
                    self.fault_injector, 'mark',
                    'detach-pdeath-after-clear-before-ack',
                    str(_parent_death_signal()),
                )
                if self.force_requested.is_set():
                    return {
                        'accepted': False,
                        'outcome': 'transferred-unconfirmed',
                        'phase': self.phase,
                        'generation': self.generation,
                        'supervisor': self.supervisor_identity,
                        'child': self.state_record['child'],
                        'reason': 'force stopped the child before ownership ACK',
                    }
                if _fault_call(
                    self.fault_injector, 'enabled',
                    'detach-after-clear-failure', default=False,
                ):
                    raise OSError('injected post-clear confirmation failure')
                if _fault_call(
                    self.fault_injector, 'enabled', 'detach-report-unknown',
                    default=False,
                ):
                    self.phase = 'transfer-unknown'
                    return {
                        'accepted': False,
                        'outcome': 'unknown',
                        'phase': self.phase,
                        'generation': self.generation,
                        'supervisor': self.supervisor_identity,
                        'child': self.state_record['child'],
                        'reason': 'injected contradictory parent-death guard observation',
                    }
                with self.force_transition_lock:
                    if self.force_requested.is_set():
                        return {
                            'accepted': False,
                            'outcome': 'transferred-unconfirmed',
                            'phase': self.phase,
                            'generation': self.generation,
                            'supervisor': self.supervisor_identity,
                            'child': self.state_record['child'],
                            'reason': 'force arrived before ownership ACK',
                        }
                    if _parent_death_signal() != 0:
                        self.phase = 'transfer-unknown'
                        return {
                            'accepted': False,
                            'outcome': 'unknown',
                            'phase': self.phase,
                            'generation': self.generation,
                            'supervisor': self.supervisor_identity,
                            'child': self.state_record['child'],
                            'reason': 'parent-death guard clear could not be confirmed',
                        }
                    self.phase = 'detached'
                return {
                    'accepted': True,
                    'outcome': 'transferred',
                    'event': 'OWNERSHIP_ACK',
                    'phase': self.phase,
                    'generation': self.generation,
                    'supervisor': self.supervisor_identity,
                    'child': self.state_record['child'],
                }
        except Exception as error:
            self.phase = 'transfer-unconfirmed' if guard_cleared else 'attached'
            return {
                'accepted': False,
                'outcome': (
                    'transferred-unconfirmed' if guard_cleared else 'not-transferred'
                ),
                'phase': self.phase,
                'generation': self.generation,
                'supervisor': self.supervisor_identity,
                'child': self.state_record['child'],
                'reason': 'ownership transfer needs reconciliation',
                'detail': type(error).__name__,
            }

    def force_request(self, request, peer_uid=None):
        """Kill only the verified direct child through the independent fast path."""
        if not isinstance(request, dict) or request.get('action') != 'force':
            return {'accepted': False, 'outcome': 'not-a-force-request'}
        supplied = request.get('secret')
        if not isinstance(supplied, str) or not hmac.compare_digest(supplied, self.secret):
            return {'accepted': False, 'outcome': 'unauthorized'}
        if request.get('generation') != self.generation or peer_uid != os.geteuid():
            return {'accepted': False, 'outcome': 'wrong-generation-or-user'}
        with self.force_transition_lock:
            self.force_requested.set()
            self.stopping = True
            self.phase = 'stopping'
            try:
                if not self.reference.exited():
                    self.reference.send(signal.SIGKILL)
            except TargetUnavailable:
                return {
                    'accepted': False,
                    'outcome': 'unknown',
                    'generation': self.generation,
                    'supervisor': self.supervisor_identity,
                    'child': self.state_record['child'],
                }
            return {
                'accepted': True,
                'outcome': 'signal-sent-or-child-exited',
                'event': 'FORCE_SENT',
                'generation': self.generation,
                'supervisor': self.supervisor_identity,
                'child': self.state_record['child'],
            }

    def request(self, request, peer_pid=None, peer_uid=None):
        if not isinstance(request, dict):
            return {'accepted': False}
        supplied = request.get('secret')
        generation = request.get('generation')
        action = request.get('action')
        if not isinstance(supplied, str) or not hmac.compare_digest(supplied, self.secret):
            return {'accepted': False}
        if generation != self.generation:
            return {'accepted': False}
        if action == 'verify-ready':
            return {
                'accepted': self.verify_ready(),
                'phase': self.phase,
                'generation': self.generation,
                'supervisor': self.supervisor_identity,
                'child': self.state_record['child'],
            }
        if action == 'status':
            return {
                'accepted': True,
                'phase': self.phase,
                'parentDeathSignal': _parent_death_signal(),
                'generation': self.generation,
                'supervisor': self.supervisor_identity,
                'child': self.state_record['child'],
            }
        if action == 'detach':
            with self.lock:
                return self._detach(peer_pid, peer_uid)
        if action == 'force':
            return self.force_request(request, peer_uid=peer_uid)
        if action != 'stop':
            return {'accepted': False}
        with self.force_transition_lock:
            if self.force_requested.is_set():
                return {'accepted': False, 'reason': 'stop is already in progress'}
            if self.stopping:
                return {'accepted': False, 'reason': 'stop is already in progress'}
            self.stopping = True
            self.phase = 'stopping'
            try:
                if not self.reference.exited():
                    self.reference.send(signal.SIGTERM)
            except TargetUnavailable:
                # The held pidfd can only report that this exact child exited;
                # the main loop will observe that and perform generation cleanup.
                pass

        def graceful():
            if not self.exited(int(self.stop_timeout * 1000)):
                # Do not hold the arbitration lock while waiting out the grace
                # period. Force can take it immediately and signal this same
                # pidfd; the timeout path is serialized only around its signal.
                with self.force_transition_lock:
                    try:
                        if not self.reference.exited():
                            try:
                                _fault_call(
                                    self.fault_injector, 'mark',
                                    'stop-timeout-force',
                                    'timeout SIGKILL path used\n',
                                )
                            except OSError:
                                # Test observation must never suppress the
                                # safety timeout's SIGKILL.
                                pass
                            self.reference.send(signal.SIGKILL)
                    except TargetUnavailable:
                        pass

        threading.Thread(target=graceful, daemon=True).start()
        return {
            'accepted': True,
            'phase': self.phase,
            'generation': self.generation,
            'supervisor': self.supervisor_identity,
            'child': self.state_record['child'],
        }

    def _terminate_child(self):
        if self.reference is not None:
            try:
                if not self.reference.exited():
                    self.reference.send(signal.SIGKILL)
            except TargetUnavailable:
                if self.child.poll() is None:
                    # This is still the unreaped direct child returned by
                    # Popen, so its PID cannot have been reused. This fallback
                    # is only for setup cleanup before owner verification; all
                    # managed stop/force signals use the pinned pidfd.
                    self.child.kill()
        if self.child.poll() is None:
            if self.reference is None:
                # Popen still owns this direct child and has not reaped it, so
                # its PID cannot have been recycled. Do not use this fallback
                # once a pidfd reference exists.
                self.child.kill()
            try:
                self.child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                raise StateSafetyError(
                    'the pinned child did not exit after SIGKILL; generation state is preserved'
                )
        if self.reference is not None:
            self.reference.close()
            self.reference = None

    def close(self):
        self._terminate_child()
        if self.state_record is not None:
            remove_current_generation(self.state_directory, self.state_record)


def _peer_credentials(connection):
    if not hasattr(socket, 'SO_PEERCRED'):
        return None
    try:
        credentials = connection.getsockopt(
            socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i'),
        )
        if len(credentials) != struct.calcsize('3i'):
            return None
        return struct.unpack('3i', credentials)
    except OSError:
        return None


def _read_bounded_request_line(connection):
    """Read one small line under a single absolute deadline."""
    deadline = time.monotonic() + _CONTROL_REQUEST_DEADLINE_SECONDS
    data = bytearray()
    while len(data) <= _CONTROL_MAX_REQUEST_BYTES:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return None
        connection.settimeout(remaining)
        try:
            chunk = connection.recv(
                min(1024, _CONTROL_MAX_REQUEST_BYTES + 1 - len(data)),
            )
        except OSError:
            return None
        if not chunk:
            return None
        data.extend(chunk)
        newline = data.find(b'\n')
        if newline >= 0:
            if newline != len(data) - 1 or len(data) > _CONTROL_MAX_REQUEST_BYTES:
                return None
            return bytes(data)
    return None


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        try:
            credentials = _peer_credentials(self.request)
            if credentials is None:
                return
            peer_pid, peer_uid, _peer_gid = credentials
            if peer_uid != os.geteuid():
                return
            raw = _read_bounded_request_line(self.request)
            if raw is None:
                return
            request = json.loads(raw)
            response = self.server.supervisor.request(
                request, peer_pid=peer_pid, peer_uid=peer_uid,
            )
            if not isinstance(response, dict):
                response = {'accepted': bool(response)}
            action = request.get('action') if isinstance(request, dict) else None
            if _fault_call(
                self.server.supervisor.fault_injector,
                'drop_response', 'control', action, response,
                default=False,
            ):
                return
            self.wfile.write(json.dumps(response).encode() + b'\n')
        except (OSError, ValueError):
            return


class Server(socketserver.UnixStreamServer):
    """Run PR_GET/SET_PDEATHSIG control on the main thread that armed it."""

    request_queue_size = _CONTROL_REQUEST_QUEUE_SIZE


class ForceHandler(socketserver.StreamRequestHandler):
    """Handle force on another thread; this path never calls PR_GET/SET_PDEATHSIG."""

    def handle(self):
        try:
            credentials = _peer_credentials(self.request)
            if credentials is None:
                return
            _peer_pid, peer_uid, _peer_gid = credentials
            if peer_uid != os.geteuid():
                return
            raw = _read_bounded_request_line(self.request)
            if raw is None:
                return
            response = self.server.supervisor.force_request(
                json.loads(raw), peer_uid=peer_uid,
            )
            if _fault_call(
                self.server.supervisor.fault_injector,
                'drop_response', 'force', 'force', response,
                default=False,
            ):
                return
            self.wfile.write(json.dumps(response).encode() + b'\n')
        except (OSError, ValueError):
            return


class ForceServer(socketserver.UnixStreamServer):
    """Dedicated socket for the fast pidfd force path."""

    request_queue_size = _CONTROL_REQUEST_QUEUE_SIZE


def _serve_force_requests(server, stopping, supervisor):
    while not stopping.is_set() and not supervisor.exited():
        server.handle_request()


def control(socket_address, generation, secret, action, timeout=5):
    response = control_response(
        socket_address, generation, secret, action, timeout=timeout,
    )
    return response.get('accepted') is True


def control_response(socket_address, generation, secret, action, timeout=5):
    if action == 'force' and not socket_address.endswith('-force'):
        socket_address += '-force'
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(timeout)
        client.connect(socket_address)
        client.sendall(json.dumps({
            'generation': generation, 'secret': secret, 'action': action,
        }).encode() + b'\n')
        response = json.loads(client.makefile('rb').readline())
        if not isinstance(response, dict):
            raise ValueError('invalid supervisor control response')
        return response


def _parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument('--state-dir', required=True)
    parser.add_argument('--port', required=True, type=int)
    parser.add_argument('--parent-pid', required=True, type=int)
    parser.add_argument('--parent-starttime', required=True, type=int)
    parser.add_argument('--startup-timeout', type=int, default=180)
    parser.add_argument('--gate-delay', type=float, default=0)
    args, remainder = parser.parse_known_args()
    if not remainder or remainder[0] != '--' or len(remainder) == 1:
        parser.error('expected -- followed by the embedding server command')
    if not 0 < args.port < 65536:
        parser.error('port must be between 1 and 65535')
    if args.startup_timeout < 1:
        parser.error('startup timeout must be positive')
    if args.gate_delay < 0:
        parser.error('gate delay cannot be negative')
    return args, remainder[1:]


def main(fault_injector=None):
    if not sys.platform.startswith('linux'):
        raise RuntimeError('supervisor prototype requires Linux')
    args, command = _parse_args()
    expected_state_directory = Path.home() / '.search-docs' / 'managed-embedding-prototype'
    if os.path.abspath(args.state_dir) != os.path.abspath(expected_state_directory):
        raise RuntimeError(
            'supervisor prototype state must use ~/.search-docs/managed-embedding-prototype '
            'so the supported CLI can quarantine it'
        )
    _set_parent_death_kill(args.parent_pid, args.parent_starttime)
    with embedding_lifecycle_lock():
        with managed_state_lock(Path(args.state_dir)):
            recover_stale_generations_locked(Path(args.state_dir), allow_live_port=args.port)
            supervisor = Supervisor(
                command, args.port, args.state_dir,
                args.parent_pid, args.parent_starttime,
                startup_timeout=args.startup_timeout,
                gate_delay=args.gate_delay,
                state_lock_held=True,
                fault_injector=fault_injector,
            )
    try:
        # Startup force is not part of this prototype's contract: the
        # supervisor constructor has already confirmed readiness and ownership.
        # Once these endpoints are live, the separate force endpoint can still
        # interrupt the normal-stop grace period for this same pinned child.
        with ForceServer(supervisor.force_socket_address, ForceHandler) as force_server:
            force_server.supervisor = supervisor
            force_server.timeout = 0.1
            force_stopping = threading.Event()
            force_thread = threading.Thread(
                target=_serve_force_requests,
                args=(force_server, force_stopping, supervisor),
                name='embedding-force-control',
                daemon=True,
            )
            force_thread.start()
            try:
                with Server(supervisor.socket_address, Handler) as server:
                    server.supervisor = supervisor
                    server.timeout = 0.1
                    if not supervisor.verify_ready():
                        raise TargetUnavailable('supervisor could not confirm its ready child')
                    print(json.dumps({
                        'event': 'READY_PENDING',
                        'phase': supervisor.phase,
                        'generation': supervisor.generation,
                        'supervisor': supervisor.supervisor_identity,
                        'child': supervisor.state_record['child'],
                        'port': supervisor.port,
                        'stateName': supervisor.state_name,
                    }), flush=True)
                    while not supervisor.exited():
                        server.handle_request()
            finally:
                force_stopping.set()
                force_thread.join(timeout=3)
                if force_thread.is_alive():
                    raise RuntimeError('force control handler did not stop; preserving generation state')
    finally:
        supervisor.close()


if __name__ == '__main__':
    main()
