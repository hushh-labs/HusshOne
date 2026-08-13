"""Compatibility exports for the reviewed Kirkland market release.

The original route imported this module directly.  Keeping these names prevents
an accidental API-side fork while moving the actual records into the versioned
release manifest and loader.
"""

from app.market_release import get_market_release

_RELEASE = get_market_release()

# TODO: Rename these at the next intentional public API major version.  They
# now point at the reviewed market release, not a synthetic/bootstrap tuple.
BOOTSTRAP_CANDIDATES = _RELEASE.candidates
BOOTSTRAP_METADATA = _RELEASE.metadata
