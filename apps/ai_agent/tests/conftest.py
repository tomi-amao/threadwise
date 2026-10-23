"""Test environment shared by every test module.

The Inngest SDK refuses to build a client without a signing key unless it is in dev
mode. A developer's `.env` sets INNGEST_DEV, but CI has no `.env`, so without this the
test run dies while collecting any module that imports the app.
"""

import os

os.environ.setdefault("INNGEST_DEV", "1")
