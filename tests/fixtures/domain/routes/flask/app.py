from flask import Flask
from .orders import orders_bp
from . import admin

app = Flask(__name__)
app.register_blueprint(orders_bp, url_prefix='/api')
app.register_blueprint(admin.bp)


@app.route('/')
def index():
    return 'hi'


@app.route('/login', methods=['GET', 'POST'])
def login():
    return ''


@app.get('/users/<int:user_id>')
def user(user_id):
    return requests.get('/not-a-route')
