/**
 * Cloudflare Worker (or Node.js compatible) backend for Shopify product reviews.
 *
 * This script defines three HTTP endpoints:
 *   GET    /reviews  - Fetch a paginated list of approved reviews for a product
 *   POST   /reviews  - Submit a new review (pending moderation)
 *   POST   /verify   - Optional endpoint to verify a purchase by email
 *
 * The implementation relies on a PostgreSQL database (schema defined in
 * reviews/schema.sql) and environment variables for configuration:
 *
 *   PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD  - PostgreSQL connection
 *   SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOPIFY_ACCESS_TOKEN, SHOPIFY_SHOP  -
 *       Credentials to call Shopify Admin APIs for order verification
 *
 * This file is written for clarity rather than completeness. You may need
 * to adapt it for your deployment environment (e.g. Cloudflare Workers,
 * Vercel Serverless Functions, AWS Lambda). See README for details.
 */

const { Pool } = require('pg');

// Create a Postgres connection pool using environment variables
const pool = new Pool({
  host: process.env.PGHOST,
  port: process.env.PGPORT,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  max: 5,
  idleTimeoutMillis: 30000
});

// Utility to parse JSON bodies
async function parseJson(request) {
  try {
    const text = await request.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    return null;
  }
}

// Utility to send JSON responses with CORS headers
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    }
  });
}

// Verify if a given email has purchased the product
async function verifyPurchase(productId, email) {
  const shop = process.env.SHOPIFY_SHOP;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!shop || !token) return false;

  // Fetch last year of orders for the email
  const query = new URL(
    `https://${shop}/admin/api/2024-07/orders.json?email=${encodeURIComponent(
      email
    )}&status=any&fields=financial_status,line_items`
  );
  const res = await fetch(query.toString(), {
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json'
    }
  });
  if (!res.ok) return false;
  const data = await res.json();
  const orders = data.orders || [];
  for (const order of orders) {
    const isPaid =
      order.financial_status === 'paid' ||
      order.fulfillment_status === 'fulfilled' ||
      order.fulfillment_status === 'partial';
    if (!isPaid) continue;
    for (const item of order.line_items || []) {
      if (String(item.product_id) === String(productId)) {
        return true;
      }
    }
  }
  return false;
}

// Handler for GET /reviews
async function handleGetReviews(url) {
  const search = url.searchParams;
  const productId = search.get('product_id');
  const page = parseInt(search.get('page') || '1', 10);
  const limit = parseInt(search.get('limit') || '10', 10);
  const offset = (page - 1) * limit;
  if (!productId) {
    return jsonResponse({ message: 'Missing product_id' }, 400);
  }
  try {
    const client = await pool.connect();
    const totalRes = await client.query(
      'SELECT COUNT(*) AS count FROM reviews WHERE product_id = $1 AND status = $2',
      [productId, 'approved']
    );
    const totalCount = parseInt(totalRes.rows[0].count, 10);
    const totalPages = Math.ceil(totalCount / limit) || 1;
    const { rows } = await client.query(
      'SELECT * FROM reviews WHERE product_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT $3 OFFSET $4',
      [productId, 'approved', limit, offset]
    );
    client.release();
    return jsonResponse({
      reviews: rows,
      page,
      total_pages: totalPages,
      total_count: totalCount
    });
  } catch (err) {
    console.error(err);
    return jsonResponse({ message: 'Error fetching reviews' }, 500);
  }
}

// Handler for POST /reviews
async function handlePostReviews(request) {
  const data = await parseJson(request);
  if (!data) return jsonResponse({ message: 'Invalid JSON' }, 400);
  const required = ['product_id', 'rating', 'title', 'body', 'author_name', 'author_email'];
  for (const field of required) {
    if (!data[field]) {
      return jsonResponse({ message: `Missing field: ${field}` }, 400);
    }
  }
  const rating = Number(data.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return jsonResponse({ message: 'Rating must be an integer between 1 and 5' }, 400);
  }
  // Basic spam check: limit body length
  if (data.body.length > 5000) {
    return jsonResponse({ message: 'Review body is too long' }, 400);
  }
  // Attempt verification
  let verified = false;
  try {
    verified = await verifyPurchase(data.product_id, data.author_email);
  } catch (err) {
    console.warn('Verification failed', err);
  }
  try {
    const client = await pool.connect();
    await client.query(
      'INSERT INTO reviews (product_id, product_handle, rating, title, body, author_name, author_email, verified_buyer, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        data.product_id,
        data.product_handle || '',
        rating,
        data.title,
        data.body,
        data.author_name,
        data.author_email,
        verified,
        'pending'
      ]
    );
    client.release();
    return jsonResponse({ ok: true });
  } catch (err) {
    console.error(err);
    return jsonResponse({ message: 'Error saving review' }, 500);
  }
}

// Handler for POST /verify (optional manual verification)
async function handlePostVerify(request) {
  const data = await parseJson(request);
  if (!data || !data.product_id || !data.email) {
    return jsonResponse({ message: 'Missing product_id or email' }, 400);
  }
  try {
    const verified = await verifyPurchase(data.product_id, data.email);
    return jsonResponse({ verified });
  } catch (err) {
    console.error(err);
    return jsonResponse({ message: 'Verification failed' }, 500);
  }
}

// Main request handler
async function handleRequest(request) {
  const url = new URL(request.url);
  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      }
    });
  }
  try {
    if (url.pathname === '/reviews' && request.method === 'GET') {
      return handleGetReviews(url);
    }
    if (url.pathname === '/reviews' && request.method === 'POST') {
      return handlePostReviews(request);
    }
    if (url.pathname === '/verify' && request.method === 'POST') {
      return handlePostVerify(request);
    }
    // Admin endpoint to fetch reviews by status (e.g. pending)
    if (url.pathname === '/admin/reviews' && request.method === 'GET') {
      const status = url.searchParams.get('status') || 'pending';
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      try {
        const client = await pool.connect();
        const { rows } = await client.query(
          'SELECT * FROM reviews WHERE status = $1 ORDER BY created_at DESC LIMIT $2',
          [status, limit]
        );
        client.release();
        return jsonResponse({ reviews: rows });
      } catch (err) {
        console.error(err);
        return jsonResponse({ message: 'Error fetching admin reviews' }, 500);
      }
    }

    // Admin endpoint to update review status. Expects body { id, status }
    if (url.pathname === '/admin/reviews' && request.method === 'POST') {
      const data = await parseJson(request);
      if (!data || !data.id || !data.status) {
        return jsonResponse({ message: 'Missing id or status' }, 400);
      }
      if (!['approved', 'rejected'].includes(data.status)) {
        return jsonResponse({ message: 'Invalid status' }, 400);
      }
      try {
        const client = await pool.connect();
        await client.query('UPDATE reviews SET status = $1 WHERE id = $2', [data.status, data.id]);
        client.release();
        return jsonResponse({ ok: true });
      } catch (err) {
        console.error(err);
        return jsonResponse({ message: 'Error updating review' }, 500);
      }
    }
    return jsonResponse({ message: 'Not found' }, 404);
  } catch (err) {
    console.error(err);
    return jsonResponse({ message: 'Internal error' }, 500);
  }
}

// Entry point for Cloudflare Worker
addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});