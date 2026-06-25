#!/usr/bin/env python3
"""Back-compat runner for the websh backend test suite.

The original monolithic test_server.py (~8000 lines) was split into
domain modules under tests/backend/ (test_config, test_vault,
test_connect, test_transport, test_side_channel, test_logging,
test_misc; shared fixture in tests/backend/_base.py). This stub keeps
`python3 test_server.py [-v]` AND the targeted forms
(`python3 test_server.py TestClamp`, `... TestClamp.test_valid`)
working for muscle memory. CI runs the package directly via
`python -m unittest discover -s tests/backend -t .`.
"""

import os
import sys
import unittest

_ROOT = os.path.dirname(os.path.abspath(__file__))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

# Star-import the domain modules so the old single-test invocation
# (`python3 test_server.py TestClamp` / `TestClamp.test_valid`) keeps
# working: unittest.main resolves names against this module's
# namespace. With no test names given, the load_tests protocol below
# takes over INSTEAD of these module attributes, so nothing is run
# twice.
from tests.backend.test_config import *        # noqa: F401,F403
from tests.backend.test_vault import *         # noqa: F401,F403
from tests.backend.test_connect import *       # noqa: F401,F403
from tests.backend.test_transport import *     # noqa: F401,F403
from tests.backend.test_side_channel import *  # noqa: F401,F403
from tests.backend.test_logging import *       # noqa: F401,F403
from tests.backend.test_misc import *          # noqa: F401,F403


def load_tests(loader, tests, pattern):
    return loader.discover(
        os.path.join(_ROOT, "tests", "backend"), top_level_dir=_ROOT)


if __name__ == "__main__":
    unittest.main()
