"""Resolve HOLLYCODE_HOME for standalone skill scripts.

Skill scripts may run outside the Hollycode process (e.g. system Python,
nix env, CI) where ``hollycode_constants`` is not importable.  This module
provides the same ``get_hollycode_home()`` and ``display_hollycode_home()``
contracts as ``hollycode_constants`` without requiring it on ``sys.path``.

When ``hollycode_constants`` IS available it is used directly so that any
future enhancements (profile resolution, Docker detection, etc.) are
picked up automatically.  The fallback path replicates the core logic
from ``hollycode_constants.py`` using only the stdlib.

All scripts under ``google-workspace/scripts/`` should import from here
instead of duplicating the ``HOLLYCODE_HOME = Path(os.getenv(...))`` pattern.
"""

from __future__ import annotations

import os
from pathlib import Path

try:
    from hollycode_constants import display_hollycode_home as display_hollycode_home
    from hollycode_constants import get_hollycode_home as get_hollycode_home
except (ModuleNotFoundError, ImportError):

    def get_hollycode_home() -> Path:
        """Return the Hollycode home directory (default: ~/.hollycode).

        Mirrors ``hollycode_constants.get_hollycode_home()``."""
        val = os.environ.get("HOLLYCODE_HOME", "").strip()
        return Path(val) if val else Path.home() / ".hollycode"

    def display_hollycode_home() -> str:
        """Return a user-friendly ``~/``-shortened display string.

        Mirrors ``hollycode_constants.display_hollycode_home()``."""
        home = get_hollycode_home()
        try:
            return "~/" + str(home.relative_to(Path.home()))
        except ValueError:
            return str(home)
