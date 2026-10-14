from fastapi import FastAPI
from .routers import orders
from app.routers.users import router as users_router
import api.v2.reports

app = FastAPI(title="Shop")

app.include_router(orders.router, prefix='/api')
app.include_router(users_router)
app.include_router(api.v2.reports.router, prefix="/v2")


@app.get('/health')
async def health():
    return {"ok": True}


# @app.get('/commented')
@app.api_route('/ping', methods=['GET', 'POST'])
def ping():
    """Ping.

@app.get('/docstring')
    """
    return "pong"
