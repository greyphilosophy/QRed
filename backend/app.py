"""FastAPI Application — QRed backend."""

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from backend.routes.seal import router as seal_router
from backend.routes.verify import router as verify_router


def create_app() -> FastAPI:
    app = FastAPI(
        title="QRed",
        description="Tamper-evident document sealing and verification",
        version="0.1.0",
    )

    # Register API routers
    app.include_router(seal_router, prefix="/api")
    app.include_router(verify_router, prefix="/api")

    # Serve static assets
    import os
    static_dir = os.path.join(os.path.dirname(__file__), "static")
    if os.path.isdir(static_dir):
        app.mount("/static", StaticFiles(directory=static_dir), name="static")

    return app
