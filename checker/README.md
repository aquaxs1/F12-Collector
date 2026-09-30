# F12 Collector – Checker

An **offline** security checker for exports produced by the F12 Collector browser extension.
It reads a ZIP (or an unpacked folder) and passively looks for common weaknesses. It makes **no
network requests** and never touches a live site – it only reads the files you exported.

> Use it on **your own sites** or targets you are **explicitly authorised** to test (e.g. an
> in-scope bug-bounty program). It is a passive analyser, not a scanner.

## Requirements

Python 3.8+ (standard library only – nothing to install).

## Usage

**Windows:** double-click `check.bat`, then drag the F12 Collector ZIP onto the window (or paste
its path) and press Enter. The HTML report opens automatically.

**Any OS (command line):**

```bash
python check.py path/to/f12-collector_example.com_2026-….zip
# or an unpacked folder:
python check.py path/to/unpacked-folder/
```

Options:

| Option | Meaning |
|---|---|
| `-o, --outdir DIR` | where to write the report (default: next to the input, `…_check/`) |
| `--format html,md` | which reports to write (default both; `report.json` is always written) |
| `--open` | open `report.html` when finished |
| `--no-open` | never open the report |

## What it checks

Each check runs only if the matching area is present in the export; otherwise it is listed as
*not checked*.

- **Security headers** – missing/weak CSP, HSTS, X-Frame-Options, X-Content-Type-Options,
  Referrer-Policy, Permissions-Policy, COOP, and CORS misconfiguration
  (`Access-Control-Allow-Origin: *` together with credentials). From `security/headers.json`.
- **Cookies** – missing `Secure`, `HttpOnly`, `SameSite`. From `storage/cookies.json`.
- **Secrets in JS** – taken from `security/findings.json` (values stay masked/redacted).
- **Mixed content** – `http://` sub-resources on an HTTPS page.
- **Outdated libraries** – library versions from `security/techstack.json` compared against the
  local, offline CVE list `data/cve-list.json`.
- **Telltale comments / internal URLs** – `TODO/FIXME/HACK/…`, credentials in comments and
  internal hostnames (`localhost`, `10.x`, `*.internal`, `*.staging`, …) in the page's code.
- **Meta files** – sensitive-looking `Disallow:` entries in `robots.txt` and exposed
  `.well-known` files.

## Reports

`report.html` (main, with a red/yellow/green light per finding), `report.md`, and `report.json`.
Each finding has a category, severity, location (file/line), a short explanation and a
recommendation. Secret values are never printed in clear text.

## The CVE list

`data/cve-list.json` is a **small, manually maintained** list of known-vulnerable library
versions – not a complete or authoritative feed. Update it by hand from public advisories
(e.g. github.com/advisories, snyk.io, nvd.nist.gov).

## Embedding in Wavetools

The logic is separated from the CLI: `run(opts, ctx=None)` does everything and returns a result
dict, while `main()` only parses arguments. To call it from another tool:

```python
from check import run
result = run({"input": "export.zip", "formats": ["html"], "open": False}, ctx={"log": print})
# result["counts"], result["findings"], result["reports"] …
```
