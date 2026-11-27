"""Linux-only tests for the isolated, unpublished supervisor prototype."""
import ctypes
import errno
import json
import os
import pathlib
import select
import selectors
import signal
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid
from contextlib import contextmanager
from unittest.mock import patch

PYTHON_DIR = pathlib.Path(__file__).resolve().parents[1]
TESTS = PYTHON_DIR / 'tests'
EXPERIMENTS = PYTHON_DIR / 'experiments'
SCRIPT = TESTS / 'embedding_supervisor_test_launcher.py'
RUNTIME_SCRIPT = EXPERIMENTS / 'managed_supervisor_prototype.py'
REPO_ROOT = PYTHON_DIR.parents[3]
EXPERIMENTAL_CLI = REPO_ROOT / 'packages' / 'cli' / 'scripts' / 'issue168-experimental-supervisor-cli.py'
sys.path.insert(0, str(PYTHON_DIR))
sys.path.insert(0, str(EXPERIMENTS))
from embedding_linux_pidfd import (  # noqa: E402
    PinnedProcess,
    TargetUnavailable,
    _listener_inodes,
    observe_port,
)
from embedding_supervisor_state import (  # noqa: E402
    GenerationInUse,
    StateSafetyError,
    current_network_namespace_inode,
    current_pid_namespace_inode,
    generation_id,
    process_identity_alive,
    process_group_alive,
    publish_generation,
    read_process_starttime,
    recover_stale_generations,
    remove_current_generation,
)
from managed_supervisor_prototype import (  # noqa: E402
    control,
    control_response,
    observe_direct_child_listener,
)


class FaultInjectionBoundaryTest(unittest.TestCase):
    def test_candidate_runtime_modules_do_not_read_test_environment(self):
        candidates = (
            EXPERIMENTS / 'embedding_control_lock.py',
            EXPERIMENTS / 'embedding_supervisor_state.py',
            EXPERIMENTS / 'managed_supervisor_prototype.py',
        )
        for candidate in candidates:
            with self.subTest(candidate=candidate.name):
                self.assertNotIn(
                    'SEARCH_DOCS_TEST_',
                    candidate.read_text(encoding='utf-8'),
                )


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def isolated_state_dir(home):
    directory = pathlib.Path(home) / '.search-docs' / 'managed-embedding-prototype'
    directory.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    return directory


def supervisor_env(state_dir):
    home = pathlib.Path(state_dir).parent.parent
    return dict(os.environ, HOME=str(home), USERPROFILE=str(home))


def direct_children(pid):
    children = set()
    for task in pathlib.Path(f'/proc/{pid}/task').glob('*/children'):
        try:
            children.update(map(int, task.read_text().split()))
        except FileNotFoundError:
            continue
    return children


def reap_if_child(pid):
    try:
        os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        pass


@contextmanager
def adopt_orphaned_test_processes():
    """Make exact test descendants reapable after their supervisor exits."""
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    try:
        yield
    finally:
        if libc.prctl(36, 0, 0, 0, 0) != 0:
            error = ctypes.get_errno()
            raise OSError(error, os.strerror(error))


def launch_supervisor(state_dir, command, port, timeout=20, extra_env=None):
    parent_pid = os.getpid()
    parent_starttime = read_process_starttime(parent_pid)
    env = supervisor_env(state_dir)
    if extra_env:
        env.update(extra_env)
    process = subprocess.Popen(
        [
            sys.executable, str(SCRIPT),
            '--state-dir', str(state_dir),
            '--port', str(port),
            '--parent-pid', str(parent_pid),
            '--parent-starttime', str(parent_starttime),
            '--startup-timeout', str(timeout),
            '--', *map(str, command),
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )
    with selectors.DefaultSelector() as selector:
        selector.register(process.stdout, selectors.EVENT_READ)
        if not selector.select(timeout + 2):
            process.kill()
            process.wait(timeout=5)
            raise RuntimeError('supervisor readiness timed out')
    line = process.stdout.readline()
    if not line:
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        raise RuntimeError(f'supervisor failed to become ready: {process.stderr.read()}')
    ready = json.loads(line)
    if ready.get('port') != port:
        raise RuntimeError('supervisor returned the wrong port')
    state_path = pathlib.Path(state_dir) / ready['stateName']
    state = json.loads(state_path.read_text())
    with PinnedProcess(process.pid) as pinned:
        pinned.verify_procfs_pid()
        if (
            ready['supervisor']['pid'] != process.pid
            or ready['supervisor']['starttime'] != read_process_starttime(process.pid)
            or not process_identity_alive(
                process.pid, ready['supervisor']['starttime'], state['pidNamespaceInode'],
            )
        ):
            raise RuntimeError('ready message is not bound to the spawned supervisor')
    if (
        state['generation'] != ready['generation']
        or state['supervisor'] != ready['supervisor']
        or state['child'] != ready['child']
        or state['pidNamespaceInode'] != current_pid_namespace_inode()
        or state['networkNamespaceInode'] != current_network_namespace_inode()
    ):
        raise RuntimeError('published state does not match the ready generation')
    return process, ready, state, state_path


def mini_server_command(port, ready_off_file=None, ignore_sigterm=True):
    source = f'''
import json, signal, sys
from pathlib import Path
ready_off_file = {str(ready_off_file)!r}
if {ignore_sigterm!r}:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
from http.server import BaseHTTPRequestHandler, HTTPServer
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        ready = not ready_off_file or not Path(ready_off_file).exists()
        body = json.dumps({{"ready": ready}}).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(body)))
        self.end_headers(); self.wfile.write(body)
    def log_message(self, *_args): pass
HTTPServer(("0.0.0.0", int(sys.argv[1])), Handler).serve_forever()
'''
    return [sys.executable, '-u', '-c', source, str(port)]


def write_detach_cli(directory):
    """Create a test-only CLI parent that distinguishes provisional READY from ACK."""
    script = pathlib.Path(directory) / 'detach-test-cli.py'
    script.write_text(r'''
import json, os, pathlib, socket, subprocess, sys, time
sys.path.insert(0, sys.argv[1])
sys.path.insert(0, sys.argv[2])
from embedding_supervisor_state import (
    current_pid_namespace_inode,
    read_process_starttime,
)
from managed_supervisor_prototype import control, control_response

state_dir = pathlib.Path(sys.argv[3])
port = int(sys.argv[4])
server_command = json.loads(sys.argv[5])
mode = sys.argv[6]
barrier_dir = pathlib.Path(os.environ['SEARCH_DOCS_TEST_DETACH_BARRIER_DIR']) if os.environ.get('SEARCH_DOCS_TEST_DETACH_BARRIER_DIR') else None
parent_pid = os.getpid()
parent_starttime = read_process_starttime(parent_pid)
env = dict(os.environ, HOME=str(state_dir.parent.parent), USERPROFILE=str(state_dir.parent.parent))
supervisor = subprocess.Popen(
    [
        sys.executable, sys.argv[7],
        '--state-dir', str(state_dir),
        '--port', str(port),
        '--parent-pid', str(parent_pid),
        '--parent-starttime', str(parent_starttime),
        '--startup-timeout', '10',
        '--', *server_command,
    ],
    stdin=subprocess.DEVNULL,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    env=env,
)
line = supervisor.stdout.readline()
if not line:
    raise SystemExit('supervisor did not send provisional READY')
pending = json.loads(line)
if pending.get('event') != 'READY_PENDING' or pending.get('phase') != 'attached':
    raise SystemExit('supervisor READY was not marked provisional')
state_path = state_dir / pending['stateName']
state_bytes = state_path.read_bytes()
state = json.loads(state_bytes)
if (
    pending.get('generation') != state.get('generation')
    or pending.get('supervisor') != state.get('supervisor')
    or pending.get('child') != state.get('child')
    or pending['supervisor']['pid'] != supervisor.pid
    or pending['supervisor']['starttime'] != read_process_starttime(supervisor.pid)
    or state['pidNamespaceInode'] != current_pid_namespace_inode()
    or state['child']['starttime'] != read_process_starttime(state['child']['pid'])
    or not control(
        state['socketAddress'], state['generation'], state['secret'], 'verify-ready',
    )
):
    raise SystemExit('provisional READY did not match the live state and pinned owner')
print(json.dumps({'event': 'READY_PENDING', 'stateName': pending['stateName']}), flush=True)
if mode == 'pending-exit':
    raise SystemExit(0)
if mode not in ('detach', 'drop-ack', 'recover-clear-failure'):
    raise SystemExit('unknown test mode')

recovered_after_lost_ack = False
if mode == 'drop-ack':
    with socket.socket(socket.AF_UNIX) as request_socket:
        request_socket.settimeout(10)
        request_socket.connect(state['socketAddress'])
        request_socket.sendall(json.dumps({
            'generation': state['generation'],
            'secret': state['secret'],
            'action': 'detach',
        }).encode() + b'\n')
        if barrier_dir is None:
            raise SystemExit('drop-ack mode requires a detach test barrier')
        marker = barrier_dir / 'after-clear-before-ack.entered'
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and not marker.exists():
            time.sleep(0.01)
        if not marker.exists():
            raise SystemExit('supervisor did not reach the post-clear ACK boundary')
        request_socket.close()
    print(json.dumps({'event': 'ACK_DROPPED', 'generation': state['generation']}), flush=True)
    release = barrier_dir / 'after-clear-before-ack.release'
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and not release.exists():
        time.sleep(0.01)
    if not release.exists():
        raise SystemExit('test did not release the supervisor after dropping ACK')
    recovered_after_lost_ack = True
else:
    ack = control_response(
        state['socketAddress'], state['generation'], state['secret'], 'detach',
    )
    if ack.get('accepted') and ack.get('event') == 'OWNERSHIP_ACK':
        if (
            ack.get('outcome') != 'transferred'
            or ack.get('generation') != state['generation']
            or ack.get('supervisor') != state['supervisor']
            or ack.get('child') != state['child']
        ):
            raise SystemExit(f'ownership ACK did not match its READY generation: {ack!r}')
    elif (
        mode == 'recover-clear-failure'
        and ack.get('accepted') is False
        and ack.get('outcome') == 'transferred-unconfirmed'
        and ack.get('phase') == 'transfer-unconfirmed'
        and ack.get('generation') == state['generation']
        and ack.get('supervisor') == state['supervisor']
        and ack.get('child') == state['child']
    ):
        recovered_after_lost_ack = True
        print(json.dumps({
            'event': 'TRANSFER_UNCONFIRMED',
            'outcome': ack['outcome'],
            'phase': ack['phase'],
            'generation': ack['generation'],
            'supervisor': ack['supervisor'],
            'child': ack['child'],
        }), flush=True)
    else:
        raise SystemExit(f'supervisor did not confirm ownership transfer: {ack!r}')
status = control_response(
    state['socketAddress'], state['generation'], state['secret'], 'status',
)
ready = control_response(
    state['socketAddress'], state['generation'], state['secret'], 'verify-ready',
)
if (
    state_path.read_bytes() != state_bytes
    or status.get('phase') not in ('detached', 'transfer-unconfirmed')
    or status.get('parentDeathSignal') != 0
    or status.get('generation') != state['generation']
    or status.get('supervisor') != state['supervisor']
    or status.get('child') != state['child']
    or not ready.get('accepted')
    or ready.get('generation') != state['generation']
    or ready.get('supervisor') != state['supervisor']
    or ready.get('child') != state['child']
    or state['supervisor']['starttime'] != read_process_starttime(state['supervisor']['pid'])
    or state['child']['starttime'] != read_process_starttime(state['child']['pid'])
):
    raise SystemExit('ownership transfer failed same-generation state/readiness reconciliation')
print(json.dumps({
    'event': 'START_CONFIRMED',
    'generation': state['generation'],
    'recoveredAfterLostAck': recovered_after_lost_ack,
}), flush=True)
''', encoding='utf-8')
    return script


def launch_detach_cli(
    script, state_dir, command, port, mode='detach', env=None,
    supervisor_script=SCRIPT,
):
    child_env = supervisor_env(state_dir)
    if env:
        child_env.update(env)
    return subprocess.Popen(
        [
            sys.executable, str(script),
            str(EXPERIMENTS), str(PYTHON_DIR), str(state_dir), str(port),
            json.dumps(list(map(str, command))), mode, str(supervisor_script),
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=child_env,
    )


_PTRACE_PARENT_HELPER = r'''
import ctypes
import errno
import json
import os
import signal
import struct
import sys
import time

TRACEME = 0
SYSCALL = 24
SETOPTIONS = 0x4200
GET_SYSCALL_INFO = 0x420e
TRACESYSGOOD = 1
SYSCALL_INFO_ENTRY = 1
SYSCALL_INFO_EXIT = 2
PR_SET_PDEATHSIG = 1
PTRACE_SYSCALL_STOP = signal.SIGTRAP | 0x80
PRCTL_NUMBERS = {'x86_64': 157, 'amd64': 157, 'aarch64': 167, 'arm64': 167,
                 'riscv64': 167, 'i386': 172, 'i686': 172, 'armv7l': 172}

libc = ctypes.CDLL(None, use_errno=True)
libc.ptrace.restype = ctypes.c_long
libc.ptrace.argtypes = (
    ctypes.c_uint, ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p,
)

def ptrace(request, pid=0, address=0, data=0):
    operation = {
        TRACEME: 'PTRACE_TRACEME',
        SETOPTIONS: 'PTRACE_SETOPTIONS',
        SYSCALL: 'PTRACE_SYSCALL',
        GET_SYSCALL_INFO: 'PTRACE_GET_SYSCALL_INFO',
        8: 'PTRACE_KILL',
    }.get(request)
    if operation in failure_plan:
        error_number = failure_plan[operation]
        raise OSError(
            error_number,
            f'injected {operation} failure: {errno.errorcode[error_number]}',
        )
    result = libc.ptrace(
        request, pid, ctypes.c_void_p(address), ctypes.c_void_p(data),
    )
    if result == -1:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    return result

real_waitpid = os.waitpid
waitpid_failure_injected = False
def waitpid(pid, options):
    global waitpid_failure_injected
    if 'WAITPID' in failure_plan and not waitpid_failure_injected:
        waitpid_failure_injected = True
        error_number = failure_plan['WAITPID']
        raise OSError(
            error_number,
            f'injected waitpid failure: {errno.errorcode[error_number]}',
        )
    return real_waitpid(pid, options)

def starttime(pid):
    text = open(f'/proc/{pid}/stat', encoding='ascii').read()
    return int(text[text.rfind(')') + 1:].split()[19])

def write_json(path, value):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(descriptor, json.dumps(value).encode())
    finally:
        os.close(descriptor)

runtime, state_dir, port, identity_path, barrier_path, stage = sys.argv[1:7]
server_command = json.loads(sys.argv[7])
injected_failure = sys.argv[8] if len(sys.argv) > 8 else ''
failure_plan = {}
for failure in injected_failure.split(','):
    if failure:
        operation, error_name = failure.split(':', 1)
        failure_plan[operation.upper()] = getattr(errno, error_name)
parent_pid = os.getpid()
parent_starttime = starttime(parent_pid)
error_read_fd, error_write_fd = os.pipe2(os.O_CLOEXEC)
child = os.fork()
if child == 0:
    os.close(error_read_fd)
    tracing_started = False
    try:
        ptrace(TRACEME)
        tracing_started = True
        arguments = [
            sys.executable, runtime,
            '--state-dir', state_dir,
            '--port', port,
            '--parent-pid', str(parent_pid),
            '--parent-starttime', str(parent_starttime),
            '--startup-timeout', '5',
            '--', *server_command,
        ]
        os.execve(sys.executable, arguments, os.environ.copy())
    except OSError as error:
        failure_kind = 'exec' if tracing_started else 'ptrace-traceme'
        os.write(error_write_fd, json.dumps({
            'kind': failure_kind,
            'errno': error.errno,
            'message': str(error),
        }).encode())
        os._exit(121)
    except BaseException as error:
        os.write(error_write_fd, json.dumps({
            'kind': 'launcher',
            'message': str(error),
        }).encode())
        os._exit(121)

os.close(error_write_fd)
try:
    tracee_pidfd = os.pidfd_open(child)
except OSError:
    # This setup-only fallback runs before the direct child has been waited
    # for, so its PID cannot have been reused.
    try:
        os.kill(child, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        os.waitpid(child, 0)
    except ChildProcessError:
        pass
    raise
os.waitpid = waitpid
write_json(identity_path, {'pid': child, 'starttime': starttime(child)})

def wait_status_details(status):
    if os.WIFEXITED(status):
        return {'exitCode': os.WEXITSTATUS(status)}
    if os.WIFSIGNALED(status):
        return {'signal': os.WTERMSIG(status)}
    return {'waitStatus': status}

def skip_reason_for(operation, error_number):
    # These operation/errno pairs identify known environment limitations:
    # TRACEME can be denied by ptrace policy; an unknown GET_SYSCALL_INFO
    # request is EIO on kernels predating that ptrace operation.
    known_unavailable = {
        'PTRACE_TRACEME': {errno.EPERM},
        'PTRACE_GET_SYSCALL_INFO': {errno.EIO},
    }
    if error_number in known_unavailable.get(operation, set()):
        return f'{operation} is unavailable in this environment (errno={error_number})'
    return None

def fail(message, kill_tracee=False, tracee_reaped=False,
         tracee_status=None, operation=None, error_number=None):
    cleanup_methods = []
    cleanup_errors = []
    def pidfd_cleanup_signal():
        try:
            signal.pidfd_send_signal(tracee_pidfd, signal.SIGKILL)
            cleanup_methods.append('pidfd_send_signal')
        except ProcessLookupError:
            cleanup_methods.append('pidfd_already_exited')
        except OSError as fallback_error:
            cleanup_errors.append({
                'operation': 'pidfd_send_signal',
                'errno': fallback_error.errno,
            })

    if kill_tracee and not tracee_reaped:
        if operation == 'waitpid' and error_number == errno.ECHILD:
            # ECHILD makes numeric-PID identity uncertain. Do not issue
            # PTRACE_KILL; the pidfd remains pinned to our original child.
            cleanup_methods.append('PTRACE_KILL_skipped_waitpid_ECHILD')
            pidfd_cleanup_signal()
        else:
            # This helper is the sole waiter. Before waitpid reaps its direct
            # child, the child's numeric PID cannot be reused for another process.
            try:
                ptrace(8, child)  # PTRACE_KILL: exact unreaped direct child
                cleanup_methods.append('PTRACE_KILL')
            except OSError as error:
                cleanup_errors.append({
                    'operation': 'PTRACE_KILL',
                    'errno': error.errno,
                })
                # Never fall back to kill(child, ...): signal only the child
                # pinned immediately after fork through its pidfd.
                pidfd_cleanup_signal()
        cleanup_deadline = time.monotonic() + 3
        while not tracee_reaped and time.monotonic() < cleanup_deadline:
            try:
                waited_pid, tracee_status = os.waitpid(child, os.WNOHANG)
                if waited_pid == child:
                    tracee_reaped = True
                elif waited_pid == 0:
                    time.sleep(0.01)
            except InterruptedError:
                continue
            except ChildProcessError as error:
                cleanup_errors.append({
                    'operation': 'waitpid',
                    'errno': error.errno,
                })
                break
            except OSError as error:
                cleanup_errors.append({
                    'operation': 'waitpid',
                    'errno': error.errno,
                })
                break
        if kill_tracee and not tracee_reaped:
            cleanup_errors.append({
                'operation': 'tracee cleanup timeout',
                'errno': None,
            })
    child_error = b''
    if error_read_fd >= 0:
        try:
            child_error = os.read(error_read_fd, 4096)
        except OSError:
            child_error = b''
        os.close(error_read_fd)
    result = {
        'error': message,
        'traceeReaped': tracee_reaped,
    }
    if tracee_status is not None:
        result['traceeStatus'] = wait_status_details(tracee_status)
    if child_error:
        try:
            result['childError'] = json.loads(child_error.decode())
        except (UnicodeDecodeError, ValueError):
            result['childError'] = 'unparseable child launcher error'
    if operation is not None:
        result['operation'] = operation
    if error_number is not None:
        result['errno'] = error_number
    skip_reason = skip_reason_for(operation, error_number)
    if skip_reason is not None:
        result['skipReason'] = skip_reason
    if cleanup_methods:
        result['cleanupMethods'] = cleanup_methods
    if cleanup_errors:
        result['cleanupErrors'] = cleanup_errors
    write_json(barrier_path, result)
    os.close(tracee_pidfd)
    raise SystemExit(120)

try:
    _pid, status = os.waitpid(child, 0)
    if not os.WIFSTOPPED(status) or os.WSTOPSIG(status) != signal.SIGTRAP:
        try:
            child_error = os.read(error_read_fd, 4096)
        except OSError:
            child_error = b''
        try:
            child_error = json.loads(child_error.decode()) if child_error else {}
        except (UnicodeDecodeError, ValueError):
            child_error = {}
        ptrace_traceme_error = child_error.get('kind') == 'ptrace-traceme'
        already_reaped = os.WIFEXITED(status) or os.WIFSIGNALED(status)
        fail(
            (
                f'PTRACE_TRACEME failed: {child_error.get("message")}'
                if ptrace_traceme_error
                else f'tracee did not stop at exec: wait status {status}'
            ),
            tracee_reaped=already_reaped,
            tracee_status=status,
            operation=(
                'PTRACE_TRACEME' if ptrace_traceme_error else 'execve'
            ),
            error_number=child_error.get('errno'),
        )
except OSError as error:
    fail(
        f'waitpid before ptrace setup failed: {error}',
        kill_tracee=True,
        operation='waitpid',
        error_number=error.errno,
    )
try:
    ptrace(SETOPTIONS, child, 0, TRACESYSGOOD)
except OSError as error:
    fail(
        f'PTRACE_SETOPTIONS failed: {error}',
        kill_tracee=True,
        operation='PTRACE_SETOPTIONS',
        error_number=error.errno,
    )
os.close(error_read_fd)
error_read_fd = -1

prctl_number = PRCTL_NUMBERS.get(os.uname().machine.lower())
if prctl_number is None:
    fail(
        f'unsupported test architecture: {os.uname().machine}',
        kill_tracee=True,
        operation='architecture',
    )
pending_pdeath_prctl = False

while True:
    try:
        ptrace(SYSCALL, child)
    except OSError as error:
        fail(
            f'PTRACE_SYSCALL failed: {error}',
            kill_tracee=True,
            operation='PTRACE_SYSCALL',
            error_number=error.errno,
        )
    try:
        _pid, status = os.waitpid(child, 0)
    except OSError as error:
        fail(
            f'waitpid during syscall stepping failed: {error}',
            kill_tracee=True,
            operation='waitpid',
            error_number=error.errno,
        )
    if os.WIFEXITED(status) or os.WIFSIGNALED(status):
        fail(
            f'tracee exited before the requested PDEATHSIG boundary: {status}',
            tracee_reaped=True,
            tracee_status=status,
        )
    if not os.WIFSTOPPED(status):
        continue
    if os.WSTOPSIG(status) == PTRACE_SYSCALL_STOP:
        info = ctypes.create_string_buffer(128)
        try:
            ptrace(GET_SYSCALL_INFO, child, len(info), ctypes.addressof(info))
        except OSError as error:
            fail(
                f'PTRACE_GET_SYSCALL_INFO failed: {error}',
                kill_tracee=True,
                operation='PTRACE_GET_SYSCALL_INFO',
                error_number=error.errno,
            )
        operation = info.raw[0]
        if operation == SYSCALL_INFO_ENTRY:
            number = struct.unpack_from('=Q', info.raw, 24)[0]
            arguments = struct.unpack_from('=6Q', info.raw, 32)
            pending_pdeath_prctl = (
                number == prctl_number
                and arguments[0] == PR_SET_PDEATHSIG
                and arguments[1] == signal.SIGKILL
            )
            if stage == 'before-prctl' and pending_pdeath_prctl:
                write_json(barrier_path, {'stage': stage, 'pid': child})
                os.kill(os.getpid(), signal.SIGSTOP)
        elif operation == SYSCALL_INFO_EXIT and pending_pdeath_prctl:
            result = struct.unpack_from('=q', info.raw, 24)[0]
            pending_pdeath_prctl = False
            if stage == 'after-prctl':
                if result != 0:
                    fail(f'PR_SET_PDEATHSIG returned {result}', kill_tracee=True)
                write_json(barrier_path, {'stage': stage, 'pid': child, 'result': result})
                os.kill(os.getpid(), signal.SIGSTOP)
    # Suppress incidental signals in this disposable tracee. The tested
    # process is stopped at a syscall boundary before the parent is killed.
'''


def tracee_for_ptrace_boundary(boundary, identity_path):
    if 'error' in boundary:
        if not boundary.get('traceeReaped'):
            raise AssertionError('ptrace helper reported an error before reaping its tracee')
        if not boundary.get('skipReason'):
            raise AssertionError(
                f'ptrace helper failed unexpectedly '
                f'({boundary.get("operation")}, errno={boundary.get("errno")}): '
                f'{boundary["error"]}'
            )
        raise unittest.SkipTest(boundary['skipReason'])
    tracee = json.loads(pathlib.Path(identity_path).read_text(encoding='utf-8'))
    if read_process_starttime(tracee['pid']) != tracee['starttime']:
        raise AssertionError('tracee PID was reused before the syscall boundary was pinned')
    return tracee


def launch_ptrace_parent(
    home, state_dir, port, identity_path, barrier_path, stage,
    server_command, injected_failure='',
):
    arguments = [
        sys.executable, '-c', _PTRACE_PARENT_HELPER,
        str(RUNTIME_SCRIPT), str(state_dir), str(port),
        str(identity_path), str(barrier_path), stage,
        json.dumps(server_command),
    ]
    if injected_failure:
        arguments.append(injected_failure)
    return subprocess.Popen(
        arguments,
        cwd=home,
        env=supervisor_env(state_dir),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def wait_for_file(path, timeout=5, process=None):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pathlib.Path(path).exists():
            return
        if process is not None and process.poll() is not None:
            detail = process.stderr.read() if process.stderr else ''
            raise AssertionError(
                f'process exited before test barrier {path} '
                f'(returncode={process.returncode}): {detail}'
            )
        time.sleep(0.01)
    raise AssertionError(f'timed out waiting for test barrier {path}')


def read_line_with_timeout(stream, timeout=2):
    with selectors.DefaultSelector() as selector:
        selector.register(stream, selectors.EVENT_READ)
        if not selector.select(timeout):
            raise AssertionError('timed out waiting for child client output')
    return stream.readline()


def launch_foreign_uid_socket_client(address, payload=None):
    """Connect as nobody; optionally send a body before waiting for the server."""
    script = r'''
import json, os, socket, sys, time
request = json.load(sys.stdin)
os.setgroups([])
os.setgid(65534)
os.setuid(65534)
with socket.socket(socket.AF_UNIX) as client:
    client.settimeout(3)
    client.connect(request['address'])
    print('connected', flush=True)
    if request.get('payload'):
        try:
            client.sendall(request['payload'].encode())
        except OSError:
            pass
    try:
        result = client.recv(1)
        print('eof' if result == b'' else 'response', flush=True)
    except OSError:
        print('closed-error', flush=True)
time.sleep(30)
'''
    process = subprocess.Popen(
        [sys.executable, '-u', '-c', script],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    process.stdin.write(json.dumps({'address': address, 'payload': payload}) + '\n')
    process.stdin.close()
    return process


def launch_same_uid_socket_client(address):
    """Keep sending one byte to distinguish an absolute deadline from idle timeout."""
    script = r'''
import socket, sys, time
with socket.socket(socket.AF_UNIX) as client:
    client.settimeout(3)
    client.connect(bytes.fromhex(sys.argv[1]))
    print('connected', flush=True)
    for _ in range(40):
        try:
            client.sendall(b'x')
        except OSError:
            break
        time.sleep(0.05)
    try:
        result = client.recv(1)
        print('eof' if result == b'' else 'response', flush=True)
    except OSError:
        print('closed-error', flush=True)
time.sleep(30)
'''
    return subprocess.Popen(
        [sys.executable, '-u', '-c', script, address.encode().hex()],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def release_test_barrier(directory, stage):
    directory = pathlib.Path(directory)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    (directory / f'{stage}.release').write_text('release', encoding='ascii')


def wait_for_exact_identity_exit(identity, namespace_inode, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not process_identity_alive(
            identity['pid'], identity['starttime'], namespace_inode,
        ):
            reap_if_child(identity['pid'])
            return
        time.sleep(0.02)
    raise AssertionError(f'exact process identity remained alive: {identity}')


def kill_exact_identity_for_test(identity, namespace_inode):
    """Cleanup only a pidfd-pinned identity created by this test."""
    if current_pid_namespace_inode() != namespace_inode:
        raise AssertionError('test cleanup refused an identity from another PID namespace')
    if not process_identity_alive(
        identity['pid'], identity['starttime'], namespace_inode,
    ):
        return
    try:
        pinned = PinnedProcess(identity['pid'])
    except TargetUnavailable:
        if not process_identity_alive(
            identity['pid'], identity['starttime'], namespace_inode,
        ):
            return
        raise
    try:
        try:
            pinned.verify_procfs_pid()
        except TargetUnavailable:
            if pinned.exited() or not process_identity_alive(
                identity['pid'], identity['starttime'], namespace_inode,
            ):
                return
            raise
        if (
            read_process_starttime(identity['pid']) != identity['starttime']
            or pinned.exited()
        ):
            return
        pinned.verify_owner(lambda: pinned.pid)
        if not pinned.exited():
            pinned.send(signal.SIGKILL)
            pinned.exited(5000)
    finally:
        pinned.close()
    reap_if_child(identity['pid'])


def cleanup_test_generation(state_dir, state):
    if not state:
        return
    namespace_inode = state['pidNamespaceInode']
    kill_exact_identity_for_test(state['supervisor'], namespace_inode)
    kill_exact_identity_for_test(state['child'], namespace_inode)
    try:
        recover_stale_generations(state_dir)
    except StateSafetyError:
        pass


def pin_test_descendant(identity_file, token):
    identity = json.loads(pathlib.Path(identity_file).read_text())
    pinned = PinnedProcess(identity['pid'])
    try:
        pinned.verify_procfs_pid()
        command_line = pathlib.Path(f"/proc/{identity['pid']}/cmdline").read_bytes()
        if token.encode() not in command_line:
            raise AssertionError('recorded PID no longer has the unique test command marker')
        if read_process_starttime(identity['pid']) != identity['starttime']:
            raise AssertionError('recorded PID starttime no longer matches the test descendant')
        pinned.verify_owner(lambda: pinned.pid)
        return pinned
    except BaseException:
        pinned.close()
        raise


@unittest.skipUnless(
    sys.platform == 'linux'
    and hasattr(os, 'pidfd_open')
    and hasattr(signal, 'pidfd_send_signal'),
    'requires Linux pidfd',
)
class SupervisorTest(unittest.TestCase):
    def test_default_main_starts_detaches_stops_forces_and_restarts(self):
        with adopt_orphaned_test_processes(), tempfile.TemporaryDirectory() as directory:
            home = pathlib.Path(directory)
            state_dir = isolated_state_dir(home)
            port = free_port()
            generations = []

            def start_without_fault_callback(command):
                client = launch_detach_cli(
                    write_detach_cli(directory),
                    state_dir,
                    command,
                    port,
                    supervisor_script=RUNTIME_SCRIPT,
                )
                try:
                    stdout, stderr = client.communicate(timeout=15)
                except subprocess.TimeoutExpired:
                    client.kill()
                    stdout, stderr = client.communicate(timeout=5)
                    self.fail(f'no-callback start/detach timed out: {stderr}')
                self.assertEqual(client.returncode, 0, stderr)
                events = [json.loads(line) for line in stdout.splitlines() if line]
                self.assertEqual(
                    [event['event'] for event in events],
                    ['READY_PENDING', 'START_CONFIRMED'],
                )
                state = json.loads(
                    (state_dir / events[0]['stateName']).read_text(encoding='utf-8'),
                )
                self.assertEqual(state['generation'], events[1]['generation'])
                self.assertEqual(
                    state['generation'],
                    control_response(
                        state['socketAddress'],
                        state['generation'],
                        state['secret'],
                        'status',
                    )['generation'],
                )
                generations.append(state)
                return state

            def run_control_cli(action, state):
                result = subprocess.run(
                    [
                        sys.executable, str(EXPERIMENTAL_CLI),
                        action, '--port', str(port),
                    ],
                    cwd=home,
                    env=supervisor_env(state_dir),
                    stdin=subprocess.DEVNULL,
                    capture_output=True,
                    text=True,
                    timeout=20,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                response = json.loads(result.stdout)
                self.assertEqual(response['status'], 'stopped')
                self.assertEqual(response['action'], action)
                self.assertEqual(response['generation'], state['generation'])
                self.assertTrue(response['postconditionReconciled'])
                return response

            try:
                first = start_without_fault_callback(
                    mini_server_command(port, ignore_sigterm=False),
                )
                first_state = state_dir / f"port-{port}-{first['generation']}.json"
                self.assertTrue(first_state.exists())
                run_control_cli('stop', first)
                wait_for_exact_identity_exit(
                    first['child'], first['pidNamespaceInode'],
                )
                wait_for_exact_identity_exit(
                    first['supervisor'], first['pidNamespaceInode'],
                )
                self.assertFalse(first_state.exists())

                with socket.socket() as probe:
                    probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    probe.bind(('127.0.0.1', port))

                second = start_without_fault_callback(
                    mini_server_command(port, ignore_sigterm=True),
                )
                second_state = state_dir / f"port-{port}-{second['generation']}.json"
                self.assertNotEqual(second['generation'], first['generation'])
                self.assertTrue(second_state.exists())
                run_control_cli('force', second)
                wait_for_exact_identity_exit(
                    second['child'], second['pidNamespaceInode'],
                )
                wait_for_exact_identity_exit(
                    second['supervisor'], second['pidNamespaceInode'],
                )
                self.assertFalse(second_state.exists())
                with socket.socket() as probe:
                    probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    probe.bind(('127.0.0.1', port))
            finally:
                for state in reversed(generations):
                    cleanup_test_generation(state_dir, state)

    def test_runtime_parent_death_before_and_after_pdeathsig_syscall(self):
        if not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
            self.skipTest('requires pidfd for exact tracee cleanup')
        for stage in ('before-prctl', 'after-prctl'):
            with self.subTest(stage=stage), adopt_orphaned_test_processes(), tempfile.TemporaryDirectory() as directory:
                home = pathlib.Path(directory)
                state_dir = isolated_state_dir(home)
                port = free_port()
                identity_path = home / 'tracee.json'
                barrier_path = home / 'syscall-boundary.json'
                server_marker = home / 'server-command-ran'
                server_command = [
                    sys.executable, '-c',
                    (
                        'from pathlib import Path; import time; '
                        f'Path({str(server_marker)!r}).write_text("ran"); '
                        'time.sleep(30)'
                    ),
                ]
                helper = launch_ptrace_parent(
                    home, state_dir, port, identity_path, barrier_path, stage,
                    server_command,
                )
                tracee_pidfd = None
                tracee_pid = None
                try:
                    deadline = time.monotonic() + 8
                    while time.monotonic() < deadline and not barrier_path.exists():
                        if helper.poll() is not None:
                            _stdout, helper_stderr = helper.communicate()
                            self.fail(
                                'ptrace parent exited before reaching the syscall boundary: '
                                f'{helper_stderr}',
                            )
                        time.sleep(0.01)
                    self.assertTrue(barrier_path.exists(), 'syscall boundary was not reached')
                    boundary = json.loads(barrier_path.read_text(encoding='utf-8'))
                    if 'error' in boundary:
                        self.assertTrue(
                            boundary.get('traceeReaped') is True,
                            'ptrace error was reported before the helper reaped its direct tracee',
                        )
                        helper.communicate(timeout=5)
                        self.assertEqual(helper.returncode, 120)
                    tracee = tracee_for_ptrace_boundary(boundary, identity_path)
                    tracee_pid = tracee['pid']
                    tracee_pidfd = os.pidfd_open(tracee_pid)
                    self.assertEqual(boundary['stage'], stage)
                    self.assertEqual(tracee_pid, boundary['pid'])

                    # Wait until the test parent is itself stopped after publishing
                    # the barrier, so killing it occurs at the requested syscall edge.
                    stopped_deadline = time.monotonic() + 2
                    while time.monotonic() < stopped_deadline:
                        try:
                            status_lines = pathlib.Path(
                                f'/proc/{helper.pid}/status',
                            ).read_text(encoding='ascii').splitlines()
                        except FileNotFoundError:
                            break
                        state_line = next(
                            (line for line in status_lines if line.startswith('State:')),
                            '',
                        )
                        if '\tT' in state_line or '\tt' in state_line:
                            break
                        time.sleep(0.005)
                    else:
                        self.fail('ptrace parent did not stop at the observed syscall boundary')

                    helper.send_signal(signal.SIGKILL)
                    try:
                        helper.communicate(timeout=5)
                    except subprocess.TimeoutExpired:
                        signal.pidfd_send_signal(tracee_pidfd, signal.SIGKILL)
                        helper.communicate(timeout=5)
                        self.fail('tracee did not resume or die after its ptrace parent exited')
                    self.assertEqual(helper.returncode, -signal.SIGKILL)

                    poller = select.poll()
                    poller.register(tracee_pidfd, select.POLLIN)
                    self.assertTrue(
                        poller.poll(5000),
                        f'supervisor did not die after its parent died at {stage}',
                    )
                    waited_pid, wait_status = os.waitpid(tracee_pid, 0)
                    self.assertEqual(waited_pid, tracee_pid)
                    if stage == 'before-prctl':
                        self.assertTrue(os.WIFEXITED(wait_status))
                        self.assertEqual(os.WEXITSTATUS(wait_status), 125)
                    else:
                        self.assertTrue(os.WIFSIGNALED(wait_status))
                        self.assertEqual(os.WTERMSIG(wait_status), signal.SIGKILL)

                    self.assertFalse(
                        server_marker.exists(),
                        'server command must not run when the supervisor parent dies in the PDEATHSIG window',
                    )
                    self.assertFalse(list(state_dir.glob('port-*.json*')))
                    with socket.socket() as probe:
                        probe.bind(('127.0.0.1', port))
                finally:
                    if tracee_pidfd is not None:
                        poller = select.poll()
                        poller.register(tracee_pidfd, select.POLLIN)
                        if not poller.poll(0):
                            signal.pidfd_send_signal(tracee_pidfd, signal.SIGKILL)
                    if helper.poll() is None:
                        helper.kill()
                    if helper.returncode is None:
                        try:
                            helper.communicate(timeout=5)
                        except subprocess.TimeoutExpired:
                            pass
                    if tracee_pidfd is not None:
                        try:
                            poller = select.poll()
                            poller.register(tracee_pidfd, select.POLLIN)
                            poller.poll(5000)
                        finally:
                            os.close(tracee_pidfd)
                    for state_path in state_dir.glob('port-*.json'):
                        try:
                            state = json.loads(state_path.read_text(encoding='utf-8'))
                        except (OSError, ValueError):
                            pass
                        else:
                            cleanup_test_generation(state_dir, state)
                    if tracee_pid is not None:
                        try:
                            os.waitpid(tracee_pid, os.WNOHANG)
                        except ChildProcessError:
                            pass

    def test_ptrace_skip_classification_and_pidfd_cleanup_are_narrow(self):
        unrelated = subprocess.Popen(
            [sys.executable, '-c', 'import time; time.sleep(30)'],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        cases = (
            {
                'injection': 'PTRACE_TRACEME:EPERM',
                'skip': True,
                'operation': 'PTRACE_TRACEME',
                'errno': errno.EPERM,
                'status': ('exitCode', 121),
                'cleanup': None,
            },
            {
                'injection': 'PTRACE_GET_SYSCALL_INFO:EIO',
                'skip': True,
                'operation': 'PTRACE_GET_SYSCALL_INFO',
                'errno': errno.EIO,
                'status': ('signal', signal.SIGKILL),
                'cleanup': 'PTRACE_KILL',
            },
            {
                'injection': 'PTRACE_GET_SYSCALL_INFO:EFAULT,PTRACE_KILL:EIO',
                'skip': False,
                'operation': 'PTRACE_GET_SYSCALL_INFO',
                'errno': errno.EFAULT,
                'status': ('signal', signal.SIGKILL),
                'cleanup': 'pidfd_send_signal',
            },
            {
                'injection': 'WAITPID:ECHILD',
                'skip': False,
                'operation': 'waitpid',
                'errno': errno.ECHILD,
                'status': ('signal', signal.SIGKILL),
                'cleanup': 'PTRACE_KILL_skipped_waitpid_ECHILD',
            },
        )
        try:
            for case in cases:
                injected_failure = case['injection']
                with self.subTest(injected_failure=injected_failure), tempfile.TemporaryDirectory() as directory:
                    home = pathlib.Path(directory)
                    state_dir = isolated_state_dir(home)
                    port = free_port()
                    identity_path = home / 'tracee.json'
                    barrier_path = home / 'syscall-boundary.json'
                    server_marker = home / 'server-command-ran'
                    server_command = [
                        sys.executable, '-c',
                        (
                            'from pathlib import Path; import time; '
                            f'Path({str(server_marker)!r}).write_text("ran"); '
                            'time.sleep(30)'
                        ),
                    ]
                    helper = launch_ptrace_parent(
                        home, state_dir, port, identity_path, barrier_path,
                        'before-prctl', server_command, injected_failure,
                    )
                    try:
                        deadline = time.monotonic() + 8
                        while time.monotonic() < deadline and not barrier_path.exists():
                            if helper.poll() is not None:
                                _stdout, helper_stderr = helper.communicate()
                                self.fail(
                                    f'{injected_failure}: helper exited without an error result: '
                                    f'{helper_stderr}',
                                )
                            time.sleep(0.01)
                        self.assertTrue(
                            barrier_path.exists(),
                            f'{injected_failure}: helper did not report the injected failure',
                        )
                        boundary = json.loads(barrier_path.read_text(encoding='utf-8'))
                        self.assertIn('error', boundary)
                        self.assertTrue(boundary['traceeReaped'])
                        self.assertEqual(boundary['operation'], case['operation'])
                        self.assertEqual(boundary['errno'], case['errno'])
                        self.assertEqual(
                            bool(boundary.get('skipReason')),
                            case['skip'],
                        )
                        helper.communicate(timeout=5)
                        self.assertEqual(helper.returncode, 120)

                        with patch(
                            f'{__name__}.read_process_starttime',
                            side_effect=AssertionError(
                                'error handling must not read /proc for the reaped PID',
                            ),
                        ) as read_starttime, patch.object(
                            os,
                            'pidfd_open',
                            side_effect=AssertionError(
                                'error handling must not open a pidfd for the reaped PID',
                            ),
                        ) as open_pidfd:
                            if case['skip']:
                                with self.assertRaises(unittest.SkipTest):
                                    tracee_for_ptrace_boundary(boundary, identity_path)
                            else:
                                with self.assertRaisesRegex(
                                    AssertionError,
                                    'ptrace helper failed unexpectedly',
                                ):
                                    tracee_for_ptrace_boundary(boundary, identity_path)
                        read_starttime.assert_not_called()
                        open_pidfd.assert_not_called()

                        status_key, expected_status = case['status']
                        self.assertEqual(
                            boundary['traceeStatus'][status_key],
                            expected_status,
                        )
                        if case['cleanup']:
                            self.assertIn(
                                case['cleanup'],
                                boundary.get('cleanupMethods', []),
                            )
                        if injected_failure in (
                            'PTRACE_GET_SYSCALL_INFO:EFAULT,PTRACE_KILL:EIO',
                            'WAITPID:ECHILD',
                        ):
                            fail_body = _PTRACE_PARENT_HELPER[
                                _PTRACE_PARENT_HELPER.index('def fail('):
                                _PTRACE_PARENT_HELPER.index("    child_error = b''")
                            ]
                            self.assertIn(
                                'if kill_tracee and not tracee_reaped:',
                                fail_body,
                            )
                            self.assertNotIn(
                                'os.kill(child, signal.SIGKILL)',
                                fail_body,
                                'failure cleanup must not signal a numeric PID',
                            )
                        if injected_failure == 'PTRACE_GET_SYSCALL_INFO:EFAULT,PTRACE_KILL:EIO':
                            self.assertIn(
                                {
                                    'operation': 'PTRACE_KILL',
                                    'errno': errno.EIO,
                                },
                                boundary.get('cleanupErrors', []),
                            )
                        if injected_failure == 'WAITPID:ECHILD':
                            self.assertIn(
                                'pidfd_send_signal',
                                boundary.get('cleanupMethods', []),
                            )
                            self.assertNotIn(
                                'PTRACE_KILL',
                                boundary.get('cleanupMethods', []),
                            )
                        self.assertIsNone(
                            unrelated.poll(),
                            'ptrace cleanup touched an unrelated process',
                        )
                        self.assertFalse(server_marker.exists())
                        self.assertFalse(list(state_dir.glob('port-*.json*')))
                        with socket.socket() as probe:
                            probe.bind(('127.0.0.1', port))
                    finally:
                        if helper.poll() is None:
                            helper.kill()
                        if helper.returncode is None:
                            helper.communicate(timeout=5)
        finally:
            if unrelated.poll() is None:
                unrelated.kill()
            unrelated.wait(timeout=5)

    def test_custom_state_directory_is_rejected_before_any_child_is_started(self):
        with tempfile.TemporaryDirectory() as directory:
            home = pathlib.Path(directory)
            custom = home / 'untracked-state'
            port = free_port()
            process = subprocess.run(
                [
                    sys.executable, str(SCRIPT),
                    '--state-dir', str(custom),
                    '--port', str(port),
                    '--parent-pid', str(os.getpid()),
                    '--parent-starttime', str(read_process_starttime(os.getpid())),
                    '--', *mini_server_command(port),
                ],
                cwd=home,
                env=dict(os.environ, HOME=str(home)),
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                timeout=5,
            )
            self.assertNotEqual(process.returncode, 0)
            self.assertIn('state must use ~/.search-docs/managed-embedding-prototype', process.stderr)
            self.assertFalse(custom.exists())
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', port))

    def test_parent_death_before_and_after_prctl_never_executes_the_server(self):
        for stage in ('before-prctl', 'after-prctl'):
            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as directory:
                home = pathlib.Path(directory)
                state_dir = isolated_state_dir(home)
                port = free_port()
                marker = home / 'server-executed'
                hook_marker = home / 'pdeath-hook-reached'
                parent_pid = os.getpid()
                env = dict(
                    os.environ,
                    HOME=str(home),
                    SEARCH_DOCS_TEST_PDEATHSIG_STAGE=stage,
                    SEARCH_DOCS_TEST_PDEATHSIG_MARKER=str(hook_marker),
                    SEARCH_DOCS_TEST_PDEATHSIG_DELAY='1.0',
                )
                process = subprocess.Popen(
                    [
                        sys.executable, str(SCRIPT),
                        '--state-dir', str(state_dir),
                        '--port', str(port),
                        '--parent-pid', str(parent_pid),
                        '--parent-starttime', str(read_process_starttime(parent_pid)),
                        '--startup-timeout', '5',
                        '--', sys.executable, '-c',
                        f"from pathlib import Path; Path({str(marker)!r}).write_text('executed')",
                    ],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    env=env,
                )
                pinned = None
                try:
                    deadline = time.monotonic() + 5
                    while time.monotonic() < deadline and not hook_marker.exists():
                        if process.poll() is not None:
                            self.fail(f'supervisor exited before hook: {process.stderr.read()}')
                        time.sleep(0.01)
                    self.assertTrue(hook_marker.exists(), f'{stage} hook was not reached')
                    child_pid = None
                    deadline = time.monotonic() + 2
                    while time.monotonic() < deadline and child_pid is None:
                        candidates = direct_children(process.pid)
                        if candidates:
                            child_pid = next(iter(candidates))
                        else:
                            time.sleep(0.01)
                    self.assertIsNotNone(child_pid, 'pre-exec child was not visible under supervisor')
                    pinned = PinnedProcess(child_pid)
                    pinned.verify_procfs_pid()
                    process.kill()
                    process.wait(timeout=5)
                    self.assertTrue(pinned.exited(5000), f'pre-exec child survived {stage} parent death')
                    self.assertFalse(marker.exists(), 'server command ran before parent-death validation')
                    self.assertFalse(list(state_dir.glob('port-*.json*')))
                    self.assertTrue(
                        (home / '.search-docs' / 'embedding-management.lock').exists(),
                        'crash must leave the cross-process lock for manual recovery',
                    )
                    with socket.socket() as probe:
                        probe.bind(('127.0.0.1', port))
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.wait(timeout=5)
                    if pinned is not None:
                        pinned.close()
                    process.stdout.close()
                    process.stderr.close()

    def test_state_publication_failures_cleanup_only_verified_dead_generations(self):
        for stage in ('partial-write', 'temp-fsync', 'link', 'directory-fsync'):
            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as directory:
                home = pathlib.Path(directory)
                state_dir = isolated_state_dir(home)
                port = free_port()
                env = dict(
                    os.environ,
                    HOME=str(home),
                    SEARCH_DOCS_TEST_STATE_FAIL_STAGE=stage,
                )
                process = subprocess.run(
                    [
                        sys.executable, str(SCRIPT),
                        '--state-dir', str(state_dir),
                        '--port', str(port),
                        '--parent-pid', str(os.getpid()),
                        '--parent-starttime', str(read_process_starttime(os.getpid())),
                        '--startup-timeout', '5',
                        '--', *mini_server_command(port),
                    ],
                    cwd=home,
                    env=env,
                    stdin=subprocess.DEVNULL,
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
                self.assertNotEqual(process.returncode, 0, process.stdout)
                self.assertIn('injected generation publication failure', process.stderr)
                with socket.socket() as probe:
                    probe.bind(('127.0.0.1', port))

                generation_files = sorted(state_dir.glob('port-*'))
                if stage == 'link':
                    self.assertEqual(generation_files, [])
                    continue
                self.assertEqual(len(generation_files), 1)
                state_path = generation_files[0]
                if stage == 'partial-write':
                    with self.assertRaises(StateSafetyError):
                        recover_stale_generations(state_dir)
                    self.assertTrue(state_path.exists(), 'malformed state must be preserved for manual inspection')
                else:
                    removed = recover_stale_generations(state_dir)
                    self.assertEqual(removed, [state_path.name.split('-')[2].split('.')[0]])
                    self.assertFalse(state_path.exists())

    def test_pdeathsig_does_not_reap_grandchildren_and_recovery_preserves_live_listener(self):
        cases = (('crash', True), ('stop', False), ('force', True))
        with adopt_orphaned_test_processes():
            for action, descendant_holds_listener in cases:
                with self.subTest(action=action), tempfile.TemporaryDirectory() as directory:
                    home = pathlib.Path(directory)
                    state_dir = isolated_state_dir(home)
                    port = free_port()
                    token = uuid.uuid4().hex
                    identity_file = home / 'descendant.json'
                    launcher = home / 'server-with-forked-descendant.py'
                    server_source = r'''
import json, os, pathlib, signal, sys, time
from http.server import BaseHTTPRequestHandler, HTTPServer
spawned = False
server = None
def spawn_descendant(_signal, _frame):
    global spawned
    if spawned: return
    spawned = True
    pid = os.fork()
    if pid == 0:
        if sys.argv[3] == 'false':
            server.server_close()
        while True: time.sleep(1)
    temporary_identity = sys.argv[2] + '.tmp'
    with open(temporary_identity, 'w', encoding='utf-8') as target:
        stat = pathlib.Path(f'/proc/{pid}/stat').read_text()
        fields = stat[stat.rfind(')') + 1:].split()
        json.dump({'pid': pid, 'starttime': int(fields[19])}, target)
    os.replace(temporary_identity, sys.argv[2])
signal.signal(signal.SIGUSR1, spawn_descendant)
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/ready':
            body = json.dumps({'ready': True}).encode()
            self.send_response(200); self.send_header('Content-Length', str(len(body)))
            self.end_headers(); self.wfile.write(body); self.wfile.flush()
    def log_message(self, *_args): pass
server = HTTPServer(('127.0.0.1', int(sys.argv[1])), Handler)
server.serve_forever()
    '''
                    # The unique token is in the child command line, allowing the
                    # test to pin and clean the exact fork without trusting a PID.
                    launcher.write_text(
                        "import os, sys\n"
                        f"os.execv(sys.executable, [sys.executable, '-u', '-c', {server_source!r}, "
                        f"{str(port)!r}, {str(identity_file)!r}, "
                        f"{str(descendant_holds_listener).lower()!r}, {token!r}])\n",
                        encoding='utf-8',
                    )
                    process = None
                    pinned = None
                    direct = None
                    state_path = None
                    try:
                        process, ready, state, state_path = launch_supervisor(
                            state_dir, [launcher], port,
                        )
                        direct = PinnedProcess(state['child']['pid'])
                        direct.verify_procfs_pid()
                        self.assertEqual(
                            read_process_starttime(state['child']['pid']),
                            state['child']['starttime'],
                        )
                        direct.verify_owner(lambda: observe_direct_child_listener(
                            state['child']['pid'], port, state['networkNamespaceInode'],
                        )[1])
                        direct.send(signal.SIGUSR1)
                        deadline = time.monotonic() + 5
                        while time.monotonic() < deadline and not identity_file.exists():
                            time.sleep(0.01)
                        self.assertTrue(identity_file.exists(), 'server did not create its test descendant')
                        identity = json.loads(identity_file.read_text())
                        self.assertNotEqual(identity['pid'], state['child']['pid'])

                        # Cleanup pins the exact forked child and checks both its
                        # starttime and unique command marker; it never signals the
                        # PID read from the fixture file on its own.
                        pinned = pin_test_descendant(identity_file, token)
                        if action == 'crash':
                            process.kill()
                        else:
                            self.assertTrue(control(
                                state['socketAddress'], ready['generation'],
                                state['secret'], action,
                            ))
                        process.wait(timeout=8)
                        process.stdout.close()
                        process.stderr.close()
                        process = None

                        self.assertTrue(direct.exited(1000), 'direct child should receive SIGKILL')
                        reap_if_child(state['child']['pid'])
                        self.assertFalse(
                            pinned.exited(),
                            'the grandchild does not inherit the direct child PDEATHSIG',
                        )
                        self.assertEqual(
                            process_group_alive(state['processGroupId']),
                            True,
                            'a descendant in the managed process group must preserve state',
                        )
                        if descendant_holds_listener:
                            pinned.verify_owner(lambda: observe_direct_child_listener(
                                pinned.pid, port, state['networkNamespaceInode'],
                            )[1])
                        else:
                            with socket.socket() as probe:
                                probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                                probe.bind(('127.0.0.1', port))
                        with self.assertRaises(GenerationInUse):
                            recover_stale_generations(state_dir)
                        self.assertTrue(
                            state_path.exists(),
                            'a remaining listener or process group must preserve state',
                        )

                        pinned.send(signal.SIGKILL)
                        self.assertTrue(pinned.exited(5000))
                        reap_if_child(identity['pid'])
                        pinned.close()
                        pinned = None
                        reap_if_child(identity['pid'])
                        deadline = time.monotonic() + 5
                        while time.monotonic() < deadline and process_group_alive(state['processGroupId']):
                            reap_if_child(identity['pid'])
                            time.sleep(0.01)
                        self.assertEqual(recover_stale_generations(state_dir), [ready['generation']])
                        self.assertFalse(state_path.exists())
                    finally:
                        if process is not None:
                            if process.poll() is None:
                                process.kill()
                            process.wait(timeout=5)
                            process.stdout.close()
                            process.stderr.close()
                        if direct is not None:
                            self.assertTrue(direct.exited(5000), 'direct child survived test cleanup')
                        if pinned is None and identity_file.exists():
                            try:
                                pinned = pin_test_descendant(identity_file, token)
                            except (OSError, TargetUnavailable, AssertionError, ValueError):
                                pinned = None
                        if pinned is not None:
                            if not pinned.exited():
                                # The held pidfd was bound to this exact test
                                # fork by starttime and its unique cmdline token.
                                # It may have closed the listener deliberately.
                                pinned.send(signal.SIGKILL)
                                pinned.exited(5000)
                            pinned.close()
                        if direct is not None:
                            direct.close()

    def test_single_pid_recovery_does_not_claim_to_collect_listenerless_setsid_descendant(self):
        """The managed stop contract covers its listener PID, not every descendant."""
        with adopt_orphaned_test_processes(), tempfile.TemporaryDirectory() as directory:
            home = pathlib.Path(directory)
            state_dir = isolated_state_dir(home)
            port = free_port()
            token = uuid.uuid4().hex
            identity_file = home / 'escaped-descendant.json'
            launcher = home / 'server-with-detached-descendant.py'
            server_source = r'''
import json, os, pathlib, signal, sys, time
from http.server import BaseHTTPRequestHandler, HTTPServer
server = None
def spawn_descendant(_signal, _frame):
    pid = os.fork()
    if pid == 0:
        os.setsid()
        server.server_close()
        while True: time.sleep(1)
    stat = pathlib.Path(f'/proc/{pid}/stat').read_text()
    fields = stat[stat.rfind(')') + 1:].split()
    pathlib.Path(sys.argv[2]).write_text(json.dumps({
        'pid': pid, 'starttime': int(fields[19]),
    }))
signal.signal(signal.SIGUSR1, spawn_descendant)
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b'{"ready":true}'
        self.send_response(200); self.send_header('Content-Length', str(len(body)))
        self.end_headers(); self.wfile.write(body)
    def log_message(self, *_args): pass
server = HTTPServer(('127.0.0.1', int(sys.argv[1])), Handler)
server.serve_forever()
'''
            launcher.write_text(
                "import os, sys\n"
                f"os.execv(sys.executable, [sys.executable, '-u', '-c', {server_source!r}, "
                f"{str(port)!r}, {str(identity_file)!r}, {token!r}])\n",
                encoding='utf-8',
            )
            process = None
            direct = None
            escaped = None
            identity = None
            try:
                process, _ready, state, state_path = launch_supervisor(
                    state_dir, [launcher], port,
                )
                direct = PinnedProcess(state['child']['pid'])
                direct.verify_procfs_pid()
                direct.verify_owner(lambda: observe_direct_child_listener(
                    state['child']['pid'], port, state['networkNamespaceInode'],
                )[1])
                direct.send(signal.SIGUSR1)
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline and not identity_file.exists():
                    time.sleep(0.01)
                self.assertTrue(identity_file.exists())
                identity = json.loads(identity_file.read_text())
                escaped = pin_test_descendant(identity_file, token)
                process.kill()
                process.wait(timeout=8)
                process.stdout.close()
                process.stderr.close()
                process = None
                self.assertTrue(direct.exited(1000))
                reap_if_child(state['child']['pid'])
                self.assertFalse(escaped.exited(), 'detached descendant should remain alive')
                self.assertFalse(process_group_alive(state['processGroupId']))
                with socket.socket() as probe:
                    probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    probe.bind(('127.0.0.1', port))

                # This listenerless process deliberately escaped the managed
                # PID's session. Its survival is outside the single-PID stop
                # contract; it must not be described as full process-tree
                # cleanup, but it does not keep the released listener owned.
                self.assertEqual(
                    recover_stale_generations(state_dir),
                    [state['generation']],
                )
                self.assertFalse(escaped.exited())
            finally:
                if process is not None:
                    if process.poll() is None:
                        process.kill()
                    process.wait(timeout=5)
                    process.stdout.close()
                    process.stderr.close()
                if escaped is not None:
                    if not escaped.exited():
                        escaped.send(signal.SIGKILL)
                        escaped.exited(5000)
                    escaped.close()
                    if identity is not None:
                        reap_if_child(identity['pid'])
                if direct is not None:
                    direct.close()

    def test_uv_child_identity_failure_keeps_orphan_listener_quarantined(self):
        uv = shutil.which('uv')
        if not uv:
            self.skipTest('uv is required to test the actual launcher process relationship')
        with tempfile.TemporaryDirectory() as directory:
            home = pathlib.Path(directory)
            state_dir = isolated_state_dir(home)
            port = free_port()
            token = uuid.uuid4().hex
            identity_path = home / 'uv-listener-identity.json'
            source = r'''
import json, os, pathlib, signal, sys, time
from http.server import BaseHTTPRequestHandler, HTTPServer
stat = pathlib.Path(f'/proc/{os.getpid()}/stat').read_text()
fields = stat[stat.rfind(')') + 1:].split()
pathlib.Path(sys.argv[2]).write_text(json.dumps({
    'pid': os.getpid(), 'starttime': int(fields[19]),
}))
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/ready':
            body = json.dumps({'ready': True}).encode()
            self.send_response(200); self.send_header('Content-Length', str(len(body)))
            self.end_headers(); self.wfile.write(body)
    def log_message(self, *_args): pass
HTTPServer(('127.0.0.1', int(sys.argv[1])), Handler).serve_forever()
'''
            parent_pid = os.getpid()
            env = supervisor_env(state_dir)
            env['UV_CACHE_DIR'] = str(home / 'uv-cache')
            process = subprocess.Popen(
                [
                    sys.executable, str(SCRIPT),
                    '--state-dir', str(state_dir),
                    '--port', str(port),
                    '--parent-pid', str(parent_pid),
                    '--parent-starttime', str(read_process_starttime(parent_pid)),
                    '--startup-timeout', '15',
                    '--',
                    uv, 'run', '--offline', '--no-project', '--no-config', '--no-cache',
                    '--no-python-downloads', '--python', sys.executable,
                    'python', '-u', '-c', source, str(port), str(identity_path), token,
                ],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=env,
            )
            server_reference = None
            try:
                with selectors.DefaultSelector() as selector:
                    selector.register(process.stdout, selectors.EVENT_READ)
                    has_ready_record = bool(selector.select(20))
                ready_line = process.stdout.readline() if has_ready_record else ''
                if ready_line:
                    print('uv run listener owner matched the pinned direct child')
                    ready = json.loads(ready_line)
                    state_path = state_dir / ready['stateName']
                    state = json.loads(state_path.read_text())
                    self.assertEqual(ready['generation'], state['generation'])
                    owner = observe_direct_child_listener(
                        state['child']['pid'], port, state['networkNamespaceInode'],
                    )[1]
                    self.assertEqual(owner, state['child']['pid'])
                    server_reference = PinnedProcess(owner)
                    server_reference.verify_procfs_pid()
                    server_reference.verify_owner(lambda: observe_direct_child_listener(
                        owner, port, state['networkNamespaceInode'],
                    )[1])
                    process.kill()
                    process.wait(timeout=5)
                    self.assertTrue(
                        server_reference.exited(5000),
                        'PDEATHSIG did not stop the uv-launched direct server after supervisor crash',
                    )
                    self.assertTrue(state_path.exists(), 'crash state remains for explicit recovery')
                    self.assertEqual(recover_stale_generations(state_dir), [state['generation']])
                    server_reference.close()
                    server_reference = None
                    with socket.socket() as probe:
                        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                        probe.bind(('127.0.0.1', port))
                    return

                process.wait(timeout=5)
                self.assertNotEqual(process.returncode, 0)
                self.assertIn(
                    'port owner changed or pinned process exited',
                    process.stderr.read(),
                )
                print('uv run listener owner differed from the pinned direct child; startup failed closed')

                state_files = list(state_dir.glob('port-*.json'))
                owner = None
                try:
                    owner = observe_port(port)[1]
                except TargetUnavailable:
                    pass
                if owner is not None:
                    self.assertEqual(len(state_files), 1, 'live uv child requires retained generation state')
                    state = json.loads(state_files[0].read_text())
                    self.assertNotEqual(owner, state['child']['pid'])
                    server_reference = PinnedProcess(owner)
                    server_reference.verify_procfs_pid()
                    self.assertIn(
                        token.encode(),
                        pathlib.Path(f'/proc/{owner}/cmdline').read_bytes(),
                    )
                    server_reference.verify_owner(lambda: observe_direct_child_listener(
                        owner, port, state['networkNamespaceInode'],
                    )[1])
                    server_reference.send(signal.SIGKILL)
                    self.assertTrue(server_reference.exited(5000))
                    # uv's child may have been reparented to the test process
                    # in a container PID namespace after the launcher exits.
                    try:
                        reap_if_child(owner)
                    except ChildProcessError:
                        pass
                    server_reference.close()
                    server_reference = None
                    self.assertEqual(recover_stale_generations(state_dir), [state['generation']])
                else:
                    if identity_path.exists():
                        # A global /proc owner scan can be incomplete in a
                        # restricted container even when the test server is
                        # readable directly. Keep that scan fail-closed, but
                        # clean the uniquely marked live server through a
                        # pidfd after checking its exact starttime and listener.
                        self.assertEqual(
                            len(state_files), 1,
                            'live uv child requires retained generation state',
                        )
                        state = json.loads(state_files[0].read_text())
                        identity = json.loads(identity_path.read_text())
                        owner = identity['pid']
                        server_reference = PinnedProcess(owner)
                        server_reference.verify_procfs_pid()
                        self.assertEqual(
                            read_process_starttime(owner), identity['starttime'],
                        )
                        self.assertIn(
                            token.encode(),
                            pathlib.Path(f'/proc/{owner}/cmdline').read_bytes(),
                        )
                        server_reference.verify_owner(
                            lambda: observe_direct_child_listener(
                                owner, port, current_network_namespace_inode(),
                            )[1],
                        )
                        server_reference.send(signal.SIGKILL)
                        self.assertTrue(server_reference.exited(5000))
                        try:
                            reap_if_child(owner)
                        except ChildProcessError:
                            pass
                        server_reference.close()
                        server_reference = None
                        self.assertEqual(
                            recover_stale_generations(state_dir),
                            [state['generation']],
                        )
                    else:
                        self.assertEqual(state_files, [])
                with socket.socket() as probe:
                    probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    probe.bind(('127.0.0.1', port))
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)
                if server_reference is not None:
                    if not server_reference.exited():
                        server_reference.verify_owner(lambda: observe_direct_child_listener(
                            server_reference.pid, port, state['networkNamespaceInode'],
                        )[1])
                        server_reference.send(signal.SIGKILL)
                        server_reference.exited(5000)
                    server_reference.close()
                process.stdout.close()
                process.stderr.close()

    def test_generation_identity_and_force_interrupts_normal_stop(self):
        with tempfile.TemporaryDirectory() as directory:
            state_dir = isolated_state_dir(directory)
            port = free_port()
            process, ready, state, state_path = launch_supervisor(
                state_dir, mini_server_command(port), port,
            )
            try:
                with PinnedProcess(state['child']['pid']) as pinned:
                    pinned.verify_procfs_pid()
                    self.assertFalse(pinned.exited())
                self.assertEqual(
                    observe_direct_child_listener(
                        state['child']['pid'], port, state['networkNamespaceInode'],
                    )[1],
                    state['child']['pid'],
                )
                self.assertEqual(state_path.stat().st_mode & 0o777, 0o600)
                self.assertEqual(state_dir.stat().st_mode & 0o777, 0o700)
                self.assertTrue(control(
                    state['socketAddress'], ready['generation'],
                    state['secret'], 'verify-ready',
                ))
                wrong_generation = control_response(
                    state['socketAddress'], '0' * 32,
                    state['secret'], 'force',
                )
                self.assertFalse(wrong_generation['accepted'])
                self.assertEqual(wrong_generation['outcome'], 'wrong-generation-or-user')
                wrong_secret = control_response(
                    state['socketAddress'], ready['generation'],
                    '0' * 64, 'force',
                )
                self.assertFalse(wrong_secret['accepted'])
                self.assertEqual(wrong_secret['outcome'], 'unauthorized')
                self.assertTrue(process_identity_alive(
                    state['child']['pid'], state['child']['starttime'],
                    state['pidNamespaceInode'],
                ), 'rejected force credentials must not stop the pinned child')
                self.assertTrue(control(
                    state['socketAddress'], ready['generation'],
                    state['secret'], 'stop',
                ))
                before = time.monotonic()
                self.assertTrue(control(
                    state['socketAddress'], ready['generation'],
                    state['secret'], 'force',
                ))
                self.assertEqual(process.wait(timeout=5), 0)
                self.assertLess(time.monotonic() - before, 5)
                self.assertFalse(state_path.exists())
                self.assertEqual(recover_stale_generations(state_dir), [])
                with socket.socket() as probe:
                    probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    probe.bind(('127.0.0.1', port))
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)
                process.stdout.close()
                process.stderr.close()

    def test_detach_ack_survives_cli_exit_and_normal_stop_uses_same_generation(self):
        with adopt_orphaned_test_processes(), tempfile.TemporaryDirectory() as directory:
            state_dir = isolated_state_dir(directory)
            port = free_port()
            client_script = write_detach_cli(directory)
            client = launch_detach_cli(
                client_script, state_dir,
                mini_server_command(port, ignore_sigterm=False), port,
            )
            state = None
            try:
                stdout, stderr = client.communicate(timeout=15)
                self.assertEqual(client.returncode, 0, stderr)
                lines = [json.loads(line) for line in stdout.splitlines() if line]
                self.assertEqual([line['event'] for line in lines], [
                    'READY_PENDING', 'START_CONFIRMED',
                ])
                state_path = state_dir / lines[0]['stateName']
                state = json.loads(state_path.read_text(encoding='utf-8'))
                status = control_response(
                    state['socketAddress'], state['generation'], state['secret'], 'status',
                )
                self.assertEqual(status['phase'], 'detached')
                self.assertEqual(status['parentDeathSignal'], 0)
                self.assertTrue(process_identity_alive(
                    state['supervisor']['pid'], state['supervisor']['starttime'],
                    state['pidNamespaceInode'],
                ))
                self.assertTrue(process_identity_alive(
                    state['child']['pid'], state['child']['starttime'],
                    state['pidNamespaceInode'],
                ))
                self.assertEqual(
                    observe_direct_child_listener(
                        state['child']['pid'], port, state['networkNamespaceInode'],
                    )[1],
                    state['child']['pid'],
                )

                self.assertTrue(control(
                    state['socketAddress'], state['generation'], state['secret'], 'stop',
                ))
                wait_for_exact_identity_exit(state['child'], state['pidNamespaceInode'])
                wait_for_exact_identity_exit(state['supervisor'], state['pidNamespaceInode'])
                self.assertFalse(state_path.exists())
                with socket.socket() as probe:
                    probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    probe.bind(('127.0.0.1', port))
            finally:
                if client.poll() is None:
                    client.kill()
                    client.wait(timeout=5)
                if state is not None:
                    cleanup_test_generation(state_dir, state)
                client.stdout.close()
                client.stderr.close()

    def test_detached_supervisor_crash_still_uses_child_parent_death_guard(self):
        with adopt_orphaned_test_processes(), tempfile.TemporaryDirectory() as directory:
            state_dir = isolated_state_dir(directory)
            port = free_port()
            client = launch_detach_cli(
                write_detach_cli(directory), state_dir,
                mini_server_command(port), port,
            )
            state = None
            try:
                stdout, stderr = client.communicate(timeout=15)
                self.assertEqual(client.returncode, 0, stderr)
                pending = json.loads(stdout.splitlines()[0])
                state_path = state_dir / pending['stateName']
                state = json.loads(state_path.read_text(encoding='utf-8'))

                supervisor = PinnedProcess(state['supervisor']['pid'])
                try:
                    supervisor.verify_procfs_pid()
                    self.assertEqual(
                        read_process_starttime(state['supervisor']['pid']),
                        state['supervisor']['starttime'],
                    )
                    supervisor.verify_owner(lambda: supervisor.pid)
                    supervisor.send(signal.SIGKILL)
                finally:
                    supervisor.close()
                wait_for_exact_identity_exit(state['supervisor'], state['pidNamespaceInode'])
                wait_for_exact_identity_exit(state['child'], state['pidNamespaceInode'])
                self.assertTrue(state_path.exists(), 'crash state must remain for explicit recovery')
                self.assertEqual(
                    recover_stale_generations(state_dir), [state['generation']],
                )
                self.assertFalse(state_path.exists())
                with socket.socket() as probe:
                    probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    probe.bind(('127.0.0.1', port))
            finally:
                if client.poll() is None:
                    client.kill()
                    client.wait(timeout=5)
                if state is not None:
                    cleanup_test_generation(state_dir, state)
                client.stdout.close()
                client.stderr.close()

    def test_supervisor_crash_after_guard_clear_before_ack_kills_child_and_preserves_state(self):
        with adopt_orphaned_test_processes(), tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            state_dir = isolated_state_dir(root)
            barrier = root / 'barriers'
            port = free_port()
            client = launch_detach_cli(
                write_detach_cli(root), state_dir,
                mini_server_command(port), port,
                env={'SEARCH_DOCS_TEST_DETACH_BARRIER_DIR': str(barrier)},
            )
            state = None
            try:
                with selectors.DefaultSelector() as selector:
                    selector.register(client.stdout, selectors.EVENT_READ)
                    self.assertTrue(selector.select(10), 'CLI did not receive provisional READY')
                pending = json.loads(client.stdout.readline())
                release_test_barrier(barrier, 'before-clear')
                wait_for_file(
                    barrier / 'after-clear-before-ack.entered', process=client,
                )
                state_path = state_dir / pending['stateName']
                state = json.loads(state_path.read_text(encoding='utf-8'))

                supervisor = PinnedProcess(state['supervisor']['pid'])
                try:
                    supervisor.verify_procfs_pid()
                    self.assertEqual(
                        read_process_starttime(state['supervisor']['pid']),
                        state['supervisor']['starttime'],
                    )
                    supervisor.verify_owner(lambda: supervisor.pid)
                    supervisor.send(signal.SIGKILL)
                finally:
                    supervisor.close()

                wait_for_exact_identity_exit(state['supervisor'], state['pidNamespaceInode'])
                wait_for_exact_identity_exit(state['child'], state['pidNamespaceInode'])
                stdout, _stderr = client.communicate(timeout=5)
                self.assertNotEqual(
                    client.returncode, 0,
                    f'CLI must not treat a missing ownership ACK as success: {stdout}',
                )
                self.assertTrue(state_path.exists(), 'crash state must be preserved')
                self.assertEqual(
                    recover_stale_generations(state_dir), [state['generation']],
                )
                self.assertFalse(state_path.exists())
                with socket.socket() as probe:
                    probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    probe.bind(('127.0.0.1', port))
            finally:
                if client.poll() is None:
                    client.kill()
                    client.wait(timeout=5)
                if state is not None:
                    cleanup_test_generation(state_dir, state)
                client.stdout.close()
                client.stderr.close()

    def test_cli_exit_before_transfer_and_parent_death_before_clear_fail_closed(self):
        with adopt_orphaned_test_processes(), tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            state_dir = isolated_state_dir(root)
            port = free_port()
            client = launch_detach_cli(
                write_detach_cli(root), state_dir,
                mini_server_command(port), port, mode='pending-exit',
            )
            try:
                stdout, stderr = client.communicate(timeout=15)
                self.assertEqual(client.returncode, 0, stderr)
                pending = json.loads(stdout.splitlines()[0])
                state_path = state_dir / pending['stateName']
                state = json.loads(state_path.read_text(encoding='utf-8'))
                wait_for_exact_identity_exit(state['supervisor'], state['pidNamespaceInode'])
                wait_for_exact_identity_exit(state['child'], state['pidNamespaceInode'])
                self.assertTrue(state_path.exists())
                self.assertEqual(
                    recover_stale_generations(state_dir), [state['generation']],
                )
                self.assertFalse(state_path.exists())
            finally:
                if client.poll() is None:
                    client.kill()
                    client.wait(timeout=5)
                client.stdout.close()
                client.stderr.close()

            barrier = root / 'before-clear'
            state_dir = isolated_state_dir(root / 'before-clear-case')
            port = free_port()
            client = launch_detach_cli(
                write_detach_cli(root), state_dir,
                mini_server_command(port), port,
                env={'SEARCH_DOCS_TEST_DETACH_BARRIER_DIR': str(barrier)},
            )
            state = None
            try:
                with selectors.DefaultSelector() as selector:
                    selector.register(client.stdout, selectors.EVENT_READ)
                    self.assertTrue(selector.select(10), 'CLI did not receive provisional READY')
                pending = json.loads(client.stdout.readline())
                wait_for_file(barrier / 'before-clear.entered', process=client)
                state_path = state_dir / pending['stateName']
                state = json.loads(state_path.read_text(encoding='utf-8'))
                client.kill()
                client.wait(timeout=5)
                wait_for_exact_identity_exit(state['supervisor'], state['pidNamespaceInode'])
                wait_for_exact_identity_exit(state['child'], state['pidNamespaceInode'])
                self.assertTrue(state_path.exists(), 'unacknowledged generation must be preserved')
                self.assertEqual(
                    recover_stale_generations(state_dir), [state['generation']],
                )
                self.assertFalse(state_path.exists())
                with socket.socket() as probe:
                    probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    probe.bind(('127.0.0.1', port))
            finally:
                if client.poll() is None:
                    client.kill()
                    client.wait(timeout=5)
                if state is not None:
                    cleanup_test_generation(state_dir, state)
                client.stdout.close()
                client.stderr.close()

    def test_lost_transfer_ack_after_guard_clear_leaves_reconcilable_generation(self):
        with adopt_orphaned_test_processes(), tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            state_dir = isolated_state_dir(root)
            barrier = root / 'barriers'
            port = free_port()
            client = launch_detach_cli(
                write_detach_cli(root), state_dir,
                mini_server_command(port), port,
                mode='drop-ack',
                env={'SEARCH_DOCS_TEST_DETACH_BARRIER_DIR': str(barrier)},
            )
            state = None
            try:
                with selectors.DefaultSelector() as selector:
                    selector.register(client.stdout, selectors.EVENT_READ)
                    self.assertTrue(selector.select(10), 'CLI did not receive provisional READY')
                pending = json.loads(client.stdout.readline())
                release_test_barrier(barrier, 'before-clear')
                wait_for_file(
                    barrier / 'after-clear-before-ack.entered', process=client,
                )
                state_path = state_dir / pending['stateName']
                state = json.loads(state_path.read_text(encoding='utf-8'))
                with selectors.DefaultSelector() as selector:
                    selector.register(client.stdout, selectors.EVENT_READ)
                    self.assertTrue(selector.select(5), 'CLI did not report that ACK was dropped')
                dropped = json.loads(client.stdout.readline())
                self.assertEqual(dropped['event'], 'ACK_DROPPED')
                self.assertEqual(dropped['generation'], state['generation'])
                self.assertIsNone(client.poll(), 'starting CLI must remain alive while reconciling')
                release_test_barrier(barrier, 'after-clear-before-ack')
                with selectors.DefaultSelector() as selector:
                    selector.register(client.stdout, selectors.EVENT_READ)
                    self.assertTrue(
                        selector.select(10),
                        'same CLI did not reconcile the lost ACK against status and readiness',
                    )
                confirmed = json.loads(client.stdout.readline())
                self.assertEqual(confirmed['event'], 'START_CONFIRMED')
                self.assertEqual(confirmed['generation'], state['generation'])
                self.assertTrue(confirmed['recoveredAfterLostAck'])
                self.assertEqual(client.wait(timeout=5), 0, client.stderr.read())
                client.stdout.close()
                client.stderr.close()

                self.assertTrue(state_path.exists(), 'lost ACK must not remove live state')
                self.assertEqual(
                    observe_direct_child_listener(
                        state['child']['pid'], port, state['networkNamespaceInode'],
                    )[1],
                    state['child']['pid'],
                )

                self.assertTrue(control(
                    state['socketAddress'], state['generation'], state['secret'], 'force',
                ))
                wait_for_exact_identity_exit(state['child'], state['pidNamespaceInode'])
                wait_for_exact_identity_exit(state['supervisor'], state['pidNamespaceInode'])
                self.assertFalse(state_path.exists())
                with socket.socket() as probe:
                    probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    probe.bind(('127.0.0.1', port))
            finally:
                if client.poll() is None:
                    client.kill()
                    client.wait(timeout=5)
                if state is not None:
                    cleanup_test_generation(state_dir, state)

    def test_post_clear_error_reports_unconfirmed_transfer_then_same_cli_recovers(self):
        with adopt_orphaned_test_processes(), tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            state_dir = isolated_state_dir(root)
            port = free_port()
            client = launch_detach_cli(
                write_detach_cli(root), state_dir,
                mini_server_command(port), port,
                mode='recover-clear-failure',
                env={'SEARCH_DOCS_TEST_DETACH_FAIL_AFTER_CLEAR': '1'},
            )
            state = None
            try:
                with selectors.DefaultSelector() as selector:
                    selector.register(client.stdout, selectors.EVENT_READ)
                    self.assertTrue(selector.select(10), 'CLI did not receive provisional READY')
                pending = json.loads(client.stdout.readline())
                state_path = state_dir / pending['stateName']
                state = json.loads(state_path.read_text(encoding='utf-8'))

                with selectors.DefaultSelector() as selector:
                    selector.register(client.stdout, selectors.EVENT_READ)
                    self.assertTrue(
                        selector.select(10),
                        'CLI did not report the post-clear transfer outcome',
                    )
                ambiguous = json.loads(client.stdout.readline())
                self.assertEqual(ambiguous['event'], 'TRANSFER_UNCONFIRMED')
                self.assertEqual(ambiguous['outcome'], 'transferred-unconfirmed')
                self.assertEqual(ambiguous['phase'], 'transfer-unconfirmed')
                self.assertEqual(ambiguous['generation'], state['generation'])
                self.assertEqual(ambiguous['supervisor'], state['supervisor'])
                self.assertEqual(ambiguous['child'], state['child'])

                with selectors.DefaultSelector() as selector:
                    selector.register(client.stdout, selectors.EVENT_READ)
                    self.assertTrue(
                        selector.select(10),
                        'CLI did not reconcile the post-clear result',
                    )
                confirmed = json.loads(client.stdout.readline())
                self.assertEqual(confirmed['event'], 'START_CONFIRMED')
                self.assertEqual(confirmed['generation'], state['generation'])
                self.assertTrue(confirmed['recoveredAfterLostAck'])
                self.assertEqual(client.wait(timeout=5), 0, client.stderr.read())
                client.stdout.close()
                client.stderr.close()

                status = control_response(
                    state['socketAddress'], state['generation'], state['secret'], 'status',
                )
                self.assertEqual(status['phase'], 'transfer-unconfirmed')
                self.assertEqual(status['parentDeathSignal'], 0)
                self.assertEqual(status['generation'], state['generation'])
                self.assertEqual(status['supervisor'], state['supervisor'])
                self.assertEqual(status['child'], state['child'])
                self.assertEqual(
                    state_path.read_bytes(),
                    json.dumps(state, sort_keys=True, separators=(',', ':')).encode() + b'\n',
                )
                self.assertEqual(
                    observe_direct_child_listener(
                        state['child']['pid'], port, state['networkNamespaceInode'],
                    )[1],
                    state['child']['pid'],
                )
                self.assertTrue(control(
                    state['socketAddress'], state['generation'], state['secret'], 'force',
                ))
                wait_for_exact_identity_exit(state['child'], state['pidNamespaceInode'])
                wait_for_exact_identity_exit(state['supervisor'], state['pidNamespaceInode'])
                self.assertFalse(state_path.exists())
                with socket.socket() as probe:
                    probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    probe.bind(('127.0.0.1', port))
            finally:
                if client.poll() is None:
                    client.kill()
                    client.wait(timeout=5)
                if state is not None:
                    cleanup_test_generation(state_dir, state)

    def test_contradictory_post_clear_observation_is_unknown_not_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            state_dir = isolated_state_dir(directory)
            port = free_port()
            process, ready, state, state_path = launch_supervisor(
                state_dir,
                mini_server_command(port),
                port,
                extra_env={'SEARCH_DOCS_TEST_DETACH_REPORT_UNKNOWN': '1'},
            )
            try:
                response = control_response(
                    state['socketAddress'], state['generation'], state['secret'], 'detach',
                )
                self.assertFalse(response['accepted'])
                self.assertEqual(response['outcome'], 'unknown')
                self.assertEqual(response['phase'], 'transfer-unknown')
                self.assertEqual(response['generation'], state['generation'])
                self.assertEqual(response['supervisor'], state['supervisor'])
                self.assertEqual(response['child'], state['child'])

                status = control_response(
                    state['socketAddress'], state['generation'], state['secret'], 'status',
                )
                ready_status = control_response(
                    state['socketAddress'], state['generation'], state['secret'], 'verify-ready',
                )
                self.assertEqual(status['phase'], 'transfer-unknown')
                self.assertEqual(status['parentDeathSignal'], 0)
                self.assertEqual(status['generation'], state['generation'])
                self.assertEqual(status['supervisor'], state['supervisor'])
                self.assertEqual(status['child'], state['child'])
                self.assertTrue(ready_status['accepted'])
                self.assertEqual(ready_status['generation'], state['generation'])
                self.assertEqual(ready_status['supervisor'], state['supervisor'])
                self.assertEqual(ready_status['child'], state['child'])
                self.assertTrue(state_path.exists())
                self.assertEqual(
                    observe_direct_child_listener(
                        state['child']['pid'], port, state['networkNamespaceInode'],
                    )[1],
                    state['child']['pid'],
                )
            finally:
                control(
                    state['socketAddress'], ready['generation'],
                    state['secret'], 'force',
                )
                process.wait(timeout=5)
                process.stdout.close()
                process.stderr.close()

    @unittest.skipUnless(os.geteuid() == 0, 'requires root to create a different-UID client')
    def test_force_rejects_foreign_slow_clients_before_reading_and_keeps_auth(self):
        with tempfile.TemporaryDirectory() as directory:
            state_dir = isolated_state_dir(directory)
            port = free_port()
            process, ready, state, state_path = launch_supervisor(
                state_dir, mini_server_command(port), port,
            )
            clients = []
            try:
                valid_body_from_foreign_uid = json.dumps({
                    'generation': state['generation'],
                    'secret': state['secret'],
                    'action': 'force',
                }) + '\n'
                clients.append(launch_foreign_uid_socket_client(
                    state['forceSocketAddress'], valid_body_from_foreign_uid,
                ))
                for _ in range(4):
                    clients.append(launch_foreign_uid_socket_client(
                        state['forceSocketAddress'],
                    ))
                for client in clients:
                    self.assertEqual(read_line_with_timeout(client.stdout).strip(), 'connected')

                self.assertIn(
                    read_line_with_timeout(clients[0].stdout).strip(),
                    ('eof', 'closed-error'),
                    'the foreign UID client must be closed without authenticating its body',
                )
                self.assertTrue(process_identity_alive(
                    state['child']['pid'], state['child']['starttime'],
                    state['pidNamespaceInode'],
                ), 'a different-UID request must be rejected before its valid-looking body')
                started = time.monotonic()
                response = control_response(
                    state['forceSocketAddress'], state['generation'],
                    state['secret'], 'force', timeout=2,
                )
                elapsed = time.monotonic() - started
                self.assertTrue(response['accepted'], response)
                self.assertLess(elapsed, 1.0, 'foreign slow clients delayed the valid force')
                wait_for_exact_identity_exit(
                    state['child'], state['pidNamespaceInode'], timeout=2,
                )
                self.assertEqual(process.wait(timeout=5), 0, process.stderr.read())
                self.assertFalse(state_path.exists())
                with socket.socket() as probe:
                    probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    probe.bind(('127.0.0.1', port))
            finally:
                for client in clients:
                    if client.poll() is None:
                        client.terminate()
                        client.wait(timeout=5)
                    client.stdout.close()
                    client.stderr.close()
                if process.poll() is None:
                    cleanup_test_generation(state_dir, state)
                    process.wait(timeout=5)
                process.stdout.close()
                process.stderr.close()

    def test_force_bounds_slow_multi_connection_and_oversized_requests(self):
        with tempfile.TemporaryDirectory() as directory:
            state_dir = isolated_state_dir(directory)
            port = free_port()
            process, ready, state, state_path = launch_supervisor(
                state_dir, mini_server_command(port), port,
            )
            clients = []
            try:
                oversized = socket.socket(socket.AF_UNIX)
                oversized.settimeout(2)
                oversized.connect(state['forceSocketAddress'])
                oversized.sendall(b'x' * 4097 + b'\n')
                try:
                    oversized_response = oversized.recv(1)
                except ConnectionResetError:
                    oversized_response = b''
                self.assertEqual(oversized_response, b'',
                                 'requests larger than 4096 bytes must be closed without parsing')
                oversized.close()
                self.assertTrue(process_identity_alive(
                    state['child']['pid'], state['child']['starttime'],
                    state['pidNamespaceInode'],
                ), 'an oversized unauthenticated body must not stop the child')

                for _ in range(3):
                    client = launch_same_uid_socket_client(state['forceSocketAddress'])
                    clients.append(client)
                    self.assertEqual(read_line_with_timeout(client.stdout).strip(), 'connected')

                started = time.monotonic()
                response = control_response(
                    state['forceSocketAddress'], state['generation'],
                    state['secret'], 'force', timeout=2,
                )
                elapsed = time.monotonic() - started
                self.assertTrue(response['accepted'], response)
                self.assertLess(
                    elapsed, 1.0,
                    'three same-UID incomplete requests exceeded the bounded force delay',
                )
                wait_for_exact_identity_exit(
                    state['child'], state['pidNamespaceInode'], timeout=2,
                )
                for client in clients:
                    self.assertIn(
                        read_line_with_timeout(client.stdout),
                        ('eof\n', 'closed-error\n'),
                    )
                self.assertEqual(process.wait(timeout=5), 0, process.stderr.read())
                self.assertFalse(state_path.exists())
                with socket.socket() as probe:
                    probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    probe.bind(('127.0.0.1', port))
            finally:
                for client in clients:
                    if client.poll() is None:
                        client.terminate()
                        client.wait(timeout=5)
                    client.stdout.close()
                    client.stderr.close()
                if process.poll() is None:
                    cleanup_test_generation(state_dir, state)
                    process.wait(timeout=5)
                process.stdout.close()
                process.stderr.close()

    def test_direct_child_listener_probe_does_not_scan_unrelated_processes(self):
        self.assertNotEqual(os.geteuid(), 0, 'this visibility probe must run unprivileged')
        with tempfile.TemporaryDirectory() as directory:
            port = free_port()
            listener_source = (
                'import socket,sys,time; '
                'server=socket.socket(); server.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); '
                'server.bind(("0.0.0.0",int(sys.argv[1]))); server.listen(); '
                'print("ready",flush=True); time.sleep(30)'
            )
            hidden_source = (
                'import ctypes,time; libc=ctypes.CDLL(None,use_errno=True); '
                'rc=libc.prctl(4,0,0,0,0); '
                'print("hidden" if rc == 0 else "visible",flush=True); time.sleep(30)'
            )
            listener = subprocess.Popen(
                [sys.executable, '-u', '-c', listener_source, str(port)],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
            unrelated = subprocess.Popen(
                [sys.executable, '-u', '-c', hidden_source],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
            try:
                self.assertEqual(listener.stdout.readline().strip(), 'ready')
                unrelated_visibility = unrelated.stdout.readline().strip()
                inaccessible = False
                try:
                    with os.scandir(f'/proc/{unrelated.pid}/fd') as descriptors:
                        list(descriptors)
                except PermissionError:
                    inaccessible = True
                self.assertEqual(unrelated_visibility, 'hidden')

                scanned_paths = []
                original_scandir = os.scandir

                def recording_scandir(path):
                    scanned_paths.append(os.fspath(path))
                    return original_scandir(path)

                with PinnedProcess(listener.pid) as pinned:
                    pinned.verify_procfs_pid()
                    listener_starttime = read_process_starttime(listener.pid)
                    with patch(
                        'managed_supervisor_prototype.os.scandir',
                        side_effect=recording_scandir,
                    ):
                        inodes, owner = observe_direct_child_listener(
                            listener.pid, port, current_network_namespace_inode(),
                        )
                    self.assertEqual(owner, listener.pid)
                    self.assertEqual(len(inodes), 1)
                    self.assertEqual(
                        scanned_paths,
                        [f'/proc/{listener.pid}/fd'],
                        'the probe must inspect only the pinned child FD directory',
                    )
                    pinned.verify_owner(
                        lambda: observe_direct_child_listener(
                            listener.pid, port, current_network_namespace_inode(),
                        )[1],
                    )
                    self.assertEqual(read_process_starttime(listener.pid), listener_starttime)
                self.assertTrue(
                    inaccessible,
                    'the same-UID non-dumpable sibling should be unreadable to this probe',
                )
            finally:
                for process in (listener, unrelated):
                    if process.poll() is None:
                        process.terminate()
                        process.wait(timeout=5)
                    process.stdout.close()
                    process.stderr.close()

    def test_direct_child_listener_probe_refuses_network_namespace_mismatch(self):
        expected_namespace = current_network_namespace_inode()
        with patch(
            'managed_supervisor_prototype.process_network_namespace_inode',
            return_value=expected_namespace + 1,
        ), patch('managed_supervisor_prototype._listener_inodes') as listeners:
            with self.assertRaisesRegex(TargetUnavailable, 'another network namespace'):
                observe_direct_child_listener(os.getpid(), 1, expected_namespace)
            listeners.assert_not_called()

    @unittest.skipUnless(os.geteuid() == 0, 'requires root to attempt an isolated network namespace')
    def test_direct_child_listener_probe_refuses_real_network_namespace_mismatch(self):
        address = '\0search-docs-test-' + uuid.uuid4().hex
        control_listener = socket.socket(socket.AF_UNIX)
        control_listener.bind(address)
        control_listener.listen(1)
        child_source = r'''
import ctypes, errno, json, os, socket, sys, time
libc = ctypes.CDLL(None, use_errno=True)
if libc.unshare(0x40000000) != 0:  # CLONE_NEWNET
    print(json.dumps({'unshare_errno': ctypes.get_errno()}), flush=True)
    sys.exit(0)
listener = socket.socket()
listener.bind(('127.0.0.1', 0))
listener.listen()
control = socket.socket(socket.AF_UNIX)
try:
    control.connect(bytes.fromhex(sys.argv[1]))
    control_result = 'connected'
except OSError as error:
    control_result = f'blocked:{error.errno}'
print(json.dumps({
    'networkNamespaceInode': os.stat('/proc/self/ns/net').st_ino,
    'port': listener.getsockname()[1],
    'socketLink': os.readlink(f'/proc/self/fd/{listener.fileno()}'),
    'controlResult': control_result,
}), flush=True)
time.sleep(30)
'''
        process = subprocess.Popen(
            [sys.executable, '-u', '-c', child_source, address.encode().hex()],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        pinned = None
        try:
            line = read_line_with_timeout(process.stdout, timeout=5)
            result = json.loads(line)
            if 'unshare_errno' in result:
                self.skipTest(
                    f'container lacks CLONE_NEWNET capability (errno {result["unshare_errno"]})'
                )
            pinned = PinnedProcess(process.pid)
            pinned.verify_procfs_pid()
            starttime = read_process_starttime(process.pid)
            pinned.verify_owner(lambda: process.pid)
            self.assertNotEqual(
                result['networkNamespaceInode'],
                current_network_namespace_inode(),
            )
            self.assertTrue(result['socketLink'].startswith('socket:['))
            self.assertNotEqual(result['controlResult'], 'connected')
            with patch('managed_supervisor_prototype._listener_inodes') as listeners:
                with self.assertRaisesRegex(TargetUnavailable, 'another network namespace'):
                    observe_direct_child_listener(
                        process.pid, result['port'], current_network_namespace_inode(),
                    )
                listeners.assert_not_called()
            self.assertEqual(read_process_starttime(process.pid), starttime)
            self.assertFalse(pinned.exited())
        finally:
            if pinned is not None:
                if not pinned.exited():
                    pinned.send(signal.SIGKILL)
                    pinned.exited(5000)
                pinned.close()
            process.wait(timeout=5)
            process.stdout.close()
            process.stderr.close()
            control_listener.close()

    def test_force_cleanup_preserves_generation_while_shared_listener_remains(self):
        with adopt_orphaned_test_processes(), tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            state_dir = isolated_state_dir(root)
            port = free_port()
            token = uuid.uuid4().hex
            identity_file = root / 'shared-listener-holder.json'
            launcher = root / 'server-with-shared-listener.py'
            server_source = r'''
import json, os, pathlib, signal, sys, time
from http.server import BaseHTTPRequestHandler, HTTPServer
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b'{"ready":true}'
        self.send_response(200); self.send_header('Content-Length', str(len(body)))
        self.end_headers(); self.wfile.write(body)
    def log_message(self, *_args): pass
server = HTTPServer(('127.0.0.1', int(sys.argv[1])), Handler)
pid = os.fork()
if pid == 0:
    os.setsid()
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    while True: time.sleep(1)
stat = pathlib.Path(f'/proc/{pid}/stat').read_text()
fields = stat[stat.rfind(')') + 1:].split()
pathlib.Path(sys.argv[2]).write_text(json.dumps({
    'pid': pid, 'starttime': int(fields[19]),
}))
server.serve_forever()
'''
            launcher.write_text(
                'import os, sys\n'
                f"os.execv(sys.executable, [sys.executable, '-u', '-c', {server_source!r}, "
                f"{str(port)!r}, {str(identity_file)!r}, {token!r}])\n",
                encoding='utf-8',
            )
            process = None
            direct = None
            pinned = None
            state_path = None
            identity = None
            try:
                process, ready, state, state_path = launch_supervisor(
                    state_dir, [launcher], port,
                )
                identity = json.loads(identity_file.read_text(encoding='utf-8'))
                pinned = pin_test_descendant(identity_file, token)
                direct = PinnedProcess(state['child']['pid'])
                direct.verify_procfs_pid()
                direct.verify_owner(lambda: observe_direct_child_listener(
                    state['child']['pid'], port, state['networkNamespaceInode'],
                )[1])

                listener_inodes = _listener_inodes(port)
                self.assertEqual(len(listener_inodes), 1)
                for pid in (state['child']['pid'], identity['pid']):
                    with os.scandir(f'/proc/{pid}/fd') as descriptors:
                        child_sockets = {
                            os.readlink(descriptor.path)[8:-1]
                            for descriptor in descriptors
                            if os.readlink(descriptor.path).startswith('socket:[')
                        }
                    self.assertTrue(listener_inodes.issubset(child_sockets))

                force = control_response(
                    state['forceSocketAddress'], ready['generation'],
                    state['secret'], 'force',
                )
                self.assertTrue(force['accepted'], force)
                self.assertEqual(process.wait(timeout=5), 0, process.stderr.read())
                process.stdout.close()
                process.stderr.close()
                process = None
                self.assertTrue(direct.exited(1000), 'the exact direct child should be killed')
                reap_if_child(state['child']['pid'])
                self.assertFalse(pinned.exited(), 'the forked holder should keep the shared socket')
                self.assertTrue(state_path.exists())
                self.assertFalse(process_group_alive(state['processGroupId']))
                self.assertEqual(_listener_inodes(port), listener_inodes)
                with self.assertRaises(GenerationInUse):
                    recover_stale_generations(state_dir)
                self.assertTrue(state_path.exists(), 'cleanup must retain state while LISTEN remains')
                with socket.socket() as probe:
                    with self.assertRaises(OSError):
                        probe.bind(('127.0.0.1', port))

                pinned.send(signal.SIGKILL)
                self.assertTrue(pinned.exited(5000))
                reap_if_child(identity['pid'])
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline and _listener_inodes(port):
                    reap_if_child(identity['pid'])
                    time.sleep(0.02)
                self.assertEqual(recover_stale_generations(state_dir), [ready['generation']])
                self.assertFalse(state_path.exists())
                with socket.socket() as probe:
                    probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    probe.bind(('127.0.0.1', port))
            finally:
                if process is not None:
                    if process.poll() is None:
                        process.kill()
                    process.wait(timeout=5)
                    process.stdout.close()
                    process.stderr.close()
                if direct is not None:
                    direct.close()
                if pinned is not None:
                    if not pinned.exited():
                        pinned.send(signal.SIGKILL)
                        pinned.exited(5000)
                    pinned.close()
                    if identity is not None:
                        reap_if_child(identity['pid'])
                if state_path is not None and state_path.exists():
                    try:
                        recover_stale_generations(state_dir)
                    except StateSafetyError:
                        pass

    def test_force_sidechannel_interrupts_detach_without_using_pdeathsig_worker(self):
        cases = (
            ('during-readiness', {'SEARCH_DOCS_TEST_DETACH_READINESS_BARRIER': '1'}),
            ('after-clear-before-ack', {}),
        )
        for stage, extra_env in cases:
            with adopt_orphaned_test_processes(), self.subTest(stage=stage), tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory)
                state_dir = isolated_state_dir(root)
                barrier = root / 'barriers'
                port = free_port()
                process, ready, state, state_path = launch_supervisor(
                    state_dir,
                    mini_server_command(port),
                    port,
                    extra_env={
                        'SEARCH_DOCS_TEST_DETACH_BARRIER_DIR': str(barrier),
                        **extra_env,
                    },
                )
                detach_result = []
                detach_error = []

                def detach():
                    try:
                        detach_result.append(control_response(
                            state['socketAddress'], state['generation'],
                            state['secret'], 'detach', timeout=10,
                        ))
                    except BaseException as error:
                        detach_error.append(error)

                detach_thread = threading.Thread(target=detach, daemon=True)
                slow_clients = []
                try:
                    detach_thread.start()
                    if stage == 'after-clear-before-ack':
                        wait_for_file(barrier / 'before-clear.entered')
                        release_test_barrier(barrier, 'before-clear')
                    wait_for_file(barrier / f'{stage}.entered')

                    for _ in range(2):
                        slow_client = socket.socket(socket.AF_UNIX)
                        slow_client.settimeout(2)
                        slow_client.connect(state['forceSocketAddress'])
                        slow_clients.append(slow_client)

                    started = time.monotonic()
                    force = control_response(
                        state['forceSocketAddress'], state['generation'],
                        state['secret'], 'force', timeout=2,
                    )
                    force_elapsed = time.monotonic() - started
                    self.assertTrue(force['accepted'], force)
                    self.assertEqual(force['event'], 'FORCE_SENT')
                    self.assertLess(
                        force_elapsed, 1.0,
                        'force waited for detach or multiple incomplete request bodies',
                    )
                    for slow_client in slow_clients:
                        self.assertEqual(
                            slow_client.recv(1), b'',
                            'an incomplete request must time out and release its connection',
                        )
                    wait_for_exact_identity_exit(
                        state['child'], state['pidNamespaceInode'], timeout=2,
                    )
                    self.assertTrue(
                        state_path.exists(),
                        'the main-thread detach handler must retain state until it resumes',
                    )

                    release_test_barrier(barrier, stage)
                    if stage == 'after-clear-before-ack':
                        release_test_barrier(barrier, 'after-clear-before-ack')
                    detach_thread.join(timeout=5)
                    self.assertFalse(detach_thread.is_alive())
                    self.assertEqual(detach_error, [])
                    self.assertEqual(len(detach_result), 1)
                    observed_pdeath = int(
                        (barrier / f'{stage}.pdeath').read_text(encoding='ascii')
                    )
                    self.assertEqual(
                        observed_pdeath,
                        signal.SIGKILL if stage == 'during-readiness' else 0,
                        'the detach/PDEATHSIG-owning thread changed state during force',
                    )
                    self.assertFalse(detach_result[0]['accepted'])
                    self.assertEqual(
                        detach_result[0]['outcome'],
                        'transferred-unconfirmed'
                        if stage == 'after-clear-before-ack'
                        else 'not-transferred',
                    )
                    self.assertEqual(detach_result[0]['phase'], 'stopping')
                    self.assertEqual(process.wait(timeout=5), 0, process.stderr.read())
                    self.assertFalse(state_path.exists())
                    with socket.socket() as probe:
                        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                        probe.bind(('127.0.0.1', port))
                finally:
                    release_test_barrier(barrier, 'during-readiness')
                    release_test_barrier(barrier, 'before-clear')
                    release_test_barrier(barrier, 'after-clear-before-ack')
                    if detach_thread.is_alive():
                        detach_thread.join(timeout=3)
                    if process.poll() is None:
                        cleanup_test_generation(state_dir, state)
                        process.wait(timeout=5)
                    process.stdout.close()
                    process.stderr.close()
                    for slow_client in slow_clients:
                        slow_client.close()

    def test_detach_rechecks_state_readiness_and_guard_clear_before_ack(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            state_dir = isolated_state_dir(root)
            port = free_port()
            ready_off_file = root / 'ready-off'
            process, ready, state, state_path = launch_supervisor(
                state_dir,
                mini_server_command(port, ready_off_file=ready_off_file),
                port,
                extra_env={'SEARCH_DOCS_TEST_DETACH_FAIL_CLEAR': '1'},
            )
            try:
                original = state_path.read_bytes()
                outsider_script = r'''
import json, socket, sys
request = json.load(sys.stdin)
with socket.socket(socket.AF_UNIX) as client:
    client.settimeout(5)
    client.connect(request['socketAddress'])
    client.sendall(json.dumps({
        'generation': request['generation'],
        'secret': request['secret'],
        'action': 'detach',
    }).encode() + b'\n')
    print(client.makefile('rb').readline().decode(), end='')
'''
                outsider = subprocess.run(
                    [sys.executable, '-c', outsider_script],
                    input=json.dumps({
                        'socketAddress': state['socketAddress'],
                        'generation': state['generation'],
                        'secret': state['secret'],
                    }),
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                self.assertEqual(outsider.returncode, 0, outsider.stderr)
                outsider_result = json.loads(outsider.stdout)
                self.assertFalse(outsider_result['accepted'])
                self.assertEqual(outsider_result['outcome'], 'not-transferred')
                status = control_response(
                    state['socketAddress'], state['generation'], state['secret'], 'status',
                )
                self.assertEqual(status['phase'], 'attached')
                self.assertEqual(status['parentDeathSignal'], signal.SIGKILL)

                changed = dict(state)
                changed['secret'] = 'a' * 64
                state_path.write_text(json.dumps(changed) + '\n', encoding='utf-8')
                response = control_response(
                    state['socketAddress'], state['generation'], state['secret'], 'detach',
                )
                self.assertFalse(response['accepted'])
                self.assertEqual(response['outcome'], 'not-transferred')
                status = control_response(
                    state['socketAddress'], state['generation'], state['secret'], 'status',
                )
                self.assertEqual(status['phase'], 'attached')
                self.assertEqual(status['parentDeathSignal'], signal.SIGKILL)
                state_path.write_bytes(original)

                ready_off_file.touch()
                response = control_response(
                    state['socketAddress'], state['generation'], state['secret'], 'detach',
                )
                self.assertFalse(response['accepted'])
                self.assertEqual(response['outcome'], 'not-transferred')
                status = control_response(
                    state['socketAddress'], state['generation'], state['secret'], 'status',
                )
                self.assertEqual(status['phase'], 'attached')
                self.assertEqual(status['parentDeathSignal'], signal.SIGKILL)
                ready_off_file.unlink()

                response = control_response(
                    state['socketAddress'], state['generation'], state['secret'], 'detach',
                )
                self.assertFalse(response['accepted'])
                self.assertEqual(response['outcome'], 'not-transferred')
                self.assertEqual(response['phase'], 'attached')
                self.assertIn('clear failure', response['reason'])
                status = control_response(
                    state['socketAddress'], state['generation'], state['secret'], 'status',
                )
                self.assertEqual(status['phase'], 'attached')
                self.assertEqual(status['parentDeathSignal'], signal.SIGKILL)
                self.assertEqual(state_path.read_bytes(), original)
            finally:
                control(
                    state['socketAddress'], ready['generation'],
                    state['secret'], 'force',
                )
                process.wait(timeout=5)
                process.stdout.close()
                process.stderr.close()

    def test_same_port_concurrent_start_is_serialized_and_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            state_dir = isolated_state_dir(directory)
            port = free_port()
            first, ready, state, state_path = launch_supervisor(
                state_dir, mini_server_command(port), port,
            )
            second = None
            try:
                second = subprocess.Popen(
                    [
                        sys.executable, str(SCRIPT),
                        '--state-dir', str(state_dir),
                        '--port', str(port),
                        '--parent-pid', str(os.getpid()),
                        '--parent-starttime', str(read_process_starttime(os.getpid())),
                        '--startup-timeout', '5',
                        '--', *mini_server_command(port),
                    ],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    env=supervisor_env(state_dir),
                )
                self.assertNotEqual(second.wait(timeout=5), 0)
                self.assertIn('GenerationInUse', second.stderr.read())
                self.assertEqual(
                    sorted(path.name for path in state_dir.glob('port-*')),
                    [state_path.name],
                )
                self.assertTrue(process_identity_alive(
                    state['child']['pid'], state['child']['starttime'],
                    state['pidNamespaceInode'],
                ))
                self.assertEqual(
                    observe_direct_child_listener(
                        state['child']['pid'], port, state['networkNamespaceInode'],
                    )[1],
                    state['child']['pid'],
                )
            finally:
                if second is not None:
                    second.stdout.close()
                    second.stderr.close()
                if first.poll() is None:
                    control(
                        state['socketAddress'], ready['generation'],
                        state['secret'], 'force',
                    )
                    first.wait(timeout=5)
                first.stdout.close()
                first.stderr.close()

    def test_real_embedding_server_stops_restarts_and_reclaims_own_generation(self):
        from test_embedding_server_main_stdlib import LAUNCHER
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            launcher = root / 'launcher.py'
            launcher.write_text(
                f"import sys; sys.path.insert(0, {str(PYTHON_DIR)!r})\n" + LAUNCHER
            )
            port = free_port()
            state_dir = isolated_state_dir(root)
            for _run in range(2):
                process, ready, state, state_path = launch_supervisor(
                    state_dir,
                    [launcher, '--port', str(port), '--model-path', temp],
                    port,
                    timeout=30,
                )
                try:
                    self.assertTrue(control(
                        state['socketAddress'], ready['generation'],
                        state['secret'], 'verify-ready',
                    ))
                    self.assertEqual(
                        observe_direct_child_listener(
                            state['child']['pid'], port, state['networkNamespaceInode'],
                        )[1],
                        state['child']['pid'],
                    )
                    self.assertTrue(control(
                        state['socketAddress'], ready['generation'],
                        state['secret'], 'stop',
                    ))
                    self.assertEqual(process.wait(timeout=8), 0)
                    self.assertFalse(state_path.exists())
                    with socket.socket() as probe:
                        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                        probe.bind(('127.0.0.1', port))
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.wait(timeout=5)
                    process.stdout.close()
                    process.stderr.close()

    def test_supervisor_crash_kills_child_and_recovery_removes_only_dead_generation(self):
        with adopt_orphaned_test_processes(), tempfile.TemporaryDirectory() as directory:
            state_dir = isolated_state_dir(directory)
            port = free_port()
            process, ready, state, state_path = launch_supervisor(
                state_dir, mini_server_command(port), port,
            )
            child_pid = state['child']['pid']
            child_starttime = state['child']['starttime']
            temporary_path = pathlib.Path(f'{state_path}.tmp')
            os.link(state_path, temporary_path)
            process.kill()
            self.assertIsNotNone(process.wait(timeout=5))
            process.stdout.close()
            process.stderr.close()

            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                try:
                    alive = process_identity_alive(
                        child_pid, child_starttime, state['pidNamespaceInode'],
                    )
                except StateSafetyError:
                    raise
                if not alive:
                    break
                time.sleep(0.02)
            self.assertFalse(process_identity_alive(
                child_pid, child_starttime, state['pidNamespaceInode'],
            ), 'PDEATHSIG must reap the server child after supervisor death')
            reap_if_child(child_pid)
            self.assertTrue(state_path.exists(), 'crash state must remain until explicit recovery')
            self.assertEqual(recover_stale_generations(state_dir), [ready['generation']])
            self.assertFalse(state_path.exists())
            self.assertFalse(temporary_path.exists())
            with socket.socket() as probe:
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                probe.bind(('127.0.0.1', port))

    def test_recovery_refuses_live_identity_namespace_mismatch_and_legacy_state(self):
        with tempfile.TemporaryDirectory() as directory:
            state_dir = isolated_state_dir(directory)
            port = free_port()
            process, _ready, state, state_path = launch_supervisor(
                state_dir, mini_server_command(port), port,
            )
            try:
                with self.assertRaises(GenerationInUse):
                    recover_stale_generations(state_dir)
                self.assertTrue(state_path.exists())
                original = state_path.read_bytes()
                with patch(
                    'embedding_supervisor_state.current_network_namespace_inode',
                    return_value=state['networkNamespaceInode'] + 1,
                ), patch('embedding_supervisor_state._listener_inodes') as listeners:
                    self.assertFalse(remove_current_generation(state_dir, state))
                    listeners.assert_not_called()
                self.assertEqual(
                    state_path.read_bytes(), original,
                    'cleanup must preserve state when network namespace identity differs',
                )
            finally:
                control(
                    state['socketAddress'], state['generation'],
                    state['secret'], 'force',
                )
                process.wait(timeout=5)
                process.stdout.close()
                process.stderr.close()
            state['networkNamespaceInode'] += 1
            state_path.write_text(json.dumps(state))
            state_path.chmod(0o600)
            before = state_path.read_bytes()
            with patch('embedding_supervisor_state.process_identity_alive') as is_alive:
                with self.assertRaisesRegex(StateSafetyError, 'network namespace'):
                    recover_stale_generations(state_dir)
                is_alive.assert_not_called()
            self.assertEqual(state_path.read_bytes(), before)
            state['networkNamespaceInode'] -= 1
            state['pidNamespaceInode'] += 1
            state_path.write_text(json.dumps(state))
            state_path.chmod(0o600)
            with self.assertRaises(StateSafetyError):
                recover_stale_generations(state_dir)
            self.assertTrue(state_path.exists())
            state_path.unlink()
            legacy = state_dir / f'port-{port}.json'
            legacy.write_text('{}')
            with self.assertRaises(StateSafetyError):
                recover_stale_generations(state_dir)
            self.assertTrue(legacy.exists())


@unittest.skipUnless(sys.platform == 'linux' and hasattr(os, 'pidfd_open'), 'requires Linux pidfd')
class GenerationStateTest(unittest.TestCase):
    def test_procfs_namespace_mismatch_preserves_state_before_pid_starttime_lookup(self):
        with tempfile.TemporaryDirectory() as directory:
            state_dir = pathlib.Path(directory) / 'managed-state'
            port = free_port()
            generation = generation_id()
            identity = {
                'pid': os.getpid(),
                'starttime': read_process_starttime(os.getpid()),
            }
            record = {
                'version': 3,
                'generation': generation,
                'port': port,
                'secret': 'd' * 64,
                'pidNamespaceInode': current_pid_namespace_inode(),
                'networkNamespaceInode': current_network_namespace_inode(),
                'supervisor': identity,
                'child': identity,
                'processGroupId': identity['pid'],
                'socketAddress': f'\0search-docs-embedding-{os.geteuid()}-{generation}',
            }
            name = publish_generation(state_dir, record)
            state_path = state_dir / name
            before = state_path.read_bytes()
            with patch(
                'embedding_linux_pidfd._procfs_pid1_namespace_inode',
                return_value=current_pid_namespace_inode() + 1,
            ), patch('embedding_supervisor_state.read_process_starttime') as read_starttime:
                with self.assertRaisesRegex(StateSafetyError, 'PID namespace'):
                    recover_stale_generations(state_dir)
                read_starttime.assert_not_called()
            self.assertEqual(state_path.read_bytes(), before)

    def test_generation_publish_never_replaces_existing_state(self):
        with tempfile.TemporaryDirectory() as directory:
            state_dir = pathlib.Path(directory) / 'managed-state'
            port = free_port()
            generation = generation_id()
            identity = {
                'pid': os.getpid(),
                'starttime': read_process_starttime(os.getpid()),
            }
            record = {
                'version': 3,
                'generation': generation,
                'port': port,
                'secret': 'a' * 64,
                'pidNamespaceInode': current_pid_namespace_inode(),
                'networkNamespaceInode': current_network_namespace_inode(),
                'supervisor': identity,
                'child': identity,
                'processGroupId': identity['pid'],
                'socketAddress': f'\0search-docs-embedding-{os.geteuid()}-{generation}',
            }
            name = publish_generation(state_dir, record)
            final_path = state_dir / name
            before = final_path.read_bytes()
            replacement = dict(record, secret='b' * 64)
            with self.assertRaises(StateSafetyError):
                publish_generation(state_dir, replacement)
            self.assertEqual(final_path.read_bytes(), before)
            self.assertFalse((state_dir / f'{name}.tmp').exists())

    def test_recovery_recognizes_pid_reuse_by_starttime_without_signalling(self):
        with tempfile.TemporaryDirectory() as directory:
            state_dir = pathlib.Path(directory) / 'managed-state'
            port = free_port()
            generation = generation_id()
            identity = {
                'pid': os.getpid(),
                'starttime': read_process_starttime(os.getpid()) + 1,
            }
            record = {
                'version': 3,
                'generation': generation,
                'port': port,
                'secret': 'c' * 64,
                'pidNamespaceInode': current_pid_namespace_inode(),
                'networkNamespaceInode': current_network_namespace_inode(),
                'supervisor': identity,
                'child': identity,
                'processGroupId': identity['pid'],
                'socketAddress': f'\0search-docs-embedding-{os.geteuid()}-{generation}',
            }
            name = publish_generation(state_dir, record)
            self.assertTrue(process_identity_alive(
                os.getpid(), read_process_starttime(os.getpid()),
                record['pidNamespaceInode'],
            ))
            self.assertEqual(recover_stale_generations(state_dir), [generation])
            self.assertFalse((state_dir / name).exists())


if __name__ == '__main__':
    unittest.main()
