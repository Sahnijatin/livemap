from typing import List, Optional

from sqlalchemy import ForeignKey, String
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = 'users'

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True)
    nickname: Mapped[Optional[str]]
    bio: Mapped[str | None] = mapped_column(String)
    items: Mapped[list['Item']] = relationship(back_populates='owner')


class Item(Base):
    __tablename__ = "items"

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id'))
    title: Mapped[str] = mapped_column(String(80), nullable=True)
    owner: Mapped["User"] = relationship(back_populates="items")
    tags: Mapped[List["Tag"]] = relationship(secondary="item_tags")


class AuditLog(Base):
    id: Mapped[int] = mapped_column(primary_key=True)
    item_id: Mapped[int] = mapped_column(ForeignKey(Item.id))
