"""Web command centre for the Proxmark3 client.

The package wraps the existing C client rather than replacing it: a long-lived
interactive session is driven over a PTY, and every GUI action maps to a real
client command.
"""

__version__ = "1.0.0"
