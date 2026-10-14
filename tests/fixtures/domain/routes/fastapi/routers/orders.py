from fastapi import APIRouter, Depends

router = APIRouter(prefix='/orders', tags=['orders'])


@router.get('/')
async def list_orders():
    return []


@router.get('/{order_id}')
async def get_order(order_id: int):
    return {}


@router.post('', status_code=201)
@requires_auth
async def create_order(body: dict = Depends(parse)):
    return body


@router.delete(
    "/{order_id}",
    dependencies=[Depends(admin)],
)
def delete_order(order_id: int):
    ...
