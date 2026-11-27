"""Test-only entry point that installs isolated supervisor fault injection."""

from pathlib import Path
import sys

TESTS = Path(__file__).resolve().parent
PYTHON = TESTS.parent
EXPERIMENTS = PYTHON / 'experiments'
sys.path.insert(0, str(TESTS))
sys.path.insert(0, str(EXPERIMENTS))
sys.path.insert(0, str(PYTHON))

from embedding_supervisor_faults import SupervisorFaults  # noqa: E402
from managed_supervisor_prototype import main  # noqa: E402


if __name__ == '__main__':
    main(fault_injector=SupervisorFaults())
