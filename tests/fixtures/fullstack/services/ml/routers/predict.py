import os

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix="/ml")


class Features(BaseModel):
    user_id: str
    basket: list[str]


@router.post("/predict")
def predict(features: Features):
    return {"model": os.environ.get("MODEL_PATH"), "score": len(features.basket)}
