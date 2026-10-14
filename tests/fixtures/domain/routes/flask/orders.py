from flask import Blueprint, jsonify

orders_bp = Blueprint('orders', __name__, url_prefix='/orders')


@orders_bp.route('/', methods=['GET'])
def list_orders():
    return jsonify([])


@orders_bp.post('/<int:id>/cancel')
def cancel(id):
    return ''


@orders_bp.route('/<path:rest>', methods=('PUT', 'PATCH'))
def other(rest):
    return ''
