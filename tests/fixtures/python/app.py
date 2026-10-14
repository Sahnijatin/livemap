@app.get("/x")
async def list_orders(user_id: str, status: str | None = None):
    def inner():
        pass
    return []


class OrderService:
    def __init__(self):
        self.x = 1

    def find(self, id):
        return id
