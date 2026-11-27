"""Fault injection used only by the isolated Issue #168 test launchers."""

import os
from pathlib import Path
import time


class SupervisorFaults:
    """Translate test environment settings into supervisor callbacks."""

    def __init__(self, environment=None):
        self.environment = os.environ if environment is None else environment

    def enabled(self, name):
        flags = {
            'state-partial-write': (
                self.environment.get('SEARCH_DOCS_TEST_STATE_FAIL_STAGE') == 'partial-write'
            ),
            'detach-readiness-barrier': (
                self.environment.get('SEARCH_DOCS_TEST_DETACH_READINESS_BARRIER') == '1'
            ),
            'detach-clear-failure': (
                self.environment.get('SEARCH_DOCS_TEST_DETACH_FAIL_CLEAR') == '1'
            ),
            'detach-after-clear-failure': (
                self.environment.get('SEARCH_DOCS_TEST_DETACH_FAIL_AFTER_CLEAR') == '1'
            ),
            'detach-report-unknown': (
                self.environment.get('SEARCH_DOCS_TEST_DETACH_REPORT_UNKNOWN') == '1'
            ),
        }
        return flags.get(name, False)

    def checkpoint(self, name):
        if name.startswith('pdeath-'):
            self._pdeath_checkpoint(name.removeprefix('pdeath-'))
            return

        state_stages = {
            'state-temp-fsync': 'temp-fsync',
            'state-link': 'link',
            'state-directory-fsync': 'directory-fsync',
        }
        state_stage = state_stages.get(name)
        if (
            state_stage is not None
            and self.environment.get('SEARCH_DOCS_TEST_STATE_FAIL_STAGE') == state_stage
        ):
            raise OSError(f'injected generation publication failure at {state_stage}')

        detach_stages = {
            'detach-during-readiness': 'during-readiness',
            'detach-before-clear': 'before-clear',
            'detach-after-clear-before-ack': 'after-clear-before-ack',
        }
        detach_stage = detach_stages.get(name)
        if detach_stage is not None:
            self._detach_barrier(detach_stage)

    def mark(self, name, content):
        if name.startswith('detach-pdeath-'):
            stage = name.removeprefix('detach-pdeath-')
            directory = self.environment.get('SEARCH_DOCS_TEST_DETACH_BARRIER_DIR')
            if directory:
                self._create_once(
                    Path(directory) / f'{stage}.pdeath',
                    str(content).encode('ascii'),
                )
            return

        if name == 'stop-timeout-force':
            marker = self.environment.get('SEARCH_DOCS_TEST_STOP_TIMEOUT_FORCE_MARKER')
            if marker:
                self._create_once(Path(marker), str(content).encode('ascii'))

    def drop_response(self, channel, action, response):
        if response.get('accepted') is not True:
            return False

        if channel == 'force':
            variable = 'SEARCH_DOCS_TEST_DROP_FIRST_FORCE_RESPONSE_MARKER'
        elif action == 'stop':
            variable = 'SEARCH_DOCS_TEST_DROP_FIRST_STOP_RESPONSE_MARKER'
        elif action == 'detach':
            variable = 'SEARCH_DOCS_TEST_DROP_FIRST_DETACH_RESPONSE_MARKER'
        elif action == 'status' and response.get('phase') == 'detached':
            variable = 'SEARCH_DOCS_TEST_DROP_FIRST_DETACH_STATUS_RESPONSE_MARKER'
        else:
            return False

        marker = self.environment.get(variable)
        return bool(
            marker
            and self._create_once(
                Path(marker), b'dropped one accepted control response\n',
            )
        )

    def _pdeath_checkpoint(self, stage):
        if self.environment.get('SEARCH_DOCS_TEST_PDEATHSIG_STAGE') != stage:
            return
        marker = self.environment.get('SEARCH_DOCS_TEST_PDEATHSIG_MARKER')
        if marker:
            Path(marker).write_text(stage, encoding='ascii')
        delay = float(self.environment.get('SEARCH_DOCS_TEST_PDEATHSIG_DELAY', '0.5'))
        time.sleep(delay)

    def _detach_barrier(self, stage):
        directory = self.environment.get('SEARCH_DOCS_TEST_DETACH_BARRIER_DIR')
        if not directory:
            return
        root = Path(directory)
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        (root / f'{stage}.entered').write_text(stage, encoding='ascii')
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if (root / f'{stage}.release').exists():
                return
            time.sleep(0.01)
        raise TimeoutError(f'test detach barrier timed out at {stage}')

    @staticmethod
    def _create_once(path, content):
        try:
            descriptor = os.open(
                path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600,
            )
        except FileExistsError:
            return False
        try:
            offset = 0
            while offset < len(content):
                offset += os.write(descriptor, content[offset:])
        finally:
            os.close(descriptor)
        return True
