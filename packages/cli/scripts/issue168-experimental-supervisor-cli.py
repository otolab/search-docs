"""Disposable CLI for Issue #168's quarantined Linux supervisor experiment.

This file is under packages/cli/scripts (the package publishes dist only) and
controls only the prototype state below ~/.search-docs. It is not the supported
search-docs CLI.
"""
import argparse
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time

root = Path(__file__).resolve().parents[3]
python_dir = root / 'packages/db-engine/src/python'
experiments = python_dir / 'experiments'
sys.path.insert(0, str(python_dir))
sys.path.insert(0, str(experiments))

from embedding_control_lock import (  # noqa: E402
    embedding_lifecycle_lock,
    ensure_managed_state_directory,
    managed_state_lock,
)
from embedding_linux_pidfd import (  # noqa: E402
    PinnedProcess,
    TargetUnavailable,
    _listener_inodes,
)
from embedding_supervisor_state import (  # noqa: E402
    StateSafetyError,
    _MAX_STATE_BYTES,
    _open_state_directory,
    _read_state_at,
    current_generation_matches,
    current_network_namespace_inode,
    current_pid_namespace_inode,
    process_network_namespace_inode,
    read_process_starttime,
)
from managed_supervisor_prototype import (  # noqa: E402
    control_response,
    observe_direct_child_listener,
)

STATE_DIRECTORY = Path.home() / '.search-docs' / 'managed-embedding-prototype'
SUPERVISOR_SCRIPT = python_dir / 'tests' / 'embedding_supervisor_test_launcher.py'
GENERATION_FILE = re.compile(r'^port-(\d+)-([0-9a-f]{32})\.json$')
CONTROL_ATTEMPTS = 4
CONTROL_TIMEOUT = 0.4
RETRY_DELAY = 0.05
RECONCILE_TIMEOUT = 10


class CliError(RuntimeError):
    """The requested operation could not be proven safe and complete."""


def _state_files(directory, port):
    prefix = f'port-{port}-'
    try:
        entries = os.listdir(directory)
    except FileNotFoundError:
        return []
    return sorted(name for name in entries if name.startswith(prefix))


def _read_state(directory, port):
    """Read one complete generation without following a replaceable path."""
    ensure_managed_state_directory(directory)
    directory_fd = _open_state_directory(directory)
    try:
        names = _state_files(directory, port)
        if not names:
            raise CliError(f'no managed experimental generation exists for port {port}')
        if len(names) != 1:
            raise CliError(f'port {port} has ambiguous or incomplete generation state')
        name = names[0]
        match = GENERATION_FILE.fullmatch(name)
        if match is None or int(match.group(1)) != port:
            raise CliError(f'port {port} has unrecognized or incomplete generation state')
        generation = match.group(2)
        record, info = _read_state_at(directory_fd, name, port, generation)
        if info.st_size > _MAX_STATE_BYTES:
            raise CliError('generation state is too large')
        flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
        fd = os.open(name, flags, dir_fd=directory_fd)
        try:
            before = os.fstat(fd)
            if (
                before.st_dev != info.st_dev
                or before.st_ino != info.st_ino
                or before.st_uid != os.geteuid()
                or before.st_mode & 0o077
                or before.st_size > _MAX_STATE_BYTES
            ):
                raise CliError('generation state changed while it was being read')
            content = bytearray()
            while len(content) <= _MAX_STATE_BYTES:
                chunk = os.read(fd, min(4096, _MAX_STATE_BYTES + 1 - len(content)))
                if not chunk:
                    break
                content.extend(chunk)
            after = os.fstat(fd)
            if (
                len(content) > _MAX_STATE_BYTES
                or before.st_dev != after.st_dev
                or before.st_ino != after.st_ino
                or before.st_size != after.st_size
            ):
                raise CliError('generation state changed while it was being read')
        finally:
            os.close(fd)
        if not current_generation_matches(directory, record):
            raise CliError('generation state changed during validation')
        return record, bytes(content), name
    except (OSError, StateSafetyError, ValueError) as error:
        if isinstance(error, CliError):
            raise
        raise CliError(f'cannot safely read generation state: {error}') from error
    finally:
        os.close(directory_fd)


def _assert_same_state(directory, port, expected, expected_bytes, expected_name):
    record, content, name = _read_state(directory, port)
    if name != expected_name or record != expected or content != expected_bytes:
        raise CliError('the recorded generation changed during the operation')


def _assert_same_state_locked(directory, port, expected, expected_bytes, expected_name):
    """Serialize only the short state check, never a control request or wait."""
    with embedding_lifecycle_lock():
        with managed_state_lock(directory):
            _assert_same_state(directory, port, expected, expected_bytes, expected_name)


def _pin_identity(identity, namespace_inode, label):
    try:
        pinned = PinnedProcess(identity['pid'])
        pinned.verify_procfs_pid()
        if pinned.exited() or read_process_starttime(identity['pid']) != identity['starttime']:
            pinned.close()
            raise CliError(f'{label} no longer matches the recorded process generation')
        if current_pid_namespace_inode() != namespace_inode:
            pinned.close()
            raise CliError('the generation belongs to another PID namespace')
        return pinned
    except (OSError, TargetUnavailable, StateSafetyError) as error:
        if isinstance(error, CliError):
            raise
        raise CliError(f'cannot pin the recorded {label}: {error}') from error


def _verify_state_namespaces(record):
    if record['pidNamespaceInode'] != current_pid_namespace_inode():
        raise CliError('the generation belongs to another PID namespace')
    if record['networkNamespaceInode'] != current_network_namespace_inode():
        raise CliError('the generation belongs to another network namespace')
    try:
        if process_network_namespace_inode(record['child']['pid']) != record['networkNamespaceInode']:
            raise CliError('the recorded child belongs to another network namespace')
    except StateSafetyError as error:
        raise CliError(f'cannot verify the child network namespace: {error}') from error


def _validate_control_reply(reply, record, label):
    if (
        reply.get('generation') != record['generation']
        or reply.get('supervisor') != record['supervisor']
        or reply.get('child') != record['child']
    ):
        raise CliError(f'{label} response does not identify the recorded generation')


def _assert_listener(record):
    try:
        inodes, owner = observe_direct_child_listener(
            record['child']['pid'],
            record['port'],
            record['networkNamespaceInode'],
        )
    except (TargetUnavailable, StateSafetyError) as error:
        raise CliError(f'cannot verify the recorded child listener: {error}') from error
    if not inodes or owner != record['child']['pid']:
        raise CliError('the recorded child does not own the requested listener')


def _port_is_released(port):
    try:
        if _listener_inodes(port):
            return False
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind(('0.0.0.0', port))
        return True
    except (OSError, TargetUnavailable):
        return False


def _wait_for_completion(
    directory, port, record, state_name, child_ref, supervisor_ref,
    timeout=RECONCILE_TIMEOUT,
):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if child_ref.exited() and supervisor_ref.exited():
            break
        time.sleep(0.025)
    else:
        return False, ['the pinned child or supervisor is still alive']

    # Supervisor cleanup runs before its process exits. Allow a brief interval
    # for filesystem visibility, but never delete state from this CLI.
    cleanup_deadline = time.monotonic() + 2
    while time.monotonic() < cleanup_deadline:
        if state_name not in _state_files(directory, port):
            break
        time.sleep(0.025)
    else:
        return False, ['generation state remains; manual recovery is required']

    # Deterministic race hook for this unpublished experimental CLI only.
    # It pauses after the old generation is gone, before checking whether a
    # different generation has appeared for the same port.
    barrier_directory = os.environ.get('SEARCH_DOCS_TEST_COMPLETION_BARRIER_DIR')
    if barrier_directory:
        barrier = Path(barrier_directory)
        barrier.mkdir(mode=0o700, parents=True, exist_ok=True)
        entered = barrier / 'entered'
        descriptor = os.open(entered, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.write(descriptor, b'old generation exited and cleaned up\n')
        finally:
            os.close(descriptor)
        release = barrier / 'release'
        barrier_deadline = time.monotonic() + 30
        while not release.exists():
            if time.monotonic() >= barrier_deadline:
                return False, ['test completion barrier timed out']
            time.sleep(0.01)

    if _state_files(directory, port):
        return False, ['another or incomplete generation state exists for this port']
    if not _port_is_released(port):
        return False, ['a listener remains or port release cannot be confirmed']
    return True, [
        'the same child pidfd exited',
        'the same supervisor pidfd exited',
        'the generation state was removed by its supervisor',
        'the port has no visible listener and can be rebound',
    ]


def _retry_control(record, action, fail_connect_count=0):
    last_error = None
    response = None
    transport_failures = 0
    attempts = 0
    for attempts in range(1, CONTROL_ATTEMPTS + 1):
        try:
            if fail_connect_count > 0:
                fail_connect_count -= 1
                raise ConnectionRefusedError('injected one-shot connection failure')
            response = control_response(
                record['socketAddress'],
                record['generation'],
                record['secret'],
                action,
                timeout=CONTROL_TIMEOUT,
            )
            if response.get('accepted') is True:
                _validate_control_reply(response, record, action)
                return response, attempts, None, transport_failures
            last_error = CliError(f'{action} was not accepted: {response!r}')
        except (OSError, ValueError) as error:
            transport_failures += 1
            last_error = error
        except CliError as error:
            last_error = error
        if attempts < CONTROL_ATTEMPTS:
            time.sleep(RETRY_DELAY)
    return response, attempts, last_error, transport_failures


def _management_operation(args):
    directory = STATE_DIRECTORY
    supervisor_ref = None
    child_ref = None
    # The lifecycle/state locks protect the snapshot and pinned references only.
    # Holding them while waiting for graceful shutdown prevents another CLI
    # from reaching the supervisor's independent force socket.
    try:
        with embedding_lifecycle_lock():
            with managed_state_lock(directory):
                record, state_bytes, state_name = _read_state(directory, args.port)
            _verify_state_namespaces(record)
            supervisor_ref = _pin_identity(
                record['supervisor'], record['pidNamespaceInode'], 'supervisor',
            )
            child_ref = _pin_identity(
                record['child'], record['pidNamespaceInode'], 'child',
            )
            _assert_same_state(directory, args.port, record, state_bytes, state_name)
        # From here on, each command uses only the immutable generation and
        # pidfds captured above. State cleanup and a later generation cannot
        # redirect a request to a reused numeric PID.
        status = control_response(
            record['socketAddress'],
            record['generation'],
            record['secret'],
            'status',
            timeout=CONTROL_TIMEOUT,
        )
        if status.get('accepted') is not True:
            raise CliError('the supervisor did not authenticate the recorded generation')
        _validate_control_reply(status, record, 'status')
        if (
            status.get('phase') not in ('detached', 'stopping')
            or status.get('parentDeathSignal') != 0
        ):
            raise CliError('the recorded supervisor has not completed detach')

        if args.action == 'status':
            _assert_same_state_locked(directory, args.port, record, state_bytes, state_name)
            ready = control_response(
                record['socketAddress'],
                record['generation'],
                record['secret'],
                'verify-ready',
                timeout=CONTROL_TIMEOUT,
            )
            _validate_control_reply(ready, record, 'readiness')
            ready_now = ready.get('accepted') is True
            if ready_now:
                _assert_listener(record)
            print(json.dumps({
                'status': 'ready' if ready_now else 'not-ready',
                'generation': record['generation'],
                'port': args.port,
                'supervisor': record['supervisor'],
                'child': record['child'],
                'phase': status['phase'],
            }, sort_keys=True))
            return 0 if ready_now else 1

        # Stop/force are serialized only for their short state validation.
        # The supervisor arbitrates the actual transition; neither CLI holds
        # this lock while requesting termination or checking completion.
        _assert_same_state_locked(directory, args.port, record, state_bytes, state_name)
        injected = args.test_fail_connect_count if args.action == 'force' else 0
        response, attempts, request_error, transport_failures = _retry_control(
            record, args.action, fail_connect_count=injected,
        )
        if response is not None and response.get('accepted') is True:
            _validate_control_reply(response, record, args.action)
        complete, evidence = _wait_for_completion(
            directory, args.port, record, state_name, child_ref, supervisor_ref,
            timeout=2 if args.action == 'force' else RECONCILE_TIMEOUT,
        )
        if not complete:
            if request_error is not None:
                raise CliError(
                    f'{args.action} was not confirmed after {attempts} attempts: '
                    f'{request_error}; ' + '; '.join(evidence)
                )
            raise CliError(f'{args.action} outcome is not confirmed: ' + '; '.join(evidence))
        print(json.dumps({
            'status': 'stopped',
            'action': args.action,
            'generation': record['generation'],
            'port': args.port,
            'supervisor': record['supervisor'],
            'child': record['child'],
            'attempts': attempts,
            'responseReceived': response is not None and response.get('accepted') is True,
            'transportFailures': transport_failures,
            'postconditionReconciled': True,
            'evidence': evidence,
        }, sort_keys=True))
        return 0
    finally:
        if child_ref is not None:
            child_ref.close()
        if supervisor_ref is not None:
            supervisor_ref.close()


def _confirm_detached_generation(
    directory, port, record, state_bytes, state_name, child_ref, supervisor_ref,
    fail_status_connect_count=0,
):
    """Recover a lost detach/start reply only from same-generation evidence."""
    if supervisor_ref.exited() or child_ref.exited():
        raise CliError('a pinned process exited before detach could be confirmed')

    status, attempts, error, _transport_failures = _retry_control(
        record, 'status', fail_connect_count=fail_status_connect_count,
    )
    if status is None or status.get('accepted') is not True:
        raise CliError(
            f'detach result remains unknown after {attempts} status attempts: {error}'
        )
    _validate_control_reply(status, record, 'post-detach status')
    if status.get('phase') != 'detached' or status.get('parentDeathSignal') != 0:
        raise CliError(
            'detach result is not confirmed; generation state is preserved for later inspection'
        )

    readiness, ready_attempts, ready_error, _transport_failures = _retry_control(
        record, 'verify-ready',
    )
    if readiness is None or readiness.get('accepted') is not True:
        raise CliError(
            'detach result is not ready after '
            f'{ready_attempts} readiness attempts: {ready_error}'
        )
    _validate_control_reply(readiness, record, 'post-detach readiness')

    _assert_same_state_locked(directory, port, record, state_bytes, state_name)
    if supervisor_ref.exited() or child_ref.exited():
        raise CliError('a pinned process exited after detach status was confirmed')
    _assert_listener(record)
    child_ref.verify_owner(
        lambda: observe_direct_child_listener(
            record['child']['pid'], port, record['networkNamespaceInode'],
        )[1],
    )
    return status


def _start(args):
    if not sys.platform.startswith('linux') or not hasattr(os, 'pidfd_open'):
        raise CliError('the experimental supervisor CLI requires Linux pidfd')
    if not 0 < args.port < 65536:
        raise CliError('port must be between 1 and 65535')
    if not Path(args.launcher).is_file():
        raise CliError(f'test server launcher does not exist: {args.launcher}')

    directory = STATE_DIRECTORY
    ensure_managed_state_directory(directory)
    # Take the shared CLI lock only for the preflight. The supervisor itself
    # must acquire that lock while publishing its generation.
    with embedding_lifecycle_lock():
        existing = _state_files(directory, args.port)
        if existing:
            raise CliError(f'port {args.port} already has experimental generation state')

    parent_pid = os.getpid()
    parent_starttime = read_process_starttime(parent_pid)
    log_path = Path.home() / '.search-docs' / 'experimental-supervisor.log'
    child_environment = dict(os.environ, HOME=str(Path.home()), USERPROFILE=str(Path.home()))
    if args.drop_first_force_response_marker:
        child_environment[
            'SEARCH_DOCS_TEST_DROP_FIRST_FORCE_RESPONSE_MARKER'
        ] = str(Path(args.drop_first_force_response_marker).resolve())
    for argument, variable in (
        ('drop_first_stop_response_marker', 'SEARCH_DOCS_TEST_DROP_FIRST_STOP_RESPONSE_MARKER'),
        ('test_stop_timeout_force_marker', 'SEARCH_DOCS_TEST_STOP_TIMEOUT_FORCE_MARKER'),
        ('drop_first_detach_response_marker', 'SEARCH_DOCS_TEST_DROP_FIRST_DETACH_RESPONSE_MARKER'),
        (
            'drop_first_detach_status_response_marker',
            'SEARCH_DOCS_TEST_DROP_FIRST_DETACH_STATUS_RESPONSE_MARKER',
        ),
    ):
        marker = getattr(args, argument)
        if marker:
            child_environment[variable] = str(Path(marker).resolve())
    command = [
        sys.executable, str(SUPERVISOR_SCRIPT),
        '--state-dir', str(directory),
        '--port', str(args.port),
        '--parent-pid', str(parent_pid),
        '--parent-starttime', str(parent_starttime),
        '--startup-timeout', str(args.startup_timeout),
        '--', str(Path(args.launcher).resolve()),
        '--port', str(args.port),
        '--model-path', str(Path(args.model_path).resolve()),
    ]
    supervisor = None
    supervisor_ref = None
    child_ref = None
    detach_sent = False
    try:
        with log_path.open('ab') as log_file:
            supervisor = subprocess.Popen(
                command,
                cwd=Path.home(),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=log_file,
                env=child_environment,
                start_new_session=True,
            )

        deadline = time.monotonic() + args.startup_timeout
        latest = None
        while time.monotonic() < deadline:
            if supervisor.poll() is not None:
                raise CliError(
                    f'supervisor exited during startup; see {log_path} for its diagnostic'
                )
            names = _state_files(directory, args.port)
            if names:
                try:
                    latest = _read_state(directory, args.port)
                    break
                except CliError:
                    # A publication may still be in progress. Malformed,
                    # duplicate, or stale state is rejected at the deadline.
                    time.sleep(0.025)
                    continue
            time.sleep(0.025)
        if latest is None:
            raise CliError(
                f'supervisor did not publish one valid generation within '
                f'{args.startup_timeout} seconds; see {log_path}'
            )
        record, state_bytes, state_name = latest
        if record['supervisor']['pid'] != supervisor.pid:
            raise CliError('published supervisor is not the process started by this CLI')
        supervisor_ref = _pin_identity(
            record['supervisor'], record['pidNamespaceInode'], 'supervisor',
        )
        child_ref = _pin_identity(
            record['child'], record['pidNamespaceInode'], 'child',
        )
        if read_process_starttime(supervisor.pid) != record['supervisor']['starttime']:
            raise CliError('started supervisor PID was reused during startup')
        _assert_same_state(directory, args.port, record, state_bytes, state_name)

        ready_deadline = time.monotonic() + args.startup_timeout
        readiness = None
        while time.monotonic() < ready_deadline:
            if supervisor.poll() is not None:
                raise CliError(f'supervisor exited before detach; see {log_path}')
            _assert_same_state(directory, args.port, record, state_bytes, state_name)
            try:
                readiness = control_response(
                    record['socketAddress'],
                    record['generation'],
                    record['secret'],
                    'verify-ready',
                    timeout=CONTROL_TIMEOUT,
                )
            except (OSError, ValueError):
                time.sleep(0.05)
                continue
            _validate_control_reply(readiness, record, 'readiness')
            if readiness.get('accepted') is True:
                break
            time.sleep(0.05)
        if readiness is None or readiness.get('accepted') is not True:
            raise CliError(f'supervisor never confirmed readiness; see {log_path}')
        _assert_listener(record)
        child_ref.verify_owner(
            lambda: observe_direct_child_listener(
                record['child']['pid'], args.port, record['networkNamespaceInode'],
            )[1],
        )

        detach_sent = True
        try:
            ack = control_response(
                record['socketAddress'],
                record['generation'],
                record['secret'],
                'detach',
                timeout=CONTROL_TIMEOUT,
            )
        except (OSError, ValueError):
            # The request may have committed even if its reply disappeared.
            # Never kill a possibly detached supervisor; recover only through
            # status bound to this generation and the same pinned references.
            final_status = _confirm_detached_generation(
                directory, args.port, record, state_bytes, state_name,
                child_ref, supervisor_ref, args.test_fail_detach_status_connect_count,
            )
            ack_event = 'OWNERSHIP_ACK_RECONCILED'
            ack_reconciled = True
        else:
            _validate_control_reply(ack, record, 'detach')
            if ack.get('accepted') is True and ack.get('event') == 'OWNERSHIP_ACK':
                ack_event = ack['event']
                ack_reconciled = False
            else:
                # A negative or ambiguous reply may follow guard release. The
                # status query decides whether ownership actually transferred.
                ack_event = 'OWNERSHIP_ACK_RECONCILED'
                ack_reconciled = True
            final_status = _confirm_detached_generation(
                directory, args.port, record, state_bytes, state_name,
                child_ref, supervisor_ref, args.test_fail_detach_status_connect_count,
            )

        print(json.dumps({
            'status': 'started',
            'generation': record['generation'],
            'port': args.port,
            'supervisor': record['supervisor'],
            'child': record['child'],
            'phase': final_status['phase'],
            'ownershipAck': ack_event,
            'ownershipAckReconciled': ack_reconciled,
        }, sort_keys=True))
        return 0
    except BaseException:
        # Before detach is sent, the Popen child is still attached to this CLI.
        # After sending detach, a missing reply cannot prove that ownership
        # stayed attached, so preserve the supervisor and require reconciliation.
        if not detach_sent and supervisor is not None and supervisor.poll() is None:
            supervisor.kill()
            try:
                supervisor.wait(timeout=5)
            except subprocess.TimeoutExpired as error:
                raise CliError(
                    f'could not reap the exact supervisor child; state was preserved at {directory}'
                ) from error
        raise
    finally:
        if child_ref is not None:
            child_ref.close()
        if supervisor_ref is not None:
            supervisor_ref.close()


def _parser():
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest='command', required=True)

    start = subparsers.add_parser('start')
    start.add_argument('--port', type=int, required=True)
    start.add_argument('--launcher', required=True)
    start.add_argument('--model-path', default=str(Path.home()))
    start.add_argument('--startup-timeout', type=int, default=30)
    start.add_argument('--drop-first-force-response-marker')
    start.add_argument('--drop-first-stop-response-marker')
    start.add_argument('--test-stop-timeout-force-marker')
    start.add_argument('--drop-first-detach-response-marker')
    start.add_argument('--drop-first-detach-status-response-marker')
    start.add_argument('--test-fail-detach-status-connect-count', type=int, default=0)

    for action in ('status', 'stop', 'force'):
        operation = subparsers.add_parser(action)
        operation.add_argument('--port', type=int, required=True)
        if action == 'force':
            operation.add_argument('--test-fail-connect-count', type=int, default=0)
    return parser


def main():
    if not sys.platform.startswith('linux'):
        print(json.dumps({'error': 'the experimental supervisor CLI requires Linux'}), file=sys.stderr)
        return 2
    args = _parser().parse_args()
    try:
        if args.command == 'start':
            if args.test_fail_detach_status_connect_count < 0:
                raise CliError('test failure count cannot be negative')
            result = _start(args)
        else:
            if args.command == 'force' and args.test_fail_connect_count < 0:
                raise CliError('test failure count cannot be negative')
            args.action = args.command
            result = _management_operation(args)
        return result
    except (CliError, OSError, StateSafetyError, TargetUnavailable) as error:
        print(json.dumps({'error': str(error)}, sort_keys=True), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
