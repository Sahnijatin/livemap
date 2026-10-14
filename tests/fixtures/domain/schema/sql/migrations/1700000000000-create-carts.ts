export async function up(db: Db): Promise<void> {
  await db.query(`
    CREATE TABLE carts (
      id UUID PRIMARY KEY,
      user_id INT REFERENCES users
    )`);
  await db.query('ALTER TABLE carts ADD COLUMN total NUMERIC NOT NULL');
  await db.query("CREATE TABLE \"cart_notes\" (body TEXT)");
}
// db.query('CREATE TABLE ghost (id INT)')
