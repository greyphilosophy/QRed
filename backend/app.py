"""FastAPI Application — QRed backend."""

from fastapi import FastAPI

from backend.routes.seal import router as seal_router
from backend.routes.verify import router as verify_router
from backend.routes.registry import router as registry_router


def create_app() -> FastAPI:
    app = FastAPI(
        title="QRed",
        description="Tamper-evident document sealing and verification",
        version="0.2.0",
    )

    # Register API routers
    app.include_router(seal_router, prefix="/api")
    app.include_router(verify_router, prefix="/api")
    app.include_router(registry_router, prefix="/api")

    return app
