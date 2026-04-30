import json
from contextlib import asynccontextmanager
import asyncio
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
import os
import logging
from database import create_db, engine
from limiter import limiter

default_level = os.environ.get("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=default_level,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)

# Optional per-module overrides, e.g. LOG_LEVEL_SOULSEEK=DEBUG
for _logger_name, _env_key in (
    ("services.soulseek", "LOG_LEVEL_SOULSEEK"),
    ("services.download", "LOG_LEVEL_DOWNLOAD"),
    ("services.providers.musicbrainz", "LOG_LEVEL_MUSICBRAINZ"),
    ("services.providers", "LOG_LEVEL_PROVIDERS"),
):
    _v = os.environ.get(_env_key, "").strip().upper()
    if _v in ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"):
        logging.getLogger(_logger_name).setLevel(getattr(logging, _v))

logging.getLogger("aioslsk.network").setLevel(logging.CRITICAL)
logging.getLogger("aioslsk").setLevel(logging.WARNING)
from routers import (auth_router, search_router, play_router, stream_router,
                     library_router, settings_router, artist_router, album_router, prefetch_router, covers_router, soulseek_router)

logger = logging.getLogger(__name__)

ALLOWED_ORIGINS = ["*"]


class ConnectionManager:
    def __init__(self):
        self.active: list[WebSocket] = []

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.active.append(ws)

    def disconnect(self, ws: WebSocket):
        if ws in self.active:
            self.active.remove(ws)

    async def broadcast(self, message: dict):
        dead = []
        for ws in self.active:
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)


ws_manager = ConnectionManager()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await asyncio.to_thread(create_db)

    def _loop_exception_handler(loop, context):
        exc = context.get("exception")
        if exc is not None:
            try:
                from aioslsk.exceptions import ConnectionFailedError, PeerConnectionError
                if isinstance(exc, (ConnectionFailedError, PeerConnectionError)):
                    logger.debug("slsk peer connection failed (expected): %s", exc)
                    return
            except ImportError:
                pass
        loop.default_exception_handler(context)

    asyncio.get_event_loop().set_exception_handler(_loop_exception_handler)

    try:
        yield
    finally:
        from services import soulseek
        from services.providers._http import aclose_all as _http_aclose_all
        await soulseek.stop_client()
        await _http_aclose_all()


app = FastAPI(title="SpotiFU", lifespan=lifespan)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _cors_headers_for_request(request) -> dict[str, str]:
    origin = request.headers.get("origin")
    if ALLOWED_ORIGINS == ["*"]:
        if origin:
            return {
                "Access-Control-Allow-Origin": origin,
                "Access-Control-Allow-Credentials": "true",
                "Access-Control-Allow-Methods": "*",
                "Access-Control-Allow-Headers": "*",
            }
    elif origin and origin in ALLOWED_ORIGINS:
        return {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Credentials": "true",
            "Access-Control-Allow-Methods": "*",
            "Access-Control-Allow-Headers": "*",
        }
    return {}


@app.exception_handler(HTTPException)
async def http_exception_handler(request, exc):
    response = JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
    for k, v in _cors_headers_for_request(request).items():
        response.headers[k] = v
    return response


@app.exception_handler(Exception)
async def unhandled_exception_handler(request, exc):
    """Ensure API errors from this origin still get CORS headers (browser shows real status)."""
    logger.exception("Unhandled error: %s", exc)
    response = JSONResponse(
        status_code=500,
        content={"detail": "Internal server error"},
    )
    for k, v in _cors_headers_for_request(request).items():
        response.headers[k] = v
    return response


app.include_router(auth_router)
app.include_router(search_router)
app.include_router(play_router)
app.include_router(stream_router)
app.include_router(library_router)
app.include_router(settings_router)
app.include_router(artist_router)
app.include_router(album_router)
app.include_router(prefetch_router)
app.include_router(covers_router)
app.include_router(soulseek_router)


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws_manager.connect(ws)
    try:
        while True:
            data = await ws.receive_text()
            if data == "ping":
                await ws.send_text("pong")
                continue
            try:
                o = json.loads(data)
            except (json.JSONDecodeError, TypeError, ValueError):
                continue
            if isinstance(o, dict) and o.get("type") == "ping":
                await ws.send_json({"type": "pong"})
    except WebSocketDisconnect:
        ws_manager.disconnect(ws)
    except Exception:
        ws_manager.disconnect(ws)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/health/ready")
def health_ready():
    """Liveness: process up. Readiness: DB + Soulseek status for monitoring."""
    from sqlalchemy import text

    from services.soulseek import is_connected

    db_ok = True
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
    except Exception:
        logger.exception("readiness: database ping failed")
        db_ok = False

    return {
        "ready": db_ok,
        "soulseek_connected": is_connected(),
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=1985, reload=True)