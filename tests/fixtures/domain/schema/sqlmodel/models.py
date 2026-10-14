from typing import ClassVar, Optional

from sqlmodel import Field, Relationship, SQLModel


class UserBase(SQLModel):
    email: str = Field(unique=True)
    name: Optional[str] = None


class User(UserBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    orders: list['Order'] = Relationship(back_populates='user')
    kind: ClassVar[str] = 'user'


class Order(SQLModel, table=True):
    __tablename__ = 'orders'

    id: int | None = Field(default=None, primary_key=True)
    total: float
    user_id: int = Field(foreign_key='user.id')
    user: Optional['User'] = Relationship(back_populates='orders')


class OrderRead(SQLModel):
    id: int
