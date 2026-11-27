"""Hard preflight checks for the isolated Linux supervisor CI run."""

import errno
import importlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from unittest.mock import patch

PYTHON_ROOT = Path(__file__).resolve().parents[1]
EXPERIMENTS_ROOT = PYTHON_ROOT / 'experiments'
sys.path.insert(0, str(PYTHON_ROOT))
sys.path.insert(0, str(EXPERIMENTS_ROOT))

import embedding_linux_pidfd as pidfd  # noqa: E402
from embedding_linux_pidfd import PinnedProcess, TargetUnavailable  # noqa: E402


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def required_environment(name):
    value = os.environ.get(name)
    require(bool(value), f'missing required environment variable: {name}')
    return value


def check_project_environment():
    expected_prefix = Path(required_environment('CI_PROJECT_PREFIX')).resolve()
    expected_base = Path(required_environment('CI_PYTHON_LOCATION')).resolve()
    require(sys.version_info[:2] == (3, 11), f'unexpected Python version: {sys.version}')
    require(Path(sys.prefix).resolve() == expected_prefix, (
        f'Python prefix mismatch: {sys.prefix!r} != {str(expected_prefix)!r}'
    ))
    require(Path(sys.base_prefix).resolve() == expected_base, (
        f'Python base prefix mismatch: {sys.base_prefix!r} != {str(expected_base)!r}'
    ))

    for module in (
        'lancedb',
        'numpy',
        'onnxruntime',
        'embedding',
        'embedding_onnx',
        'embedding_server',
    ):
        importlib.import_module(module)

    print(
        json.dumps({
            'python': sys.version.split()[0],
            'prefix': sys.prefix,
            'basePrefix': sys.base_prefix,
            'imports': [
                'lancedb',
                'numpy',
                'onnxruntime',
                'embedding',
                'embedding_onnx',
                'embedding_server',
            ],
        }),
        flush=True,
    )


def check_injected_procfs_denial():
    reference = PinnedProcess(os.getpid())
    try:
        with patch.object(
            pidfd,
            '_procfs_pid1_namespace_inode',
            side_effect=PermissionError(
                errno.EACCES,
                os.strerror(errno.EACCES),
                '/proc/1/ns/pid',
            ),
        ):
            try:
                reference.verify_procfs_pid()
            except TargetUnavailable as exc:
                cause = exc.__cause__
                require(
                    isinstance(cause, PermissionError)
                    and cause.errno == errno.EACCES
                    and cause.filename == '/proc/1/ns/pid',
                    f'procfs denial was not preserved: {exc!r}',
                )
            else:
                raise RuntimeError('procfs EACCES did not fail closed')
    finally:
        reference.close()


def check_actual_host_procfs():
    try:
        inode = pidfd.verify_procfs_pid_namespace()
    except TargetUnavailable as exc:
        cause = exc.__cause__
        require(
            isinstance(cause, PermissionError)
            and cause.errno in (errno.EACCES, errno.EPERM)
            and cause.filename == '/proc/1/ns/pid',
            f'unexpected host procfs result (not an expected access denial): {exc!r}',
        )
        print(
            'Host procfs access to /proc/1/ns/pid is denied; '
            'the production check rejected it safely.'
        )
    else:
        print(
            'Host procfs namespace check was readable '
            f'(inode={inode}); injected EACCES rejection was still verified.'
        )


def host_negative():
    require(sys.platform.startswith('linux'), 'Linux is required')
    require(os.geteuid() != 0, 'host-negative preflight must run as non-root')
    check_project_environment()
    check_injected_procfs_denial()
    check_actual_host_procfs()


def check_private_pid_namespace():
    require(os.getpid() > 1, 'PID namespace probe must run below container PID 1')
    actual_uid = os.getuid()
    actual_gid = os.getgid()
    expected_uid = int(required_environment('CI_EXPECTED_UID'))
    expected_gid = int(required_environment('CI_EXPECTED_GID'))
    require(actual_uid != 0, 'private-container preflight must not run as root')
    actual_identity = (actual_uid, actual_gid, os.geteuid(), os.getegid())
    expected_identity = (expected_uid, expected_gid, expected_uid, expected_gid)
    require(
        actual_identity == expected_identity,
        f'container identity {actual_identity} does not match '
        f'runner identity {expected_identity}',
    )

    own_namespace = os.stat('/proc/self/ns/pid').st_ino
    pid1_namespace = os.stat('/proc/1/ns/pid').st_ino
    host_namespace = int(required_environment('CI_HOST_PID_NAMESPACE_INODE'))
    require(own_namespace == pid1_namespace, (
        'container procfs PID 1 does not belong to the current PID namespace'
    ))
    require(own_namespace != host_namespace, (
        'container is using the runner host PID namespace'
    ))

    with open('/proc/self/status', encoding='ascii') as status_file:
        status = {
            line.split(':', 1)[0]: line.split(':', 1)[1].strip()
            for line in status_file
            if ':' in line
        }
    require(int(status.get('CapEff', '-1'), 16) == 0, 'container has effective capabilities')
    require(status.get('NoNewPrivs') == '1', 'no-new-privileges is not active')

    print(
        json.dumps({
            'pid': os.getpid(),
            'uid': actual_uid,
            'gid': actual_gid,
            'pidNamespaceInode': own_namespace,
            'hostPidNamespaceInode': host_namespace,
            'effectiveCapabilities': status['CapEff'],
            'noNewPrivs': status['NoNewPrivs'],
        }),
        flush=True,
    )


def check_readonly_workspace_and_tmp():
    workspace = Path(required_environment('CI_WORKSPACE'))
    require(workspace.is_dir(), f'workspace is unavailable: {workspace}')
    git_metadata = workspace / '.git'
    require(git_metadata.is_dir(), 'checkout metadata was not masked with a temporary mount')
    require(
        not (git_metadata / 'config').exists(),
        'Git configuration is visible inside the container',
    )
    probe = workspace / f'.issue168-readonly-probe-{os.getpid()}'
    try:
        try:
            descriptor = os.open(
                probe,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                0o600,
            )
        except OSError as exc:
            require(exc.errno == errno.EROFS, (
                f'workspace was not proven read-only (errno={exc.errno}): {exc}'
            ))
        else:
            os.close(descriptor)
            probe.unlink(missing_ok=True)
            raise RuntimeError('workspace unexpectedly allowed writes')
    finally:
        if probe.exists():
            probe.unlink()

    temporary_root = Path(required_environment('TMPDIR')).resolve()
    require(temporary_root == Path('/tmp'), f'unexpected temporary directory: {temporary_root}')
    home = Path(required_environment('HOME')).resolve()
    cache = Path(required_environment('UV_CACHE_DIR')).resolve()
    require(home.is_relative_to(temporary_root), f'HOME is not on tmpfs: {home}')
    require(cache.is_relative_to(temporary_root), f'uv cache is not on tmpfs: {cache}')
    require(home.is_dir() and cache.is_dir(), 'temporary HOME/cache were not initialized')
    with tempfile.NamedTemporaryFile(dir=temporary_root) as temporary:
        temporary.write(b'private temporary storage is writable')
        temporary.flush()


def check_uv_launcher():
    uv = shutil.which('uv')
    require(uv is not None, 'uv launcher is unavailable in the isolated container')
    environment = dict(os.environ, UV_OFFLINE='1', UV_PYTHON_DOWNLOADS='never')
    result = subprocess.run(
        [uv, '--version'],
        check=True,
        capture_output=True,
        text=True,
        env=environment,
    )
    print(result.stdout.strip(), flush=True)


def check_node_launcher():
    node = shutil.which('node')
    require(node is not None, 'Node launcher is unavailable in the isolated container')
    result = subprocess.run(
        [node, '--version'],
        check=True,
        capture_output=True,
        text=True,
    )
    require(result.stdout.strip().startswith('v22.'), (
        f'expected the CI Node 22 toolchain, got {result.stdout.strip()!r}'
    ))
    print(result.stdout.strip(), flush=True)


def check_container_os():
    release = {}
    with open('/etc/os-release', encoding='ascii') as release_file:
        for line in release_file:
            key, separator, value = line.partition('=')
            if separator:
                release[key] = value.strip().strip('"')
    expected_version = required_environment('CI_EXPECTED_OS_VERSION')
    require(release.get('ID') == 'ubuntu', (
        f'expected an Ubuntu container, got {release.get("ID")!r}'
    ))
    require(release.get('VERSION_ID') == expected_version, (
        f'container Ubuntu {release.get("VERSION_ID")!r} does not match '
        f'runner Ubuntu {expected_version!r}'
    ))
    print(
        f'Container OS matches the runner: Ubuntu {release["VERSION_ID"]}.',
        flush=True,
    )


def private_container():
    require(sys.platform.startswith('linux'), 'Linux is required')
    check_container_os()
    check_project_environment()
    subprocess.run(
        [sys.executable, str(Path(__file__).resolve()), 'pid-child'],
        check=True,
        env=os.environ.copy(),
    )
    check_readonly_workspace_and_tmp()
    check_uv_launcher()
    check_node_launcher()


def main():
    if len(sys.argv) != 2:
        raise SystemExit('usage: embedding_supervisor_ci_preflight.py MODE')
    mode = sys.argv[1]
    if mode == 'host-negative':
        host_negative()
    elif mode == 'private-container':
        private_container()
    elif mode == 'pid-child':
        check_private_pid_namespace()
    else:
        raise SystemExit(f'unknown preflight mode: {mode}')


if __name__ == '__main__':
    main()
