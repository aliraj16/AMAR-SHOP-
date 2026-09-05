# AMAR SHOP — Production E-commerce Foundation

এই project আপনার browser-only AMAR SHOP-কে server + PostgreSQL ভিত্তিক real e-commerce architecture-এ নিয়েছে।

## Included
- Real PostgreSQL products/orders/stock
- Transaction-safe order creation + stock deduction
- Admin authentication with bcrypt + HTTP-only cookie JWT
- Product management
- Order management/status
- Customer order tracking by order number (no public phone/address exposure)
- Server-side Telegram notification
- Image upload
- Meta Conversions API endpoint + browser purchase event
- COD checkout
- Payment/courier credential slots prepared for merchant-approved integrations

## Important: payment/courier activation
bKash, Nagad, Rocket এবং card payments are not safely "activated" by putting a number in HTML. A merchant account/API credential and the provider's required server-side checkout/callback/webhook flow are needed. Keep credentials in `.env`, never in public JavaScript.

For courier, the backend is structured so a provider adapter can create a shipment and store the consignment/tracking ID. Pathao states that its Merchant panel can be integrated with a website through its Developer API option. Steadfast also provides merchant management and real-time tracking. Configure the chosen merchant credentials before enabling automatic shipment creation.

## Local
1. Copy `.env.example` to `.env`.
2. Start PostgreSQL: `docker compose up -d db`
3. `npm install`
4. Run `server/schema.sql` against your database.
5. `npm start`
6. Store: http://localhost:3000
7. Admin: http://localhost:3000/admin/

## Production checklist
- HTTPS
- Managed PostgreSQL + automated backups
- Persistent object storage for images
- Strong random JWT secret
- Strong admin password
- Rotate any secrets previously exposed in the old HTML
- Configure Meta Pixel ID + Conversions API access token
- Configure one approved payment gateway and verify server-side callback/webhook
- Configure Pathao or Steadfast merchant API credentials and save courier consignment IDs
- Add refund/return workflow
- Add SMS/WhatsApp provider if required
- Add monitoring/error logging
- Add daily database backup
- Add privacy policy, terms, return/refund policy and contact details

## Original file
`legacy-amar-shop.html` is the original user HTML preserved for reference. Its product storage uses IndexedDB/localStorage rather than a shared server database.
