"""
Generates the SHA-256 hash used by public/app.js's LOCAL-ONLY fallback
login check (for testing the dashboard before it's deployed).

This is NOT the real security layer -- see README.md. The real check is
server-side in api/login.js, configured with the DASHBOARD_PASSCODE
environment variable in Vercel, which never ships to the browser.

Usage: python3 scripts/hash_passcode.py "your-local-test-passcode"
"""
import hashlib
import sys

if len(sys.argv) != 2:
    print(__doc__)
    sys.exit(1)

print(hashlib.sha256(sys.argv[1].encode()).hexdigest())
