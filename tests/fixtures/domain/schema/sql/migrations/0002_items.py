def upgrade(op):
    op.execute("""
    CREATE TABLE items (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL -- display name
    )
    """)
# op.execute("CREATE TABLE ghost (id INT)")
