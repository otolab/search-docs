"""Windows-only probe for creation-time Job Object membership and crash cleanup.

Requires Windows 10+ for PROC_THREAD_ATTRIBUTE_JOB_LIST. It covers a supervisor
terminated after the child is created and verified. The supervisor duplicates
the CreateProcessW process handle into the test harness before resume; the
harness never reopens the reported PID. It does not cover death inside
CreateProcessW, uv's full process tree, or child breakaway behavior.
"""
import ctypes
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock
from ctypes import wintypes


JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
PROC_THREAD_ATTRIBUTE_JOB_LIST = 0x0002000D
EXTENDED_STARTUPINFO_PRESENT = 0x00080000
CREATE_SUSPENDED = 0x00000004
WAIT_OBJECT_0 = 0
WAIT_TIMEOUT = 0x00000102
WAIT_FAILED = 0xFFFFFFFF
PROCESS_TERMINATE = 0x0001
PROCESS_DUP_HANDLE = 0x0040
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
SYNCHRONIZE = 0x00100000
DUPLICATE_CLOSE_SOURCE = 0x00000001


def _win32():
    if os.name != 'nt':
        raise RuntimeError('this probe requires Windows')

    class BasicLimitInformation(ctypes.Structure):
        _fields_ = [
            ('PerProcessUserTimeLimit', ctypes.c_longlong),
            ('PerJobUserTimeLimit', ctypes.c_longlong),
            ('LimitFlags', wintypes.DWORD),
            ('MinimumWorkingSetSize', ctypes.c_size_t),
            ('MaximumWorkingSetSize', ctypes.c_size_t),
            ('ActiveProcessLimit', wintypes.DWORD),
            ('Affinity', ctypes.c_size_t),
            ('PriorityClass', wintypes.DWORD),
            ('SchedulingClass', wintypes.DWORD),
        ]

    class IoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong) for name in (
            'ReadOperationCount',
            'WriteOperationCount',
            'OtherOperationCount',
            'ReadTransferCount',
            'WriteTransferCount',
            'OtherTransferCount',
        )]

    class ExtendedLimitInformation(ctypes.Structure):
        _fields_ = [
            ('BasicLimitInformation', BasicLimitInformation),
            ('IoInfo', IoCounters),
            ('ProcessMemoryLimit', ctypes.c_size_t),
            ('JobMemoryLimit', ctypes.c_size_t),
            ('PeakProcessMemoryUsed', ctypes.c_size_t),
            ('PeakJobMemoryUsed', ctypes.c_size_t),
        ]

    class StartupInfo(ctypes.Structure):
        _fields_ = [
            ('cb', wintypes.DWORD),
            ('lpReserved', wintypes.LPWSTR),
            ('lpDesktop', wintypes.LPWSTR),
            ('lpTitle', wintypes.LPWSTR),
            ('dwX', wintypes.DWORD),
            ('dwY', wintypes.DWORD),
            ('dwXSize', wintypes.DWORD),
            ('dwYSize', wintypes.DWORD),
            ('dwXCountChars', wintypes.DWORD),
            ('dwYCountChars', wintypes.DWORD),
            ('dwFillAttribute', wintypes.DWORD),
            ('dwFlags', wintypes.DWORD),
            ('wShowWindow', wintypes.WORD),
            ('cbReserved2', wintypes.WORD),
            ('lpReserved2', ctypes.c_void_p),
            ('hStdInput', wintypes.HANDLE),
            ('hStdOutput', wintypes.HANDLE),
            ('hStdError', wintypes.HANDLE),
        ]

    class StartupInfoEx(ctypes.Structure):
        _fields_ = [
            ('StartupInfo', StartupInfo),
            ('lpAttributeList', ctypes.c_void_p),
        ]

    class ProcessInformation(ctypes.Structure):
        _fields_ = [
            ('hProcess', wintypes.HANDLE),
            ('hThread', wintypes.HANDLE),
            ('dwProcessId', wintypes.DWORD),
            ('dwThreadId', wintypes.DWORD),
        ]

    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    kernel32.SetInformationJobObject.argtypes = [
        wintypes.HANDLE, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD,
    ]
    kernel32.SetInformationJobObject.restype = wintypes.BOOL
    kernel32.InitializeProcThreadAttributeList.argtypes = [
        ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD,
        ctypes.POINTER(ctypes.c_size_t),
    ]
    kernel32.InitializeProcThreadAttributeList.restype = wintypes.BOOL
    kernel32.UpdateProcThreadAttribute.argtypes = [
        ctypes.c_void_p, wintypes.DWORD, ctypes.c_size_t, ctypes.c_void_p,
        ctypes.c_size_t, ctypes.c_void_p, ctypes.c_void_p,
    ]
    kernel32.UpdateProcThreadAttribute.restype = wintypes.BOOL
    kernel32.DeleteProcThreadAttributeList.argtypes = [ctypes.c_void_p]
    kernel32.DeleteProcThreadAttributeList.restype = None
    kernel32.CreateProcessW.argtypes = [
        wintypes.LPCWSTR, wintypes.LPWSTR, ctypes.c_void_p, ctypes.c_void_p,
        wintypes.BOOL, wintypes.DWORD, ctypes.c_void_p, wintypes.LPCWSTR,
        ctypes.POINTER(StartupInfoEx), ctypes.POINTER(ProcessInformation),
    ]
    kernel32.CreateProcessW.restype = wintypes.BOOL
    kernel32.ResumeThread.argtypes = [wintypes.HANDLE]
    kernel32.ResumeThread.restype = wintypes.DWORD
    kernel32.IsProcessInJob.argtypes = [
        wintypes.HANDLE, wintypes.HANDLE, ctypes.POINTER(wintypes.BOOL),
    ]
    kernel32.IsProcessInJob.restype = wintypes.BOOL
    kernel32.GetCurrentProcess.argtypes = []
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    kernel32.DuplicateHandle.argtypes = [
        wintypes.HANDLE, wintypes.HANDLE, wintypes.HANDLE,
        ctypes.POINTER(wintypes.HANDLE), wintypes.DWORD, wintypes.BOOL,
        wintypes.DWORD,
    ]
    kernel32.DuplicateHandle.restype = wintypes.BOOL
    kernel32.GetProcessId.argtypes = [wintypes.HANDLE]
    kernel32.GetProcessId.restype = wintypes.DWORD
    kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel32.WaitForSingleObject.restype = wintypes.DWORD
    kernel32.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    kernel32.TerminateProcess.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    return kernel32, ExtendedLimitInformation, StartupInfoEx, ProcessInformation


def _check(result):
    if not result:
        raise ctypes.WinError(ctypes.get_last_error())
    return result


def _is_process_in_job(kernel32, process, job):
    member = wintypes.BOOL()
    _check(kernel32.IsProcessInJob(process, job, ctypes.byref(member)))
    return bool(member.value)


def _handle_value(handle):
    value = ctypes.cast(handle, wintypes.HANDLE).value
    if value is None:
        return 0
    return int(value)


def _duplicate_handle(
    kernel32, source_process, source_handle, target_process, desired_access,
):
    target_handle = wintypes.HANDLE()
    _check(kernel32.DuplicateHandle(
        source_process,
        source_handle,
        target_process,
        ctypes.byref(target_handle),
        desired_access,
        False,
        0,
    ))
    return target_handle


def _close_remote_handle(kernel32, remote_process, remote_handle_value):
    """Close a handle in another process without opening it by process ID."""
    local_duplicate = wintypes.HANDLE()
    if kernel32.DuplicateHandle(
        remote_process,
        wintypes.HANDLE(remote_handle_value),
        kernel32.GetCurrentProcess(),
        ctypes.byref(local_duplicate),
        0,
        False,
        DUPLICATE_CLOSE_SOURCE,
    ):
        if local_duplicate:
            kernel32.CloseHandle(local_duplicate)


def _wait(kernel32, process, timeout_ms):
    status = kernel32.WaitForSingleObject(process, timeout_ms)
    if status == WAIT_FAILED:
        raise ctypes.WinError(ctypes.get_last_error())
    return status


def _terminate_and_wait(kernel32, process, timeout_ms=5000):
    status = _wait(kernel32, process, 0)
    if status == WAIT_OBJECT_0:
        return
    if status == WAIT_TIMEOUT:
        if not kernel32.TerminateProcess(process, 1):
            error = ctypes.WinError(ctypes.get_last_error())
            if _wait(kernel32, process, 0) == WAIT_TIMEOUT:
                raise error
        status = _wait(kernel32, process, timeout_ms)
    if status != WAIT_OBJECT_0:
        raise TimeoutError('test process did not exit during cleanup')


def _job_child(marker):
    Path(marker).write_text(str(os.getpid()), encoding='ascii')
    while True:
        time.sleep(60)


class WindowsCleanupHelperTest(unittest.TestCase):
    def test_wait_failed_raises_win_error_without_attempting_termination(self):
        class FailedWaitKernel:
            terminate_attempted = False

            def WaitForSingleObject(self, process, timeout_ms):
                return WAIT_FAILED

            def TerminateProcess(self, process, exit_code):
                self.terminate_attempted = True
                return False

        kernel32 = FailedWaitKernel()
        with (
            mock.patch.object(
                ctypes, 'WinError', lambda code: OSError(f'WinError {code}'),
                create=True,
            ),
            mock.patch.object(ctypes, 'get_last_error', lambda: 6, create=True),
        ):
            with self.assertRaisesRegex(OSError, 'WinError 6'):
                _terminate_and_wait(kernel32, wintypes.HANDLE(1234))
        self.assertFalse(kernel32.terminate_attempted)


def _job_supervisor(marker, ready):
    kernel32, ExtendedLimitInformation, StartupInfoEx, ProcessInformation = _win32()
    job = None
    parent_process = None
    attribute_buffer = None
    attribute_list_initialized = False
    process_info = ProcessInformation()
    remote_child_handle = None
    readiness_published = False
    try:
        # The harness duplicates its own process handle into this process and
        # sends that handle value over stdin. This avoids reopening the parent
        # by a PID that could have been recycled.
        parent_handle_line = sys.stdin.buffer.readline()
        if not parent_handle_line:
            raise RuntimeError('test harness did not provide its process handle')
        parent_process = wintypes.HANDLE(int(parent_handle_line.strip(), 10))

        job = _check(kernel32.CreateJobObjectW(None, None))
        limits = ExtendedLimitInformation()
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        _check(kernel32.SetInformationJobObject(
            job,
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            ctypes.byref(limits),
            ctypes.sizeof(limits),
        ))

        attribute_size = ctypes.c_size_t()
        kernel32.InitializeProcThreadAttributeList(
            None, 1, 0, ctypes.byref(attribute_size),
        )
        if not attribute_size.value:
            raise ctypes.WinError(ctypes.get_last_error())
        attribute_buffer = ctypes.create_string_buffer(attribute_size.value)
        attribute_list = ctypes.cast(attribute_buffer, ctypes.c_void_p)
        _check(kernel32.InitializeProcThreadAttributeList(
            attribute_list, 1, 0, ctypes.byref(attribute_size),
        ))
        attribute_list_initialized = True

        # The handle is deliberately non-inheritable; bInheritHandles is FALSE.
        job_list = (wintypes.HANDLE * 1)(job)
        _check(kernel32.UpdateProcThreadAttribute(
            attribute_list,
            0,
            PROC_THREAD_ATTRIBUTE_JOB_LIST,
            ctypes.cast(job_list, ctypes.c_void_p),
            ctypes.sizeof(job_list),
            None,
            None,
        ))
        startup = StartupInfoEx()
        startup.StartupInfo.cb = ctypes.sizeof(startup)
        startup.lpAttributeList = attribute_list
        command = ctypes.create_unicode_buffer(subprocess.list2cmdline([
            sys.executable, str(Path(__file__).resolve()), '--job-child', marker,
        ]))
        _check(kernel32.CreateProcessW(
            sys.executable,
            command,
            None,
            None,
            False,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED,
            None,
            None,
            ctypes.byref(startup),
            ctypes.byref(process_info),
        ))

        if not _is_process_in_job(kernel32, process_info.hProcess, job):
            raise RuntimeError('CreateProcessW child was not assigned to the test Job Object')
        ambient_job = _is_process_in_job(
            kernel32, kernel32.GetCurrentProcess(), None,
        )
        # Give the test harness a handle to this exact CreateProcessW result.
        # The PID is diagnostic only; parent-side waiting and cleanup use this
        # duplicated handle and never call OpenProcess.
        remote_child_handle = _duplicate_handle(
            kernel32,
            kernel32.GetCurrentProcess(),
            process_info.hProcess,
            parent_process,
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE,
        )
        ready_path = Path(ready)
        temporary_ready = ready_path.with_suffix('.tmp')
        temporary_ready.write_text(json.dumps({
            'child_process_id': process_info.dwProcessId,
            'child_process_handle': _handle_value(remote_child_handle),
            'assigned_to_private_job': True,
            'supervisor_in_ambient_job': ambient_job,
        }), encoding='utf-8')
        os.replace(temporary_ready, ready_path)
        readiness_published = True

        # The parent validates and adopts the duplicated handle before resume.
        if sys.stdin.buffer.read(1) != b'R':
            raise RuntimeError('test harness did not authorize child resume')
        remote_child_handle = None
        if kernel32.ResumeThread(process_info.hThread) == 0xFFFFFFFF:
            raise ctypes.WinError(ctypes.get_last_error())

        deadline = time.monotonic() + 10
        while not Path(marker).exists() and time.monotonic() < deadline:
            if _wait(kernel32, process_info.hProcess, 0) == WAIT_OBJECT_0:
                raise RuntimeError('test child exited before writing its marker')
            time.sleep(0.02)
        if not Path(marker).exists():
            raise TimeoutError('test child did not start')

        # The test harness terminates this process after pinning the child handle.
        sys.stdin.buffer.read(1)
    finally:
        cleanup_error = None
        if process_info.hProcess:
            try:
                _terminate_and_wait(kernel32, process_info.hProcess)
            except Exception as exc:
                cleanup_error = exc
        # If readiness was never published, the parent cannot own this remote
        # handle yet. Close that duplicate explicitly; once published, leave
        # ownership to the harness (which closes it or exits and closes its
        # handle table).
        if remote_child_handle and not readiness_published and parent_process:
            try:
                _close_remote_handle(
                    kernel32, parent_process, _handle_value(remote_child_handle),
                )
            except Exception as exc:
                if cleanup_error is None:
                    cleanup_error = exc
        if job:
            if not kernel32.CloseHandle(job) and cleanup_error is None:
                cleanup_error = ctypes.WinError(ctypes.get_last_error())
            job = None
        # Retry through the exact CreateProcessW handle after closing the job.
        # This also covers a child that failed the Job membership assertion.
        if process_info.hProcess:
            try:
                _terminate_and_wait(kernel32, process_info.hProcess)
                cleanup_error = None
            except Exception as exc:
                cleanup_error = exc
        if process_info.hThread:
            kernel32.CloseHandle(process_info.hThread)
        if process_info.hProcess:
            kernel32.CloseHandle(process_info.hProcess)
        if parent_process:
            kernel32.CloseHandle(parent_process)
        if attribute_list_initialized:
            kernel32.DeleteProcThreadAttributeList(attribute_list)
        if cleanup_error is not None:
            raise cleanup_error


@unittest.skipUnless(os.name == 'nt', 'requires Windows Job Objects')
class WindowsJobSupervisorTest(unittest.TestCase):
    def test_creation_time_membership_and_supervisor_death_reap_child(self):
        kernel32, _, _, _ = _win32()
        with tempfile.TemporaryDirectory(prefix='issue168-windows-job-') as directory:
            marker = Path(directory) / 'child-started'
            ready = Path(directory) / 'supervisor-ready.json'
            supervisor = subprocess.Popen(
                [
                    sys.executable, str(Path(__file__).resolve()),
                    '--job-supervisor', str(marker), str(ready),
                ],
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
            child_handle = None
            try:
                # Duplicate the harness process handle into the supervisor.
                # The supervisor can then duplicate its creation-time child
                # process handle back into this exact process.
                supervisor_process_handle = wintypes.HANDLE(
                    int(supervisor._handle)
                )
                remote_parent_handle = _duplicate_handle(
                    kernel32,
                    kernel32.GetCurrentProcess(),
                    kernel32.GetCurrentProcess(),
                    supervisor_process_handle,
                    PROCESS_DUP_HANDLE,
                )
                supervisor.stdin.write(
                    str(_handle_value(remote_parent_handle)).encode('ascii') + b'\n'
                )
                supervisor.stdin.flush()

                deadline = time.monotonic() + 20
                while not ready.exists() and time.monotonic() < deadline:
                    if supervisor.poll() is not None:
                        _, stderr = supervisor.communicate(timeout=5)
                        self.fail(
                            'supervisor probe exited before readiness: '
                            + stderr.decode(errors='replace')
                        )
                    time.sleep(0.02)
                self.assertTrue(ready.exists(), 'supervisor probe did not become ready')
                report = json.loads(ready.read_text(encoding='utf-8'))
                self.assertTrue(report['assigned_to_private_job'])

                # This numeric value is a HANDLE already duplicated into this
                # process, not a PID. Never turn ready-file data into OpenProcess.
                candidate_handle = wintypes.HANDLE(
                    int(report['child_process_handle'])
                )
                actual_process_id = kernel32.GetProcessId(candidate_handle)
                self.assertNotEqual(
                    actual_process_id, 0,
                    'duplicated child process handle is invalid',
                )
                self.assertEqual(
                    actual_process_id,
                    report['child_process_id'],
                    'duplicated handle does not refer to the reported child',
                )
                child_handle = candidate_handle
                self.assertTrue(
                    _is_process_in_job(kernel32, child_handle, None),
                    'child is not associated with any Job Object',
                )
                self.assertEqual(
                    _wait(kernel32, child_handle, 0),
                    WAIT_TIMEOUT,
                    'suspended test child exited before the supervisor crash',
                )
                supervisor.stdin.write(b'R')
                supervisor.stdin.flush()
                child_deadline = time.monotonic() + 10
                while not marker.exists() and time.monotonic() < child_deadline:
                    time.sleep(0.02)
                self.assertTrue(marker.exists(), 'test child did not start after being resumed')
                self.assertEqual(
                    marker.read_text(encoding='ascii'),
                    str(actual_process_id),
                )
                self.assertEqual(
                    _wait(kernel32, child_handle, 0),
                    WAIT_TIMEOUT,
                    'test child exited before the supervisor crash',
                )

                print(
                    'Windows Job Object probe: '
                    f"supervisor_in_ambient_job={report['supervisor_in_ambient_job']}",
                    flush=True,
                )
                supervisor.kill()
                supervisor.wait(timeout=10)
                self.assertEqual(
                    _wait(kernel32, child_handle, 10_000),
                    WAIT_OBJECT_0,
                    'child survived supervisor termination after KILL_ON_JOB_CLOSE',
                )
            finally:
                try:
                    if supervisor.poll() is None:
                        try:
                            # Before readiness/resume this asks the supervisor
                            # to abort cleanly. If it is busy, force its exit so
                            # closing its Job handle reaps the child.
                            supervisor.stdin.write(b'A')
                            supervisor.stdin.flush()
                        except (OSError, ValueError):
                            pass
                    try:
                        supervisor.communicate(timeout=10)
                    except subprocess.TimeoutExpired:
                        try:
                            supervisor.kill()
                        except OSError:
                            pass
                        supervisor.communicate(timeout=5)
                finally:
                    if child_handle:
                        try:
                            _terminate_and_wait(kernel32, child_handle)
                        finally:
                            kernel32.CloseHandle(child_handle)


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == '--job-supervisor':
        _job_supervisor(sys.argv[2], sys.argv[3])
    elif len(sys.argv) == 3 and sys.argv[1] == '--job-child':
        _job_child(sys.argv[2])
    elif os.name != 'nt':
        raise SystemExit('This experiment must run on Windows.')
    else:
        unittest.main()
