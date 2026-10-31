"""Running behind a public URL. Serves the built website from the API's port, and, with PUBLIC_DEMO=1, keeps visitors to the
read-only demo: anything that changes a case, sends an alert, uploads a file or touches the bot needs the operator, who
unlocks it once with /?operator=<OPERATOR_KEY> (kept in a cookie). What visitors can still do is rate limited, because
Ask, the red team and translation spend the model key. Off by default, so a local run behaves as before."""
import hmac
import os
import re
import time
from collections import defaultdict, deque
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"
COOKIE = "yatharth_operator"
COOKIE_DAYS = 14
MAX_BODY = 64 * 1024

# (what a visitor may POST, per visitor in the window, everyone together in the window, window in seconds)
VISITOR_WRITES = [(re.compile(r"^/api/cases/[^/]+/(ask|redteam)$"), 20, 300, 600),
                  (re.compile(r"^/api/i18n/te$"), 200, 2000, 600),
                  (re.compile(r"^/api/cases/[^/]+/(counterfactual|intercept/approve)$"), 120, 2000, 600),
                  (re.compile(r"^/api/severity/score$"), 120, 2000, 600)]
PRIVATE_READS = re.compile(r"^/(docs|redoc|openapi\.json)|^/api/notify|^/api/telegram/(?!status$)")
_hits: dict[str, deque] = defaultdict(deque)


def enabled() -> bool:
    return os.getenv("PUBLIC_DEMO") == "1"


def _key_matches(given: str | None) -> bool:
    key = os.getenv("OPERATOR_KEY")
    return bool(key and given and hmac.compare_digest(given.encode(), key.encode()))


def is_visitor(request: Request) -> bool:
    """True for anyone on the public demo who hasn't unlocked it."""
    return enabled() and not _key_matches(request.cookies.get(COOKIE))


def _over_limit(name: str, limit: int, window: int) -> bool:
    now, hits = time.monotonic(), _hits[name]
    while hits and now - hits[0] > window:
        hits.popleft()
    if len(hits) >= limit:
        return True
    hits.append(now)
    return False


def _refused(status: int, why: str) -> JSONResponse:
    return JSONResponse({"detail": why}, status_code=status)


def install_guard(app: FastAPI):
    @app.middleware("http")
    async def public_guard(request: Request, call_next):
        if not enabled():
            return await call_next(request)
        path = request.url.path
        given = request.query_params.get("operator")
        if given is not None:   # the key leaves the address bar straight away
            to = RedirectResponse(path, status_code=303)
            if _key_matches(given):
                to.set_cookie(COOKIE, given, max_age=COOKIE_DAYS * 86400, httponly=True, samesite="lax", secure=request.headers.get("x-forwarded-proto") == "https")
            return to
        if not is_visitor(request):
            return await call_next(request)
        if PRIVATE_READS.match(path):
            return _refused(404, "Not available on the public demo.")
        if request.query_params.get("rerun"):   # a rebuild takes most of a minute of the server's CPU
            return _refused(403, "Rebuilding is limited to the operator on the public demo.")
        if request.method in ("GET", "HEAD", "OPTIONS"):
            return await call_next(request)
        rule = next((r for r in VISITOR_WRITES if r[0].match(path)), None)
        if rule is None:
            return _refused(403, "This action is limited to the operator on the public demo.")
        if int(request.headers.get("content-length") or 0) > MAX_BODY:
            return _refused(413, "That is too large for the public demo.")
        who = request.headers.get("cf-connecting-ip") or (request.client.host if request.client else "?")
        group = rule[0].pattern
        if _over_limit(f"{group}|{who}", rule[1], rule[3]) or _over_limit(group, rule[2], rule[3]):
            return _refused(429, "Too many requests on the public demo. Try again in a few minutes.")
        return await call_next(request)


class _Website(StaticFiles):
    """The built site; any path that isn't a file is a page of the app."""

    async def get_response(self, path, scope):
        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as e:
            if e.status_code != 404 or path.startswith("api/"):
                raise
            return await super().get_response("index.html", scope)


def mount_website(app: FastAPI):
    """Call last: the website takes every path the API doesn't. Does nothing until the site has been built."""
    if (DIST / "index.html").exists():
        app.mount("/", _Website(directory=DIST, html=True), name="website")
