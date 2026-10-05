#!/usr/bin/env python3
"""F12 Collector – offline security checker.

Reads a ZIP (or unpacked folder) produced by the F12 Collector browser extension and passively
looks for common weaknesses. It is a pure offline tool: it ONLY reads the exported files and
makes NO network requests and never touches a live site. It deliberately imports no networking
modules (no socket / urllib / http.client).

Only your own sites or targets you are explicitly authorised to test (e.g. an in-scope
bug-bounty program) should be analysed with this tool.

Layout (so it can later be embedded in the Wavetools CLI):
  * run(opts, ctx=None) -> dict   – all logic, no argument parsing, returns a result dict
  * main()                        – CLI wrapper that builds opts and calls run()

opts keys:
  input   : path to a .zip or a folder  (required)
  outdir  : where to write the report   (default: next to the input)
  formats : list, subset of ["html", "md"]  (default both)
  open    : bool, open report.html when done (default False)
"""

from __future__ import annotations

import argparse
import base64
import datetime as _dt
import html
import io
import json
import os
import re
import sys
import zipfile

VERSION = "1.0.0"

SEV_ORDER = {"high": 0, "medium": 1, "low": 2, "info": 3, "ok": 4}
SEV_LIGHT = {"high": "red", "medium": "yellow", "low": "yellow", "info": "green", "ok": "green"}


# --------------------------------------------------------------------------------------
# Export reader (zip or folder), hiding the top-level "f12-collector_..." root directory
# --------------------------------------------------------------------------------------
class Export:
    def __init__(self, path: str):
        self.path = path
        self._zip = None
        self._members = {}  # relative path (no root) -> real name / abs path
        self.root = ""
        if os.path.isdir(path):
            self._load_dir(path)
        elif zipfile.is_zipfile(path):
            self._load_zip(path)
        else:
            raise ValueError("Input is neither a .zip nor a folder: %s" % path)

    def _strip_root(self, name: str) -> str:
        name = name.replace("\\", "/")
        parts = name.split("/", 1)
        if self.root and name.startswith(self.root + "/"):
            return name[len(self.root) + 1 :]
        return name

    def _load_zip(self, path: str):
        self._zip = zipfile.ZipFile(path)
        names = [n for n in self._zip.namelist() if not n.endswith("/")]
        tops = {n.replace("\\", "/").split("/", 1)[0] for n in names}
        if len(tops) == 1:
            self.root = next(iter(tops))
        for n in names:
            self._members[self._strip_root(n)] = n

    def _load_dir(self, path: str):
        # If the folder itself is the root (contains manifest.json), root = ""
        entries = os.listdir(path)
        if "manifest.json" not in entries and len(entries) == 1 and os.path.isdir(os.path.join(path, entries[0])):
            self.root = entries[0]
            base = os.path.join(path, entries[0])
        else:
            base = path
        self._base_dir = base
        for dirpath, _dirs, files in os.walk(base):
            for f in files:
                full = os.path.join(dirpath, f)
                rel = os.path.relpath(full, base).replace("\\", "/")
                self._members[rel] = full

    def exists(self, rel: str) -> bool:
        return rel in self._members

    def list(self, prefix: str = "") -> list:
        return sorted(p for p in self._members if p.startswith(prefix))

    def read_bytes(self, rel: str):
        if rel not in self._members:
            return None
        if self._zip is not None:
            return self._zip.read(self._members[rel])
        with open(self._members[rel], "rb") as fh:
            return fh.read()

    def read_text(self, rel: str):
        b = self.read_bytes(rel)
        if b is None:
            return None
        return b.decode("utf-8", "replace")

    def read_json(self, rel: str):
        t = self.read_text(rel)
        if t is None:
            return None
        try:
            return json.loads(t)
        except Exception:
            return None


# --------------------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------------------
def _ver_tuple(v: str):
    return tuple(int(x) for x in re.findall(r"\d+", str(v))[:4]) or (0,)


def _ver_le(a: str, b: str) -> bool:
    """a <= b, numeric-part comparison."""
    ta, tb = _ver_tuple(a), _ver_tuple(b)
    n = max(len(ta), len(tb))
    ta += (0,) * (n - len(ta))
    tb += (0,) * (n - len(tb))
    return ta <= tb


def _finding(cat, severity, title, location, detail, recommendation):
    return {
        "category": cat,
        "severity": severity,
        "title": title,
        "location": location or "",
        "detail": detail or "",
        "recommendation": recommendation or "",
    }


# --------------------------------------------------------------------------------------
# Individual checks – each returns (list_of_findings, checked_bool, note)
# --------------------------------------------------------------------------------------
def check_security_headers(exp: Export):
    data = exp.read_json("security/headers.json")
    if not data:
        return [], False, "security/headers.json not in export"
    findings = []
    for c in data.get("checks", []):
        sev = c.get("severity", "info")
        if sev in ("ok", "info"):
            continue
        findings.append(
            _finding(
                "Security headers",
                sev,
                ("Missing/weak: " + c["name"]) if not c.get("present") else ("Weak: " + c["name"]),
                data.get("mainDocument", ""),
                c.get("note", ""),
                _header_reco(c["name"]),
            )
        )
    return findings, True, None


def _header_reco(name: str) -> str:
    n = name.lower()
    if "content-security" in n:
        return "Add a strict Content-Security-Policy (avoid 'unsafe-inline'/'unsafe-eval')."
    if "strict-transport" in n:
        return "Send Strict-Transport-Security: max-age=31536000; includeSubDomains."
    if "frame" in n:
        return "Send X-Frame-Options: DENY or CSP frame-ancestors 'none'."
    if "content-type-options" in n:
        return "Send X-Content-Type-Options: nosniff."
    if "referrer" in n:
        return "Send Referrer-Policy: strict-origin-when-cross-origin (or stricter)."
    if "cors" in n or "access-control" in n:
        return "Do not combine Access-Control-Allow-Origin: * with credentials; echo an allow-list instead."
    return "Review and set this response header."


def check_cookies(exp: Export):
    data = exp.read_json("storage/cookies.json")
    if data is None:
        return [], False, "storage/cookies.json not in export"
    findings = []
    for c in data if isinstance(data, list) else []:
        name = c.get("name", "?")
        domain = c.get("domain", "")
        miss = []
        if not c.get("secure"):
            miss.append("Secure")
        if not c.get("httpOnly"):
            miss.append("HttpOnly")
        ss = (c.get("sameSite") or "").lower()
        if ss in ("", "no_restriction", "none", "unspecified"):
            miss.append("SameSite")
        if miss:
            sev = "medium" if ("HttpOnly" in miss or "Secure" in miss) else "low"
            findings.append(
                _finding(
                    "Cookies",
                    sev,
                    "Cookie '%s' missing flag(s): %s" % (name, ", ".join(miss)),
                    "domain " + domain,
                    "Session cookies without Secure/HttpOnly/SameSite are exposed to theft (XSS) or CSRF.",
                    "Set the %s flag(s) on this cookie." % ", ".join(miss),
                )
            )
    return findings, True, None


def check_secrets(exp: Export):
    data = exp.read_json("security/findings.json")
    if not data:
        return [], False, "security/findings.json not in export"
    findings = []
    for s in data.get("secrets", []):
        findings.append(
            _finding(
                "Secrets in JS",
                s.get("severity", "medium"),
                "Possible %s" % s.get("type", "secret"),
                "%s : line %s" % (s.get("location", "?"), s.get("line", "?")),
                "Value (masked): %s" % s.get("preview", "[REDACTED]"),
                "Remove the secret from client-side code and rotate it if real.",
            )
        )
    return findings, True, None


def check_mixed_content(exp: Export):
    manifest = exp.read_json("manifest.json") or {}
    url = manifest.get("url", "")
    if not url.lower().startswith("https://"):
        return [], True, "page is not HTTPS – mixed content not applicable"
    urls = set()
    tp = exp.read_json("security/third-parties.json")
    if tp:
        for grp in (tp.get("thirdParties", []), tp.get("firstParty", [])):
            for hostrec in grp:
                for u in hostrec.get("samples", []):
                    urls.add(u)
    har = exp.read_json("network.har")
    if har:
        for e in har.get("log", {}).get("entries", []):
            u = e.get("request", {}).get("url", "")
            if u:
                urls.add(u)
    findings = []
    seen = set()
    for u in urls:
        if u.lower().startswith("http://") and not u.startswith("http://127.") and not u.startswith("http://localhost"):
            host = re.sub(r"^http://([^/]+).*", r"\1", u)
            if host in seen:
                continue
            seen.add(host)
            findings.append(
                _finding(
                    "Mixed content",
                    "medium",
                    "Insecure http:// resource on an HTTPS page",
                    u[:200],
                    "Loading HTTP sub-resources on an HTTPS page can be blocked or tampered with.",
                    "Load every sub-resource over HTTPS.",
                )
            )
    return findings, True, None


def check_outdated_libs(exp: Export, cve_db: dict):
    tech = exp.read_json("security/techstack.json")
    if not tech:
        return [], False, "security/techstack.json not in export"
    libs = cve_db.get("libraries", {})
    findings = []
    for t in tech.get("technologies", []):
        name = t.get("name")
        ver = t.get("version")
        if not ver or name not in libs:
            continue
        for adv in libs[name]:
            if _ver_le(ver, adv["maxVulnerable"]):
                findings.append(
                    _finding(
                        "Outdated library",
                        adv.get("severity", "medium"),
                        "%s %s – %s" % (name, ver, adv.get("id", "known issue")),
                        "; ".join(t.get("evidence", [])[:2]),
                        adv.get("desc", ""),
                        "Upgrade %s beyond %s." % (name, adv["maxVulnerable"]),
                    )
                )
                break
    return findings, True, None


TELLTALE_COMMENT = re.compile(r"(?://|/\*|<!--|#)\s*[^\n\r]*?\b(TODO|FIXME|HACK|XXX|BUG|DEBUG|password|passwd|secret|api[_-]?key|do not ship|remove before|temporary)\b", re.I)
INTERNAL_URL = re.compile(r"\bhttps?://(?:localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|[a-z0-9.-]*\.(?:local|internal|test|dev|staging|corp|intranet))\b[^\s'\"]*", re.I)


def check_comments(exp: Export):
    # Only real code files – not F12 Collector's own metadata JSON/map indexes.
    src = [
        p
        for p in exp.list("sources/")
        if re.search(r"\.(js|mjs|ts|css|html?)$", p, re.I)
        and not p.endswith("/index.json")
        and p not in ("sources/window-globals.json",)
    ]
    if not src:
        return [], False, "no sources/ in export"
    findings = []
    scanned = 0
    for p in src:
        if scanned >= 400 or len(findings) >= 300:
            break
        scanned += 1
        text = exp.read_text(p)
        if not text:
            continue
        for m in TELLTALE_COMMENT.finditer(text):
            line = text.count("\n", 0, m.start()) + 1
            snippet = m.group(0).strip()[:160]
            findings.append(
                _finding(
                    "Telltale comment",
                    "low",
                    "Comment mentions '%s'" % m.group(1).upper(),
                    "%s : line %d" % (p, line),
                    snippet,
                    "Remove developer/debug comments and any credentials from shipped code.",
                )
            )
        hosts = set()
        for m in INTERNAL_URL.finditer(text):
            u = m.group(0)
            if u in hosts:
                continue
            hosts.add(u)
            line = text.count("\n", 0, m.start()) + 1
            findings.append(
                _finding(
                    "Internal URL",
                    "low",
                    "Internal/non-public URL in code",
                    "%s : line %d" % (p, line),
                    u[:160],
                    "Do not ship internal hostnames/URLs to the client.",
                )
            )
    return findings, True, None


def check_meta(exp: Export):
    if not exp.exists("meta/index.json"):
        return [], False, "meta/ not in export"
    findings = []
    robots = exp.read_text("meta/robots.txt")
    if robots:
        for m in re.finditer(r"(?im)^\s*Disallow:\s*(\S+)", robots):
            path = m.group(1)
            if re.search(r"admin|backup|\.git|config|private|secret|internal|db|sql|test|staging|old|tmp|api", path, re.I):
                findings.append(
                    _finding(
                        "robots.txt",
                        "info",
                        "Sensitive-looking path disallowed in robots.txt",
                        "meta/robots.txt",
                        "Disallow: %s (robots.txt reveals paths; it does not protect them)." % path,
                        "Do not rely on robots.txt for security; protect these paths with auth.",
                    )
                )
    idx = exp.read_json("meta/index.json") or {}
    for e in idx.get("entries", []):
        p = e.get("path", "")
        if e.get("file") and re.search(r"\.(git|env|htaccess)|assetlinks|apple-app-site", p):
            findings.append(
                _finding("Exposed file", "low", "Well-known file exposed: %s" % p, "meta/" + str(e.get("file")), "This file is publicly reachable.", "Confirm it should be public.")
            )
    return findings, True, None


# --------------------------------------------------------------------------------------
# Orchestration
# --------------------------------------------------------------------------------------
CHECKS = [
    ("Security headers", check_security_headers),
    ("Cookies", check_cookies),
    ("Secrets in JS", check_secrets),
    ("Mixed content", check_mixed_content),
    ("Telltale comments/URLs", check_comments),
    ("Meta files", check_meta),
]


def run(opts: dict, ctx=None) -> dict:
    """Analyse an F12 Collector export. Pure offline. Returns a result dict and writes reports."""
    log = (ctx or {}).get("log") if isinstance(ctx, dict) else None

    def info(msg):
        if callable(log):
            log(msg)

    inp = opts["input"]
    exp = Export(inp)
    manifest = exp.read_json("manifest.json") or {}

    here = os.path.dirname(os.path.abspath(__file__))
    cve_db = {}
    try:
        with open(os.path.join(here, "data", "cve-list.json"), "r", encoding="utf-8") as fh:
            cve_db = json.load(fh)
    except Exception:
        info("cve-list.json could not be loaded")

    findings = []
    status = []  # (name, checked, note)

    for name, fn in CHECKS:
        try:
            if fn is check_outdated_libs:  # not in list; placeholder
                res, checked, note = fn(exp, cve_db)
            else:
                res, checked, note = fn(exp)
        except Exception as e:  # a broken area never breaks the whole checker
            res, checked, note = [], True, "check error: %s" % e
        findings.extend(res)
        status.append((name, checked, note))
        info("%-24s %s" % (name, "checked" if checked else "not checked"))

    # Outdated libs (needs the cve db)
    try:
        res, checked, note = check_outdated_libs(exp, cve_db)
    except Exception as e:
        res, checked, note = [], True, "check error: %s" % e
    findings.extend(res)
    status.append(("Outdated libraries", checked, note))

    findings.sort(key=lambda f: (SEV_ORDER.get(f["severity"], 5), f["category"]))

    counts = {"high": 0, "medium": 0, "low": 0, "info": 0}
    for f in findings:
        counts[f["severity"]] = counts.get(f["severity"], 0) + 1

    result = {
        "tool": "F12 Collector Checker",
        "version": VERSION,
        "generatedAt": _dt.datetime.now().isoformat(timespec="seconds"),
        "target": {
            "url": manifest.get("url"),
            "title": manifest.get("title"),
            "browser": manifest.get("browser"),
            "createdAt": manifest.get("createdAt"),
            "mode": manifest.get("mode"),
            "extensionVersion": manifest.get("extensionVersion"),
        },
        "input": os.path.abspath(inp),
        "counts": counts,
        "findings": findings,
        "checks": [{"name": n, "checked": c, "note": note} for (n, c, note) in status],
        "cveListUpdated": cve_db.get("_updated"),
    }

    # Write reports
    outdir = opts.get("outdir") or _default_outdir(inp)
    os.makedirs(outdir, exist_ok=True)
    formats = opts.get("formats") or ["html", "md"]
    written = {}
    if "html" in formats:
        p = os.path.join(outdir, "report.html")
        with open(p, "w", encoding="utf-8") as fh:
            fh.write(render_html(result))
        written["html"] = p
    if "md" in formats:
        p = os.path.join(outdir, "report.md")
        with open(p, "w", encoding="utf-8") as fh:
            fh.write(render_md(result))
        written["md"] = p
    p = os.path.join(outdir, "report.json")
    with open(p, "w", encoding="utf-8") as fh:
        json.dump(result, fh, indent=2)
    written["json"] = p
    result["reports"] = written
    return result


def _default_outdir(inp: str) -> str:
    inp = os.path.abspath(inp)
    base = inp[:-4] if inp.lower().endswith(".zip") else inp
    return base + "_check"


# --------------------------------------------------------------------------------------
# Rendering
# --------------------------------------------------------------------------------------
LOGO_SVG = (
    "<svg width='40' height='40' viewBox='0 0 64 64' xmlns='http://www.w3.org/2000/svg'>"
    "<rect width='64' height='64' rx='14' fill='#070d1c'/>"
    "<rect x='14' y='14' width='36' height='26' rx='3' fill='none' stroke='#e8eefc' stroke-width='3'/>"
    "<circle cx='20' cy='20' r='1.6' fill='#e8eefc'/><circle cx='26' cy='20' r='1.6' fill='#e8eefc'/>"
    "<rect x='19' y='26' width='20' height='3' rx='1.5' fill='#1274ff'/>"
    "<rect x='19' y='31' width='14' height='3' rx='1.5' fill='#1274ff'/>"
    "<path d='M24 40 L40 40 L34 48 L34 52 L30 52 L30 48 Z' fill='#e8eefc'/>"
    "<path d='M32 54 l2.2 3.2 3.2 2.2 -3.2 2.2 -2.2 3.2 -2.2 -3.2 -3.2 -2.2 3.2 -2.2 z' fill='#1274ff'/></svg>"
)


def render_html(r: dict) -> str:
    e = html.escape
    c = r["counts"]
    t = r["target"]
    rows = []
    for f in r["findings"]:
        light = SEV_LIGHT.get(f["severity"], "green")
        rows.append(
            "<tr class='sev-{sev}'>"
            "<td><span class='chip {light}'>{sev}</span></td>"
            "<td>{cat}</td><td>{title}</td>"
            "<td class='loc'>{loc}</td><td>{detail}</td><td class='reco'>{reco}</td></tr>".format(
                sev=e(f["severity"]), light=light, cat=e(f["category"]), title=e(f["title"]),
                loc=e(f["location"]), detail=e(f["detail"]), reco=e(f["recommendation"]),
            )
        )
    checks_rows = "".join(
        "<li>{mark} {name}{note}</li>".format(
            mark="✔" if ck["checked"] else "—",
            name=e(ck["name"]),
            note="" if ck["checked"] else " <span class='muted'>(%s)</span>" % e(ck["note"] or "not in export"),
        )
        for ck in r["checks"]
    )
    total = sum(c.values())
    verdict = "red" if c["high"] else "yellow" if (c["medium"] or c["low"]) else "green"
    verdict_text = {"red": "High-severity issues found", "yellow": "Some issues found", "green": "No notable issues found"}[verdict]
    return """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>F12 Collector – Security Check</title>
<style>
:root{{--bg:#070d1c;--panel:#0d1830;--border:#1d3057;--fg:#e8eefc;--muted:#8a9cc2;--accent:#1274ff;--red:#ff6b7a;--yellow:#ffc15c;--green:#3ddc97;color-scheme:dark;}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;padding:24px;}}
.wrap{{max-width:1100px;margin:0 auto}}
header{{display:flex;align-items:center;gap:14px;border-bottom:1px solid var(--border);padding-bottom:14px;margin-bottom:18px}}
h1{{font-size:20px;margin:0}}h1 span{{color:var(--accent)}}
.meta{{color:var(--muted);font-size:12.5px}}
.verdict{{display:inline-block;padding:3px 12px;border-radius:20px;font-weight:700;margin-left:auto}}
.verdict.red{{background:rgba(255,107,122,.15);color:var(--red);border:1px solid var(--red)}}
.verdict.yellow{{background:rgba(255,193,92,.12);color:var(--yellow);border:1px solid var(--yellow)}}
.verdict.green{{background:rgba(61,220,151,.12);color:var(--green);border:1px solid var(--green)}}
.cards{{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0}}
.card{{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:12px 18px;min-width:110px}}
.card .n{{font-size:26px;font-weight:700}}.card .l{{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.5px}}
.card.red .n{{color:var(--red)}}.card.yellow .n{{color:var(--yellow)}}.card.green .n{{color:var(--green)}}
.grid{{display:grid;grid-template-columns:1fr 280px;gap:18px;align-items:start}}
@media(max-width:800px){{.grid{{grid-template-columns:1fr}}}}
table{{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--border);border-radius:10px;overflow:hidden}}
th,td{{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border);vertical-align:top;font-size:13px}}
th{{background:#12203d;color:var(--accent);text-transform:uppercase;font-size:11px;letter-spacing:.5px}}
td.loc{{font-family:ui-monospace,monospace;font-size:12px;color:var(--muted);word-break:break-all;max-width:240px}}
td.reco{{color:var(--green)}}
.chip{{padding:1px 8px;border-radius:10px;font-size:11px;font-weight:700;text-transform:uppercase}}
.chip.red{{background:rgba(255,107,122,.15);color:var(--red)}}
.chip.yellow{{background:rgba(255,193,92,.12);color:var(--yellow)}}
.chip.green{{background:rgba(61,220,151,.12);color:var(--green)}}
aside{{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:14px}}
aside h2{{font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:var(--accent);margin:0 0 8px}}
ul{{list-style:none;padding:0;margin:0}}ul li{{padding:3px 0;border-bottom:1px dashed var(--border)}}
.muted{{color:var(--muted)}}.note{{color:var(--muted);font-size:12px;margin-top:10px}}
footer{{margin-top:20px;color:var(--muted);font-size:12px;border-top:1px solid var(--border);padding-top:12px}}
</style></head><body><div class="wrap">
<header>{logo}<div><h1>F12 <span>Collector</span> — Security Check</h1>
<div class="meta">Target: {url} · {mode} · {browser} · captured {created}</div></div>
<span class="verdict {verdict}">{verdict_text}</span></header>

<div class="cards">
<div class="card red"><div class="n">{high}</div><div class="l">High</div></div>
<div class="card yellow"><div class="n">{medium}</div><div class="l">Medium</div></div>
<div class="card yellow"><div class="n">{low}</div><div class="l">Low</div></div>
<div class="card green"><div class="n">{info}</div><div class="l">Info</div></div>
<div class="card"><div class="n">{total}</div><div class="l">Total</div></div>
</div>

<div class="grid"><div>
<table><thead><tr><th>Sev</th><th>Category</th><th>Finding</th><th>Location</th><th>Detail</th><th>Recommendation</th></tr></thead>
<tbody>{rows}</tbody></table>
{empty}
</div>
<aside><h2>Areas checked</h2><ul>{checks}</ul>
<div class="note">Only areas present in the export are checked. Everything else is marked “not in export”.</div>
</aside></div>

<footer>Generated by F12 Collector Checker v{ver} at {gen}. Offline analysis — no network requests were made.
CVE list updated {cve}. This tool is for your own sites or authorised testing only.</footer>
</div></body></html>""".format(
        logo=LOGO_SVG,
        url=e(t.get("url") or "unknown"),
        mode=e(t.get("mode") or ""),
        browser=e(t.get("browser") or ""),
        created=e(t.get("createdAt") or ""),
        verdict=verdict,
        verdict_text=verdict_text,
        high=c["high"], medium=c["medium"], low=c["low"], info=c["info"], total=total,
        rows="".join(rows) or "",
        empty="" if rows else "<p class='muted' style='margin-top:14px'>No findings for the areas present in this export.</p>",
        checks=checks_rows,
        ver=e(r["version"]),
        gen=e(r["generatedAt"]),
        cve=e(str(r.get("cveListUpdated"))),
    )


def render_md(r: dict) -> str:
    c = r["counts"]
    t = r["target"]
    out = []
    out.append("# F12 Collector — Security Check\n")
    out.append("**Target:** %s  " % (t.get("url") or "unknown"))
    out.append("**Mode:** %s · **Browser:** %s · **Captured:** %s  " % (t.get("mode"), t.get("browser"), t.get("createdAt")))
    out.append("**Generated:** %s (offline, no network requests)\n" % r["generatedAt"])
    out.append("## Summary\n")
    out.append("| High | Medium | Low | Info | Total |")
    out.append("|---|---|---|---|---|")
    out.append("| %d | %d | %d | %d | %d |\n" % (c["high"], c["medium"], c["low"], c["info"], sum(c.values())))
    out.append("## Areas checked\n")
    for ck in r["checks"]:
        out.append("- %s %s%s" % ("[x]" if ck["checked"] else "[ ]", ck["name"], "" if ck["checked"] else " (not in export)"))
    out.append("\n## Findings\n")
    if not r["findings"]:
        out.append("_No findings for the areas present in this export._\n")
    for f in r["findings"]:
        out.append("### [%s] %s — %s" % (f["severity"].upper(), f["category"], f["title"]))
        if f["location"]:
            out.append("- **Location:** `%s`" % f["location"])
        if f["detail"]:
            out.append("- **Detail:** %s" % f["detail"])
        if f["recommendation"]:
            out.append("- **Recommendation:** %s" % f["recommendation"])
        out.append("")
    out.append("---\n_Generated by F12 Collector Checker v%s. For your own sites or authorised testing only._" % r["version"])
    return "\n".join(out)


# --------------------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------------------
def main(argv=None):
    ap = argparse.ArgumentParser(description="Offline security checker for F12 Collector exports.")
    ap.add_argument("input", nargs="?", help="Path to the F12 Collector .zip or unpacked folder")
    ap.add_argument("-o", "--outdir", help="Output directory for the report (default: next to the input)")
    ap.add_argument("--format", default="html,md", help="Report formats: html,md (default both)")
    ap.add_argument("--open", action="store_true", help="Open report.html when finished")
    ap.add_argument("--no-open", action="store_true", help="Do not open the report (overrides --open)")
    args = ap.parse_args(argv)

    inp = args.input
    if not inp:
        try:
            inp = input("Path to the F12 Collector ZIP or folder: ").strip().strip('"')
        except EOFError:
            inp = ""
    if not inp:
        ap.error("no input given")
    if not os.path.exists(inp):
        print("Error: input not found: %s" % inp, file=sys.stderr)
        return 2

    opts = {
        "input": inp,
        "outdir": args.outdir,
        "formats": [x for x in args.format.split(",") if x.strip()],
        "open": args.open and not args.no_open,
    }
    try:
        result = run(opts, ctx={"log": lambda m: print("  " + m)})
    except Exception as e:
        print("Error: %s" % e, file=sys.stderr)
        return 1

    c = result["counts"]
    print("\nDone. High=%d Medium=%d Low=%d Info=%d" % (c["high"], c["medium"], c["low"], c["info"]))
    for k, v in result["reports"].items():
        print("  %-5s %s" % (k, v))

    if opts["open"] and result["reports"].get("html"):
        _open_file(result["reports"]["html"])
    return 0


def _open_file(path: str):
    # Local file only; no networking.
    try:
        if sys.platform.startswith("win"):
            os.startfile(path)  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            import subprocess

            subprocess.Popen(["open", path])
        else:
            import subprocess

            subprocess.Popen(["xdg-open", path])
    except Exception:
        pass


if __name__ == "__main__":
    raise SystemExit(main())
