from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, Numeric, String
from sqlalchemy.orm import declarative_base, relationship

Base = declarative_base()


class TimestampMixin:
    created_at = Column(DateTime, nullable=False)


class User(Base):
    __tablename__ = 'users'

    id = Column(Integer, primary_key=True)
    email = Column(String(255), nullable=False, unique=True)
    name = Column('full_name', String)
    orders = relationship('Order', back_populates='user', uselist=True)

    def __repr__(self):
        label = Column(String)
        return f"<User {self.email}>"

    active = Column(Boolean,
        default=True)


class Order(TimestampMixin, Base):
    """An order.

Column(Integer) in a docstring is not a field.
    """
    __tablename__ = "orders"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey('users.id'), nullable=False)
    # note = Column(String)
    total = Column(Numeric(10, 2))
    user = relationship("User", back_populates="orders")
    tags = relationship('Tag', secondary='order_tags')


class Helper:
    value = Column(Integer)


stray = Column(Integer)
