from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()


class OrderItem(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    order_id = db.Column(db.Integer, db.ForeignKey('orders.id'))
    sku = db.Column(db.String(32), unique=True, nullable=False)
    order = db.relationship('Order', uselist=False)


class Plain:
    pass
