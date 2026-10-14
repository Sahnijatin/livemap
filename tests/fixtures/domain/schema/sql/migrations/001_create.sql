-- Initial schema
/* CREATE TABLE ghosts (id INT); */
-- CREATE TABLE commented (id INT);
CREATE TABLE IF NOT EXISTS public."users" (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  name text,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

create table orders (
  id BIGSERIAL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  total NUMERIC(10, 2) NOT NULL DEFAULT 0,
  note TEXT DEFAULT 'a, b (c -- not a comment',
  coupon_code VARCHAR(32),
  PRIMARY KEY (id),
  CONSTRAINT orders_coupon_fk FOREIGN KEY (coupon_code) REFERENCES `coupons` (`code`),
  UNIQUE (coupon_code)
);

CREATE TABLE [dbo].[order_items] (
  [order_id] INT NOT NULL,
  [sku] NVARCHAR(64) NOT NULL,
  qty INT,
  CONSTRAINT pk_items PRIMARY KEY ([order_id], [sku]),
  FOREIGN KEY ([order_id]) REFERENCES [dbo].[orders] ([id])
);

INSERT INTO users (email) VALUES ('CREATE TABLE fake (id INT)');
DROP TABLE IF EXISTS legacy;
