-- SQL schema for the product reviews system
--
-- Create a table to store reviews for Shopify products.
-- Each review is associated with a product_id and contains
-- metadata about the author, rating, title, body, verification status
-- and moderation status. A timestamp records when the review was created.

-- Enable extension for UUID generation (PostgreSQL specific)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id TEXT NOT NULL,
  product_handle TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title VARCHAR(100) NOT NULL,
  body TEXT NOT NULL,
  author_name VARCHAR(255) NOT NULL,
  author_email TEXT NOT NULL,
  verified_buyer BOOLEAN DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Index to quickly fetch reviews by product_id and status
CREATE INDEX IF NOT EXISTS idx_reviews_product_status
  ON reviews (product_id, status);