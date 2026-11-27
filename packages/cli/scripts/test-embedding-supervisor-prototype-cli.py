"""Exercise the isolated Linux supervisor through its disposable CLI."""
import ctypes
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[3]
PYTHON_DIR = ROOT / 'packages/db-engine/src/python'
EXPERIMENTS = PYTHON_DIR / 'experiments'
EXPERIMENTAL_CLI = ROOT / 'packages/cli/scripts/issue168-experimental-supervisor-cli.py'
sys.path.insert(0, str(PYTHON_DIR))
sys.path.insert(0, str(EXPERIMENTS))

from embedding_linux_pidfd import TargetUnavailable, observe_port  # noqa: E402
from embedding_supervisor_state import (  # noqa: E402
    current_pid_namespace_inode,
    process_identity_alive,
)
from managed_supervisor_prototype import (  # noqa: E402
    control_response,
    observe_direct_child_listener,
)


def free_port():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


def make_server_launcher(directory, port, ignore_sigterm=False):
    launcher = directory / (
        'embedding-server-ignore-sigterm.py'
        if ignore_sigterm else 'embedding-server.py'
    )
    signal_setup = (
        'import signal; signal.signal(signal.SIGTERM, signal.SIG_IGN)\n'
        if ignore_sigterm else ''
    )
    launcher.write_text(
        f'''
import sys, types
sys.path.insert(0, {str(PYTHON_DIR)!r})
{signal_setup}
embedding = types.ModuleType('embedding')
embedding.RuriEmbedding = object
sys.modules['embedding'] = embedding
onnx = types.ModuleType('embedding_onnx')
class Model:
    def __init__(self, model_path, dimension):
        self.dimension = dimension
        self.model_name = 'issue168-fake-model'
    def load(self): return True
    def encode(self, texts, dimension=None):
        return [[0.0] * (dimension or self.dimension)]
onnx.ONNXEmbedding = Model
sys.modules['embedding_onnx'] = onnx
import embedding_server
embedding_server.main()
''',
        encoding='utf-8',
    )
    return launcher


def run_cli(home, *arguments, timeout=30):
    environment = dict(
        os.environ,
        HOME=str(home),
        USERPROFILE=str(home),
    )
    return subprocess.run(
        [sys.executable, str(EXPERIMENTAL_CLI), *arguments],
        cwd=home,
        env=environment,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def start(home, launcher, port, drop_stop_response=None):
    arguments = [
        'start',
        '--port', str(port),
        '--launcher', str(launcher),
        '--model-path', str(home),
    ]
    if drop_stop_response is not None:
        arguments.extend([
            '--drop-first-stop-response-marker', str(drop_stop_response),
        ])
    result = run_cli(home, *arguments, timeout=45)
    assert result.returncode == 0, (result.stdout, result.stderr)
    payload = json.loads(result.stdout)
    assert payload['status'] == 'started', payload
    assert payload['phase'] == 'detached', payload
    return payload


def state_for(home, port, generation):
    state_path = (
        home / '.search-docs' / 'managed-embedding-prototype'
        / f'port-{port}-{generation}.json'
    )
    return state_path, json.loads(state_path.read_text(encoding='utf-8'))


def assert_generation_owns_listener(state, port):
    assert process_identity_alive(
        state['supervisor']['pid'],
        state['supervisor']['starttime'],
        state['pidNamespaceInode'],
    ), 'detached supervisor did not survive its start CLI'
    assert process_identity_alive(
        state['child']['pid'],
        state['child']['starttime'],
        state['pidNamespaceInode'],
    ), 'server child did not survive its start CLI'
    assert observe_direct_child_listener(
        state['child']['pid'], port, state['networkNamespaceInode'],
    )[1] == state['child']['pid']


def assert_port_released(port):
    try:
        if observe_port(port)[0]:
            raise AssertionError(f'listener still owns port {port}')
    except TargetUnavailable:
        pass
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind(('127.0.0.1', port))


def force_any_remaining_generation(home, port):
    state_dir = home / '.search-docs' / 'managed-embedding-prototype'
    if not state_dir.exists():
        return
    for state_path in state_dir.glob(f'port-{port}-*.json'):
        result = run_cli(home, 'force', '--port', str(port), timeout=15)
        if result.returncode != 0:
            raise RuntimeError(
                f'could not clean fixture generation {state_path.name}: '
                f'{result.stdout} {result.stderr}'
            )


def main():
    if not sys.platform.startswith('linux') or not hasattr(os, 'pidfd_open'):
        raise SystemExit('Linux pidfd is required for this prototype test')
    if sys.prefix == sys.base_prefix:
        raise SystemExit('run this test in the prepared uv project environment')

    # Confirm that the existing CI-synchronized runtime is usable without
    # resolving or installing anything during this test.
    import embedding  # noqa: F401
    import lancedb  # noqa: F401
    import numpy  # noqa: F401
    import onnxruntime  # noqa: F401

    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))

    with tempfile.TemporaryDirectory(prefix='issue168-supervisor-cli-') as temporary:
        home = Path(temporary)
        (home / '.search-docs').mkdir(mode=0o700)
        port = free_port()
        normal_launcher = make_server_launcher(home, port)
        stubborn_launcher = make_server_launcher(home, port, ignore_sigterm=True)
        try:
            first = start(home, normal_launcher, port)
            first_state_path, first_state = state_for(home, port, first['generation'])
            assert first['child'] == first_state['child']
            assert_generation_owns_listener(first_state, port)

            status = run_cli(home, 'status', '--port', str(port))
            assert status.returncode == 0, (status.stdout, status.stderr)
            status_payload = json.loads(status.stdout)
            assert status_payload['generation'] == first['generation']
            assert status_payload['status'] == 'ready'

            stop = run_cli(home, 'stop', '--port', str(port), timeout=20)
            assert stop.returncode == 0, (stop.stdout, stop.stderr)
            stop_payload = json.loads(stop.stdout)
            assert stop_payload['generation'] == first['generation']
            assert stop_payload['responseReceived'] is True
            assert not first_state_path.exists()
            assert_port_released(port)

            stop_marker = home / 'dropped-normal-stop-response.marker'
            second = start(home, stubborn_launcher, port, stop_marker)
            second_state_path, second_state = state_for(home, port, second['generation'])
            assert second['generation'] != first['generation']
            assert_generation_owns_listener(second_state, port)

            stop_process = subprocess.Popen(
                [
                    sys.executable, str(EXPERIMENTAL_CLI),
                    'stop', '--port', str(port),
                ],
                cwd=home,
                env=dict(os.environ, HOME=str(home), USERPROFILE=str(home)),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            try:
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    if stop_process.poll() is not None:
                        raise AssertionError(
                            'normal stop exited before force could interrupt it'
                        )
                    phase = control_response(
                        second_state['socketAddress'],
                        second['generation'],
                        second_state['secret'],
                        'status',
                    ).get('phase')
                    if phase == 'stopping':
                        break
                    time.sleep(0.025)
                else:
                    raise AssertionError('normal stop did not enter its grace period')
                assert stop_marker.exists(), 'normal stop acknowledgement was not dropped'

                started_at = time.monotonic()
                force = run_cli(home, 'force', '--port', str(port), timeout=20)
                elapsed = time.monotonic() - started_at
                assert force.returncode == 0, (force.stdout, force.stderr)
                force_payload = json.loads(force.stdout)
                assert force_payload['generation'] == second['generation']
                assert force_payload['child'] == second['child']
                assert force_payload['postconditionReconciled'] is True
                assert elapsed < 5, f'force waited through normal stop grace ({elapsed:.3f}s)'

                stop_stdout, stop_stderr = stop_process.communicate(timeout=8)
                assert stop_process.returncode == 0, (stop_stdout, stop_stderr)
                stop_payload = json.loads(stop_stdout)
                assert stop_payload['generation'] == second['generation']
                assert stop_payload['responseReceived'] is False
                assert stop_payload['postconditionReconciled'] is True
                assert not second_state_path.exists()
                assert_port_released(port)
            finally:
                if stop_process.poll() is None:
                    stop_process.kill()
                    stop_process.communicate(timeout=5)

            third = start(home, normal_launcher, port)
            third_state_path, third_state = state_for(home, port, third['generation'])
            assert third['generation'] not in (first['generation'], second['generation'])
            assert_generation_owns_listener(third_state, port)
            force = run_cli(home, 'force', '--port', str(port), timeout=20)
            assert force.returncode == 0, (force.stdout, force.stderr)
            assert json.loads(force.stdout)['generation'] == third['generation']
            assert not third_state_path.exists()
            assert_port_released(port)
        finally:
            force_any_remaining_generation(home, port)
            if libc.prctl(36, 0, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
                error = ctypes.get_errno()
                raise OSError(error, os.strerror(error))

    print(
        'Prepared-uv prototype CLI passed start/status/stop, stop-interrupting '
        'force, cleanup, and same-port restart.'
    )


if __name__ == '__main__':
    main()
