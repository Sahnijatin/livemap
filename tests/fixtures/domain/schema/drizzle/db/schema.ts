import { pgTable, serial, integer, varchar, numeric, text, timestamp } from 'drizzle-orm/pg-core';
import { sqliteTable } from 'drizzle-orm/sqlite-core';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  name: text('name'),
});

// export const ghosts = pgTable('ghosts', { id: serial('id') });
export const orders = pgTable('orders', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  total: numeric('total', { precision: 10, scale: 2 }).notNull(),
  'created_at': timestamp('created_at').defaultNow(),
  ...timestamps,
});

export const items = sqliteTable('order_items', (t) => ({
  orderId: t.integer('order_id').references(() => orders.id),
  sku: t.text().notNull(),
}));
